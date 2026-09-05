// Away from 3.5.6: the data home moved from the proxy package's default
// (`~/.local/share/copilot-api`) to copilot-env's own (`~/.local/share/copilot-env`).
// Every daemon spawn pins COPILOT_API_HOME (DaemonSpec.home), so the move is a
// directory rename plus repointing the artifacts that persist absolute paths into
// the home: the managed Codex configs' `model_catalog_json`, the owned Claude
// Desktop entries' `inferenceCredentialHelper`, and the proxy float's
// resolved-version record (`deno_dir`). Idempotent: a re-run finds nothing left to
// move and the repoint pass rewrites only values still carrying the legacy prefix.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { consola } from "consola";
import { saveJsonIfChanged } from "../claude/desktop.ts";
import { knownCodexHomes } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
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

/** Stop every daemon still tracked under the LEGACY home (default + profiles) so
 *  none keeps writing into (or re-creating) the old dir mid-move. The env override
 *  is how the whole paths layer is pointed at the legacy layout for the duration.
 *  Any daemon NOT confirmed stopped -- a kill survivor, or a stop refused because
 *  the pid could not be corroborated as ours -- aborts the migration (the move must
 *  not race a live writer); the runner treats that as non-fatal and the re-run
 *  retries. */
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
  description: `move the data home to ${DEFAULT_HOME}`,
  run: () =>
    moveDataHome({
      legacyHome: LEGACY_HOME,
      nextHome: DEFAULT_HOME,
      stopDaemons: stopLegacyDaemons,
      codexConfigPaths: () => knownCodexHomes().homes.map((home) => codexConfigPath(home)),
      // The ledger answers from its own file only, and this step runs BEFORE the
      // ownership fix-up below, so adopt the pre-ledger record first (post-move,
      // where the state store is readable; idempotent, so the fix-up's own run
      // is then a no-op) and both layouts answer.
      desktopEntryPaths: () => {
        const ledger = new OwnershipLedger();
        ledger.adoptLegacyRecords();
        return ledger.ownedPaths("claudeDesktop");
      },
    }),
};

/** Second fix-up of the same step: recorded artifact ownership (the
 *  WebSearch-deny and Claude Desktop paths) moved from the shared state store
 *  into the machine-local ownership ledger. The ledger's readers answer from
 *  the ledger alone, so a pre-ledger claim is unowned until this has run
 *  (the home move above already runs the same idempotent adoption for its own
 *  read, so on that path this is a no-op). Registered AFTER the
 *  home move: the state store it reads lives inside the moved home. */
export const v356Ownership: Migration = {
  version: "3.5.6",
  description: "move recorded artifact ownership into the ownership ledger",
  run: () => new OwnershipLedger().adoptLegacyRecords(),
};

/** Third fix-up of the same step: the default credential moved from the state
 *  store's top-level pair into the reserved `default` profile slot. The store's
 *  read boundary tolerates the legacy pair and every default-slot write lifts
 *  it too (the runner is best-effort), so this is a tidy-up, not a
 *  correctness gate. Registered after the home move for the
 *  same reason (the state store lives inside the moved home) and BEFORE the
 *  versioned-layout adoption: this fix-up is install-layout-independent, and
 *  the adoption's invariant is that it runs last (it relocates the install
 *  everything else fixed up). */
export const v356DefaultSlot: Migration = {
  version: "3.5.6",
  description: "lift the default credential into the reserved 'default' profile slot",
  run: () => new CopilotEnvState().adoptLegacyDefaultCredential(),
};

/** Fourth fix-up of the same step: the DEFAULT daemon's home moved from the
 *  flat root layout (config.json, .run/, logs, usage DBs at the data home
 *  itself) into `<root>/profiles/default/`, so every daemon home has one
 *  shape. The paths layer tolerates an unmigrated flat root
 *  (defaultDaemonHome prefers profiles/default only once it exists), so this
 *  is the same tidy-up-not-gate posture as its siblings. Registered after the
 *  home move (it relocates files inside the moved home) and BEFORE the
 *  versioned-layout adoption, whose invariant is that it runs last. */
export const v356DefaultHome: Migration = {
  version: "3.5.6",
  description: "move the default daemon home into profiles/default",
  run: () => moveDefaultDaemonHome(),
};

/** How the move acquires each lock (the global start lock, then the flat root's
 *  daemon.lock): dead-holder-only reclaim (staleMs Infinity -- a LIVE holder is a
 *  running launch/daemon, never aged out) with a short bounded wait that absorbs
 *  a transient CLI probe's momentary hold. Not held -> the move refuses. */
const DEFAULT_HOME_MOVE_LOCK_POLICY: LockPolicy = {
  staleMs: Number.POSITIVE_INFINITY,
  waitMs: 2_000,
  retryMs: 100,
};

/**
 * The v356DefaultHome core: move the flat root's daemon files (the
 * DAEMON_HOME_ARTIFACTS set) into `<root>/profiles/default/`.
 *
 * Safety against a still-running daemon or launch:
 *  - A busy GLOBAL start lock refuses the move first: a launch in flight has
 *    already resolved the paths it will spawn into.
 *  - The move itself runs HOLDING the root's daemon.lock (dead-holder-only
 *    reclaim): a live daemon keeps the lock, so acquisition fails and the move
 *    is refused with a warning -- never yank files (or the lock) from under a
 *    live daemon; the re-run after `agent stop` picks it up. The per-file path
 *    into an EXISTING profiles/default additionally holds THAT home's lock,
 *    since a daemon may already be running out of it.
 *  - A pre-lock daemon (started by an older release) holds no lock, so the
 *    FLAT root's per-host tracked pid is read directly (never through the
 *    paths layer, whose resolution may already prefer profiles/default) and
 *    any live pid not CONFIDENTLY another process refuses the move the same
 *    way (classification "yes" or "unknown" -- fail closed).
 * The stale lock marker a dead holder left is deleted (not moved) under the
 * held lock: the daemon that wrote it is dead, and its replacement takes a
 * fresh lock in the new home.
 *
 * The flip is atomic: artifacts are staged into `profiles/.default.migrating`
 * and ONE final rename creates `profiles/default`. A mid-move failure leaves
 * the flat root still resolving -- defaultDaemonHome counts the staging dir as
 * the flat layout precisely so a fully staged crash cannot read as a fresh
 * root -- and a re-run resumes the staging and finalizes. Only when
 * profiles/default ALREADY exists (a hand-made dir) do the artifacts move
 * per-file into it -- an artifact present on BOTH sides is refused, never
 * merged (the v356 posture).
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
  // Probe the global start lock WITHOUT materializing its run dir (a lock cannot be
  // held where its directory does not exist): a launch in flight has resolved the
  // paths it will spawn into -- flat or target-homed, it must finish before anything
  // moves. (A start beginning after this probe can still spawn within the move's
  // few-ms window; a flat-homed daemon it leaves is untracked in the new home, so
  // the next start's orphan sweep reaps it -- the accepted residual.)
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
      // A pre-lock daemon holds no lock; the FLAT root's tracked pid is the remaining
      // liveness signal this host can judge. Read the flat state file by explicit
      // path (the paths layer may already resolve elsewhere) and judge by
      // CLASSIFICATION, refusing on "yes" AND "unknown": "failed to look" is never
      // "nobody there" (daemon_lock.ts's posture). The kill paths' boolean scan maps
      // an unreadable identity to false because there false means "don't signal" --
      // here false would mean "move the home out from under a possibly-live daemon",
      // the exact inversion. Fail-closed is recoverable (`agent stop`, re-run the
      // migrate); cross-host pre-lock daemons stay undetectable -- the same accepted
      // residual every pre-lock consult has.
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
        // Reads already resolve to `target`, so a daemon may be RUNNING out of it:
        // fence the target home with ITS OWN lock before the per-file moves write
        // into it -- the root lock held above says nothing about this home.
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
    // Delete the dead holder's stale marker UNDER the held lock (the OS lock lives on
    // the `.oslock` sidecar, so the marker file is plain data here) -- no gap in which
    // a booting daemon could have re-acquired it. Nothing consults the root's lock
    // after the move: a new daemon locks its own home under profiles/.
    rmSync(lockPath, { force: true });
  });
}

/** The FLAT root's tracked daemon pid for THIS host, read by explicit path (the run-state
 *  store would resolve through defaultDaemonHome, which no longer answers the flat root
 *  once profiles/default exists). Only the pid is wanted; any other shape reads as none.
 *  A missing or unreadable file also flattens to none (the plain load(), DECIDED over the
 *  strict read) -- accepted: our store writes atomically, so the common case is "never
 *  written", and the residue (a permissions or corruption failure hiding a live pre-lock
 *  daemon) joins this consult's existing accepted residuals (see the call site: cross-host
 *  daemons are undetectable too), while a strict throw would fail the whole best-effort
 *  migration over a blind spot it tolerates elsewhere. */
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

/** Fifth (and LAST) fix-up of the same step: installs moved from the flat
 *  layout (one binary and its runtime files at the install root) to the
 *  versioned one (`<top>/versions/vX.Y.Z/` roots behind a `current` link). The
 *  pre-versioned updater has already swapped THIS binary into `<top>/bin` when
 *  it spawns the migrate step, so the adoption builds the layout around the
 *  live binary: copy it (its own running image -- readable everywhere,
 *  deletable nowhere on Windows) into its version root, materialize the
 *  release's runtime files there, flip `current`, rewrite the top shims to
 *  dispatch through it, and only then sweep the flat leftovers. Idempotent,
 *  and a no-op for versioned roots and dev checkouts (adoptVersionedLayout
 *  owns those guards). Registered last: it relocates the install the earlier
 *  fix-ups operated on. */
export const v356VersionedLayout: Migration = {
  version: "3.5.6",
  description: "adopt the versioned install layout (versions/ + a current link)",
  run: () => adoptVersionedLayout(),
};
