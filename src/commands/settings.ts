// `agent settings`: export/import every portable copilot-env setting as one
// JSON bundle (the domain lives in src/agents/transfer.ts). Flag-verb style
// like `auth`/`profile`: exactly one of --export/--import per invocation.
// Export defaults to stdout so nothing lands on disk unasked, and to REDACTED
// tokens so a shared bundle never leaks a credential. Import computes the full
// plan first, confirms against the plan's own write list, backs the previous
// settings up, then applies that same plan -- so a bad import is one
// `--import <backup>` away from undone.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { consola } from "consola";
import {
  applyImportPlan,
  buildExportBundle,
  type ImportDeps,
  type ImportOutcome,
  parseSettingsBundle,
  planImport,
  serializeSettingsBundle,
  writeSettingsBackup,
} from "../agents/transfer.ts";
import {
  CONFIG_REGISTRY,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  isProxyProjected,
} from "../copilot_api/env_config.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { PROXY_RESTART_HINT, unreadProjectedKeyWarnings } from "./config.ts";

// Narration to stderr so `--export`'s stdout stays a clean machine-readable bundle.
const logger = createStderrLogger();

export interface SettingsArgs {
  /** `--export [file]`: write the bundle to the file, or stdout when bare. */
  exportTo?: string | boolean;
  /** `--import <file>`: restore the bundle from the file. */
  importFrom?: string;
  /** `--with-credentials`: with --export, include the real tokens. */
  withCredentials?: boolean;
  /** `--force`: with --import, skip the confirmation prompt (headless use). */
  force?: boolean;
  /** `--no-backup`: with --import, skip the pre-import settings backup. */
  noBackup?: boolean;
}

/** Test seams: the domain deps plus the plan/apply steps themselves,
 *  injectable so the failure path (rollback messaging) can be exercised
 *  hermetically. */
export interface SettingsDeps extends ImportDeps {
  planImport?: typeof planImport;
  applyPlan?: typeof applyImportPlan;
}

/**
 * What ONE `agent settings` invocation does -- an export or an import, parsed
 * ONCE by `parseSettingsAction` at the CLI boundary. Each arm carries only its
 * own knobs, so a mismatched flag (`--import --with-credentials`, `--export
 * --force`) is a rejection here and the handlers never re-narrow the raw bag.
 */
export type SettingsAction =
  | { kind: "export"; target: string | boolean; withCredentials: boolean }
  | { kind: "import"; file: string; force: boolean; noBackup: boolean };

const EXACTLY_ONE = "pass exactly one of --export [file], --import <file>";

/** Parse the raw `agent settings` flags into a SettingsAction (the CLI boundary). */
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

/** The rollback invocation, path quoted for THIS machine's shell. */
function rollbackCommand(backupPath: string): string {
  const quoted = process.platform === "win32"
    ? quotePowerShell(backupPath)
    : quotePosix(backupPath);
  return `agent settings --import ${quoted}`;
}

// Rollback restores the STORES; it does not delete profiles an import created
// (import never deletes profiles), so the hint says exactly that.
const ROLLBACK_SCOPE_NOTE =
  "(restores the stores; profiles this import created stay until `agent profile --del`)";

/**
 * Post-import restart guidance (hint first, then warnings): a bundle carrying
 * any proxy-projected key just wrote preferences a RUNNING daemon will not see
 * -- projection happens at `agent start`, and with auto-start the idempotent
 * no-op start never re-projects -- so the import surfaces the same restart
 * hint and too-old-proxy warnings `agent config --set` / `agent start` would.
 * Exported for tests; empty when no projected key is set or reset.
 */
export function importRestartHints(
  config: CopilotEnvConfigData,
  preImportPrefs: CopilotEnvConfigData,
): string[] {
  // Prefs are FULL-REPLACE, so a projected key changes when the bundle carries
  // it OR when the bundle drops one the store had (reset to default) -- a
  // running daemon misses either direction until it restarts.
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
      logger.warn("This bundle contains your REAL tokens - treat the output like a password.");
    }
    process.stdout.write(text);
    return;
  }
  if (withCredentials) {
    // Recreate the file so the 0600 create-mode actually applies: writeFileSync
    // only sets the mode on creation, and an overwritten 0644 target would hold
    // the plaintext tokens under its old permissions.
    rmSync(target, { force: true });
    writeFileSync(target, text, { mode: 0o600 });
    logger.warn(`${target} contains your REAL tokens - treat it like a password file.`);
  } else {
    writeFileSync(target, text);
  }
  logger.success(`Settings exported to ${target}.`);
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

  // ONE plan drives both the confirmation and the apply, so the prompt models
  // exactly what will be written (a plan with no writes needs no prompt).
  const plan = (deps.planImport ?? planImport)(bundle, deps);
  if (plan.writes.length > 0 && !action.force && !(await confirmImport(plan.writes, file))) {
    consola.info("Import aborted - nothing was changed.");
    process.exitCode = 1;
    return;
  }

  // Backup BEFORE any write (even with --force), unless opted out; empty
  // stores skip it inside writeSettingsBackup (nothing to roll back to).
  const backupPath = action.noBackup ? null : writeSettingsBackup();
  // Snapshot the prefs the full-replace import is about to drop: the restart
  // hint must fire for a projected key the bundle RESETS, not just one it sets.
  const preImportPrefs = new CopilotEnvConfig().read();

  let outcome: ImportOutcome;
  try {
    outcome = await (deps.applyPlan ?? applyImportPlan)(plan, deps);
  } catch (e) {
    // A mid-import throw may leave the stores half-written; the rollback hint
    // must reach the user HERE, riding the rendered error.
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
    logger.error(`Settings imported from ${file}${wired}, but some wiring failed (see above).`);
    process.exitCode = 1;
  } else {
    logger.success(`Settings imported from ${file}${wired}.`);
  }
  const [restartHint, ...projectionWarnings] = importRestartHints(bundle.config, preImportPrefs);
  if (restartHint !== undefined) logger.info(restartHint);
  for (const warning of projectionWarnings) logger.warn(warning);
  if (backupPath !== null) {
    logger.log(`  Previous settings backed up to ${backupPath}`);
    logger.log(`  Roll back with:  ${rollbackCommand(backupPath)}  ${ROLLBACK_SCOPE_NOTE}`);
  }
}

/** `agent settings`: export or import the portable-settings bundle. */
export async function runSettings(args: SettingsArgs, deps: SettingsDeps = {}): Promise<void> {
  const action = parseSettingsAction(args);
  if (action.kind === "export") {
    runExport(action.target, action.withCredentials);
    return;
  }
  await runImport(action, deps);
}
