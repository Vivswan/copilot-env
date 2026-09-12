// The domain is src/agents/transfer.ts; this file validates, orchestrates, and renders.
//   export  -> stdout and redacted tokens by default, so nothing lands on disk or leaks unasked
//   import  -> confirms against the plan it then applies, after backing the stores up, so a bad
//              import is one `--import <backup>` away from undone
import { readFileSync } from "node:fs";
import { consola } from "consola";
import {
  applyImportPlan,
  buildExportBundle,
  type ImportDeps,
  type ImportOutcome,
  parseSettingsBundle,
  planImport,
  rollbackCommand,
  serializeSettingsBundle,
  writeSettingsBackup,
} from "../agents/transfer.ts";
import {
  CONFIG_REGISTRY,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  isProxyProjected,
} from "../copilot_api/env_config.ts";
import { profileLabel } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { atomicWriteFile, writeFileReported } from "../utils/report_write.ts";
import { PROXY_RESTART_HINT, unreadProjectedKeyWarnings } from "./config.ts";

// Narration to stderr so `--export`'s stdout stays a clean machine-readable bundle.
const logger = createStderrLogger();

export interface SettingsArgs {
  exportTo?: string | boolean;
  importFrom?: string;
  withCredentials?: boolean;
  force?: boolean;
  noBackup?: boolean;
}

/** The plan/apply steps are injectable so the failure path (rollback messaging) can be exercised
 *  hermetically. */
export interface SettingsDeps extends ImportDeps {
  planImport?: typeof planImport;
  applyPlan?: typeof applyImportPlan;
}

export type SettingsAction =
  | { kind: "export"; target: string | boolean; withCredentials: boolean }
  | { kind: "import"; file: string; force: boolean; noBackup: boolean };

const EXACTLY_ONE = "pass exactly one of --export [file], --import <file>";

export function parseSettingsAction(args: SettingsArgs): SettingsAction {
  if (args.importFrom !== undefined) {
    if (args.exportTo !== undefined) throw new Error(EXACTLY_ONE);
    if (args.withCredentials) {
      throw new Error(
        "--with-credentials only applies to --export (an import reads whatever the bundle holds)",
      );
    }
    return {
      kind: "import",
      file: args.importFrom,
      force: Boolean(args.force),
      noBackup: Boolean(args.noBackup),
    };
  }
  if (args.exportTo === undefined) throw new Error(EXACTLY_ONE);
  if (args.force || args.noBackup) {
    throw new Error("--force/--no-backup only apply to --import");
  }
  return { kind: "export", target: args.exportTo, withCredentials: Boolean(args.withCredentials) };
}

const ROLLBACK_SCOPE_NOTE =
  "(restores the stores; profiles this import created stay until `agent profile --del`)";

/** Projection happens at `agent start`, and an auto-start no-op never re-projects, so a running
 *  daemon misses a projected key the bundle set or reset until it restarts. Hint first, then
 *  warnings. Exported for tests. */
export function importRestartHints(
  config: CopilotEnvConfigData,
  preImportPrefs: CopilotEnvConfigData,
): string[] {
  // Prefs are full-replace, so a projected key changes when the bundle carries it OR when the
  // bundle drops one the store had.
  const projectedChanges = CONFIG_REGISTRY.some(
    (def) =>
      isProxyProjected(def) &&
      (config[def.key] !== undefined || preImportPrefs[def.key] !== undefined),
  );
  if (!projectedChanges) return [];
  return [PROXY_RESTART_HINT, ...unreadProjectedKeyWarnings()];
}

function runExport(target: string | boolean, withCredentials: boolean): void {
  const text = serializeSettingsBundle(buildExportBundle({ withCredentials }));
  if (typeof target !== "string") {
    if (withCredentials) {
      logger.warn(
        "This bundle contains your REAL tokens (and any stored pricing-url) - treat the output like a password.",
      );
    }
    process.stdout.write(text);
    return;
  }
  if (withCredentials) {
    // A fresh 0600 inode by rename: a write into an existing 0644 target would hold the plaintext
    // tokens under its old permissions.
    atomicWriteFile(target, text, 0o600, "settings bundle with your REAL tokens");
    // Its own line, not the write report's detail: a target inside copilot-env's own homes gets no
    // write line.
    logger.warn(
      `${target} contains your REAL tokens (and any stored pricing-url) - treat it like a password file.`,
    );
  } else {
    writeFileReported(target, text, { detail: "settings bundle, tokens redacted" });
  }
}

async function confirmImport(writeLines: string[], file: string): Promise<boolean> {
  logger.log(`Importing ${file} will overwrite:\n${writeLines.map((l) => `  • ${l}`).join("\n")}`);
  if (!process.stdin.isTTY) {
    throw new Error("not a terminal - pass --force to import non-interactively");
  }
  const confirmed = await consola.prompt("Overwrite these settings with the bundle?", {
    type: "confirm",
    initial: false,
  });
  return confirmed === true;
}

async function runImport(
  action: Extract<SettingsAction, { kind: "import" }>,
  deps: SettingsDeps,
): Promise<void> {
  const file = action.file;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`could not read ${file}: ${errMessage(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const bundle = parseSettingsBundle(parsed);

  // One plan drives both the confirmation and the apply, so the prompt shows exactly what the
  // import OVERWRITES (planWrites), not every file it writes.
  const plan = (deps.planImport ?? planImport)(bundle, deps);
  if (plan.writes.length > 0 && !action.force && !(await confirmImport(plan.writes, file))) {
    consola.info("Import aborted - nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const backupPath = action.noBackup ? null : writeSettingsBackup();
  // The restart hint must fire for a projected key the bundle RESETS, not just one it sets.
  const preImportPrefs = new CopilotEnvConfig().read();

  let outcome: ImportOutcome;
  try {
    outcome = await (deps.applyPlan ?? applyImportPlan)(plan, deps);
  } catch (e) {
    // A mid-import throw may leave the stores half-written, so the rollback hint rides the rendered
    // error.
    if (backupPath !== null) {
      throw new Error(
        `${errMessage(e)}\nThe previous settings were backed up first - roll back with: ` +
          `${rollbackCommand(backupPath)} ${ROLLBACK_SCOPE_NOTE}`,
      );
    }
    throw e;
  }

  for (const line of outcome.skipped) logger.warn(line);
  for (const line of outcome.failures) logger.warn(line);
  const wired = outcome.wiredProfiles.length > 0
    ? ` (profiles: ${outcome.wiredProfiles.join(", ")})`
    : "";
  if (outcome.failures.length > 0) {
    // failures carries both a failed profile commit and a failed default-agent wiring; the summary
    // must not claim only "wiring".
    logger.error(
      `Settings imported from ${file}${wired}, but some profiles or wiring could not be applied (see above).`,
    );
    process.exitCode = 1;
  } else {
    logger.success(`Settings imported from ${file}${wired}.`);
  }
  // The profile writes name the shared Codex config once per process, so each imported profile's
  // launch hint (the line `agent profile` prints) is said here.
  for (const name of outcome.wiredProfiles) {
    logger.log(`  Launch ${profileLabel(name)}:  cl --profile ${name}  /  cx --profile ${name}`);
  }
  const [restartHint, ...projectionWarnings] = importRestartHints(bundle.config, preImportPrefs);
  if (restartHint !== undefined) logger.info(restartHint);
  for (const warning of projectionWarnings) logger.warn(warning);
  // The backup lives inside copilot-env's own home, where writes are silent, so the rollback
  // command is said here.
  if (backupPath !== null) {
    logger.log(`  Roll back with: ${rollbackCommand(backupPath)} ${ROLLBACK_SCOPE_NOTE}.`);
  }
}

export async function runSettings(args: SettingsArgs, deps: SettingsDeps = {}): Promise<void> {
  const action = parseSettingsAction(args);
  if (action.kind === "export") {
    runExport(action.target, action.withCredentials);
    return;
  }
  await runImport(action, deps);
}
