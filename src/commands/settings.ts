// The domain is src/agents/transfer.ts; this file validates, orchestrates, and renders.
//   export  -> stdout and redacted tokens by default, so nothing lands on disk or leaks unasked
//   import  -> confirms against the plan it then applies, after backing the stores up, so a bad
//              import is one `--import <backup>` away from undone
import { consola } from "consola";
import {
  applyImportPlan,
  buildExportBundle,
  type ImportDeps,
  type ImportOutcome,
  type ImportScope,
  parseSettingsBundle,
  planImport,
  rollbackCommand,
  serializeSettingsBundle,
  type SettingsBundle,
  writeSettingsBackup,
} from "../agents/transfer.ts";
import {
  CONFIG_REGISTRY,
  configKeyDef,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  type GlobalConfigData,
  type GlobalMapKey,
  isGlobalMapKey,
  isProfileMapKey,
  isProxyProjected,
  type ProfileMapKey,
  profileSettingsKey,
} from "../copilot_api/env_config.ts";
import { assertProfileSlot } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { PROXY_RESTART_HINT_ALL } from "./config.ts";
import { runDryRun } from "./dry_run.ts";

// Narration to stderr so `--export`'s stdout stays a clean machine-readable bundle.
const logger = createStderrLogger();

export interface SettingsArgs {
  exportTo?: string | boolean;
  importFrom?: string;
  withCredentials?: boolean;
  force?: boolean;
  noBackup?: boolean;
  /** With --import: print what the bundle would change, attribute by attribute, and write nothing.
   *  Only the confirmation is skipped: the pre-import backup and its prune are planned too. With
   *  --export <file>: name the file the bundle would land in, and never its keys or tokens (the file
   *  it replaces may hold real ones). */
  dryRun?: boolean;
}

/** The plan/apply steps are injectable so the failure path (rollback messaging) can be exercised
 *  hermetically. */
export interface SettingsDeps extends ImportDeps {
  planImport?: typeof planImport;
  applyPlan?: typeof applyImportPlan;
}

export type SettingsAction =
  | { kind: "export"; target: string | boolean; withCredentials: boolean; dryRun: boolean }
  | { kind: "import"; file: string; force: boolean; noBackup: boolean; dryRun: boolean };

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
      dryRun: Boolean(args.dryRun),
    };
  }
  if (args.exportTo === undefined) throw new Error(EXACTLY_ONE);
  if (args.force || args.noBackup) {
    throw new Error("--force/--no-backup only apply to --import");
  }
  if (args.dryRun && typeof args.exportTo !== "string") {
    throw new Error("--dry-run previews --export <file>; an export to stdout writes nothing");
  }
  return {
    kind: "export",
    target: args.exportTo,
    withCredentials: Boolean(args.withCredentials),
    dryRun: Boolean(args.dryRun),
  };
}

const ROLLBACK_SCOPE_NOTE =
  "(restores the stores; profiles this import created stay until `agent profile <name> del`)";

/** Projection happens at `agent start` per profile, and an auto-start no-op never re-projects, so a
 *  running daemon misses a projected key the bundle set or reset until it restarts. Exported for
 *  tests. */
export function importRestartHints(
  config: CopilotEnvConfigData,
  preImportPrefs: CopilotEnvConfigData,
): string[] {
  // Prefs are full-replace, so a projected key changes when the bundle carries it OR when the
  // bundle drops one the store had, in the global map or any profile's section.
  const carries = (data: CopilotEnvConfigData, key: GlobalMapKey & ProfileMapKey): boolean =>
    data.global[key] !== undefined ||
    Object.values(data.profiles).some((section) => section[key] !== undefined);
  const projectedChanges = CONFIG_REGISTRY.some(
    (def) =>
      isProxyProjected(def) && isGlobalMapKey(def.key) && isProfileMapKey(def.key) &&
      (carries(config, def.key) || carries(preImportPrefs, def.key)),
  );
  return projectedChanges ? [PROXY_RESTART_HINT_ALL] : [];
}

/** The bundle a scope exports: the whole store (buildExportBundle) or one profile's projection. */
type BundleBuilder = (options: { withCredentials: boolean }) => SettingsBundle;

function runExport(target: string | boolean, withCredentials: boolean, build: BundleBuilder): void {
  const text = serializeSettingsBundle(build({ withCredentials }));
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
    fs.writeText(target, text, {
      mode: 0o600,
      detail: "settings bundle with your REAL tokens",
      secret: true,
    });
    // Its own line, not the write report's detail: a target inside copilot-env's own homes gets no
    // write line.
    logger.warn(
      `${target} contains your REAL tokens (and any stored pricing-url) - treat it like a password file.`,
    );
  } else {
    // The file this replaces may hold real tokens (an earlier --with-credentials export), so a
    // dry run names the path and prints neither side. In place (not atomic): the target may be
    // the user's own symlink, which a rename would replace.
    fs.writeText(target, text, {
      atomic: false,
      detail: "settings bundle, tokens redacted",
      secret: true,
    });
  }
}

async function confirmImport(writeLines: string[], file: string): Promise<boolean> {
  logger.log(`Importing ${file} will overwrite:\n${writeLines.map((l) => `  • ${l}`).join("\n")}`);
  if (!process.stdin.isTTY) {
    throw new Error("not a terminal - pass --force to import non-interactively");
  }
  const confirmed = await prompt("Overwrite these settings with the bundle?", {
    type: "confirm",
    initial: false,
  });
  return confirmed === true;
}

/** What a scope makes of the parsed bundle before the one import plans it: the whole store takes
 *  it as it is; a profile's scope refuses a bundle of anything else and widens its projection
 *  back to a store-shaped document over the current store. `plan` is the reach the planner is
 *  told (a named profile's import never lands the default's wiring). */
interface BundleScope {
  widen(bundle: SettingsBundle, file: string): SettingsBundle;
  plan: ImportScope;
}

async function runImport(
  action: Extract<SettingsAction, { kind: "import" }>,
  deps: SettingsDeps,
  scope: BundleScope,
): Promise<void> {
  const file = action.file;
  let raw: string;
  try {
    raw = fs.readText(file);
  } catch (e) {
    throw new Error(`could not read ${file}: ${errMessage(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const bundle = scope.widen(parseSettingsBundle(parsed), file);

  // One plan drives both the confirmation and the apply, so the prompt shows exactly what the
  // import OVERWRITES (planWrites), not every file it writes.
  const plan = (deps.planImport ?? planImport)(bundle, deps, scope.plan);
  if (action.dryRun) {
    // The same landing, recorded: the pre-import backup (its file, and the prune it triggers), then
    // every store slot and agent file the bundle would change, by key. The skips and failures the
    // apply would report are said, and fail the run, the same way. Only the confirmation is skipped.
    await runDryRun(async () => {
      if (!action.noBackup) writeSettingsBackup();
      const outcome = await (deps.applyPlan ?? applyImportPlan)(plan, deps, scope.plan);
      for (const line of [...outcome.skipped, ...outcome.failures]) logger.warn(line);
      if (outcome.failures.length > 0) process.exitCode = 1;
    });
    return;
  }
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
    outcome = await (deps.applyPlan ?? applyImportPlan)(plan, deps, scope.plan);
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
  for (const hint of importRestartHints(bundle.config, preImportPrefs)) logger.info(hint);
  // The backup lives inside copilot-env's own home, where writes are silent, so the rollback
  // command is said here.
  if (backupPath !== null) {
    logger.log(`  Roll back with: ${rollbackCommand(backupPath)} ${ROLLBACK_SCOPE_NOTE}.`);
  }
}

/** `agent settings`: the whole store. */
export async function runSettings(args: SettingsArgs, deps: SettingsDeps = {}): Promise<void> {
  await runScopedSettings(args, deps, buildExportBundle, {
    widen: (bundle) => bundle,
    plan: { defaultWiring: true },
  });
}

/** `agent profile [<name>] settings`: one profile's bundle. The default's is its credential, both
 *  agents' mode, its own section, and the shared proxy and probe defaults; a named profile's is
 *  its slot and its section. Both are store-shaped documents (the same format, the other parts
 *  empty), so `agent settings --import` reads them too. */
export async function runProfileSettings(
  rawProfile: string | undefined,
  args: SettingsArgs,
  deps: SettingsDeps = {},
): Promise<void> {
  const profile = parseProfileFlag(rawProfile);
  await runScopedSettings(
    args,
    deps,
    (options) => {
      // An export carries the profile's store slot (the import requires it back), so a name with
      // a daemon home and no slot is refused here with its repair; an import is how a bundle
      // creates a profile.
      if (profile !== null) assertProfileSlot(profile);
      return profileBundle(buildExportBundle(options), profile);
    },
    {
      widen: (bundle, file) => {
        assertProfileBundle(bundle, profile, file);
        return widenToStore(bundle, profile);
      },
      plan: { defaultWiring: profile === null },
    },
  );
}

async function runScopedSettings(
  args: SettingsArgs,
  deps: SettingsDeps,
  build: BundleBuilder,
  scope: BundleScope,
): Promise<void> {
  const action = parseSettingsAction(args);
  if (action.kind === "export") {
    if (action.dryRun) {
      await runDryRun(() =>
        Promise.resolve(runExport(action.target, action.withCredentials, build))
      );
    } else {
      runExport(action.target, action.withCredentials, build);
    }
    return;
  }
  await runImport(action, deps, scope);
}

// --- one profile's bundle ------------------------------------------------------------------------

/** A shared profile default (scope "profile-default") lives in the global map beside the machine's
 *  own keys; the default profile's bundle carries the former and never the latter. */
function isSharedDefaultKey(key: string): boolean {
  return configKeyDef(key)?.scope === "profile-default";
}

function pickGlobal(
  global: GlobalConfigData,
  keep: (key: string) => boolean,
): GlobalConfigData {
  return Object.fromEntries(
    Object.entries(global).filter(([key]) => keep(key)),
  ) as GlobalConfigData;
}

function pickSection<T>(sections: Record<string, T>, key: string): Record<string, T> {
  return key in sections ? { [key]: sections[key] as T } : {};
}

/** The whole store's bundle narrowed to one profile. Exported for its tests. */
export function profileBundle(whole: SettingsBundle, profile: Profile): SettingsBundle {
  const section = pickSection(whole.config.profiles, profileSettingsKey(profile));
  if (profile === null) {
    return {
      formatVersion: whole.formatVersion,
      config: { global: pickGlobal(whole.config.global, isSharedDefaultKey), profiles: section },
      credential: whole.credential,
      profiles: {},
      modes: whole.modes,
    };
  }
  return {
    formatVersion: whole.formatVersion,
    config: { global: {}, profiles: section },
    credential: { githubToken: null, authProvider: null, ghUser: null },
    profiles: pickSection(whole.profiles, profile),
    modes: { codex: "none", claude: "none" },
  };
}

/** A profile's import takes a bundle of that profile alone: anything else in it would land on
 *  another profile or the machine, which is `agent settings --import`'s scope. */
function assertProfileBundle(bundle: SettingsBundle, profile: Profile, file: string): void {
  const key = profileSettingsKey(profile);
  const stray: string[] = [];
  const foreignSections = Object.keys(bundle.config.profiles).filter((k) => k !== key);
  if (foreignSections.length > 0) stray.push(`preferences of ${foreignSections.join(", ")}`);
  const foreignGlobal = Object.keys(bundle.config.global).filter((k) =>
    profile !== null || !isSharedDefaultKey(k)
  );
  if (foreignGlobal.length > 0) stray.push(`machine preferences (${foreignGlobal.join(", ")})`);
  const foreignSlots = Object.keys(bundle.profiles).filter((k) => k !== profile);
  if (foreignSlots.length > 0) stray.push(`the profiles ${foreignSlots.join(", ")}`);
  if (profile !== null) {
    const { githubToken, authProvider, ghUser } = bundle.credential;
    if (githubToken !== null || authProvider !== null || ghUser !== null) {
      stray.push("the default credential");
    }
    if (bundle.modes.codex !== "none" || bundle.modes.claude !== "none") {
      stray.push("the default wiring modes");
    }
  }
  if (stray.length > 0) {
    throw new Error(
      `${file} is not a bundle of ${profileLabel(profile)} alone: it carries ${
        stray.join("; ")
      }. The whole store imports with \`agent settings --import\`; one profile's bundle comes from ` +
        "`agent profile [<name>] settings --export`.",
    );
  }
  // Every genuine named-profile export carries the profile's slot under `profiles` (its `add`
  // records a mode before anything else). Without it (a fresh machine's empty whole-store export,
  // read as a profile's) the import would clear the profile's preferences and land no slot. The
  // default's bundle has no such slot: before its first credential it is preferences alone.
  if (profile !== null && !Object.hasOwn(bundle.profiles, profile)) {
    throw new Error(
      `${file} carries no slot for ${profileLabel(profile)}: not one profile's bundle. One comes ` +
        `from \`agent profile ${profile} settings --export\`.`,
    );
  }
}

/** The profile's bundle as a store-shaped document over the CURRENT store, so the one import
 *  (preferences full-replace, credentials preserve-if-absent) changes this profile's parts alone:
 *  every other section and the machine's keys are the store's own values, and no other slot
 *  travels. */
function widenToStore(bundle: SettingsBundle, profile: Profile): SettingsBundle {
  const current = new CopilotEnvConfig().read();
  const key = profileSettingsKey(profile);
  const profiles = { ...current.profiles };
  delete profiles[key];
  Object.assign(profiles, pickSection(bundle.config.profiles, key));
  const global = profile === null
    ? { ...pickGlobal(current.global, (k) => !isSharedDefaultKey(k)), ...bundle.config.global }
    : current.global;
  return { ...bundle, config: { global, profiles } };
}
