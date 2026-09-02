// Away from 3.5.6: the data home moved from the proxy package's default
// (`~/.local/share/copilot-api`) to copilot-env's own (`~/.local/share/copilot-env`).
// Every daemon spawn pins COPILOT_API_HOME (DaemonSpec.home), so the move is a
// directory rename plus repointing the artifacts that persist absolute paths into
// the home: the managed Codex configs' `model_catalog_json`, the owned Claude
// Desktop entries' `inferenceCredentialHelper`, and the proxy float's
// resolved-version record (`deno_dir`). Idempotent: a re-run finds nothing left to
// move and the repoint pass rewrites only values still carrying the legacy prefix.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { consola } from "consola";
import { saveJsonIfChanged } from "../claude/desktop.ts";
import { knownCodexHomes } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { DEFAULT_HOME, profileHomeNames } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { adoptVersionedLayout } from "../install/installer.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../proxy_float.ts";
import { errMessage } from "../utils/error.ts";
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
 *  A daemon that survives its kill aborts the migration (the move must not race a
 *  live writer); the runner treats that as non-fatal and the re-run retries. */
async function stopLegacyDaemons(): Promise<void> {
  const saved = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = LEGACY_HOME;
  try {
    const profiles = profileHomeNames();
    for (const profile of [null, ...profiles]) {
      const result = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
      if (result.signalled && !result.stopped) {
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
      // Through the ledger (ledger entries plus the not-yet-adopted legacy
      // record): this step runs BEFORE the ownership adoption below, and on a
      // re-run after it, so both layouts must answer.
      desktopEntryPaths: () => new OwnershipLedger().ownedPaths("claudeDesktop"),
    }),
};

/** Second fix-up of the same step: recorded artifact ownership (the
 *  WebSearch-deny and Claude Desktop paths) moved from the shared state store
 *  into the machine-local ownership ledger. The ledger's readers tolerate the
 *  legacy keys until this has run (a dev checkout never runs migrations), so
 *  the adoption is a tidy-up, not a correctness gate. Registered AFTER the
 *  home move: the state store it reads lives inside the moved home. */
export const v356Ownership: Migration = {
  version: "3.5.6",
  description: "move recorded artifact ownership into the ownership ledger",
  run: () => new OwnershipLedger().adoptLegacyRecords(),
};

/** Third fix-up of the same step: the default credential moved from the state
 *  store's top-level pair into the reserved `default` profile slot. The store's
 *  read boundary tolerates the legacy pair and every default-slot write lifts
 *  it too (the runner is best-effort), so this is the same tidy-up-not-gate
 *  posture as the ownership adoption. Registered after the home move for the
 *  same reason (the state store lives inside the moved home) and BEFORE the
 *  versioned-layout adoption: this fix-up is install-layout-independent, and
 *  the adoption's invariant is that it runs last (it relocates the install
 *  everything else fixed up). */
export const v356DefaultSlot: Migration = {
  version: "3.5.6",
  description: "lift the default credential into the reserved 'default' profile slot",
  run: () => new CopilotEnvState().adoptLegacyDefaultCredential(),
};

/** Fourth (and LAST) fix-up of the same step: installs moved from the flat
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
