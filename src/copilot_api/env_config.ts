// The preference store behind `agent config`: one key registry (config_registry.ts), every key scoped to a profile or to
// the machine, and ONE precedence rule (resolveSettingIn): explicit flag > the profile's own value >
// the global value > the built-in default. The store holds a global map and one section per
// profile; the type keeps a profile-scoped key out of the global map.
import * as v from "valibot";
import { type CopilotApiConfig, ensureDict } from "./config.ts";
import {
  type CodexHomePrefs,
  codexHomePrefsFor,
  CONFIG_REGISTRY,
  configDefaultValue,
  type ConfigKey,
  type ConfigKeyDef,
  configScope,
  type ConfigValue,
  type ConfigValueTypes,
  COPILOT_HOST_AUTO,
  type GlobalConfigData,
  type GlobalKey,
  type GlobalMapKey,
  type ProfileConfigData,
  type ProfileMapKey,
  type ProxyConfigPath,
  registryEntry,
  type StaticKeyAgent,
  type StaticKeyScope,
} from "./config_registry.ts";
import { rootStateStore } from "./state_store.ts";
import type { Profile, ProfileName } from "./profile.ts";
import { isRecord } from "../utils/json.ts";

/** The store as read: both maps always present. `profiles` is keyed by profile name, the default
 *  profile under PROFILE_SETTINGS_DEFAULT_KEY. */
export interface CopilotEnvConfigData {
  global: GlobalConfigData;
  profiles: Record<string, ProfileConfigData>;
}

/** null and undefined both delete the key. */
export type GlobalPatch = { [K in GlobalMapKey]?: ConfigValueTypes[K] | null };
export type ProfilePatch = { [K in ProfileMapKey]?: ConfigValueTypes[K] | null };

/** The default profile's map name: one `profiles.default` holds its settings and its credential slot. */
export const PROFILE_SETTINGS_DEFAULT_KEY = "default";

export function profileSettingsKey(profile: Profile): string {
  return profile ?? PROFILE_SETTINGS_DEFAULT_KEY;
}

// The preference commands a message may point at, spelled ONCE. The key is typed, so a renamed key
// cannot leave a stale hint behind, and test/config_key_lint.test.ts refuses a hand-spelled one.

/** The command a key's write or read belongs to: a named profile's own verbs; with no name, a
 *  profile key is the default profile's (`agent profile set`), and a machine key or a shared
 *  default is `agent config`. */
function preferenceCommand(key: ConfigKey, profile: Profile): string {
  if (profile !== null) return `agent profile ${profile}`;
  return configScope(key) === "profile" ? "agent profile" : "agent config";
}

export function configSetCommand(key: ConfigKey, value: string, profile: Profile = null): string {
  return `${preferenceCommand(key, profile)} set ${key} ${value}`;
}

export function configDelCommand(key: ConfigKey, profile: Profile = null): string {
  return `${preferenceCommand(key, profile)} unset ${key}`;
}

export function configGetCommand(key: ConfigKey, profile: Profile = null): string {
  return `${preferenceCommand(key, profile)} get ${key}`;
}

/** A bad stored value falls back to undefined (unset) instead of throwing, so a hand-mangled file still reads. */
function lenientField(
  schema: v.GenericSchema<unknown, ConfigValue>,
): v.GenericSchema<unknown, ConfigValue | undefined> {
  return v.fallback(v.optional(schema), undefined);
}

function mapSchema<T>(keys: readonly ConfigKeyDef[]): v.GenericSchema<unknown, T> {
  // The fromEntries fold erases the key-to-value-type correlation ConfigKeyDefCore enforces per
  // entry, so the cast only restates what `satisfies` checked.
  return v.object(
    Object.fromEntries(keys.map((def) => [def.key, lenientField(def.schema)])),
  ) as unknown as v.GenericSchema<unknown, T>;
}

/** Exported for the settings-bundle parser (src/agents/transfer.ts), which hardens the leniency into
 *  strict rejections at its own trust boundary. */
export const GLOBAL_CONFIG_SCHEMA = mapSchema<GlobalConfigData>(
  CONFIG_REGISTRY.filter((def) => def.scope !== "profile"),
);
export const PROFILE_CONFIG_SCHEMA = mapSchema<ProfileConfigData>(
  CONFIG_REGISTRY.filter((def) => def.scope !== "global"),
);

/** The settings keys each map of the store may hold (the state keys sharing the maps are
 *  env_state.ts's): what a whole-store replace or a profile deletion touches. */
export const GLOBAL_SETTING_KEYS: readonly string[] = CONFIG_REGISTRY
  .filter((def) => def.scope !== "profile")
  .map((def) => def.key);
export const PROFILE_SETTING_KEYS: readonly string[] = CONFIG_REGISTRY
  .filter((def) => def.scope !== "global")
  .map((def) => def.key);

/** A profile map holding no setting has nothing for the bundle or the table: skipped. */
function settingsOf(data: CopilotEnvConfigData): CopilotEnvConfigData {
  return {
    global: data.global,
    profiles: Object.fromEntries(
      Object.entries(data.profiles).filter(([, section]) =>
        Object.values(section).some((value) => value !== undefined)
      ),
    ),
  };
}

/** A missing map reads as empty; a malformed one (not an object) reads as empty too. */
export const CONFIG_SCHEMA: v.GenericSchema<unknown, CopilotEnvConfigData> = v.object({
  global: v.fallback(v.optional(GLOBAL_CONFIG_SCHEMA, {}), {}),
  profiles: v.fallback(
    v.optional(v.record(v.string(), v.fallback(PROFILE_CONFIG_SCHEMA, {})), {}),
    {},
  ),
});

// --- resolution -------------------------------------------------------------------------

/** Where a resolved value came from. A global key never answers `profile`; a profile key never
 *  answers `global`. */
export type SettingSource = "flag" | "profile" | "global" | "default";

export interface ResolvedSetting<T> {
  /** undefined only when nothing is set and unset IS the default. */
  value: T | undefined;
  source: SettingSource;
}

export interface ResolveOptions<T> {
  /** The profile the value is for; null is the default profile. Irrelevant to a global key. */
  profile: Profile;
  /** A per-invocation override (a CLI flag, an env var), already parsed; undefined = none given. */
  flag?: T | undefined;
}

/** THE precedence: flag > the profile's own value > the global value > the built-in default, each
 *  layer only where the key's scope admits it. Pure over an already-read store. */
export function resolveSettingIn<K extends ConfigKey>(
  data: CopilotEnvConfigData,
  key: K,
  opts: ResolveOptions<ConfigValueTypes[K]>,
): ResolvedSetting<ConfigValueTypes[K]> {
  if (opts.flag !== undefined) return { value: opts.flag, source: "flag" };
  const def = registryEntry(key);
  if (def.scope !== "global") {
    // The section's type is a subset of every key's, so the widening is a plain assignment.
    const section: Partial<ConfigValueTypes> = data.profiles[profileSettingsKey(opts.profile)] ??
      {};
    const own = section[key];
    if (own !== undefined) return { value: own, source: "profile" };
  }
  if (def.scope !== "profile") {
    const global: Partial<ConfigValueTypes> = data.global;
    const shared = global[key];
    if (shared !== undefined) return { value: shared, source: "global" };
  }
  // The registry's per-key `satisfies` typed the default to the key; the cast restates it.
  return {
    value: configDefaultValue(def) as ConfigValueTypes[K] | undefined,
    source: "default",
  };
}

/** A stored value is what `unset` can revert: anything resolved from either map. */
export function isStoredSource(source: SettingSource): boolean {
  return source === "profile" || source === "global";
}

export interface ProjectedProxyEntry {
  path: ProxyConfigPath;
  /** undefined = an opt-in key with nothing stored: the path is CLEARED so the proxy's own default
   *  stands, whatever a previous start wrote there. */
  value: ConfigValue | undefined;
}

/** What `agent start` lands in `profile`'s daemon config.json before launch (applyDefaultConfig in
 *  launch.ts): one entry per projected key, each as it resolves FOR THAT PROFILE. */
export function projectedProxyConfig(
  profile: Profile,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): ProjectedProxyEntry[] {
  const data = config.read();
  const out: ProjectedProxyEntry[] = [];
  for (const def of CONFIG_REGISTRY) {
    if (def.proxyDefault !== undefined) {
      // Force-projected: the built-in default IS proxyDefault, so the resolution always has a value.
      const resolved = resolveSettingIn(data, def.key, { profile });
      out.push({ path: def.proxyPath, value: resolved.value ?? def.proxyDefault });
    } else if (def.proxyProjected === true) {
      const resolved = resolveSettingIn(data, def.key, { profile });
      out.push({
        path: def.proxyPath,
        value: isStoredSource(resolved.source) ? resolved.value : undefined,
      });
    }
  }
  return out;
}

export function formatConfigValue(value: ConfigValue): string {
  return String(value);
}

/** A POSIX-only key's stored value (an imported bundle's) does nothing on Windows; the table and
 *  `--get <key>` name such a value instead of hiding it. */
export function isStoredValueInert(
  def: ConfigKeyDef,
  resolved: ResolvedSetting<ConfigValue>,
  platform: NodeJS.Platform,
): boolean {
  return def.posixOnly === true && platform === "win32" && isStoredSource(resolved.source);
}

// --- writes ------------------------------------------------------------------------------

/** Which map a `set`/`unset` lands in. */
export type SettingTarget = { kind: "global" } | { kind: "profile"; profile: Profile };

/** Applies one patch to one map: null, undefined, and a blank string delete; strings are trimmed. */
function applyPatch(map: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete map[key];
    } else if (typeof value === "string") {
      const t = value.trim();
      if (t === "") delete map[key];
      else map[key] = t;
    } else {
      map[key] = value;
    }
  }
}

/** The `host` literal in force for `profile` in one read of the store (`auto` and unset read as
 *  null), so a caller judging a not-yet-stored document (an import's plan) applies the same rule as
 *  the live store. */
export function copilotHostIn(data: CopilotEnvConfigData, profile: Profile): string | null {
  const value = resolveSettingIn(data, "host", { profile }).value;
  return value === undefined || value === COPILOT_HOST_AUTO ? null : value;
}

/** The `identity` pin in force, likewise; `auto` reads as null so `set identity auto` restores
 *  probing without a separate `unset`. */
export function pinnedIntegrationIdIn(data: CopilotEnvConfigData, profile: Profile): string | null {
  const value = resolveSettingIn(data, "identity", { profile }).value;
  return value === undefined || value.toLowerCase() === "auto" ? null : value;
}

/** A resolved setting whose registry entry carries a default is never undefined (resolveSettingIn
 *  lands on the default); reaching here without one is a programmer error, not a fallback. */
function settled<V>(key: ConfigKey, value: V | undefined): V {
  if (value === undefined) throw new Error(`config key '${key}' has no built-in default`);
  return value;
}

export class CopilotEnvConfig {
  private readonly store: CopilotApiConfig;

  /** `path` = another `state.json` (a test fixture). */
  constructor(path?: string) {
    this.store = rootStateStore(path);
  }

  /** STRICT: an unreadable file THROWS rather than reading as "no preference set", because wiring, the
   *  proxy float pin, and the port knobs are decisions that must never act on an unproven empty. */
  read(): CopilotEnvConfigData {
    return settingsOf(v.parse(CONFIG_SCHEMA, this.store.loadStrict()));
  }

  /** ONLY for the best-effort background gates, where a throw would kill the serving daemon
   *  (src/scripts/idle_watchdog.ts) or the autoupdate preflight. Their flatten is the safe direction:
   *  lifecycle off, default window, no self-update. */
  private readDegraded(): CopilotEnvConfigData {
    return settingsOf(v.parse(CONFIG_SCHEMA, this.store.load()));
  }

  /** The one precedence rule over this store (resolveSettingIn). */
  resolve<K extends ConfigKey>(
    key: K,
    opts: ResolveOptions<ConfigValueTypes[K]>,
  ): ResolvedSetting<ConfigValueTypes[K]> {
    return resolveSettingIn(this.read(), key, opts);
  }

  /** For a key whose "unset" IS a value (a floating pin, no cooldown by hand). */
  private value<K extends GlobalKey>(key: K): ConfigValueTypes[K] | undefined {
    return this.resolve(key, { profile: null }).value;
  }

  /** For a key with a registry default: resolveSettingIn lands on it when nothing is stored. */
  private setting<K extends GlobalKey>(key: K): ConfigValueTypes[K] {
    return settled(key, this.value(key));
  }

  /** The same on the degraded read, for the watchdog- and preflight-reachable gates. */
  private degradedSetting<K extends GlobalKey>(key: K): ConfigValueTypes[K] {
    return settled(key, resolveSettingIn(this.readDegraded(), key, { profile: null }).value);
  }

  /** Watchdog-reachable, so the read degrades. */
  autoStartEnabled(): boolean {
    return this.degradedSetting("daemon.auto-start");
  }

  /** Preflight-reachable, so the read degrades. */
  autoUpdateEnabled(): boolean {
    return this.degradedSetting("update.auto");
  }

  /** OFF sweeps the profile entries and leaves the default's in place (src/claude/desktop.ts). */
  claudeDesktopEnabled(): boolean {
    return this.setting("claude.desktop");
  }

  codexHomePrefs(platform: NodeJS.Platform = process.platform): CodexHomePrefs {
    return codexHomePrefsFor(this.read().global, platform);
  }

  codexHostEnabled(platform: NodeJS.Platform = process.platform): boolean {
    return this.codexHomePrefs(platform).hostFarm;
  }

  codexModelCatalogEnabled(): boolean {
    return this.setting("codex.model-catalog");
  }

  launchersEnabled(): boolean {
    return this.setting("shell.launchers");
  }

  /** The agents in scope get the credential value baked by their writer (src/agents/configure.ts
   *  resolves it once per write) and run no copilot-env process at request time. */
  staticKeyScope(profile: Profile): StaticKeyScope {
    return settled("static-key", this.resolve("static-key", { profile }).value);
  }

  /** The per-agent question every writer asks, so no call site compares scope strings. */
  staticKeyFor(agent: StaticKeyAgent, profile: Profile): boolean {
    const scope = this.staticKeyScope(profile);
    return scope === "all" || scope === agent;
  }

  wireMcpEnabled(): boolean {
    return this.wireMcpResolved().value;
  }

  /** Value and source from ONE snapshot, so `agent profile mcp` never prints a torn pair. */
  wireMcpResolved(): { value: boolean; source: "stored" | "default" } {
    const resolved = this.resolve("claude.wire-mcp", { profile: null });
    return {
      value: settled("claude.wire-mcp", resolved.value),
      source: isStoredSource(resolved.source) ? "stored" : "default",
    };
  }

  /** On the STRICT read on purpose: an unreadable store fails the update rather than reading as "off". */
  verifyProvenanceEnabled(): boolean {
    return this.setting("update.verify-provenance");
  }

  /** `profile`'s `host` literal, or null for `auto`: the caller then resolves the host per credential
   *  (the select*IdentityAndHost pair, integration_identity.ts). */
  copilotHost(profile: Profile): string | null {
    return copilotHostIn(this.read(), profile);
  }

  pinnedIntegrationId(profile: Profile): string | null {
    return pinnedIntegrationIdIn(this.read(), profile);
  }

  /** undefined = `auto` or unset; the caller decides from the credential's provider and token shape. */
  passthroughOverride(profile: Profile): boolean | undefined {
    const value = this.resolve("passthrough", { profile }).value;
    if (value === "on") return true;
    if (value === "off") return false;
    return undefined;
  }

  defaultPort(): number {
    return this.setting("daemon.port");
  }

  minPort(): number {
    return this.setting("daemon.min-port");
  }

  maxPort(): number {
    return this.setting("daemon.max-port");
  }

  strictPortEnabled(): boolean {
    return this.setting("daemon.strict-port");
  }

  proxyLogsEnabled(): boolean {
    return this.setting("daemon.logs");
  }

  /** The `daemon.version` pin, or undefined to float (the COPILOT_API_VERSION env layer stays at the
   *  read site, src/proxy_float.ts). */
  proxyVersionPin(): string | undefined {
    return this.value("daemon.version");
  }

  /** The COPILOT_API_MIN_RELEASE_AGE env layer stays at the read site (src/proxy_float.ts). */
  releaseCooldownSeconds(): number {
    return this.setting("daemon.release-cooldown");
  }

  /** The COPILOT_API_IDLE_TIMEOUT env layer stays at the read site (src/scripts/idle_watchdog.ts).
   *  Watchdog-reachable, so the read degrades. */
  idleTimeoutSeconds(): number {
    return this.degradedSetting("daemon.idle-timeout");
  }

  /** The per-run `--pricing-url` layer stays at the read site (resolvePricingUrl in src/usage/cost.ts). */
  pricingUrl(): string {
    return this.setting("cost.pricing-url");
  }

  /** The stored `cost.credits-target`, else null: `agent credits` then paces against the entitlement alone. */
  creditsTarget(): number | null {
    return this.value("cost.credits-target") ?? null;
  }

  /** null = no cooldown by hand; autoupdate layers its own policy default on top
   *  (effectiveUpdateCooldownDays in src/autoupdate/state.ts). */
  updateCooldownDays(): number | null {
    return this.value("update.cooldown") ?? null;
  }

  /** The defaults belong to the read sites: the proxy's own on the proxy path, DEFAULT_WEB_SEARCH_MODEL in
   *  web_search.ts on the MCP path (that module imports this one, so the registry cannot reference it). */
  messageApiWebSearchModel(profile: Profile): string | null {
    const resolved = this.resolve("proxy.message-websearch-model", { profile });
    return isStoredSource(resolved.source) ? resolved.value ?? null : null;
  }

  /** The global map: null, undefined, and a blank string all delete the key; strings are trimmed. */
  set(patch: GlobalPatch): void {
    this.writeGlobal(patch);
  }

  del(key: GlobalMapKey): void {
    this.set({ [key]: undefined });
  }

  /** `profile`'s section, same delete rules; an emptied section is removed. */
  setProfile(profile: Profile, patch: ProfilePatch): void {
    this.writeProfile(profile, patch);
  }

  delProfile(profile: Profile, key: ProfileMapKey): void {
    this.setProfile(profile, { [key]: undefined });
  }

  /** Every setting goes with the profile (`agent profile <name> del`): a deleted profile leaves no
   *  value behind for a later profile of the same name to inherit. The slot's state keys are
   *  CopilotEnvState.deleteProfile's; a map left with nothing is dropped. */
  deleteProfile(name: ProfileName): void {
    this.store.update((d) => {
      const profiles = d.profiles;
      if (!isRecord(profiles) || !isRecord(profiles[name])) return;
      const section = profiles[name];
      for (const key of PROFILE_SETTING_KEYS) delete section[key];
      if (Object.keys(section).length === 0) delete profiles[name];
    });
  }

  /** The `set`/`unset` write: the key's scope decides the map (settingTarget), so the
   *  rule sits at the one mutation point. `value` null deletes. Returns where it landed for the
   *  caller to say. */
  assign(
    def: ConfigKeyDef,
    value: ConfigValue | null,
    profile: Profile,
  ): SettingTarget {
    const target = settingTarget(def, profile);
    if (target.kind === "global") this.writeGlobal({ [def.key]: value });
    else this.writeProfile(target.profile, { [def.key]: value });
    return target;
  }

  /** Every setting at once (the settings-bundle import): each map's setting keys are replaced,
   *  nothing merged; the state keys sharing the maps are untouched. */
  replace(data: CopilotEnvConfigData): void {
    this.store.update((d) => {
      const global = ensureDict(d, "global");
      for (const key of GLOBAL_SETTING_KEYS) delete global[key];
      applyPatch(global, data.global);
      if (Object.keys(global).length === 0) delete d.global;
      const profiles = ensureDict(d, "profiles");
      for (const [name, section] of Object.entries(profiles)) {
        if (!isRecord(section)) continue;
        for (const key of PROFILE_SETTING_KEYS) delete section[key];
        if (Object.keys(section).length === 0) delete profiles[name];
      }
      for (const [name, section] of Object.entries(data.profiles)) {
        const out = ensureDict(profiles, name);
        applyPatch(out, section);
        if (Object.keys(out).length === 0) delete profiles[name];
      }
      if (Object.keys(profiles).length === 0) delete d.profiles;
    });
  }

  private writeGlobal(patch: Record<string, unknown>): void {
    this.store.update((d) => applyPatch(ensureDict(d, "global"), patch));
  }

  private writeProfile(profile: Profile, patch: Record<string, unknown>): void {
    this.store.update((d) => {
      const profiles = ensureDict(d, "profiles");
      const name = profileSettingsKey(profile);
      const section = ensureDict(profiles, name);
      applyPatch(section, patch);
      if (Object.keys(section).length === 0) delete profiles[name];
    });
  }
}

/**
 * Which map a key lands in, from its scope; null is the default profile:
 *
 *   global key          -> the global map; a named profile is an error (the key has no profile value)
 *   profile key         -> the profile's own section, the default's included
 *   profile-default key -> the named profile's section; the default's is the GLOBAL map (the
 *                          shared default every profile follows: the default never overrides it)
 */
export function settingTarget(def: ConfigKeyDef, profile: Profile): SettingTarget {
  switch (def.scope) {
    case "global":
      if (profile !== null) {
        throw new Error(
          `'${def.key}' is a global setting (scope ${def.scope}): it has no per-profile value; \`${
            configSetCommand(def.key, "<value>")
          }\` sets this machine's`,
        );
      }
      return { kind: "global" };
    case "profile":
      return { kind: "profile", profile };
    case "profile-default":
      return profile === null ? { kind: "global" } : { kind: "profile", profile };
  }
}
