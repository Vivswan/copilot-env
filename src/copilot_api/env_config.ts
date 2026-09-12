// The account-wide preference store behind `agent config`. Each read site applies the precedence
// itself: explicit flag/env > this stored config > built-in default.
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import { SECONDS_PER_DAY } from "../utils/time.ts";

export type PassthroughPref = "auto" | "on" | "off";

/** Each key's meaning is its registry entry's `describe` below; an absent or ill-typed field reads back
 *  as `undefined`, which every read site treats as "apply the default". */
export interface CopilotEnvConfigData {
  autoStart?: boolean;
  autoUpdate?: boolean;
  passthrough?: PassthroughPref;
  integrationId?: string;
  idleTimeout?: number;
  launchers?: boolean;
  proxyLogs?: boolean;
  smallModel?: string;
  useResponsesApiWebSocket?: boolean;
  useResponsesApiWebSearch?: boolean;
  useMessagesApi?: boolean;
  useResponsesApiContextManagement?: boolean;
  messageApiWebSearchModel?: string;
  alphaSearchCodexPriority?: boolean;
  alphaSearchModel?: string;
  claudeAutoModel?: string;
  claudeDesktop?: boolean;
  claudeTokenMultiplier?: number;
  port?: number;
  pricingUrl?: string;
  creditsTarget?: number;
  minPort?: number;
  maxPort?: number;
  strictPort?: boolean;
  proxyVersion?: string;
  releaseCooldown?: number;
  updateCooldown?: number;
  verifyProvenance?: boolean;
  codexHost?: boolean;
  codexModelCatalog?: boolean;
  wireMcp?: boolean;
}

/** null and undefined both delete the key. Exported for the settings-bundle import, which rebuilds the whole store. */
export type ConfigPatch = { [K in keyof CopilotEnvConfigData]?: CopilotEnvConfigData[K] | null };

// Generous ceilings: anything larger is a typo, not a setting.
const MAX_SECONDS = 365 * 24 * 60 * 60;
const MAX_CREDITS = 1_000_000_000_000;
const MAX_TOKEN_MULTIPLIER = 1000;
const MAX_DAYS = 3650;

const PASSTHROUGH_VALUES = ["auto", "on", "off"] as const;

/**
 * The value is interpolated into HTTP headers (newline-separated ANTHROPIC_CUSTOM_HEADERS, Codex
 * `http_headers`), so only a header-safe token may pass either boundary that feeds them: the pin here
 * and the settings-bundle identities (src/agents/transfer.ts). The `auto` sentinel matches.
 */
export const INTEGRATION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type ConfigKey = keyof CopilotEnvConfigData;
export type ConfigValue = boolean | number | string;

/** A key path into the proxy config.json document, e.g. `["contextManagement", "responses"]`. */
export type ProxyConfigPath = readonly [string, ...string[]];

/** Display order of the config table. */
export const CONFIG_SECTIONS = [
  "Proxy daemon",
  "Proxy features",
  "Credential",
  "Codex",
  "Claude",
  "Shell",
  "Updates",
  "Cost",
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/** The one section whose keys are projected into the proxy's config.json. */
const PROJECTED_SECTION = "Proxy features" satisfies ConfigSection;

/** The generic ties `schema` and `parse` to the key's OWN field type, so a key can never be write-only
 *  again (accepted by `--set`, stripped by the folded read schema). */
interface ConfigKeyDefCore<K extends ConfigKey = ConfigKey> {
  cli: string;
  key: K;
  describe: string;
  /** The config table's `[type]` cell: `bool`, `1-65535`, `model id`, ... */
  type: string;
  /** The single source CONFIG_SCHEMA folds; `parse` is derived from it by the domain builders. */
  schema: v.GenericSchema<unknown, NonNullable<CopilotEnvConfigData[K]>>;
  parse: (raw: string) => NonNullable<CopilotEnvConfigData[K]>;
  /** `agent config --set` refuses the key on Windows. */
  posixOnly?: true;
}

/** Absent when "unset" IS the default (a disabled override, a floating pin), rendered `<unset>`. On an
 *  opt-in projected key it is the PROXY'S own default, informational only and never projected. */
interface DefaultSpec<K extends ConfigKey = ConfigKey> {
  defaultValue?: NonNullable<CopilotEnvConfigData[K]>;
}

/** What `agent config` set/del prints about when a change takes effect; projected keys already get
 *  the restart hint, and a key with neither applies immediately. */
type ApplySpec =
  | {
    /** Read only when a daemon launches, though not projected into config.json. */
    restartToApply: true;
    applyHint?: undefined;
  }
  | {
    /** Replaces the proxy-restart hint for keys that apply through another mechanism. */
    applyHint: string;
    restartToApply?: undefined;
  }
  | { restartToApply?: undefined; applyHint?: undefined };

interface ProjectedKeyFields {
  /** Pinning every projected key to the one section makes the grouping rule a compile check. */
  section: typeof PROJECTED_SECTION;
  /** Default `[key]`. Set when the proxy renamed or nested its key while our storage key stays put,
   *  since renaming ours would need a store migration. */
  proxyPath?: ProxyConfigPath;
  /** Oldest proxy version that reads the key: `agent config --set` warns on an older installed proxy,
   *  where the projection would be a silent no-op. Unset = every version above our floor. */
  sinceProxyVersion?: string;
}

/** Our own code reads it; nothing is written into the proxy config.json for it. */
type InternalConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & DefaultSpec<K>
  & ApplySpec
  & {
    section: Exclude<ConfigSection, typeof PROJECTED_SECTION>;
    proxyDefault?: undefined;
    proxyProjected?: undefined;
    proxyPath?: undefined;
    sinceProxyVersion?: undefined;
  };

/** Always written at `agent start` as `stored ?? proxyDefault`, for keys copilot-env has an opinion on. */
type ForceProjectedConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & ApplySpec
  & ProjectedKeyFields
  & {
    proxyDefault: NonNullable<CopilotEnvConfigData[K]>;
    defaultValue?: undefined;
    proxyProjected?: undefined;
  };

/** Written only while our store holds a value, so the proxy's own default stands otherwise. A previous
 *  write is cleared once the key is unset, ownership-tracked per daemon home (applyDefaultConfig in launch.ts). */
type OptInProjectedConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & DefaultSpec<K>
  & ApplySpec
  & ProjectedKeyFields
  & {
    proxyProjected: true;
    proxyDefault?: undefined;
  };

/** Distributed over ConfigKey so each entry's schema, parse, and default must fit ITS key's value type.
 *  The registry's `as const satisfies` rejects at compile time:
 *    proxyDefault + proxyProjected              -> the two projection shapes are exclusive
 *    proxyPath / sinceProxyVersion, unprojected  -> only projected keys land in config.json
 *    projected key outside PROJECTED_SECTION     -> that section means "restart the daemon to apply"
 *    unprojected key inside PROJECTED_SECTION    -> it would promise a projection that never happens
 *    force-projected + defaultValue              -> proxyDefault is its source
 *    restartToApply + applyHint                  -> one notice per key */
export type ConfigKeyDef = {
  [K in ConfigKey]:
    | InternalConfigKeyDef<K>
    | ForceProjectedConfigKeyDef<K>
    | OptInProjectedConfigKeyDef<K>;
}[ConfigKey];

/** undefined when unset is itself the default. */
export function configDefaultValue(def: ConfigKeyDef): ConfigValue | undefined {
  return def.defaultValue ?? def.proxyDefault;
}

export function isProxyProjected(def: ConfigKeyDef): boolean {
  return def.proxyDefault !== undefined || def.proxyProjected === true;
}

// Each key's domain is stated ONCE as the schema on its registry entry: CONFIG_SCHEMA folds those into
// the read schema and every `--set` parse is derived from the same schema, so write and read can never disagree.

/** Spread into a registry entry (`...BOOL_DOMAIN`). */
interface ConfigDomain<T extends ConfigValue> {
  schema: v.GenericSchema<unknown, T>;
  parse: (raw: string) => T;
  type: string;
}

/** `coerce` only turns the CLI string into the value type; the domain checks and their messages live
 *  on the schema's actions. */
function domain<T extends ConfigValue>(
  schema: v.GenericSchema<unknown, T>,
  coerce: (raw: string) => unknown,
  type: string,
): ConfigDomain<T> {
  return { schema, parse: (raw) => v.parse(schema, coerce(raw)), type };
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on", "enable", "enabled"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off", "disable", "disabled"]);

const BOOL_DOMAIN: ConfigDomain<boolean> = domain(v.boolean(), (raw) => {
  const t = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  throw new Error(`expected a boolean (true/false), got '${raw}'`);
}, "bool");

function wholeNumberDomain(min: number, max: number, unit?: string): ConfigDomain<number> {
  const range = (issue: { input: unknown }) =>
    `must be between ${min} and ${max}, got ${issue.input}`;
  // The grammar only lets digits through, so the sole non-integer reaching v.integer is an overflow's
  // Infinity; the range message fits it too.
  return domain(
    v.pipe(v.number(), v.integer(range), v.minValue(min, range), v.maxValue(max, range)),
    (raw) => {
      const t = raw.trim();
      if (!/^\d+$/.test(t)) throw new Error(`expected a whole number, got '${raw}'`);
      return Number.parseInt(t, 10);
    },
    unit ?? `${min}-${max}`,
  );
}

function positiveDecimalDomain(max: number): ConfigDomain<number> {
  const ceiling = (issue: { input: unknown }) => `must be at most ${max}, got ${issue.input}`;
  // The grammar bans signs, exponents, and NaN, so the only NON-finite value reaching v.finite is an
  // overflow's +Infinity.
  return domain(
    v.pipe(
      v.number(),
      v.finite(ceiling),
      v.gtValue(0, (issue) => `must be greater than 0, got ${issue.input}`),
      v.maxValue(max, ceiling),
    ),
    (raw) => {
      const t = raw.trim();
      if (!/^\d+(\.\d+)?$/.test(t)) {
        throw new Error(`expected a positive decimal number, got '${raw}'`);
      }
      return Number.parseFloat(t);
    },
    "number",
  );
}

const PASSTHROUGH_DOMAIN: ConfigDomain<PassthroughPref> = domain(
  v.picklist(PASSTHROUGH_VALUES),
  // Membership is checked in the coercion so the rejection echoes the ORIGINAL input, not the
  // lowercased form the schema would see.
  (raw) => {
    const t = raw.trim().toLowerCase();
    if (!PASSTHROUGH_VALUES.some((a) => a === t)) {
      throw new Error(`expected one of ${PASSTHROUGH_VALUES.join("|")}, got '${raw}'`);
    }
    return t;
  },
  PASSTHROUGH_VALUES.join("|"),
);

function nonEmptyDomain(type: string): ConfigDomain<string> {
  return domain(
    v.pipe(v.string(), v.trim(), v.minLength(1, "expected a non-empty value")),
    (raw) => raw,
    type,
  );
}
const MODEL_ID_DOMAIN = nonEmptyDomain("model id");
const PROXY_VERSION_DOMAIN = nonEmptyDomain("version|tag");

/** The rejection never echoes the value: junk pasted here can be a token. An invalid stored pin reads
 *  as unset, so reads fall back to the probe rather than baking a header-splitting value. */
const INTEGRATION_ID_DOMAIN: ConfigDomain<string> = domain(
  v.pipe(
    v.string(),
    v.trim(),
    v.regex(
      INTEGRATION_ID_RE,
      "expected a header-safe identity token (1-64 chars of [A-Za-z0-9._-]) or `auto`",
    ),
  ),
  (raw) => raw,
  "id|auto",
);

/** Lives here rather than in src/usage/pricing.ts because this module sits in the daemon shims' import
 *  closure and the usage layer must not (test/installer_pinning.test.ts). */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Userinfo is refused because fetch rejects a `user:password@` URL, so it could only fail at run time.
 *  Neither rejection echoes the value: a custom price-list URL may carry credentials. */
function pricingUrlRejection(raw: string): string | null {
  if (!URL.canParse(raw) || new URL(raw).protocol !== "https:") {
    return "expected an https:// URL";
  }
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") {
    return "expected an https:// URL without user:password@ credentials (put a token in the query instead)";
  }
  return null;
}

/** Canonical spelling (lowercase scheme and host), so the fetch's https check and the digest that keys
 *  the price cache see one form. */
export function canonicalPricingUrl(raw: string): string {
  const rejection = pricingUrlRejection(raw);
  if (rejection !== null) throw new Error(rejection);
  return new URL(raw).href;
}

const HTTPS_URL_DOMAIN: ConfigDomain<string> = domain(
  v.pipe(
    v.string(),
    v.trim(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const rejection = pricingUrlRejection(dataset.value);
      if (rejection !== null) {
        addIssue({ message: rejection });
        return NEVER;
      }
      return new URL(dataset.value).href;
    }),
  ),
  (raw) => raw,
  "url",
);

/** Ordered ALPHABETICALLY by CLI name: that is the `--get` and `--help` display order, and a test pins
 *  it, so insert new keys in place. */
const CONFIG_REGISTRY_LITERAL = [
  {
    cli: "alpha-search-codex-priority",
    key: "alphaSearchCodexPriority",
    section: "Proxy features",
    describe: "Prefer Codex for the proxy's /alpha/search (Codex search)",
    ...BOOL_DOMAIN,
    defaultValue: true,
    proxyProjected: true,
    sinceProxyVersion: "1.15.0",
  },
  {
    cli: "alpha-search-model",
    key: "alphaSearchModel",
    section: "Proxy features",
    describe: "Responses model for /alpha/search when the requested model cannot search",
    ...MODEL_ID_DOMAIN,
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    sinceProxyVersion: "1.16.3",
  },
  {
    cli: "auto-start",
    key: "autoStart",
    section: "Proxy daemon",
    describe: "Auto-start the proxy on agent open and auto-stop it when idle",
    ...BOOL_DOMAIN,
    defaultValue: false,
  },
  {
    cli: "auto-update",
    key: "autoUpdate",
    section: "Updates",
    describe: "Daily self-update on `agent start`, honoring update-cooldown",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next `agent start` (checked once a day); `agent update` updates now, `agent update --auto-status` shows the last check.",
  },
  {
    cli: "claude-auto-model",
    key: "claudeAutoModel",
    section: "Proxy features",
    describe: "Model for Claude Code's background security-monitor requests; unset disables",
    ...MODEL_ID_DOMAIN,
    proxyProjected: true,
    sinceProxyVersion: "1.14.22",
  },
  {
    cli: "claude-desktop",
    key: "claudeDesktop",
    section: "Claude",
    describe: "Wire Claude Desktop's config library; false unwires profiles only",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint:
      "Applies at the next `agent init`/`agent claude`/`agent profile` wiring; setting the key writes no Desktop files itself.",
  },
  {
    cli: "claude-token-multiplier",
    key: "claudeTokenMultiplier",
    section: "Proxy features",
    describe: "Multiplier the proxy applies when estimating Claude token usage",
    ...positiveDecimalDomain(MAX_TOKEN_MULTIPLIER),
    defaultValue: 1.15,
    proxyProjected: true,
  },
  {
    cli: "codex-host",
    key: "codexHost",
    section: "Codex",
    describe: "Per-host CODEX_HOME at ~/.codex/hosts/<hostname> via `agent env` (Linux/macOS)",
    ...BOOL_DOMAIN,
    defaultValue: false,
    posixOnly: true,
    applyHint:
      "Applies at the next `agent codex`/`agent init` wiring, which builds or removes the farm.",
  },
  {
    cli: "codex-model-catalog",
    key: "codexModelCatalog",
    section: "Codex",
    describe: "Patched Codex model catalog with Copilot's real context windows",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next Codex auth refresh (within ~5 minutes) or `agent codex`/`agent init` wiring.",
  },
  {
    cli: "credits-target",
    key: "creditsTarget",
    section: "Cost",
    describe:
      "Copilot AI credits (100 to the dollar) to stay under per month; unset paces against the plan's entitlement alone",
    ...wholeNumberDomain(1, MAX_CREDITS, "credits"),
    applyHint: "Applies to the next `agent credits` run.",
  },
  {
    cli: "idle-timeout",
    key: "idleTimeout",
    section: "Proxy daemon",
    describe: "Idle auto-stop window; 0 disables",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 3600,
    restartToApply: true,
  },
  {
    cli: "integration-id",
    key: "integrationId",
    section: "Credential",
    describe: "Copilot-Integration-Id header to send; auto probes it per credential",
    ...INTEGRATION_ID_DOMAIN,
    defaultValue: "auto",
    applyHint:
      "Applies at the next `agent start` (proxy) and `agent init`/`agent profile --add` (direct wiring).",
  },
  {
    cli: "launchers",
    key: "launchers",
    section: "Shell",
    describe: "Shell launchers cl / co / cx (+ clx / cox / cxx) in `agent env`",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint: "New shells pick a change up; the current one picks up an ENABLE on the next " +
      "`agent` command (a disable applies to new shells only).",
  },
  {
    cli: "max-port",
    key: "maxPort",
    section: "Proxy daemon",
    describe: "Upper bound of the allowed proxy port range",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 65535,
    restartToApply: true,
  },
  {
    cli: "message-websearch-model",
    key: "messageApiWebSearchModel",
    section: "Proxy features",
    describe: "Web-search model: proxy Messages-API path and MCP web_search tool",
    ...MODEL_ID_DOMAIN,
    // Must equal DEFAULT_WEB_SEARCH_MODEL in web_search.ts, which imports this module and so cannot be
    // referenced here; a registry test pins the two.
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    applyHint:
      "Proxy surface applies on the next `agent start`; the MCP web_search tool reads it on every call.",
  },
  {
    cli: "messages-api",
    key: "useMessagesApi",
    section: "Proxy features",
    describe: "Proxy Messages-API (Anthropic-shaped) endpoint",
    ...BOOL_DOMAIN,
    proxyDefault: true,
  },
  {
    cli: "min-port",
    key: "minPort",
    section: "Proxy daemon",
    describe: "Lower bound of the allowed proxy port range",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 1024,
    restartToApply: true,
  },
  {
    cli: "passthrough",
    key: "passthrough",
    section: "Credential",
    describe: "Use a PAT-shaped token as the bearer directly; auto detects the token",
    ...PASSTHROUGH_DOMAIN,
    defaultValue: "auto",
    restartToApply: true,
  },
  {
    cli: "port",
    key: "port",
    section: "Proxy daemon",
    describe: "Default proxy port; the next free one is used when busy",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 4141,
    restartToApply: true,
  },
  {
    cli: "pricing-url",
    key: "pricingUrl",
    section: "Cost",
    describe: "OpenRouter models API URL for `agent cost`; `--pricing-url` overrides once",
    ...HTTPS_URL_DOMAIN,
    defaultValue: OPENROUTER_MODELS_URL,
    applyHint: "Applies to the next `agent cost` run.",
  },
  {
    cli: "proxy-logs",
    key: "proxyLogs",
    section: "Proxy daemon",
    describe: "Proxy request logging under <home>/logs; false discards the writes",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    cli: "proxy-version",
    key: "proxyVersion",
    section: "Proxy daemon",
    describe: "Pin the floated proxy to a version or tag; unset floats to the latest",
    ...PROXY_VERSION_DOMAIN,
  },
  {
    cli: "release-cooldown",
    key: "releaseCooldown",
    section: "Proxy daemon",
    describe: "Age a proxy release must reach before the float adopts it",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 7 * SECONDS_PER_DAY,
  },
  {
    cli: "responses-context-management",
    // The storage key is the proxy's pre-1.14 flat key; renaming it would need a store migration.
    key: "useResponsesApiContextManagement",
    section: "Proxy features",
    describe: "Proxy Responses-API server-side context management",
    ...BOOL_DOMAIN,
    defaultValue: false,
    proxyProjected: true,
    proxyPath: ["contextManagement", "responses"],
  },
  {
    cli: "responses-websearch",
    key: "useResponsesApiWebSearch",
    section: "Proxy features",
    describe: "Proxy Responses-API web search",
    ...BOOL_DOMAIN,
    proxyDefault: true,
  },
  {
    cli: "responses-websocket",
    key: "useResponsesApiWebSocket",
    section: "Proxy features",
    describe: "Proxy Responses-API over WebSocket instead of HTTP/SSE",
    ...BOOL_DOMAIN,
    proxyDefault: true,
  },
  {
    cli: "small-model",
    key: "smallModel",
    section: "Proxy features",
    describe: "Small/fast model the proxy uses",
    ...MODEL_ID_DOMAIN,
    proxyDefault: "gpt-5-mini",
  },
  {
    cli: "strict-port",
    key: "strictPort",
    section: "Proxy daemon",
    describe: "Fail start on a busy port instead of auto-incrementing",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    cli: "update-cooldown",
    key: "updateCooldown",
    section: "Updates",
    describe: "Min release age for updates; unset means none by hand, 7 for auto",
    ...wholeNumberDomain(0, MAX_DAYS, "days"),
  },
  {
    cli: "verify-provenance",
    key: "verifyProvenance",
    section: "Updates",
    describe: "Verify `agent update` downloads against Sigstore provenance",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint:
      "Applies to the next `agent update` / autoupdate run; `agent update --no-verify` skips a single run.",
  },
  {
    cli: "wire-mcp",
    key: "wireMcp",
    section: "Claude",
    describe: "Wire the copilot-env MCP server + WebSearch deny on direct writes",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint: "Applies at the next `agent claude`/`agent init` direct wiring.",
  },
] as const satisfies readonly ConfigKeyDef[];

/** The configDefault* accessors take this so a typo'd key is a compile error, not a module-load throw. */
export type ConfigCli = (typeof CONFIG_REGISTRY_LITERAL)[number]["cli"];

type RegistryStorageKey = (typeof CONFIG_REGISTRY_LITERAL)[number]["key"];

/** Exported only for the @ts-expect-error pin tests. */
export type TotalOverConfigKeys<Pin extends { [K in ConfigKey]: K }> = Pin;

/** Every CopilotEnvConfigData field is optional, so a key omitted from the registry would still compile:
 *  written by set() yet silently stripped by CONFIG_SCHEMA on every read. This pin names the omission. */
type _RegistryIsTotalOverConfigKeys = TotalOverConfigKeys<{ [K in RegistryStorageKey]: K }>;

export const CONFIG_REGISTRY: readonly ConfigKeyDef[] = CONFIG_REGISTRY_LITERAL;

/** A bad stored value falls back to undefined (unset) instead of throwing, so a hand-mangled file still reads. */
function lenientField(
  schema: v.GenericSchema<unknown, ConfigValue>,
): v.GenericSchema<unknown, ConfigValue | undefined> {
  return v.fallback(v.optional(schema), undefined);
}

/**
 * Exported for the settings-bundle parser (src/agents/transfer.ts), which hardens the leniency into
 * strict rejections at its own trust boundary. The fromEntries fold erases the key-to-value-type
 * correlation ConfigKeyDefCore enforces per entry, so the cast only restates what `satisfies` checked.
 */
export const CONFIG_SCHEMA = v.object(
  Object.fromEntries(CONFIG_REGISTRY.map((def) => [def.key, lenientField(def.schema)])),
) as v.GenericSchema<unknown, CopilotEnvConfigData>;

/** Always false on Windows whatever a bundle imported: no farm without POSIX symlinks. Shared by the
 *  accessor and the settings-import plan. */
export function codexHostEnabledFor(
  stored: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  return stored ?? configDefaultBoolean("codex-host");
}

export function configKeyDef(cli: string): ConfigKeyDef | undefined {
  return CONFIG_REGISTRY.find((d) => d.cli === cli.trim());
}

/** A missing or non-numeric entry is a programmer error. */
export function configDefaultNumber(cli: ConfigCli): number {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "number") {
    throw new Error(`config key '${cli}' has no numeric built-in default`);
  }
  return value;
}

export function configDefaultString(cli: ConfigCli): string {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "string") {
    throw new Error(`config key '${cli}' has no string built-in default`);
  }
  return value;
}

export function configDefaultBoolean(cli: ConfigCli): boolean {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "boolean") {
    throw new Error(`config key '${cli}' has no boolean built-in default`);
  }
  return value;
}

export interface ProjectedProxyEntry {
  path: ProxyConfigPath;
  value: ConfigValue;
  /** Opt-in entries are ownership-tracked per daemon home so a later unset clears OUR leftover write
   *  (applyDefaultConfig, ProxyProjectionState). */
  optIn: boolean;
}

/** The ownership ALLOWLIST, set or not: applyDefaultConfig only deletes recorded paths inside this set,
 *  so a recorded path the registry no longer projects opt-in is left alone in config.json. */
export function optInProxyConfigPaths(): ProxyConfigPath[] {
  const out: ProxyConfigPath[] = [];
  for (const def of CONFIG_REGISTRY) {
    if (def.proxyProjected === true) out.push(def.proxyPath ?? [def.key]);
  }
  return out;
}

/** What `agent start` writes into the daemon's config.json before launch (applyDefaultConfig in launch.ts). */
export function projectedProxyConfig(
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): ProjectedProxyEntry[] {
  const prefs = config.read();
  const out: ProjectedProxyEntry[] = [];
  for (const def of CONFIG_REGISTRY) {
    const stored = prefs[def.key];
    if (def.proxyDefault !== undefined) {
      out.push({
        path: def.proxyPath ?? [def.key],
        value: stored ?? def.proxyDefault,
        optIn: false,
      });
    } else if (def.proxyProjected === true && stored !== undefined) {
      out.push({ path: def.proxyPath ?? [def.key], value: stored, optIn: true });
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
  data: CopilotEnvConfigData,
  platform: NodeJS.Platform,
): boolean {
  return def.posixOnly === true && platform === "win32" && data[def.key] !== undefined;
}

export class CopilotEnvConfig {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    if (path === undefined) {
      const paths = new CopilotApiPaths();
      this.store = new CopilotApiConfig(paths.envConfigFile, paths.envConfigLock);
    } else {
      this.store = new CopilotApiConfig(path);
    }
  }

  /** STRICT: an unreadable file THROWS rather than reading as "no preference set", because wiring, the
   *  proxy float pin, and the port knobs are decisions that must never act on an unproven empty. */
  read(): CopilotEnvConfigData {
    return v.parse(CONFIG_SCHEMA, this.store.loadStrict());
  }

  /** ONLY for the best-effort background gates, where a throw would kill the serving daemon
   *  (src/scripts/idle_watchdog.ts) or the autoupdate preflight. Their flatten is the safe direction:
   *  lifecycle off, default window, no self-update. */
  private readDegraded(): CopilotEnvConfigData {
    return v.parse(CONFIG_SCHEMA, this.store.load());
  }

  /** Watchdog-reachable, so the read degrades. */
  autoStartEnabled(): boolean {
    return this.readDegraded().autoStart ?? configDefaultBoolean("auto-start");
  }

  /** Preflight-reachable, so the read degrades. */
  autoUpdateEnabled(): boolean {
    return this.readDegraded().autoUpdate ?? configDefaultBoolean("auto-update");
  }

  /** OFF sweeps the profile entries and leaves the default's in place (src/claude/desktop.ts). */
  claudeDesktopEnabled(): boolean {
    return this.read().claudeDesktop ?? configDefaultBoolean("claude-desktop");
  }

  codexHostEnabled(platform: NodeJS.Platform = process.platform): boolean {
    return codexHostEnabledFor(this.read().codexHost, platform);
  }

  codexModelCatalogEnabled(): boolean {
    return this.read().codexModelCatalog ?? configDefaultBoolean("codex-model-catalog");
  }

  launchersEnabled(): boolean {
    return this.read().launchers ?? configDefaultBoolean("launchers");
  }

  wireMcpEnabled(): boolean {
    return this.wireMcpResolved().value;
  }

  /** Value and source from ONE snapshot, so `agent mcp` never prints a torn pair. */
  wireMcpResolved(): { value: boolean; source: "stored" | "default" } {
    const stored = this.read().wireMcp;
    return stored === undefined
      ? { value: configDefaultBoolean("wire-mcp"), source: "default" }
      : { value: stored, source: "stored" };
  }

  /** On the STRICT read on purpose: an unreadable store fails the update rather than reading as "off". */
  verifyProvenanceEnabled(): boolean {
    return this.read().verifyProvenance ?? configDefaultBoolean("verify-provenance");
  }

  /** `auto` reads as null so `--set integration-id auto` restores probing without a separate `--del`. */
  pinnedIntegrationId(): string | null {
    const value = this.read().integrationId;
    return value === undefined || value.toLowerCase() === "auto" ? null : value;
  }

  /** undefined = `auto` or unset; the caller decides from the credential's provider and token shape. */
  passthroughOverride(): boolean | undefined {
    const value = this.read().passthrough;
    if (value === "on") return true;
    if (value === "off") return false;
    return undefined;
  }

  defaultPort(): number {
    return this.read().port ?? configDefaultNumber("port");
  }

  minPort(): number {
    return this.read().minPort ?? configDefaultNumber("min-port");
  }

  maxPort(): number {
    return this.read().maxPort ?? configDefaultNumber("max-port");
  }

  strictPortEnabled(): boolean {
    return this.read().strictPort ?? configDefaultBoolean("strict-port");
  }

  proxyLogsEnabled(): boolean {
    return this.read().proxyLogs ?? configDefaultBoolean("proxy-logs");
  }

  /** The COPILOT_API_IDLE_TIMEOUT env layer stays at the read site (src/scripts/idle_watchdog.ts).
   *  Watchdog-reachable, so the read degrades. */
  idleTimeoutSeconds(): number {
    return this.readDegraded().idleTimeout ?? configDefaultNumber("idle-timeout");
  }

  /** The per-run `--pricing-url` layer stays at the read site (resolvePricingUrl in src/usage/cost.ts). */
  pricingUrl(): string {
    return this.read().pricingUrl ?? configDefaultString("pricing-url");
  }

  /** The stored `credits-target`, else null: `agent credits` then paces against the entitlement alone. */
  creditsTarget(): number | null {
    return this.read().creditsTarget ?? null;
  }

  /** null = no cooldown by hand; autoupdate layers its own policy default on top
   *  (effectiveUpdateCooldownDays in src/autoupdate/state.ts). */
  updateCooldownDays(): number | null {
    return this.read().updateCooldown ?? null;
  }

  /** The defaults belong to the read sites: the proxy's own on the proxy path, DEFAULT_WEB_SEARCH_MODEL in
   *  web_search.ts on the MCP path (that module imports this one, so the registry cannot reference it). */
  messageApiWebSearchModel(): string | null {
    return this.read().messageApiWebSearchModel ?? null;
  }

  /** null, undefined, and a blank string all delete the key; strings are trimmed. */
  set(patch: ConfigPatch): void {
    this.store.update((d) => {
      for (const key of Object.keys(patch) as (keyof ConfigPatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined) {
          delete d[key];
        } else if (typeof value === "string") {
          const t = value.trim();
          if (t === "") delete d[key];
          else d[key] = t;
        } else {
          d[key] = value;
        }
      }
    });
  }

  del(key: ConfigKey): void {
    this.set({ [key]: undefined });
  }
}
