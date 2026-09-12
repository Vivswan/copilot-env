// Away from 3.5.6: the data home moved from the proxy package's default
// (`~/.local/share/copilot-api`) to copilot-env's own (`~/.local/share/copilot-env`). Every
// daemon spawn pins COPILOT_API_HOME (DaemonSpec.home), so the move is a directory rename plus
// repointing the artifacts that persist absolute paths into the home. Idempotent: a re-run finds
// nothing to move and repoints only values still carrying the legacy prefix.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { consola } from "consola";
import { saveJsonIfChanged } from "../claude/desktop.ts";
import { knownCodexHomes } from "../codex/host.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { moveRootStores } from "./4.0.2.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { startLockPath } from "../copilot_api/launch.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  DAEMON_HOME_ARTIFACTS,
  DEFAULT_HOME,
  DEFAULT_HOME_STAGING_DIR,
  DEFAULT_PROFILE_DIR,
  profileHomeNames,
  PROFILES_DIR_NAME,
  resolveRootHome,
  RUN_DIR_NAME,
  RUN_STATE_FILENAME,
} from "../copilot_api/paths.ts";
import { classifyDaemonPid, DAEMON_SIGKILL_GRACE_MS, pidAlive } from "../copilot_api/process.ts";
import { adoptVersionedLayout } from "../install/installer.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../proxy_float.ts";
import { daemonLockPath } from "../scripts/daemon_lock.ts";
import { errMessage } from "../utils/error.ts";
import { type LockPolicy, withFileLock } from "../utils/file_lock.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isRecord } from "../utils/json.ts";
import { fenceShellBlocks, rewriteClaudeWiring, rewriteCodexWiring } from "./4.0.0.ts";
import type { Migration } from "./index.ts";

/** The pre-rename default home (the proxy package's own spelling), frozen here. */
const LEGACY_HOME: string = join(homedir(), ".local", "share", "copilot-api");

export interface DataHomeMoveOptions {
  legacyHome: string;
  nextHome: string;
  /** Stop every daemon still tracked under the legacy home, pre-move. */
  stopDaemons: () => Promise<void>;
  /** Thunks, not lists: both stores live INSIDE the home, so they are only
   *  readable at their new location once the move has happened. */
  codexConfigPaths: () => string[];
  desktopEntryPaths: () => string[];
}

/** The injectable core (the migration binds the real values below). */
export async function moveDataHome(opts: DataHomeMoveOptions): Promise<void> {
  const { legacyHome, nextHome } = opts;
  if (process.env.COPILOT_API_HOME) {
    consola.info("  COPILOT_API_HOME is set; the pinned home stays where it is.");
    return;
  }
  if (existsSync(legacyHome)) {
    if (existsSync(nextHome)) {
      consola.warn(
        `  both ${legacyHome} and ${nextHome} exist; refusing to merge them. ` +
          "Move or remove one by hand, then re-run `agent migrate 3.5.6 3.5.7`.",
      );
      return;
    }
    await opts.stopDaemons();
    renameSync(legacyHome, nextHome);
    consola.info(`  moved ${legacyHome} -> ${nextHome}`);
  }
  // The moved-in stores still wear their pre-4.0.2 names, and every read below goes through the
  // new-only readers (the hoisted v402RootLayout step runs only after this step returns). Rename
  // whenever the destination exists, not only on the move path: a re-run after a crash right
  // after the directory rename enters with legacyHome already absent.
  if (existsSync(nextHome)) moveRootStores(nextHome);

  /** `value` repointed onto the new home, or null when it does not reference the
   *  legacy home (foreign paths are never ours to rewrite). */
  const repointed = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    if (value === legacyHome) return nextHome;
    if (value.startsWith(legacyHome + sep)) return nextHome + value.slice(legacyHome.length);
    return null;
  };

  // The float's resolved-version record pins its deno cache dir by absolute path;
  // a stale pointer would make every offline start miss the (moved) cache.
  const record = readResolvedVersionRecord(nextHome);
  const nextDenoDir = repointed(record?.denoDir);
  if (record !== null && nextDenoDir !== null) {
    writeResolvedVersionRecord(nextHome, record.version, record.resolvedAtMs, nextDenoDir);
  }

  // The legacy prefix alone proves a `model_catalog_json` value is our generated path.
  for (const configPath of opts.codexConfigPaths()) {
    try {
      const read = readCodexToml(configPath);
      if (read.kind !== "ok") continue;
      const next = repointed(read.doc.model_catalog_json);
      if (next === null) continue;
      read.doc.model_catalog_json = next;
      saveCodexToml(configPath, read.doc);
    } catch (e) {
      consola.warn(`  could not repoint ${configPath}: ${errMessage(e)}`);
    }
  }

  // Only OWNED Desktop entries (the caller feeds the ownership record).
  for (const entryPath of opts.desktopEntryPaths()) {
    try {
      if (!existsSync(entryPath)) continue;
      const doc: unknown = JSON.parse(readFileSync(entryPath, "utf8"));
      if (!isRecord(doc)) continue;
      const next = repointed(doc["inferenceCredentialHelper"]);
      if (next === null) continue;
      doc["inferenceCredentialHelper"] = next;
      saveJsonIfChanged(entryPath, doc);
    } catch (e) {
      consola.warn(`  could not repoint ${entryPath}: ${errMessage(e)}`);
    }
  }
}

/** The env override points the whole paths layer at the legacy layout for the duration. Any
 *  daemon NOT confirmed stopped (a kill survivor, or a pid that could not be corroborated as
 *  ours) aborts the migration: the move must not race a live writer. The runner treats that as
 *  non-fatal and the re-run retries. */
async function stopLegacyDaemons(): Promise<void> {
  const saved = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = LEGACY_HOME;
  try {
    const profiles = profileHomeNames();
    for (const profile of [null, ...profiles]) {
      const result = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
      if (!result.stopped) {
        throw new Error(
          `a daemon (pid ${result.trackedPid}) under ${LEGACY_HOME} would not stop`,
        );
      }
    }
  } finally {
    if (saved === undefined) delete process.env.COPILOT_API_HOME;
    else process.env.COPILOT_API_HOME = saved;
  }
}

export const v356: Migration = {
  version: "3.5.6",
  layout: true,
  description: `move the data home to ${DEFAULT_HOME}`,
  run: () =>
    moveDataHome({
      legacyHome: LEGACY_HOME,
      nextHome: DEFAULT_HOME,
      stopDaemons: stopLegacyDaemons,
      codexConfigPaths: () => knownCodexHomes().homes.map((home) => codexConfigPath(home)),
      // The ledger answers from its own file only, and this step runs BEFORE the ownership
      // fix-up below, so adopt the pre-ledger record first (post-move, where the state store
      // is readable; idempotent, so the fix-up's own run is then a no-op).
      desktopEntryPaths: () => {
        const ledger = new OwnershipLedger();
        ledger.adoptLegacyRecords();
        return ledger.ownedPaths("claudeDesktop");
      },
    }),
};

/** Recorded artifact ownership moved from the shared state store into the machine-local
 *  ledger, whose readers answer from the ledger alone: a pre-ledger claim is unowned until this
 *  runs. Registered AFTER the home move because the state store lives inside the moved home
 *  (the move already runs this adoption for its own read, so on that path this is a no-op). */
export const v356Ownership: Migration = {
  version: "3.5.6",
  description: "move recorded artifact ownership into the ownership ledger",
  run: () => new OwnershipLedger().adoptLegacyRecords(),
};

/** The default credential moved from the state store's top-level pair into the reserved
 *  `default` slot. The store reads the slot shape ONLY and its writes leave the pair in place,
 *  so this lift is the one path that converts it: a correctness gate, not a tidy-up. After the
 *  home move (the store lives inside it) and BEFORE the versioned-layout adoption, whose
 *  invariant is that it runs last. */
export const v356DefaultSlot: Migration = {
  version: "3.5.6",
  description: "lift the default credential into the reserved 'default' profile slot",
  run: () => new CopilotEnvState().adoptLegacyDefaultCredential(),
};

/** The DEFAULT daemon's home moved from the flat root into `<root>/profiles/default/`, so every
 *  daemon home has one shape. The paths layer tolerates an unmigrated flat root
 *  (defaultDaemonHome prefers profiles/default only once it exists), so this is a tidy-up, not
 *  a gate. After the home move and BEFORE the versioned-layout adoption, which must run last. */
export const v356DefaultHome: Migration = {
  version: "3.5.6",
  description: "move the default daemon home into profiles/default",
  run: () => moveDefaultDaemonHome(),
};

/** Dead-holder-only reclaim (staleMs Infinity: a LIVE holder is a running launch or daemon,
 *  never aged out) with a short wait that absorbs a transient CLI probe's hold. Not held -> the
 *  move refuses. */
const DEFAULT_HOME_MOVE_LOCK_POLICY: LockPolicy = {
  staleMs: Number.POSITIVE_INFINITY,
  waitMs: 2_000,
  retryMs: 100,
};

/**
 * Refuses rather than yank files from a daemon or launch it can SEE, with a warning naming the
 * re-run after `agent stop`. Two gaps stay, each noted at its guard below: a start that begins
 * after the start-lock probe, and a pre-lock daemon on another host (flatTrackedPid reads this
 * one). defaultDaemonHome counts the staging dir as the flat layout, so a crash mid-move still
 * resolves flat and a re-run resumes.
 *
 *   busy start lock / held root daemon.lock / pre-lock pid not CONFIDENTLY foreign -> refuse
 *   no profiles/default      -> stage into profiles/.default.migrating -> ONE rename creates it
 *   profiles/default exists  -> per-file moves under ITS lock; a name on BOTH sides refuses
 */
export async function moveDefaultDaemonHome(
  classifyPid: typeof classifyDaemonPid = classifyDaemonPid,
): Promise<void> {
  const root = resolveRootHome();
  const lockPath = daemonLockPath(root);
  const staging = join(root, PROFILES_DIR_NAME, DEFAULT_HOME_STAGING_DIR);
  if (
    !DAEMON_HOME_ARTIFACTS.some((name) => existsSync(join(root, name))) &&
    !existsSync(staging) &&
    !existsSync(lockPath)
  ) {
    return; // fresh or already migrated: touch nothing
  }
  // Probe the start lock WITHOUT materializing its run dir (a lock cannot be held where its
  // directory does not exist): a launch in flight must finish before anything moves. A start
  // beginning after this probe can still spawn in the move's few-ms window; the flat-homed
  // daemon it leaves is untracked in the new home and the next start's orphan sweep reaps it,
  // the accepted residual.
  const startLock = startLockPath();
  if (existsSync(dirname(startLock))) {
    const startBusy = await withFileLock(
      startLock,
      DEFAULT_HOME_MOVE_LOCK_POLICY,
      (outcome) => !outcome.held,
    );
    if (startBusy) {
      consola.warn(
        "  an `agent start` is in progress; leaving the flat home in place. " +
          "Re-run `agent migrate 3.5.6 3.5.7` once it finishes.",
      );
      return;
    }
  }
  await withFileLock(lockPath, DEFAULT_HOME_MOVE_LOCK_POLICY, async (outcome) => {
    if (!outcome.held) {
      consola.warn(
        `  a daemon still holds ${lockPath} (or it cannot be probed); leaving the flat ` +
          "home in place. Stop it (`agent stop`) and re-run `agent migrate 3.5.6 3.5.7`.",
      );
      return;
    }
    // Re-list under the lock: the wait above may have raced a writer.
    const pending = DAEMON_HOME_ARTIFACTS.filter((name) => existsSync(join(root, name)));
    if (pending.length > 0 || existsSync(staging)) {
      // A pre-lock daemon holds no lock; the FLAT root's tracked pid is the remaining liveness
      // signal. Judge by CLASSIFICATION and refuse on "yes" AND "unknown": "failed to look" is
      // never "nobody there" (daemon_lock.ts's posture). The kill paths flatten an unreadable
      // identity to false because there false means "don't signal"; here it would mean "move
      // the home out from under a possibly-live daemon", the exact inversion. Fail-closed is
      // recoverable (`agent stop`, re-run); cross-host pre-lock daemons stay undetectable.
      const tracked = flatTrackedPid(root);
      if (tracked !== undefined && pidAlive(tracked)) {
        const cls = await classifyPid(tracked);
        if (cls === "yes" || cls === "unknown") {
          consola.warn(
            `  a daemon (pid ${tracked}) may still be running out of ${root} (identity ` +
              `${cls === "yes" ? "confirmed" : "unreadable"}); leaving the flat home in ` +
              "place. Stop it (`agent stop`) and re-run `agent migrate 3.5.6 3.5.7`.",
          );
          return;
        }
      }
      const target = join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR);
      if (existsSync(target)) {
        // Reads already resolve to `target`, so a daemon may be RUNNING out of it: fence it
        // with ITS OWN lock before writing into it; the root lock says nothing about this home.
        await withFileLock(
          daemonLockPath(target),
          DEFAULT_HOME_MOVE_LOCK_POLICY,
          (targetOutcome) => {
            if (!targetOutcome.held) {
              consola.warn(
                `  a daemon still holds ${daemonLockPath(target)} (or it cannot be ` +
                  "probed); leaving the flat leftovers in place. Stop it (`agent stop`) " +
                  "and re-run `agent migrate 3.5.6 3.5.7`.",
              );
              return;
            }
            if (existsSync(staging)) {
              consola.warn(
                `  a leftover staging dir ${staging} exists beside ${target}; merge or remove it by hand.`,
              );
            }
            moveArtifactsInto(root, pending, target);
            // Our own acquisition's marker: the target home's next daemon takes a
            // fresh lock of its own.
            rmSync(daemonLockPath(target), { force: true });
          },
        );
      } else {
        mkdirSync(staging, { recursive: true }); // resumes a crashed staging run
        moveArtifactsInto(root, pending, staging);
        renameSync(staging, target); // THE flip: reads move to profiles/default here
        consola.info(`  moved the default daemon home into ${target}`);
      }
    }
    // Delete the dead holder's marker UNDER the held lock (the OS lock lives on the `.oslock`
    // sidecar, so the marker is plain data here): no gap for a booting daemon to re-acquire it.
    // Nothing consults the root's lock after the move; a new daemon locks its own home.
    rmSync(lockPath, { force: true });
  });
}

/** Read by explicit path: the run-state store would resolve through defaultDaemonHome, which
 *  stops answering the flat root once profiles/default exists. A missing or unreadable file
 *  flattens to none (the plain load(), DECIDED over the strict read): our store writes
 *  atomically, so the common case is "never written", and the residue (a corruption hiding a
 *  live pre-lock daemon) joins this consult's accepted residuals, where a strict throw would
 *  fail the whole best-effort migration over a blind spot it tolerates elsewhere. */
function flatTrackedPid(root: string): number | undefined {
  const stateFile = join(root, RUN_DIR_NAME, getSanitizedHostname(), RUN_STATE_FILENAME);
  const pid = new CopilotApiConfig(stateFile).load()["pid"];
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Rename each of `names` from `root` into `into`; a name already present on the
 *  destination side is refused (never merged), matching moveDataHome. */
function moveArtifactsInto(root: string, names: readonly string[], into: string): void {
  for (const name of names) {
    const src = join(root, name);
    const dst = join(into, name);
    if (existsSync(dst)) {
      consola.warn(`  both ${src} and ${dst} exist; refusing to merge them.`);
      continue;
    }
    renameSync(src, dst);
    consola.info(`  moved ${src} -> ${dst}`);
  }
}

/** The wiring 3.5.6 wrote, converted to the shapes the current readers know. The conversions
 *  live in 4.0.0.ts (a 4.0.0 install runs them too) and are registered here as well because
 *  they must land BEFORE the layout adoption below: it re-wires the shell through the current
 *  writer, which owns only the marker line of an unfenced block and would strand its body, and
 *  it sweeps the flat `src/scripts` the old Codex and Claude wiring still pointed at. */
export const v356ShellFence: Migration = {
  version: "3.5.6",
  description: "fence the shell rc blocks written without an end marker",
  run: fenceShellBlocks,
};
export const v356CodexWiring: Migration = {
  version: "3.5.6",
  description: "rewrite the pre-4.0.0 Codex proxy wiring to the current auth.command",
  run: rewriteCodexWiring,
};
export const v356ClaudeWiring: Migration = {
  version: "3.5.6",
  description: "rewrite Claude's helper-file apiKeyHelper to the inline command",
  run: rewriteClaudeWiring,
};

/** Installs moved from the flat layout to the versioned one (`<top>/versions/vX.Y.Z/` roots
 *  behind a `current` link). The pre-versioned updater has already swapped THIS binary into
 *  `<top>/bin` when it spawns the migrate step, so the adoption builds the layout around the
 *  live binary (adoptVersionedLayout owns the guards and the idempotence). Registered LAST: it
 *  relocates the install the earlier fix-ups operated on. */
export const v356VersionedLayout: Migration = {
  version: "3.5.6",
  description: "adopt the versioned install layout (versions/ + a current link)",
  run: () => adoptVersionedLayout(),
};
