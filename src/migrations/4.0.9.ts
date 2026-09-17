// Away from 4.0.9: Codex (>= 0.134, the profile-v2 layout) reads a named profile from
// `<name>.config.toml` and refuses the old shape at startup, so every `cx --profile <name>` on a
// 4.0.9 install fails before it reaches our provider:
//
//   `[profiles.<name>]` table    -> `codex --profile <name>` refuses to start
//   top-level `profile = "..."`  -> every launch refuses to start
//
// The fix-up moves each table copilot-env wrote (its model_provider is our `copilot-env-<name>`)
// into the profile file and drops it from config.toml. Foreign tables and the `profile` key are
// the user's: left in place, reported with the Codex error they cause.
import { consola } from "consola";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexProviderId } from "../codex/config.ts";
import { knownCodexHomes } from "../codex/host.ts";
import {
  CODEX_PROFILE_TABLES_LAST_VERSION,
  codexConfigPath,
  codexProfileConfigPath,
} from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { CopilotApiConfig, ensureDict, JSON_PARSE_DIAGNOSTIC } from "../copilot_api/config.ts";
import { AUTOUPDATE_FILENAME, autoupdateDir } from "../autoupdate/paths.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import {
  CODEX_IDENTITY_NAME,
  type ConfigKey,
  configScope,
  CopilotEnvConfig,
  GLOBAL_SETTING_KEYS,
  PROFILE_SETTING_KEYS,
  PROFILE_SETTINGS_DEFAULT_KEY,
} from "../copilot_api/env_config.ts";
import { GLOBAL_STATE_KEYS, PROFILE_STATE_KEYS } from "../copilot_api/env_state.ts";
import {
  DEFAULT_PROFILE_DIR,
  LOCKS_DIR_NAME,
  LOGS_DIR_NAME,
  PROFILES_DIR_NAME,
  PROJECTIONS_FILENAME,
  PROXY_CONFIG_FILENAME,
  resolveRootHome,
  ROOT_HOME_ENV,
  RUN_DIR_NAME,
  RUN_STATE_FILENAME,
  STATE_STORE_FILENAME,
} from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { rootStateStore } from "../copilot_api/state_store.ts";
import {
  isValidProfileName,
  parseProfileName,
  type Profile,
  profileLabel,
} from "../copilot_api/profile.ts";
import { shellTargetFiles } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, readTextResult } from "../utils/fs.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { writeFileReported } from "../utils/report_write.ts";
import { FENCE_LINES, LAUNCHERS_MARKER, LAUNCHERS_MARKER_END } from "./4.0.0.ts";
import type { Migration } from "./index.ts";

/** A parsed TOML table is a plain object; smol-toml's date-time scalar is a class instance with no
 *  enumerable keys, so recursing into it would spread it to an empty table. */
function isTable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Key-wise, recursing into tables, `over`'s leaves winning: a table's `features.multi_agent`
 *  survives a file that only sets `features.shell_tool`, as Codex itself layers the two. */
function layer(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = out[key];
    out[key] = isTable(under) && isTable(value) ? layer(under, value) : value;
  }
  return out;
}

/** One home's config.toml: ours move, the rest is reported. Every table is visited before the
 *  file is saved, and an owned table whose profile file exists but cannot be parsed stays put and
 *  FAILS the step after the others moved (the runner then names the re-run), since no wiring
 *  command removes a legacy table. Exported for the migration test. */
export function moveCodexProfileTables(codexHome: string): void {
  const configPath = codexConfigPath(codexHome);
  const read = readCodexToml(configPath);
  if (read.kind === "absent") return;
  if (read.kind === "unparseable") {
    throw new Error(`${configPath} is not valid TOML (${read.error})`);
  }
  const doc = read.doc;
  if (doc.profile !== undefined) {
    consola.warn(
      `  ${configPath} carries a top-level \`profile = ${JSON.stringify(doc.profile)}\` that ` +
        'copilot-env never wrote; Codex refuses every launch on it ("legacy `profile` config is ' +
        'no longer supported"). Delete the line and use `codex --profile <name>` instead.',
    );
  }
  const profiles = isRecord(doc.profiles) ? doc.profiles : null;
  if (profiles === null) return;
  let changed = false;
  const stuck: string[] = [];
  for (const [name, table] of Object.entries(profiles)) {
    const ours = isValidProfileName(name) && isRecord(table) &&
      table.model_provider === codexProviderId(parseProfileName(name));
    if (!ours) {
      // The name may be one copilot-env would never mint, so the file is spelled without the brand.
      consola.warn(
        `  [profiles.${name}] in ${configPath} is not copilot-env's; \`codex --profile ${name}\` ` +
          `refuses to start until its keys move to ${join(codexHome, `${name}.config.toml`)} ` +
          "and the table is deleted.",
      );
      continue;
    }
    const profilePath = codexProfileConfigPath(codexHome, parseProfileName(name));
    const existing = readCodexToml(profilePath);
    if (existing.kind === "unparseable") {
      consola.warn(
        `  left [profiles.${name}] in ${configPath}: ${profilePath} is not valid TOML ` +
          `(${existing.error}); repair it, then re-run this migration`,
      );
      stuck.push(profilePath);
      continue;
    }
    // The file's own keys are what `codex --profile <name>` reads today, so they win over the
    // table's; the selector is ours either way.
    saveCodexToml(
      profilePath,
      {
        ...layer(table, existing.kind === "ok" ? existing.doc : {}),
        "model_provider": codexProviderId(parseProfileName(name)),
      },
      `moved from [profiles.${name}] in config.toml`,
    );
    delete profiles[name];
    changed = true;
  }
  if (changed) {
    if (Object.keys(profiles).length === 0) delete doc.profiles;
    saveCodexToml(configPath, doc, "legacy [profiles.<name>] tables moved to <name>.config.toml");
  }
  if (stuck.length > 0) {
    throw new Error(`profile file(s) not valid TOML: ${stuck.join(", ")}`);
  }
}

/** Every known Codex home; one home's failure is reported and the rest still run. */
export function moveCodexProfileTablesEverywhere(): void {
  const { homes, complete } = knownCodexHomes();
  if (!complete) {
    consola.warn(
      "  could not enumerate every ~/.codex/hosts home; a config there may keep a [profiles.<name>] table.",
    );
  }
  const failed: string[] = [];
  for (const home of homes) {
    try {
      moveCodexProfileTables(home);
    } catch (e) {
      consola.warn(`  could not convert ${codexConfigPath(home)}: ${errMessage(e)}`);
      failed.push(codexConfigPath(home));
    }
  }
  if (failed.length > 0) {
    throw new Error(`could not convert: ${failed.join(", ")}`);
  }
}

export const v409CodexProfileFiles: Migration = {
  version: CODEX_PROFILE_TABLES_LAST_VERSION,
  description: "move Codex named profiles from [profiles.<name>] to <name>.config.toml",
  run: moveCodexProfileTablesEverywhere,
};

// --- the preference store's shape: scoped, grouped keys -----------------------------------
//
// Away from 4.0.9: the preference store was one flat map of camelCase keys. It is now a `global` map
// of dotted, grouped keys plus a `profiles` section (one map per profile), and the four keys that
// follow the credential (identity, host, passthrough, static-key) live only in a profile's
// section. A reader knows only the new shape, so this is the one place the old names exist.

/** Old stored key, its old CLI spelling, new key. Every old key moves; the profile keys land in the
 *  profile sections. Exported so test/config_key_lint.test.ts can refuse the old spellings anywhere
 *  outside this directory, the one place they legitimately live. */
export const PREFERENCE_RENAMES: ReadonlyArray<readonly [string, string, ConfigKey]> = [
  ["alphaSearchCodexPriority", "alpha-search-codex-priority", "proxy.alpha-search.codex-priority"],
  ["alphaSearchModel", "alpha-search-model", "proxy.alpha-search.model"],
  ["autoStart", "auto-start", "daemon.auto-start"],
  ["autoUpdate", "auto-update", "update.auto"],
  ["claudeAutoModel", "claude-auto-model", "proxy.claude-auto-model"],
  ["claudeDesktop", "claude-desktop", "claude.desktop"],
  ["claudeTokenMultiplier", "claude-token-multiplier", "proxy.claude-token-multiplier"],
  ["codexHome", "codex-home", "codex.home"],
  ["codexHost", "codex-host", "codex.host"],
  ["codexModelCatalog", "codex-model-catalog", "codex.model-catalog"],
  ["copilotHost", "copilot-host", "host"],
  ["creditsTarget", "credits-target", "cost.credits-target"],
  ["idleTimeout", "idle-timeout", "daemon.idle-timeout"],
  ["integrationId", "integration-id", "identity"],
  ["launchers", "launchers", "shell.launchers"],
  ["maxPort", "max-port", "daemon.max-port"],
  ["messageApiWebSearchModel", "message-websearch-model", "proxy.message-websearch-model"],
  ["minPort", "min-port", "daemon.min-port"],
  ["passthrough", "passthrough", "passthrough"],
  ["port", "port", "daemon.port"],
  ["pricingUrl", "pricing-url", "cost.pricing-url"],
  ["proxyLogs", "proxy-logs", "daemon.logs"],
  ["proxyVersion", "proxy-version", "daemon.version"],
  ["releaseCooldown", "release-cooldown", "daemon.release-cooldown"],
  ["smallModel", "small-model", "proxy.small-model"],
  ["staticKey", "static-key", "static-key"],
  ["strictPort", "strict-port", "daemon.strict-port"],
  ["updateCooldown", "update-cooldown", "update.cooldown"],
  ["useMessagesApi", "messages-api", "proxy.messages-api"],
  [
    "useResponsesApiContextManagement",
    "responses-context-management",
    "proxy.responses.context-management",
  ],
  ["useResponsesApiWebSearch", "responses-websearch", "proxy.responses.websearch"],
  ["useResponsesApiWebSocket", "responses-websocket", "proxy.responses.websocket"],
  ["verifyProvenance", "verify-provenance", "update.verify-provenance"],
  ["wireMcp", "wire-mcp", "claude.wire-mcp"],
];

/** Pure over the raw preferences document; the fold applies it as preferences.json folds, so a
 *  store still flat at 4.0.9 lands grouped in one pass. Values move verbatim (the other 4.0.9 steps
 *  still judge them at their new place); an old key whose new key already holds a value is dropped,
 *  since the new one is what readers use. A profile key was read by EVERY profile before, so it
 *  lands in the default's section and in each named profile's (`namedProfiles`, the credential
 *  slots'), a section's own value winning. Idempotent: a document without old keys is returned
 *  unchanged. */
export function regroupPreferences(
  doc: Record<string, unknown>,
  namedProfiles: readonly string[],
): Record<string, unknown> {
  const out = structuredClone(doc);
  let moved = false;
  for (const [oldKey, , key] of PREFERENCE_RENAMES) {
    if (!Object.hasOwn(out, oldKey)) continue;
    const value = out[oldKey];
    delete out[oldKey];
    moved = true;
    const targets = configScope(key) === "profile"
      ? [PROFILE_SETTINGS_DEFAULT_KEY, ...namedProfiles].map((name) =>
        ensureDict(ensureDict(out, "profiles"), name)
      )
      : [ensureDict(out, "global")];
    for (const map of targets) {
      if (!Object.hasOwn(map, key)) map[key] = value;
    }
  }
  return moved ? out : doc;
}

/** Every profile's RAW section (the default's and each named one's), since the typed reader already
 *  folds an invalid value to unset. The regrouping wrote the same value into all of them, so a
 *  fix-up that judged the default alone would leave the named profiles on the unfixed value. */
function rawProfileSections(): Array<[Profile, Record<string, unknown>]> {
  const profiles = rootStateStore().loadStrict().profiles;
  if (!isRecord(profiles)) return [];
  const out: Array<[Profile, Record<string, unknown>]> = [];
  for (const [name, section] of Object.entries(profiles)) {
    if (!isRecord(section)) continue;
    if (name === PROFILE_SETTINGS_DEFAULT_KEY) out.push([null, section]);
    else if (isValidProfileName(name)) out.push([parseProfileName(name), section]);
  }
  return out;
}

// --- the `codex` identity pin --------------------------------------------------------------
//
// Away from 4.0.9: `agent config --set integration-id codex` was accepted (the domain was a bare
// regex). The domain now refuses it (Direct's default identity sends no header, so nothing can pin
// it) and the reader folds the stored value to unset, but the key stays in the settings and
// the agent configs may still bake `Copilot-Integration-Id: codex` until the next rewire. Runs
// after the regrouping, so the pin is judged at its new place, each profile section's `identity`.

/** Only the key goes; the agent configs are the wiring pass's to rebake. Exported for the migration test. */
export function dropCodexIdentityPin(): void {
  for (const [profile, section] of rawProfileSections()) {
    const stored = section.identity;
    if (typeof stored !== "string" || stored.trim().toLowerCase() !== CODEX_IDENTITY_NAME) continue;
    new CopilotEnvConfig().delProfile(profile, "identity");
    consola.info(
      `  dropped ${
        profileLabel(profile)
      }'s identity pin \`${stored}\` (Direct's default identity ` +
        "cannot be pinned; the identity now reads as auto, and Direct wiring rebakes at the next " +
        "`agent init` / `agent profile --add`)",
    );
  }
}

export const v409IntegrationIdPin: Migration = {
  version: "4.0.9",
  description: "drop a stored identity pin of `codex` (Direct's default, no longer pinnable)",
  run: dropCodexIdentityPin,
};

// --- the `static-key` boolean --------------------------------------------------------------
//
// Away from 4.0.9: `static-key` was a boolean (bake the value into both agent configs, or into
// neither). It is now the scope `none | claude | codex | all`, and a stored boolean fails that
// domain and reads as `none`: an install that baked both would go back to the resolver command at
// its next wiring without being told. Judged at the key's new place, each profile section.

/** `true` becomes `all` (what the boolean baked); `false` was the default and goes. Exported for
 *  the migration test. */
export function scopeStaticKeyBoolean(): void {
  for (const [profile, section] of rawProfileSections()) {
    const stored = section["static-key"];
    if (typeof stored !== "boolean") continue;
    const config = new CopilotEnvConfig();
    if (stored) {
      config.setProfile(profile, { "static-key": "all" });
      consola.info(
        `  ${
          profileLabel(profile)
        }: static-key \`true\` is now the scope \`all\` (both agent configs keep the baked value)`,
      );
    } else {
      config.delProfile(profile, "static-key");
      consola.info(
        `  ${
          profileLabel(profile)
        }: dropped static-key \`false\` (the default, now spelled \`none\`)`,
      );
    }
  }
}

export const v409StaticKeyScope: Migration = {
  version: "4.0.9",
  description: "turn the static-key boolean into its scope (`true` -> `all`, `false` -> unset)",
  run: scopeStaticKeyBoolean,
};

// --- the launchers rc block ------------------------------------------------------------------
//
// Away from 4.0.9: `agent shell` stripped the launchers block every pre-4.0.0 release wrote on
// every wire. The strip is a migration now, so an rc still carrying the block loses it once here.

/** A line equals `marker` ignoring a trailing CR (rc/profile files may be CRLF). */
const lineIs = (line: string | undefined, marker: string): boolean =>
  (line ?? "").replace(/\r$/, "") === marker;

/**
 * Every launchers block, bounded as the shell writer bounded its blocks: the marker through its
 * end fence (any other fence line first means the block was never closed and the marker line
 * alone is owned), plus the blank line before it and the ONE blank after its end fence (never the
 * file terminator). `leftBehind` is the user line directly under an unclosed marker, for the
 * caller to warn about. Exported for the migration test.
 */
export function stripLaunchersBlocks(
  content: string,
): { content: string; leftBehind: string[] } {
  const lines = content.split("\n");
  const skip = new Set<number>();
  const leftBehind: string[] = [];
  lines.forEach((line, idx) => {
    if (!lineIs(line, LAUNCHERS_MARKER)) return;
    let end = idx;
    for (let j = idx + 1; j < lines.length; j++) {
      const later = (lines[j] ?? "").replace(/\r$/, "");
      if (later === LAUNCHERS_MARKER_END) {
        end = j;
        break;
      }
      if (FENCE_LINES.includes(later)) break;
    }
    if (end === idx) {
      const next = idx + 1 < lines.length ? (lines[idx + 1] ?? "").replace(/\r$/, "") : null;
      if (next !== null && next !== "" && !FENCE_LINES.includes(next)) leftBehind.push(next);
    }
    if (idx > 0 && lineIs(lines[idx - 1], "")) skip.add(idx - 1);
    for (let i = idx; i <= end; i++) skip.add(i);
    const after = end + 1;
    if (
      after < lines.length && lineIs(lines[after], "") &&
      !(after === lines.length - 1 && lines[after] === "")
    ) skip.add(after);
  });
  if (skip.size === 0) return { content, leftBehind };
  return { content: lines.filter((_, idx) => !skip.has(idx)).join("\n"), leftBehind };
}

/** Every rc/profile file; a file that cannot be read fails the step after the others ran. */
export function stripLaunchersRcBlocks(): void {
  const failed: string[] = [];
  for (const file of shellTargetFiles()) {
    try {
      const read = readTextResult(file);
      if (read.kind === "absent") continue;
      if (read.kind === "unreadable") throw new Error(read.error);
      const stripped = stripLaunchersBlocks(read.text);
      for (const line of stripped.leftBehind) {
        consola.warn(
          `Unrecognized line under a copilot-env marker in ${file} -- ` +
            `not written by copilot-env, so it (and everything after it) was left in place: ${line}`,
        );
      }
      if (stripped.content === read.text) continue;
      writeFileReported(file, stripped.content, { detail: "copilot-env launchers block removed" });
    } catch (e) {
      consola.warn(`  could not strip ${file}: ${errMessage(e)}`);
      failed.push(file);
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} file(s) were not converted: ${failed.join(", ")}`);
  }
}

export const v409LaunchersBlock: Migration = {
  version: "4.0.9",
  description: "remove the launchers rc block (the launchers are `agent env` emissions)",
  run: stripLaunchersRcBlocks,
};

// --- the per-profile identity and host cache ---------------------------------------------------
//
// Away from 4.0.9: a Direct profile slot cached its probed identity and host beside two validity
// keys (`integrationIdentity`, `copilotHost`, `copilotHostIdentity`, `copilotHostSource`) and a
// replay checked the validity keys before trusting the pair. The pair is now state the probing
// wiring writes and every re-render reads as-is, and the cache is not promoted into it (no compat):
// all four go from a slot in the old shape, and the first Direct rewire of the slot probes once
// through the no-pair gap. Store writes preserve unknown keys, so the four would otherwise ride
// along forever. The two validity keys are the old shape's marker: a slot without them is already
// in the new shape (the pair the new wiring stored), so a re-run leaves it alone.

const SLOT_CACHE_KEYS = [
  "integrationIdentity",
  "copilotHost",
  "copilotHostIdentity",
  "copilotHostSource",
] as const;
const OLD_SHAPE_KEYS = ["copilotHostIdentity", "copilotHostSource"] as const;

function inOldShape(slot: unknown): slot is Record<string, unknown> {
  return isRecord(slot) && OLD_SHAPE_KEYS.some((key) => key in slot);
}

/** Exported for the migration test. Silent when no slot is in the old shape. */
export function dropSlotIdentityCache(): void {
  const store = rootStateStore();
  const profiles = store.loadStrict().profiles;
  const carrying = isRecord(profiles) ? Object.values(profiles).filter(inOldShape).length : 0;
  if (carrying === 0) return;
  store.update((d) => {
    const slots = isRecord(d.profiles) ? d.profiles : {};
    for (const slot of Object.values(slots)) {
      if (!inOldShape(slot)) continue;
      for (const key of SLOT_CACHE_KEYS) delete slot[key];
    }
  });
  consola.info(
    `  dropped the cached Direct identity and host from ${carrying} profile slot(s); the next ` +
      "Direct rewire of each renders from its identity pin and host literal, and probes once for " +
      "a half neither covers, storing what it finds",
  );
}

export const v409IdentityCache: Migration = {
  version: "4.0.9",
  description: "drop the cached Direct identity and host from the profile slots",
  run: dropSlotIdentityCache,
};

// --- one store: state.json ---------------------------------------------------------------
//
// Away from 4.0.9: the root home held three account-wide stores (credentials.json, preferences.json,
// ownership.json), each with its own lock under `locks/`. They are now ONE `state.json` under ONE
// lock (src/copilot_api/state_store.ts): preferences.json's `global` map and credentials.json's
// non-profile keys become `global`; each profile's settings section and its credential slot become
// one `profiles.<name>`; ownership.json becomes `ownership`. A preferences.json still flat (pre-4.0.9
// keys) is regrouped as it folds (regroupPreferences), so the fold is the one step that reads it.
// This is a `layout` step, ahead of every other 4.0.9 step, which read the merged maps.
// The same pass removes what nothing reads any more, naming each file: the three stores' lock
// sidecars, the copilot-api login artifact under `opencode/` (a host selector the proxy no longer
// runs under) and its then-empty directory, the catalog backup a past sync left, and the root
// `github_token` with its login lock (the device flow stores its token in state.json now).

const FOLDED_STORES = ["credentials.json", "preferences.json", "ownership.json"] as const;
type FoldedStore = (typeof FOLDED_STORES)[number];

/** Lock sidecars of the three folded stores, under `locks/`. */
const FOLDED_LOCKS: readonly string[] = [
  "credentials.json.lock",
  "preferences.json.lock",
  "ownership.json.lock",
  "ownership.json.ops.lock",
].flatMap((name) => [name, `${name}.oslock`]);

/** Root-home debris nothing reads, relative to the root home. */
const ROOT_DEBRIS: readonly string[] = [
  join("opencode", "github_token"),
  "codex-model-catalog.json.bak",
  "github_token",
  join(LOCKS_DIR_NAME, "github_token.login.lock"),
  join(LOCKS_DIR_NAME, "github_token.login.lock.oslock"),
];

function mapHasKey(map: unknown, keys: readonly string[]): boolean {
  return isRecord(map) && keys.some((key) => Object.hasOwn(map, key));
}

function anyProfileHasKey(doc: Record<string, unknown>, keys: readonly string[]): boolean {
  return isRecord(doc.profiles) &&
    Object.values(doc.profiles).some((slot) => mapHasKey(slot, keys));
}

/** Whether `doc` (state.json) already holds what `store` would fold into it: the store's own
 *  keys, wherever they land. An old file beside a store already folded is the half-migrated
 *  shape (a crash between the write and the delete): kept as is and named, never folded twice. */
function alreadyFolded(doc: Record<string, unknown>, store: FoldedStore): boolean {
  switch (store) {
    case "credentials.json":
      return mapHasKey(doc.global, GLOBAL_STATE_KEYS) || anyProfileHasKey(doc, PROFILE_STATE_KEYS);
    case "preferences.json":
      return mapHasKey(doc.global, GLOBAL_SETTING_KEYS) ||
        anyProfileHasKey(doc, PROFILE_SETTING_KEYS);
    case "ownership.json":
      return Object.hasOwn(doc, "ownership");
  }
}

function namedProfilesOf(doc: Record<string, unknown>): string[] {
  return isRecord(doc.profiles)
    ? Object.keys(doc.profiles).filter((name) =>
      name !== PROFILE_SETTINGS_DEFAULT_KEY && isValidProfileName(name)
    )
    : [];
}

/** Whether a preferences.json document is still the pre-4.0.9 flat shape: regroupPreferences moves
 *  a key. Pure (it returns the same document when nothing moves). */
function isFlatPreferences(doc: Record<string, unknown>): boolean {
  return regroupPreferences(doc, []) !== doc;
}

/** One old store's document merged into state.json's maps. A slot's key and a settings key never
 *  share a spelling; were one to, the later fold (preferences.json, after credentials.json) wins.
 *  A flat preferences.json copies its profile keys into EVERY profile: the union of the profiles
 *  state.json already holds (the credential slots, folded first) and the sections the preferences
 *  document carries itself, so no section preferences.json holds is dropped whatever the slots say. */
function foldInto(
  d: Record<string, unknown>,
  store: FoldedStore,
  doc: Record<string, unknown>,
): void {
  if (store === "ownership.json") {
    d.ownership = doc;
    return;
  }
  const grouped = store === "preferences.json"
    ? regroupPreferences(doc, [...new Set([...namedProfilesOf(d), ...namedProfilesOf(doc)])])
    : doc;
  const { profiles, global, ...rest } = grouped;
  const globalMap = ensureDict(d, "global");
  Object.assign(globalMap, rest, isRecord(global) ? global : {});
  if (Object.keys(globalMap).length === 0) delete d.global;
  if (isRecord(profiles)) {
    const profilesMap = ensureDict(d, "profiles");
    for (const [name, section] of Object.entries(profiles)) {
      if (isRecord(section)) Object.assign(ensureDict(profilesMap, name), section);
    }
  }
}

/** Exported for the migration test; `rootHome` isolates. Idempotent: a
 *  home already folded (no old store present) writes nothing. A store that is not a JSON object is
 *  left in place and named: the fold never discards content it cannot carry over. */
export function foldRootStores(rootHome: string = resolveRootHome()): void {
  const stateFile = join(rootHome, STATE_STORE_FILENAME);
  const store = new CopilotApiConfig(
    stateFile,
    join(rootHome, LOCKS_DIR_NAME, `${STATE_STORE_FILENAME}.lock`),
  );
  const docs = new Map<FoldedStore, Record<string, unknown>>();
  for (const name of FOLDED_STORES) {
    const oldPath = join(rootHome, name);
    if (!existsSync(oldPath)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(oldPath, "utf8"));
    } catch {
      // The parser's message can quote the file's text (a token); the store's fixed diagnostic instead.
      consola.warn(
        `  ${oldPath} is not valid JSON (${JSON_PARSE_DIAGNOSTIC}); left in place, not folded`,
      );
      continue;
    }
    if (!isRecord(doc)) {
      consola.warn(`  ${oldPath} is not a JSON object; left in place, not folded`);
      continue;
    }
    docs.set(name, doc);
  }
  // A flat preferences.json copies its profile keys into every profile credentials.json names, so
  // it is folded only once credentials.json has been read (or never existed): a source is never
  // deleted while a source it depends on failed validation.
  const credentialsUnread = existsSync(join(rootHome, "credentials.json")) &&
    !docs.has("credentials.json");
  const prefs = docs.get("preferences.json");
  const held = prefs !== undefined && credentialsUnread && isFlatPreferences(prefs);
  if (held) docs.delete("preferences.json");
  if (docs.size > 0) {
    const kept: FoldedStore[] = [];
    store.update((d) => {
      // Judged on the document as it stood BEFORE this pass, so the credentials fold (which lands
      // catalog keys in `global`) cannot make the preferences fold read as done.
      const before = structuredClone(d);
      for (const [name, doc] of docs) {
        if (alreadyFolded(before, name)) kept.push(name);
        else foldInto(d, name, doc);
      }
    });
    for (const name of docs.keys()) {
      const oldPath = join(rootHome, name);
      if (kept.includes(name)) {
        consola.warn(
          `  both ${oldPath} and its keys in ${stateFile} exist - keeping ${stateFile} (the one ` +
            `readers use); delete ${name} by hand after checking it holds nothing newer`,
        );
        continue;
      }
      rmSync(oldPath, { force: true });
      consola.info(`  folded ${name} into ${stateFile}`);
    }
  }
  if (held) {
    consola.warn(
      `  ${join(rootHome, "preferences.json")} kept: its profile keys copy into every profile ` +
        `credentials.json names, and credentials.json could not be read; fix credentials.json, ` +
        "then re-run the migration",
    );
  }
  for (const name of FOLDED_LOCKS) {
    const path = join(rootHome, LOCKS_DIR_NAME, name);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    consola.info(`  removed ${path} (the store's one lock is ${STATE_STORE_FILENAME}.lock)`);
  }
  for (const rel of ROOT_DEBRIS) {
    const path = join(rootHome, rel);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    consola.info(`  removed ${path} (nothing reads it)`);
  }
  const opencodeDir = join(rootHome, "opencode");
  if (existsSync(opencodeDir) && readdirSync(opencodeDir).length === 0) {
    rmSync(opencodeDir, { recursive: true });
    consola.info(`  removed ${opencodeDir} (empty)`);
  }
}

/** The autoupdate throttle file takes the name of what it holds; "state.json" is the account-wide
 *  store's. Exported for the migration test; `autoupdateHome` isolates. */
export function renameAutoupdateThrottle(autoupdateHome: string = autoupdateDir()): void {
  const oldAutoupdate = join(autoupdateHome, "state.json");
  const newAutoupdate = join(autoupdateHome, AUTOUPDATE_FILENAME);
  if (!existsSync(oldAutoupdate)) return;
  if (!existsSync(newAutoupdate)) {
    renameSync(oldAutoupdate, newAutoupdate);
    consola.info(`  moved ${oldAutoupdate} -> ${newAutoupdate}`);
    return;
  }
  // Both present: the OLD process of a self-update writes its final throttle at ITS path after the
  // new binary ran this step, so the old file and its lock sidecar reappear beside the new one. The
  // re-run removes them; the new file (what the readers use) keeps its content.
  for (const path of [oldAutoupdate, `${oldAutoupdate}.lock`, `${oldAutoupdate}.lock.oslock`]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    consola.info(`  removed ${path} (superseded by ${newAutoupdate})`);
  }
}

export const v409StateFold: Migration = {
  version: "4.0.9",
  layout: true,
  description:
    "fold credentials.json, preferences.json, and ownership.json into state.json (one store, one lock)",
  run: () => {
    foldRootStores();
    renameAutoupdateThrottle();
  },
};

// --- the default daemon's home ----------------------------------------------------------

/** The daemon files the pre-5.0.0 reader accepted AT the root as the default daemon's home, frozen
 *  here: a device-flow login with COPILOT_API_HOME pinned left the proxy's config.json there, and
 *  the first `agent start` followed it. Any one of them makes the root a daemon home to move (the
 *  login alone leaves config.json and no `.run`); `.run` goes LAST, so a run interrupted mid-way
 *  still finds it at the root and resumes. The usage database lives under `.run/<host>/` and travels
 *  with it; a `copilot-api.sqlite` directly at the root predates 4.0.0 and has no reader. */
const ROOT_DAEMON_ARTIFACTS: readonly string[] = [
  PROXY_CONFIG_FILENAME,
  PROJECTIONS_FILENAME,
  LOGS_DIR_NAME,
  RUN_DIR_NAME,
];

/** The `.run/<host>/.state.json` files that may belong to a live daemon: another host's recording a
 *  pid (it means nothing on this host, so nothing here can stop it), or any host's that cannot be
 *  read or parsed. Fail closed: a state this host cannot judge is never "no daemon". This host's
 *  own readable record is stopTrackedProxy's to judge. */
function occupiedRunStates(runDir: string, thisHost: string): string[] {
  let hosts: string[];
  try {
    hosts = readdirSync(runDir);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
  const occupied: string[] = [];
  for (const host of hosts) {
    const file = join(runDir, host, RUN_STATE_FILENAME);
    const read = readTextResult(file);
    if (read.kind === "absent") continue;
    if (read.kind === "text") {
      const doc = parseJsonRecord(read.text);
      if (doc !== null && (host === thisHost || typeof doc.pid !== "number")) continue;
    }
    occupied.push(file);
  }
  return occupied;
}

/** Exported for the migration test; `stopDaemon` is the seam (the real one stops the daemon tracked
 *  under the root on this host) and `thisHost` the sanitized hostname. A refused stop, or a run
 *  state that may be another daemon's (occupiedRunStates), throws before any move, so the files
 *  never leave a running daemon. A file whose `profiles/default` counterpart already exists is kept
 *  at the root and named, never merged. */
export async function moveRootDaemonHome(
  root: string,
  stopDaemon: () => Promise<void>,
  thisHost: string = getSanitizedHostname(),
): Promise<void> {
  const present = ROOT_DAEMON_ARTIFACTS.filter((name) => existsSync(join(root, name)));
  if (present.length === 0) return;
  const occupied = occupiedRunStates(join(root, RUN_DIR_NAME), thisHost);
  if (occupied.length > 0) {
    throw new Error(
      `a daemon may still run at ${root}: ${occupied.join(", ")} ` +
        `(a pid recorded by another machine, or a file this one cannot read). Run \`agent stop\` ` +
        "there, or remove that .run/<host> dir if the machine is gone, then re-run",
    );
  }
  await stopDaemon();
  // Re-listed after the stop: stopping touches the run state under the root, so a `.run` it left
  // behind travels too.
  const moving = ROOT_DAEMON_ARTIFACTS.filter((name) => existsSync(join(root, name)));
  const target = join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR);
  mkdirSync(target, { recursive: true });
  for (const name of moving) {
    const from = join(root, name);
    const to = join(target, name);
    if (existsSync(to)) {
      consola.warn(
        `  both ${from} and ${to} exist - keeping ${to} (the one readers use); delete ${from} by ` +
          "hand after checking it holds nothing newer",
      );
      continue;
    }
    renameSync(from, to);
    consola.info(`  moved ${from} -> ${to}`);
  }
}

/** The paths layer resolves the default home through the CURRENT rule (profiles/default), so the
 *  root daemon is reached the way a daemon reaches its own home: with both env pins aimed at the
 *  root for the duration of the stop. Restored whatever happens. */
async function stopRootDaemon(root: string): Promise<void> {
  const saved = { home: process.env.COPILOT_API_HOME, rootHome: process.env[ROOT_HOME_ENV] };
  process.env.COPILOT_API_HOME = root;
  process.env[ROOT_HOME_ENV] = root;
  try {
    const result = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, null);
    if (!result.stopped) {
      throw new Error(`the daemon (pid ${result.trackedPid}) running at ${root} would not stop`);
    }
    // A migration never starts a daemon (that is the launch pipeline's), so a live one stays down
    // until the next `agent start`; said here because an autoupdate inside `agent start` reaches
    // this step right after that start spawned it.
    if (result.signalled) {
      consola.warn(
        `  the default daemon at ${root} was stopped for the move; the next \`agent start\` (or a ` +
          "launcher) starts it under profiles/default",
      );
    }
  } finally {
    if (saved.home === undefined) delete process.env.COPILOT_API_HOME;
    else process.env.COPILOT_API_HOME = saved.home;
    if (saved.rootHome === undefined) delete process.env[ROOT_HOME_ENV];
    else process.env[ROOT_HOME_ENV] = saved.rootHome;
  }
}

export const v409RootDaemonHome: Migration = {
  version: "4.0.9",
  layout: true,
  description: "move a default daemon still running at the root home into profiles/default",
  run: () => {
    const root = resolveRootHome();
    return moveRootDaemonHome(root, () => stopRootDaemon(root));
  },
};
