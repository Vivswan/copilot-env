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

import { join } from "node:path";
import { consola } from "consola";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import { runClaude, runCodex } from "../agents/configure_defaults.ts";
import { wireBothAgents } from "../agents/profile_wiring.ts";
import { AUTOUPDATE_FILENAME, autoupdateDir } from "../autoupdate/state.ts";
import {
  directHelperCommand,
  managedHelperShape,
  proxyHelperCommand,
  SETTINGS_SECRETS,
} from "../claude/config.ts";
import { desktopHelperPath, writeDesktopHelperScript } from "../claude/desktop_helper_scripts.ts";
import {
  desktopEntryName,
  META_FILENAME,
  parseDesktopMeta,
  readFileOrNull,
  resolveDesktopLibraryDir,
  saveJsonIfChanged,
  writeDesktopMeta,
} from "../claude/desktop_library.ts";
import {
  entryProfileAt,
  launcherSubcommandArgs,
  mcpServeArgs,
  ownMcpRow,
  retargetEntryProfile,
} from "../claude/desktop_payload.ts";
import { retargetMcpRegistration } from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { knownCodexHomes } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath, codexProviderId } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { CopilotApiConfig, ensureDict, JSON_PARSE_DIAGNOSTIC } from "../copilot_api/config.ts";
import {
  CODEX_IDENTITY_NAME,
  type ConfigKey,
  configScope,
} from "../copilot_api/config_registry.ts";
import {
  CopilotEnvConfig,
  GLOBAL_SETTING_KEYS,
  PROFILE_SETTING_KEYS,
} from "../copilot_api/env_config.ts";
import {
  CopilotEnvState,
  GLOBAL_STATE_KEYS,
  PROFILE_MODES,
  PROFILE_STATE_KEYS,
} from "../copilot_api/env_state.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  DEFAULT_PROFILE_DIR,
  LOCKS_DIR_NAME,
  LOGS_DIR_NAME,
  PROFILES_DIR_NAME,
  PROXY_CONFIG_FILENAME,
  profileHome,
  profileHomeNames,
  RUN_DIR_NAME,
  RUN_STATE_FILENAME,
  resolveRootHome,
  STATE_STORE_FILENAME,
} from "../copilot_api/paths.ts";
import {
  DEFAULT_PROFILE_NAME,
  isReservedProfileWord,
  isValidProfileName,
  type Profile,
  type ProfileName,
  parseProfileName,
  profileLabel,
} from "../copilot_api/profile.ts";
import { rootStateStore } from "../copilot_api/state_store.ts";
import { shellTargetFiles } from "../shell/integration.ts";
import { assertNever } from "../utils/assert.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isRecord, parseJsonRecord, sameStrings } from "../utils/json.ts";
import { caught } from "../utils/message.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  proxyTokenArgs,
  proxyTokenCommand,
} from "../utils/root.ts";
import { isTomlTable } from "../utils/toml.ts";
import { FENCE_LINES, failIfAny, LAUNCHERS_MARKER, LAUNCHERS_MARKER_END } from "./4.0.0.ts";
import type { Migration } from "./index.ts";
import { foreignHolderWarning, stopLockedDaemon } from "./legacy_daemon.ts";

/** Key-wise, recursing into tables, `over`'s leaves winning: a table's `features.multi_agent`
 *  survives a file that only sets `features.shell_tool`, as Codex itself layers the two. */
function layer(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = out[key];
    out[key] = isTomlTable(under) && isTomlTable(value) ? layer(under, value) : value;
  }
  return out;
}

/** A `[profiles.<name>]` table copilot-env wrote: a valid profile name whose model_provider is
 *  our id for it. */
function ownsProfileTable(name: string, table: unknown): table is Record<string, unknown> {
  return (
    isValidProfileName(name) &&
    isRecord(table) &&
    table.model_provider === codexProviderId(parseProfileName(name))
  );
}

/** The table's keys into the profile file, under our selector. False when the file exists but
 *  cannot be parsed: the table stays put, and the caller reports it. */
function moveCodexProfileTable(
  configPath: string,
  profilePath: string,
  profile: ProfileName,
  table: Record<string, unknown>,
): boolean {
  const existing = readCodexToml(profilePath);
  if (existing.kind === "unparseable") {
    consola.warn(
      `  left [profiles.${profile}] in ${configPath}: ${profilePath} is not valid TOML ` +
        `(${existing.error}); repair it, then re-run this migration`,
    );
    return false;
  }
  // The file's own keys are what `codex --profile <name>` reads today, so they win over the
  // table's; the selector is ours either way.
  saveCodexToml(
    profilePath,
    {
      ...layer(table, existing.kind === "ok" ? existing.doc : {}),
      model_provider: codexProviderId(profile),
    },
    `moved from [profiles.${profile}] in config.toml`,
  );
  return true;
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
    if (!ownsProfileTable(name, table)) {
      // The name may be one copilot-env would never mint, so the file is spelled without the brand.
      consola.warn(
        `  [profiles.${name}] in ${configPath} is not copilot-env's; \`codex --profile ${name}\` ` +
          `refuses to start until its keys move to ${join(codexHome, `${name}.config.toml`)} ` +
          "and the table is deleted.",
      );
      continue;
    }
    const profile = parseProfileName(name);
    const profilePath = codexProfileConfigPath(codexHome, profile);
    if (!moveCodexProfileTable(configPath, profilePath, profile, table)) {
      stuck.push(profilePath);
      continue;
    }
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
function moveCodexProfileTablesEverywhere(): void {
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
      consola.warn(
        caught(e, (message) => `  could not convert ${codexConfigPath(home)}: ${message}`),
      );
      failed.push(codexConfigPath(home));
    }
  }
  if (failed.length > 0) {
    throw new Error(`could not convert: ${failed.join(", ")}`);
  }
}

/** Each Codex home converts on its own; the ones left unconverted fail the step together, named. */
export const v409CodexProfileFiles: Migration = {
  version: "4.0.9",
  description: "move Codex named profiles from [profiles.<name>] to <name>.config.toml",
  run: moveCodexProfileTablesEverywhere,
};

/** Old key, old CLI spelling, new key; exported so config_key_lint.test.ts refuses the old spellings elsewhere. */
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

// --- the preference store's shape: scoped, grouped keys -----------------------------------
//
// Away from 4.0.9: the preference store was one flat map of camelCase keys. It is now a `global` map
// of dotted, grouped keys plus a `profiles` section (one map per profile), and the four keys that
// follow the credential (identity, host, passthrough, static-key) live only in a profile's
// section. A reader knows only the new shape, so this is the one place the old names exist: every
// old key in PREFERENCE_RENAMES moves, the profile keys into the profile sections, and
// test/copilot_api/config_key_lint.test.ts refuses the old spellings anywhere outside this directory.

/** Pure over the raw preferences document; the fold applies it as preferences.json folds, so a
 *  store still flat at 4.0.9 lands grouped in one pass. Values move verbatim (the other 4.0.9 steps
 *  still judge them at their new place); an old key whose new key already holds a value is dropped,
 *  since the new one is what readers use. A profile key was read by EVERY profile before, so it
 *  lands in the default's section and in each named profile's (`namedProfiles`, the credential
 *  slots'), a section's own value winning. Idempotent: a document without old keys is returned
 *  unchanged. */
function regroupPreferences(
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
    const targets =
      configScope(key) === "profile"
        ? [DEFAULT_PROFILE_NAME, ...namedProfiles].map((name) =>
            ensureDict(ensureDict(out, "profiles"), name),
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
    if (name === DEFAULT_PROFILE_NAME) out.push([null, section]);
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
      `  dropped ${profileLabel(
        profile,
      )}'s identity pin \`${stored}\` (Direct's default identity ` +
        "cannot be pinned; the identity now reads as auto, and Direct wiring rebakes at the next " +
        "`agent init` / `agent profile <name> add`)",
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
        `  ${profileLabel(
          profile,
        )}: static-key \`true\` is now the scope \`all\` (both agent configs keep the baked value)`,
      );
    } else {
      config.delProfile(profile, "static-key");
      consola.info(
        `  ${profileLabel(
          profile,
        )}: dropped static-key \`false\` (the default, now spelled \`none\`)`,
      );
    }
  }
}

/** Per profile section; left alone, a stored boolean reads as `none` and both agents lose the baked key untold. */
export const v409StaticKeyScope: Migration = {
  version: "4.0.9",
  description: "turn the static-key boolean into its scope (`true` -> `all`, `false` -> unset)",
  run: scopeStaticKeyBoolean,
};

/** A line equals `marker` ignoring a trailing CR (rc/profile files may be CRLF). */
const lineIs = (line: string | undefined, marker: string): boolean =>
  (line ?? "").replace(/\r$/, "") === marker;

// --- the launchers rc block ------------------------------------------------------------------
//
// Away from 4.0.9: `agent shell` stripped the launchers block every pre-4.0.0 release wrote on
// every wire. The strip is a migration now, so an rc still carrying the block loses it once here.

/** The index of the end fence closing the launchers block opened at `start`, or `start` itself
 *  when another fence line comes first or none does (the block was never closed). */
function launchersBlockEnd(lines: readonly string[], start: number): number {
  for (let j = start + 1; j < lines.length; j++) {
    const later = (lines[j] ?? "").replace(/\r$/, "");
    if (later === LAUNCHERS_MARKER_END) return j;
    if (FENCE_LINES.includes(later)) return start;
  }
  return start;
}

/** The user line directly under an unclosed marker at `start`; null when nothing, a blank, or a
 *  fence line follows it. */
function lineLeftBehind(lines: readonly string[], start: number): string | null {
  const next = lines[start + 1];
  if (next === undefined) return null;
  const bare = next.replace(/\r$/, "");
  if (bare === "" || FENCE_LINES.includes(bare)) return null;
  return bare;
}

/** The line indices one block occupies: the marker through `end`, the blank line before it, and
 *  the ONE blank after its end fence (never the file terminator). */
function launchersBlockSpan(lines: readonly string[], start: number, end: number): number[] {
  const span: number[] = [];
  if (start > 0 && lineIs(lines[start - 1], "")) span.push(start - 1);
  for (let i = start; i <= end; i++) span.push(i);
  const after = end + 1;
  const terminator = after === lines.length - 1 && lines[after] === "";
  if (after < lines.length && lineIs(lines[after], "") && !terminator) span.push(after);
  return span;
}

/**
 * Every launchers block, bounded as the shell writer bounded its blocks: the marker through its
 * end fence (any other fence line first means the block was never closed and the marker line
 * alone is owned), plus the blank line before it and the ONE blank after its end fence (never the
 * file terminator). `leftBehind` is the user line directly under an unclosed marker, for the
 * caller to warn about. Exported for the migration test.
 */
export function stripLaunchersBlocks(content: string): { content: string; leftBehind: string[] } {
  const lines = content.split("\n");
  const skip = new Set<number>();
  const leftBehind: string[] = [];
  for (const [idx, line] of lines.entries()) {
    if (!lineIs(line, LAUNCHERS_MARKER)) continue;
    const end = launchersBlockEnd(lines, idx);
    if (end === idx) {
      const left = lineLeftBehind(lines, idx);
      if (left !== null) leftBehind.push(left);
    }
    for (const i of launchersBlockSpan(lines, idx, end)) skip.add(i);
  }
  if (skip.size === 0) return { content, leftBehind };
  return { content: lines.filter((_, idx) => !skip.has(idx)).join("\n"), leftBehind };
}

/** Every rc/profile file; a file that cannot be read fails the step after the others ran. */
function stripLaunchersRcBlocks(): void {
  const failed: string[] = [];
  for (const file of shellTargetFiles()) {
    try {
      const read = fs.readTextResult(file);
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
      // In place: an rc file may be the user's own symlink, which a rename would replace.
      fs.writeText(file, stripped.content, {
        atomic: false,
        detail: "copilot-env launchers block removed",
      });
    } catch (e) {
      consola.warn(caught(e, (message) => `  could not strip ${file}: ${message}`));
      failed.push(file);
    }
  }
  failIfAny(failed);
}

/** Every rc file shellTargetFiles names; a file that cannot be read fails the step after the others ran. */
export const v409LaunchersBlock: Migration = {
  version: "4.0.9",
  description: "remove the launchers rc block (the launchers are `agent profile env` emissions)",
  run: stripLaunchersRcBlocks,
};

/** The four keys the old slot shape cached; dropSlotIdentityCache deletes them from a slot in that shape. */
const SLOT_CACHE_KEYS = [
  "integrationIdentity",
  "copilotHost",
  "copilotHostIdentity",
  "copilotHostSource",
] as const;

/** The old shape's marker: a slot without these two validity keys is already in the new shape. */
const OLD_SHAPE_KEYS = ["copilotHostIdentity", "copilotHostSource"] as const;

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

/** Store writes keep unknown keys, so without this step the four would ride along forever. */
export const v409IdentityCache: Migration = {
  version: "4.0.9",
  description: "drop the cached Direct identity and host from the profile slots",
  run: dropSlotIdentityCache,
};

/** In fold order: preferences.json folds after credentials.json, so its value wins a key both spell. */
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

// --- one store: state.json ---------------------------------------------------------------
//
// The fold is also the one reader left of a flat (pre-4.0.9) preferences.json, regrouped as it
// folds. Each debris path is named as it goes; `opencode/github_token` was copilot-api's login under
// a host selector the proxy no longer runs under.

function mapHasKey(map: unknown, keys: readonly string[]): boolean {
  return isRecord(map) && keys.some((key) => Object.hasOwn(map, key));
}

function anyProfileHasKey(doc: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    isRecord(doc.profiles) && Object.values(doc.profiles).some((slot) => mapHasKey(slot, keys))
  );
}

/** Whether `doc` (state.json) already holds what `store` would fold into it: the store's own
 *  keys, wherever they land. An old file beside a store already folded is the half-migrated
 *  shape (a crash between the write and the delete): kept as is and named, never folded twice. */
function alreadyFolded(doc: Record<string, unknown>, store: FoldedStore): boolean {
  switch (store) {
    case "credentials.json":
      return mapHasKey(doc.global, GLOBAL_STATE_KEYS) || anyProfileHasKey(doc, PROFILE_STATE_KEYS);
    case "preferences.json":
      return (
        mapHasKey(doc.global, GLOBAL_SETTING_KEYS) || anyProfileHasKey(doc, PROFILE_SETTING_KEYS)
      );
    case "ownership.json":
      return Object.hasOwn(doc, "ownership");
  }
}

function namedProfilesOf(doc: Record<string, unknown>): string[] {
  return isRecord(doc.profiles)
    ? Object.keys(doc.profiles).filter(
        (name) => name !== DEFAULT_PROFILE_NAME && isValidProfileName(name),
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
  const grouped =
    store === "preferences.json"
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

/** The old store at `oldPath` as a JSON object; null for an absent one, or for one left in place
 *  and named: not valid JSON, or not an object. */
function readFoldedStore(oldPath: string): Record<string, unknown> | null {
  if (!fs.exists(oldPath)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readText(oldPath));
  } catch {
    // The parser's message can quote the file's text (a token); the store's fixed diagnostic instead.
    consola.warn(
      `  ${oldPath} is not valid JSON (${JSON_PARSE_DIAGNOSTIC}); left in place, not folded`,
    );
    return null;
  }
  if (!isRecord(doc)) {
    consola.warn(`  ${oldPath} is not a JSON object; left in place, not folded`);
    return null;
  }
  return doc;
}

/** Each read store folded into state.json's maps, then removed and named; a store already folded
 *  (the half-migrated shape) is kept and named instead. */
function foldStoreDocs(
  rootHome: string,
  docs: ReadonlyMap<FoldedStore, Record<string, unknown>>,
): void {
  const stateFile = join(rootHome, STATE_STORE_FILENAME);
  const store = new CopilotApiConfig(
    stateFile,
    join(rootHome, LOCKS_DIR_NAME, `${STATE_STORE_FILENAME}.lock`),
  );
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
    fs.rm(oldPath, { force: true });
    consola.info(`  folded ${name} into ${stateFile}`);
  }
}

/** The folded stores' lock sidecars and the root-home debris nothing reads, each named. */
function removeFoldDebris(rootHome: string): void {
  for (const name of FOLDED_LOCKS) {
    const path = join(rootHome, LOCKS_DIR_NAME, name);
    if (!fs.exists(path)) continue;
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (the store's one lock is ${STATE_STORE_FILENAME}.lock)`);
  }
  for (const rel of ROOT_DEBRIS) {
    const path = join(rootHome, rel);
    if (!fs.exists(path)) continue;
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (nothing reads it)`);
  }
  // Through the facade: the token removed a moment ago is gone for a dry run too.
  const opencodeDir = join(rootHome, "opencode");
  if (fs.exists(opencodeDir) && fs.readdir(opencodeDir).length === 0) {
    fs.rm(opencodeDir, { recursive: true, force: true });
    consola.info(`  removed ${opencodeDir} (empty)`);
  }
}

/** Exported for the migration test; `rootHome` isolates. Idempotent: a
 *  home already folded (no old store present) writes nothing. A store that is not a JSON object is
 *  left in place and named: the fold never discards content it cannot carry over. */
export function foldRootStores(rootHome: string = resolveRootHome()): void {
  const docs = new Map<FoldedStore, Record<string, unknown>>();
  for (const name of FOLDED_STORES) {
    const doc = readFoldedStore(join(rootHome, name));
    if (doc !== null) docs.set(name, doc);
  }
  // A flat preferences.json copies its profile keys into every profile credentials.json names, so
  // it is folded only once credentials.json has been read (or never existed): a source is never
  // deleted while a source it depends on failed validation.
  const credentialsUnread =
    fs.exists(join(rootHome, "credentials.json")) && !docs.has("credentials.json");
  const prefs = docs.get("preferences.json");
  const held = prefs !== undefined && credentialsUnread && isFlatPreferences(prefs);
  if (held) docs.delete("preferences.json");
  if (docs.size > 0) foldStoreDocs(rootHome, docs);
  if (held) {
    consola.warn(
      `  ${join(rootHome, "preferences.json")} kept: its profile keys copy into every profile ` +
        `credentials.json names, and credentials.json could not be read; fix credentials.json, ` +
        "then re-run the migration",
    );
  }
  removeFoldDebris(rootHome);
}

/** The autoupdate throttle file takes the name of what it holds; "state.json" is the account-wide
 *  store's. */
export function renameAutoupdateThrottle(autoupdateHome: string): void {
  const oldAutoupdate = join(autoupdateHome, "state.json");
  const newAutoupdate = join(autoupdateHome, AUTOUPDATE_FILENAME);
  if (!fs.exists(oldAutoupdate)) return;
  if (!fs.exists(newAutoupdate)) {
    fs.rename(oldAutoupdate, newAutoupdate);
    consola.info(`  moved ${oldAutoupdate} -> ${newAutoupdate}`);
    return;
  }
  // Both present: the OLD process of a self-update writes its final throttle at ITS path after the
  // new binary ran this step, so the old file and its lock sidecar reappear beside the new one. The
  // re-run removes them; the new file (what the readers use) keeps its content.
  for (const path of [oldAutoupdate, `${oldAutoupdate}.lock`, `${oldAutoupdate}.lock.oslock`]) {
    if (!fs.exists(path)) continue;
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (superseded by ${newAutoupdate})`);
  }
}

/** A `layout` step: every other 4.0.9 step reads the merged maps, so the fold runs first. */
export const v409StateFold: Migration = {
  version: "4.0.9",
  layout: true,
  description:
    "fold credentials.json, preferences.json, and ownership.json into state.json (one store, one lock)",
  run: (installRoot) => {
    foldRootStores();
    renameAutoupdateThrottle(autoupdateDir(installRoot));
  },
};

/** Frozen: the files the pre-5.0.0 reader accepted AT the root as the default daemon's home; `.run` goes LAST. */
const ROOT_DAEMON_ARTIFACTS: readonly string[] = [
  PROXY_CONFIG_FILENAME,
  // The projection record earlier releases wrote beside config.json; nothing reads it any more.
  ".copilot-env-projections.json",
  LOGS_DIR_NAME,
  RUN_DIR_NAME,
];

// --- the default daemon's home ----------------------------------------------------------
//
// Away from 4.0.9: a device-flow login with COPILOT_API_HOME pinned left the proxy's config.json at
// the root, and the first `agent start` followed it. Any one of ROOT_DAEMON_ARTIFACTS makes the root
// a daemon home to move (the login alone leaves config.json and no `.run`); `.run` goes LAST, so a
// run interrupted mid-way still finds it at the root and resumes. The usage database lives under
// `.run/<host>/` and travels with it; a `copilot-api.sqlite` directly at the root predates 4.0.0 and
// has no reader.

/** The `.run/<host>/.state.json` files that may belong to a live daemon: another host's recording a
 *  pid (it means nothing on this host, so nothing here can stop it), or any host's that cannot be
 *  read or parsed. Fail closed: a state this host cannot judge is never "no daemon". This host's
 *  own daemon is the root's lock's to judge (stopRootDaemon). */
function occupiedRunStates(runDir: string, thisHost: string): string[] {
  let hosts: string[];
  try {
    hosts = fs.readdir(runDir);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
  const occupied: string[] = [];
  for (const host of hosts) {
    const file = join(runDir, host, RUN_STATE_FILENAME);
    const read = fs.readTextResult(file);
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
  const present = ROOT_DAEMON_ARTIFACTS.filter((name) => fs.exists(join(root, name)));
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
  // behind travels too (through the facade: in a dry run, one the stop planned as well).
  const rootEntries = new Set(fs.readdir(root));
  const moving = ROOT_DAEMON_ARTIFACTS.filter((name) => rootEntries.has(name));
  const target = join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR);
  fs.mkdir(target);
  for (const name of moving) {
    const from = join(root, name);
    const to = join(target, name);
    if (fs.exists(to)) {
      consola.warn(
        `  both ${from} and ${to} exist - keeping ${to} (the one readers use); delete ${from} by ` +
          "hand after checking it holds nothing newer",
      );
      continue;
    }
    fs.rename(from, to);
    consola.info(`  moved ${from} -> ${to}`);
  }
}

/** The root daemon's home IS the root (the layout before this step), so its lock is read there, and
 *  it is stopped by the lock and its pid's command line (stopLockedDaemon): this release's
 *  classifier reads the previous release's daemon as foreign, so no pid-table judgment could own
 *  it. A migration never starts a daemon (that is the launch pipeline's), so a live one stays down
 *  until the next `agent start`; said out loud because an autoupdate inside `agent start` reaches
 *  this step right after that start spawned it. Exported for the migration test. */
export async function stopRootDaemon(root: string): Promise<void> {
  const outcome = await stopLockedDaemon(root);
  switch (outcome.kind) {
    case "none":
      return;
    case "would-stop":
      consola.info(`  would stop the daemon (pid ${outcome.pid}) running at ${root} for the move`);
      return;
    case "unjudged":
      throw new Error(
        `a daemon may still run at ${root}: ${outcome.reason}. Run \`agent stop\` there, then re-run`,
      );
    case "foreign":
      consola.warn(foreignHolderWarning(root, outcome));
      return;
    case "stopped":
      if (outcome.stillRunning) {
        throw new Error(`the daemon (pid ${outcome.pid}) running at ${root} would not stop`);
      }
      consola.warn(
        `  the default daemon at ${root} (pid ${outcome.pid}) was stopped for the move; the next ` +
          "`agent start` (or a launcher) starts it under profiles/default",
      );
      return;
    default:
      assertNever(outcome);
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

// --- the `agent profile [<name>] <verb>` command tree --------------------------------------------
//
// The readers classify the old command lines as foreign, so each is rewritten in place before the
// profile re-renders: the user's own keys in the profile files and the Desktop entry's identity
// survive. The default's Direct line stays `agent auth --get`, an alias. A profile named like a
// verb before the word was reserved is renamed first, across every artifact.

/** The 4.0.9 spellings, the one place they still exist. */
function legacyAuthGetArgs(profile: ProfileName): string[] {
  return ["auth", "--get", "--profile", profile];
}
function legacyProxyTokenArgs(profile: Profile): string[] {
  return ["proxy-token", "--yes", ...(profile === null ? [] : ["--profile", profile])];
}
function legacyMcpServeArgs(profile: Profile): string[] {
  return ["mcp", "--serve", ...(profile === null ? [] : ["--profile", profile])];
}

/** `from === to` is a retarget with no rename; the default (null) is only ever retargeted. */
interface ProfileMove {
  from: Profile;
  to: Profile;
}

/** The named rename a move performs, or null for a retarget in place. */
function renameOf({ from, to }: ProfileMove): { from: ProfileName; to: ProfileName } | null {
  return from !== null && to !== null && from !== to ? { from, to } : null;
}

function freeProfileName(base: ProfileName, taken: (name: string) => boolean): ProfileName {
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (isValidProfileName(candidate) && !taken(candidate)) return parseProfileName(candidate);
  }
}

/** The current resolver line for `to` when `helper` is a 4.0.9 line of `from` (a named profile's
 *  Direct line, any profile's proxy line) or, under a rename, the current proxy line of `from`;
 *  null for any other value. */
function retargetedHelperLine(helper: unknown, { from, to }: ProfileMove): string | null {
  if (typeof helper !== "string") return null;
  if (from !== null && managedHelperShape(helper, legacyAuthGetArgs(from))) {
    return directHelperCommand(to);
  }
  if (managedHelperShape(helper, legacyProxyTokenArgs(from))) return proxyHelperCommand(to);
  if (from !== to && managedHelperShape(helper, proxyTokenArgs(from))) {
    return proxyHelperCommand(to);
  }
  return null;
}

/** The one Claude file of the profile: the old resolver line becomes the new one, the file moves
 *  under the new name; every other key is the user's and rides along. */
function retargetClaude(claudeHome: string, move: ProfileMove): boolean {
  const oldPath = settingsPathFor(claudeHome, move.from);
  const newPath = settingsPathFor(claudeHome, move.to);
  const read = fs.readTextResult(oldPath);
  if (read.kind === "absent") return false;
  if (read.kind === "unreadable") throw new Error(`could not read ${oldPath}: ${read.error}`);
  const doc = parseJsonRecord(read.text);
  if (doc === null) {
    consola.warn(`  ${oldPath} is not a JSON object; left as it is`);
    return false;
  }
  const next = retargetedHelperLine(doc.apiKeyHelper, move);
  if (next === null && oldPath === newPath) return false;
  if (next !== null) doc.apiKeyHelper = next;
  if (oldPath !== newPath) {
    fs.rename(oldPath, newPath);
  }
  if (next !== null) {
    fs.writeText(newPath, `${JSON.stringify(doc, null, 2)}\n`, {
      detail:
        "apiKeyHelper now `agent profile [<name>] proxy-token --yes` or `agent profile <name> auth --get`",
      atomic: false,
      secretKeys: SETTINGS_SECRETS,
    });
  }
  return true;
}

/** `args` of the current resolver line for `to` when `auth` carries a 4.0.9 line of `from` (a
 *  named profile's Direct line, any profile's proxy line) or, under a rename, the current proxy
 *  line of `from`; null for any other command. */
function retargetedAuthArgs(
  auth: Record<string, unknown>,
  { from, to }: ProfileMove,
): string[] | null {
  const legacy = from === null ? null : agentLauncherCommand(legacyAuthGetArgs(from));
  if (legacy !== null && auth.command === legacy.command && sameStrings(auth.args, legacy.args)) {
    return agentLauncherCommand(agentAuthGetArgs(to)).args;
  }
  const legacyProxy = agentLauncherCommand(legacyProxyTokenArgs(from));
  if (auth.command === legacyProxy.command && sameStrings(auth.args, legacyProxy.args)) {
    return proxyTokenCommand(to).args;
  }
  const proxy = proxyTokenCommand(from);
  if (from !== to && auth.command === proxy.command && sameStrings(auth.args, proxy.args)) {
    return proxyTokenCommand(to).args;
  }
  return null;
}

/** The provider table of `from` in one config.toml: its `auth` line retargeted and, for a rename,
 *  the table re-keyed under the new id with its `name`. Returns whether the file changed. */
function retargetCodexProviderTable(configPath: string, move: ProfileMove): boolean {
  const read = readCodexToml(configPath);
  if (read.kind === "unparseable") {
    throw new Error(`${configPath} is not valid TOML (${read.error})`);
  }
  if (read.kind === "absent") return false;
  const oldId = codexProviderId(move.from);
  const newId = codexProviderId(move.to);
  const providers = read.doc.model_providers;
  if (!isRecord(providers)) return false;
  const table = providers[oldId];
  if (!isRecord(table)) return false;
  let tableChanged = false;
  const auth = table.auth;
  if (isRecord(auth)) {
    const args = retargetedAuthArgs(auth, move);
    if (args !== null) {
      auth.args = args;
      tableChanged = true;
    }
  }
  if (oldId !== newId) {
    table.name = newId;
    providers[newId] = table;
    delete providers[oldId];
    tableChanged = true;
  }
  if (!tableChanged) return false;
  saveCodexToml(configPath, read.doc, `[model_providers.${newId}] resolver and name`);
  return true;
}

/** A renamed profile's file moved under the new name, its selector following. Returns whether a
 *  file moved. */
function renameCodexProfileFile(
  codexHome: string,
  rename: { from: ProfileName; to: ProfileName },
): boolean {
  const oldFile = codexProfileConfigPath(codexHome, rename.from);
  const newFile = codexProfileConfigPath(codexHome, rename.to);
  const fileRead = readCodexToml(oldFile);
  if (fileRead.kind === "unparseable") {
    throw new Error(`${oldFile} is not valid TOML (${fileRead.error})`);
  }
  if (fileRead.kind === "absent") return false;
  const oldId = codexProviderId(rename.from);
  const newId = codexProviderId(rename.to);
  if (fileRead.doc.model_provider === oldId) fileRead.doc.model_provider = newId;
  fs.rename(oldFile, newFile);
  saveCodexToml(newFile, fileRead.doc, `model_provider = "${newId}"`);
  return true;
}

/** One Codex home: the provider table's `auth` command line and, for a rename, the table's key
 *  and `name` plus the profile file's selector. */
function retargetCodex(codexHome: string, move: ProfileMove): boolean {
  const tableChanged = retargetCodexProviderTable(codexConfigPath(codexHome), move);
  const rename = renameOf(move);
  const fileMoved = rename !== null && renameCodexProfileFile(codexHome, rename);
  return tableChanged || fileMoved;
}

/** The 4.0.9 shape's attribution: the entry's own MCP row spawned `mcp --serve [--profile <name>]`
 *  behind the launcher's own argv. The profile (the default is null) for a row in that shape;
 *  undefined for a row already in the new shape, one of another shape, or no row of ours. */
function legacyEntryProfileAt(doc: Record<string, unknown>): Profile | undefined {
  const ours = ownMcpRow(doc);
  if (ours === undefined) return undefined;
  const sub = launcherSubcommandArgs(ours.args);
  if (sameStrings(sub, legacyMcpServeArgs(null))) return null;
  const name = sub[sub.indexOf("--profile") + 1];
  if (typeof name !== "string" || !isValidProfileName(name)) return undefined;
  const profile = parseProfileName(name);
  return sameStrings(sub, legacyMcpServeArgs(profile)) ? profile : undefined;
}

/** Every owned Desktop entry's MCP row in the old shape gets the verb spelling under the same
 *  name. Runs at the front of the update (a layout step): the 4.0.2 helper move reconciles the
 *  library through the NEW reader (entryProfileAt), which would read an old-shape row as no
 *  profile's and sweep the entry as an orphan. Exported for the migration test. */
export function rewriteDesktopMcpArgv(): void {
  const dir = resolveDesktopLibraryDir();
  if (dir === null) return;
  const raw = readFileOrNull(join(dir, META_FILENAME));
  if (raw === null) return;
  const meta = parseDesktopMeta(raw);
  if (meta === null) return;
  const ledger = new OwnershipLedger();
  for (const entry of meta.entries) {
    const path = join(dir, `${entry.id}.json`);
    if (!ledger.owns("claudeDesktop", path)) continue;
    const doc = parseJsonRecord(readFileOrNull(path) ?? "");
    if (doc === null) continue;
    const profile = legacyEntryProfileAt(doc);
    if (profile === undefined) continue;
    const ours = ownMcpRow(doc);
    if (ours === undefined) continue;
    ours.args = agentLauncherCommand(mcpServeArgs(profile)).args;
    saveJsonIfChanged(path, doc, `Claude Desktop entry "${desktopEntryName(profile)}"`);
  }
}

export const v409DesktopMcpArgv: Migration = {
  version: "4.0.9",
  layout: true,
  description: "spell a Claude Desktop entry's MCP row `agent profile [<name>] mcp --serve`",
  run: rewriteDesktopMcpArgv,
};

/** The owned entry at `path` whose profile is `from`, retargeted to `to` in its profile word and
 *  its helper-script pointer; false for an entry not ours, another profile's, or unreadable. */
function retargetOwnedEntry(
  path: string,
  ledger: OwnershipLedger,
  from: ProfileName,
  to: ProfileName,
): boolean {
  if (!ledger.owns("claudeDesktop", path) || entryProfileAt(path) !== from) return false;
  const doc = parseJsonRecord(readFileOrNull(path) ?? "");
  if (doc === null) return false;
  retargetEntryProfile(doc, from, to);
  for (const mode of PROFILE_MODES) {
    if (doc.inferenceCredentialHelper === desktopHelperPath(resolveRootHome(), mode, from)) {
      doc.inferenceCredentialHelper = desktopHelperPath(resolveRootHome(), mode, to);
    }
  }
  saveJsonIfChanged(path, doc, `Claude Desktop entry "${desktopEntryName(to)}"`);
  return true;
}

/** The owned Desktop entry keeps its id: its row is renamed and its MCP row's profile word
 *  retargeted, so the re-render finds it instead of minting a twin. */
function retargetDesktopEntry(from: ProfileName, to: ProfileName): void {
  const dir = resolveDesktopLibraryDir();
  if (dir === null) return;
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  if (raw === null) return;
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    consola.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the library alone`,
    );
    return;
  }
  const ledger = new OwnershipLedger();
  let changed = false;
  for (const entry of meta.entries) {
    if (!retargetOwnedEntry(join(dir, `${entry.id}.json`), ledger, from, to)) continue;
    if (entry.name === desktopEntryName(from)) entry.name = desktopEntryName(to);
    changed = true;
  }
  if (changed) writeDesktopMeta(dir, raw, meta);
}

/** The store slot moves whole (credential, mode, pair, and the profile's settings section). */
function renameStoreSlot(from: ProfileName, to: ProfileName): boolean {
  let moved = false;
  rootStateStore().update((d) => {
    const profiles = d.profiles;
    if (!isRecord(profiles) || !Object.hasOwn(profiles, from)) return;
    profiles[to] = profiles[from];
    delete profiles[from];
    moved = true;
  });
  return moved;
}

/** Mirrors `agent profile [<name>] sync` from the slot (`stored`), so no login. A Direct slot
 *  whose pair is not stored (the identity-cache step of the same run took the old cache) probes
 *  once for it and stores it, as any re-render does; on a real 4.0.9 store that is every Direct
 *  profile, so the re-render is not skipped. */
async function rerender(profile: Profile): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(profile);
  if (slot.kind !== "complete") {
    consola.info(
      `  ${profileLabel(profile)} has no complete wiring to re-render; its files carry the new ` +
        "resolver line already",
    );
    return;
  }
  if (profile === null) {
    const configure = { kind: "configure", mode: "auto" } as const;
    await runClaude(configure);
    await runCodex(configure);
    await reconcileClaudeDesktopWiring();
  } else {
    await wireBothAgents(profile, slot.mode, true, "stored");
  }
  consola.info(`  re-rendered ${profileLabel(profile)}'s agent files`);
}

/** Every file a rename edits is parsed BEFORE the first move, the Desktop library's index
 *  included, so a malformed one fails the profile whole (nothing renamed, nothing deleted) and a
 *  re-run after the repair finds every artifact under the old name. */
function assertMovable(
  move: { from: ProfileName; to: ProfileName },
  claudeHome: string,
  codexHomes: readonly string[],
): void {
  const settings = fs.readTextResult(settingsPathFor(claudeHome, move.from));
  if (settings.kind === "unreadable") {
    throw new Error(`could not read ${settingsPathFor(claudeHome, move.from)}: ${settings.error}`);
  }
  if (settings.kind === "text" && parseJsonRecord(settings.text) === null) {
    throw new Error(`${settingsPathFor(claudeHome, move.from)} is not a JSON object`);
  }
  for (const home of codexHomes) {
    for (const path of [codexConfigPath(home), codexProfileConfigPath(home, move.from)]) {
      const read = readCodexToml(path);
      if (read.kind === "unparseable") throw new Error(`${path} is not valid TOML (${read.error})`);
    }
  }
  const dir = resolveDesktopLibraryDir();
  if (dir !== null) {
    const metaPath = join(dir, META_FILENAME);
    const raw = readFileOrNull(metaPath);
    if (raw !== null && parseDesktopMeta(raw) === null) {
      throw new Error(
        `Claude Desktop's ${metaPath} has an unexpected shape; the profile's Desktop entry could ` +
          "not be retargeted, so nothing was renamed (repair or remove the index and re-run)",
      );
    }
  }
}

/** The profile's daemon stopped, then its store slot and daemon home moved under the new name
 *  (its agent files follow in moveProfile). Returns whether anything moved. */
async function renameProfile(
  rename: { from: ProfileName; to: ProfileName },
  claudeHome: string,
  codexHomes: readonly string[],
): Promise<boolean> {
  assertMovable(rename, claudeHome, codexHomes);
  // By the lock and the command line, like the root daemon's stop: the previous release's
  // daemon reads as foreign to this release's classifier.
  const outcome = await stopLockedDaemon(profileHome(rename.from));
  if (outcome.kind === "foreign") {
    consola.warn(foreignHolderWarning(profileHome(rename.from), outcome));
  }
  if (outcome.kind === "unjudged" || (outcome.kind === "stopped" && outcome.stillRunning)) {
    // The profile's name is a verb, so no command addresses its daemon any more: by hand it is.
    throw new Error(
      `${profileLabel(rename.from)}'s proxy daemon did not stop; stop it by hand (its pid is ` +
        `recorded under ${profileHome(rename.from)}) and re-run`,
    );
  }
  const slotMoved = renameStoreSlot(rename.from, rename.to);
  const oldHome = profileHome(rename.from);
  const homeMoved = fs.exists(oldHome);
  if (homeMoved) {
    fs.rename(oldHome, profileHome(rename.to));
    consola.info(`  moved ${oldHome} -> ${profileHome(rename.to)}`);
  }
  consola.info(
    `  renamed ${profileLabel(rename.from)} -> '${rename.to}' (its name is a verb of agent profile)`,
  );
  return slotMoved || homeMoved;
}

/** Every mode's helper script of `from` rewritten under `to` (the same name when nothing renames):
 *  the Desktop entry points at the script by path, and its body carries the resolver spelling and
 *  the profile's name, so the pointer stays valid and the body current whether or not the
 *  re-render runs. */
function rewriteDesktopHelperScripts({ from, to }: ProfileMove): void {
  for (const mode of PROFILE_MODES) {
    const oldHelper = desktopHelperPath(resolveRootHome(), mode, from);
    if (!fs.exists(oldHelper)) continue;
    writeDesktopHelperScript(mode, to);
    if (from === to) continue;
    fs.rm(oldHelper, { force: true, detail: `Claude Desktop helper of profile '${from}'` });
  }
}

async function moveProfile(
  move: ProfileMove,
  claudeHome: string,
  codexHomes: readonly string[],
): Promise<void> {
  const { from, to } = move;
  const rename = renameOf(move);
  let changed = false;
  if (rename !== null) changed = await renameProfile(rename, claudeHome, codexHomes);
  // The machine-global registration spawns the default's server; its old argv is ours to rewrite.
  if (from === null && retargetMcpRegistration(legacyMcpServeArgs(null))) changed = true;
  rewriteDesktopHelperScripts(move);
  changed = retargetClaude(claudeHome, move) || changed;
  for (const home of codexHomes) changed = retargetCodex(home, move) || changed;
  if (rename !== null) retargetDesktopEntry(rename.from, rename.to);
  if (changed) await rerender(to);
}

/** Exported for the migration test. Every profile is visited even after one fails; the failures
 *  then fail the step (the runner names the re-run). Idempotent: a second run finds no old
 *  resolver line and no verb-named profile, and writes nothing. */
export async function moveProfilesToVerbTree(): Promise<void> {
  // First, so a rename below finds every entry in the new shape (a real update ran the layout
  // step already; this is its idempotent repeat for a direct call).
  rewriteDesktopMcpArgv();
  const rawProfiles = rootStateStore().loadStrict().profiles;
  const storeNames = isRecord(rawProfiles) ? Object.keys(rawProfiles) : [];
  const named = [...new Set([...storeNames.filter(isValidProfileName), ...profileHomeNames()])]
    .filter((name) => name !== DEFAULT_PROFILE_NAME)
    .sort()
    .map((name) => parseProfileName(name));
  const claudeHome = resolveClaudeHome();
  const { homes: codexHomes, complete } = knownCodexHomes();
  if (!complete) {
    consola.warn(
      "  could not enumerate every ~/.codex/hosts home; a config there may keep the old resolver line.",
    );
  }
  const claimed = new Set<string>();
  const taken = (candidate: string): boolean =>
    claimed.has(candidate) ||
    storeNames.includes(candidate) ||
    fs.exists(profileHome(parseProfileName(candidate))) ||
    fs.exists(settingsPathFor(claudeHome, parseProfileName(candidate))) ||
    codexHomes.some((home) => {
      if (fs.exists(codexProfileConfigPath(home, parseProfileName(candidate)))) return true;
      const read = readCodexToml(codexConfigPath(home));
      return (
        read.kind === "ok" &&
        isRecord(read.doc.model_providers) &&
        Object.hasOwn(read.doc.model_providers, codexProviderId(parseProfileName(candidate)))
      );
    });
  // The default first: its lines move too, and nothing renames it.
  const moves: ProfileMove[] = [{ from: null, to: null }];
  for (const name of named) {
    if (!isReservedProfileWord(name)) {
      moves.push({ from: name, to: name });
      continue;
    }
    const to = freeProfileName(name, taken);
    claimed.add(to);
    moves.push({ from: name, to });
  }
  const failed: string[] = [];
  for (const move of moves) {
    try {
      await moveProfile(move, claudeHome, codexHomes);
    } catch (e) {
      consola.warn(
        caught(e, (message) => `  could not move ${profileLabel(move.from)}: ${message}`),
      );
      failed.push(profileLabel(move.from));
    }
  }
  if (failed.length > 0) throw new Error(`not moved: ${failed.join(", ")}`);
}

/** Under 4.0.9, not 5.0.0 (unreleased): every install that meets the verbs leaves 4.0.9, so this runs exactly once. */
export const v409ProfileVerbTree: Migration = {
  version: "4.0.9",
  description:
    "spell every profile's resolver lines `agent profile [<name>] ...` and rename a profile named like a verb",
  run: moveProfilesToVerbTree,
};
