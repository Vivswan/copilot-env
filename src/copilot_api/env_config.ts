// copilot-env's account/machine-wide PREFERENCES, managed by `agent config`. Separate from
// the credential store (CopilotEnvState): this holds user-tunable knobs only. Stored in
// `preferences.json` under the copilot-api home, built on CopilotApiConfig (the
// atomic JSON store) + a lenient valibot schema, mirroring CopilotEnvState/CopilotEnvRunState.
//
// Precedence for every knob is: explicit flag/env (per-invocation) > this stored config >
// built-in default. Each read site applies that itself; this module is just the store.
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import { SECONDS_PER_DAY } from "../utils/time.ts";

/** Passthrough preference: `auto` (detect from token shape), or force `on`/`off`. */
export type PassthroughPref = "auto" | "on" | "off";

/** The persisted preferences (absent/ill-typed fields read back as `undefined` = default). */
export interface CopilotEnvConfigData {
  /** Managed proxy lifecycle (auto-start on agent open + idle auto-stop). */
  autoStart?: boolean;
  /** Once-a-day self-update preflight on `agent start` (the release cooldown is `update-cooldown`). */
  autoUpdate?: boolean;
  /** PAT passthrough default for `agent start`. */
  passthrough?: PassthroughPref;
  /**
   * Pin the Copilot `Copilot-Integration-Id` client identity (e.g.
   * `copilot-developer-cli`), overriding the per-credential probe. `auto`/unset probes.
   */
  integrationId?: string;
  /** Idle auto-stop window in whole seconds (`0` disables). */
  idleTimeout?: number;
  /** Define the opt-in cl/co/cx launcher functions in the shell (`agent env` emits them). */
  launchers?: boolean;
  /** Proxy request logging under `<home>/logs` (`false` discards the writes). */
  proxyLogs?: boolean;
  /** Small/fast model id the proxy uses. */
  smallModel?: string;
  /** Proxy Responses-API transport: WebSocket (`true`) vs HTTP/SSE (`false`). */
  useResponsesApiWebSocket?: boolean;
  /** Proxy Responses-API web search feature. */
  useResponsesApiWebSearch?: boolean;
  /** Proxy Messages-API (Anthropic-shaped) endpoint. */
  useMessagesApi?: boolean;
  /** Proxy Responses-API server-side context management. */
  useResponsesApiContextManagement?: boolean;
  /** Model id the proxy uses for Messages-API web search. */
  messageApiWebSearchModel?: string;
  /** Whether the proxy's /alpha/search endpoint (Codex search) prefers Codex over the
   *  Copilot fallback. */
  alphaSearchCodexPriority?: boolean;
  /** Native-Responses model the proxy's /alpha/search (Codex search) uses when the requested
   *  model is Messages-backed and cannot run the search itself. */
  alphaSearchModel?: string;
  /** Model override for Claude Code's background security-monitor requests (unset disables). */
  claudeAutoModel?: string;
  /** Wire Claude Desktop's config library (default + every profile) while the app is installed. */
  claudeDesktop?: boolean;
  /** Multiplier the proxy applies when estimating Claude token usage. */
  claudeTokenMultiplier?: number;
  /** Default proxy port. */
  port?: number;
  /** OpenRouter models API URL `agent cost` prices at (`--pricing-url` overrides per run). */
  pricingUrl?: string;
  /** Lower bound of the allowed proxy port range (default 1024). */
  minPort?: number;
  /** Upper bound of the allowed proxy port range (default 65535). */
  maxPort?: number;
  /** Fail `agent start` when the default/configured port is busy instead of auto-incrementing. */
  strictPort?: boolean;
  /** Pin the floated proxy to an exact version/tag. */
  proxyVersion?: string;
  /** Proxy float supply-chain cooldown in whole seconds. */
  releaseCooldown?: number;
  /** copilot-env update cooldown in whole days. */
  updateCooldown?: number;
  /** Verify `agent update` downloads against the release's build-provenance attestation. */
  verifyProvenance?: boolean;
  /** Per-host CODEX_HOME symlink farm, derived by `agent init`/`agent codex` (Linux/macOS). */
  codexHost?: boolean;
  /** Patched Codex model catalog with Copilot's real context windows (opt-in). */
  codexModelCatalog?: boolean;
  /** Wire the copilot-env MCP server (+ WebSearch deny) into Claude on direct writes. */
  wireMcp?: boolean;
}

/** A `set()` patch: per-key values, null/undefined deleting the key. Exported
 *  for callers that rebuild the whole store (the settings-bundle import). */
export type ConfigPatch = { [K in keyof CopilotEnvConfigData]?: CopilotEnvConfigData[K] | null };

const MAX_SECONDS = 365 * 24 * 60 * 60; // a year, a generous ceiling for cooldown/idle knobs
const MAX_TOKEN_MULTIPLIER = 1000; // generous; anything larger is surely a typo, not an estimate
const MAX_DAYS = 3650;

const PASSTHROUGH_VALUES = ["auto", "on", "off"] as const;

/**
 * The shape of a Copilot-Integration-Id value. It is interpolated into HTTP
 * headers by the config writers (newline-separated ANTHROPIC_CUSTOM_HEADERS,
 * Codex `http_headers`), so ONLY a header-safe token may pass any boundary that
 * feeds those paths: the `integration-id` pin here (which WINS over probed
 * identities) and the settings-bundle identities (src/agents/transfer.ts).
 * The `auto` probe sentinel matches.
 */
export const INTEGRATION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type ConfigKey = keyof CopilotEnvConfigData;
export type ConfigValue = boolean | number | string;

/** A non-empty key path into the proxy config.json document
 *  (e.g. `["contextManagement", "responses"]`). */
export type ProxyConfigPath = readonly [string, ...string[]];

/** The config table's sections, in display order. Grouped by what a key drives: the daemon
 *  process itself, the features projected into its config.json, the credential's handling,
 *  one agent's wiring, the shell, or copilot-env's own updates. */
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

/** The section holding exactly the keys projected into the proxy's config.json. */
const PROJECTED_SECTION = "Proxy features" satisfies ConfigSection;

/** Fields every config key carries: its CLI name (kebab), storage key (camel), help section,
 *  help text, and its value domain (see ConfigDomain). The generic ties `schema`/`parse` to the KEY'S
 *  OWN field type in CopilotEnvConfigData, so an entry without a schema -- or with a schema
 *  whose output cannot be its key's value -- is a compile error, and a registry key can never
 *  be write-only again (accepted by `--set`, stripped by the folded read schema). */
interface ConfigKeyDefCore<K extends ConfigKey = ConfigKey> {
  cli: string;
  key: K;
  describe: string;
  /** Short label of the value domain for the config table's `[type]` cell (`bool`,
   *  `1-65535`, `model id`, ...). Owned by the domain builders like `schema`/`parse`. */
  type: string;
  /** The key's VALUE domain, the single source CONFIG_SCHEMA folds. */
  schema: v.GenericSchema<unknown, NonNullable<CopilotEnvConfigData[K]>>;
  /** Parser from the `--set <value>` string to the stored value (throws a clear message
   *  on bad input). Derived from `schema` by the domain builders, never hand-written. */
  parse: (raw: string) => NonNullable<CopilotEnvConfigData[K]>;
  /** The feature needs POSIX (Linux/macOS): `agent config --set` refuses it on Windows. */
  posixOnly?: true;
}

/** The built-in a read site applies when the key is unset: exactly the value `--set` would
 *  store, so the table shows it bare. Absent when "unset" IS the default (a disabled override,
 *  a floating pin), rendered `<unset>`. On an opt-in projected key it is the PROXY'S own
 *  default, informational only (never projected). */
interface DefaultSpec<K extends ConfigKey = ConfigKey> {
  defaultValue?: NonNullable<CopilotEnvConfigData[K]>;
}

/** How a change takes effect, for `agent config` set/del's notice: the generic restart hint
 *  XOR a bespoke hint XOR neither (projected shapes already get the restart hint; anything
 *  else applies immediately). */
type ApplySpec =
  | {
    /** Read by `agent start`'s launch wiring (NOT projected into the proxy config.json),
     *  yet still applied only when a daemon launches -- so a change deserves the same
     *  restart hint the projected keys get. */
    restartToApply: true;
    applyHint?: undefined;
  }
  | {
    /** Printed by `agent config` set/del INSTEAD of the proxy-restart hint, for keys that
     *  apply through some other mechanism than a daemon launch. */
    applyHint: string;
    restartToApply?: undefined;
  }
  | { restartToApply?: undefined; applyHint?: undefined };

/** Shared by the two projected shapes below. */
interface ProjectedKeyFields {
  /** Every projected key is listed under the one section that means "restart the daemon
   *  to apply"; the internal shape excludes it, so the grouping rule is a compile check. */
  section: typeof PROJECTED_SECTION;
  /** Where in the proxy config.json a projected value lands: a non-empty key path into the
   *  document (default: `[key]`, i.e. the storage key at the top level). Set it when the
   *  proxy renamed or nested its key while our storage key stays put (a rename there would
   *  need a store migration). */
  proxyPath?: ProxyConfigPath;
  /** Oldest proxy version that reads this key (where upstream introduced it). `agent config
   *  --set` warns when the installed proxy is older, since the projection would be a silent
   *  no-op until the float catches up. Unset = read by every version above our floor. */
  sinceProxyVersion?: string;
}

/** A copilot-env-internal key: our own code reads it; nothing is written into the proxy
 *  config.json for it. */
type InternalConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & DefaultSpec<K>
  & ApplySpec
  & {
    /** Which `--help` section lists the key: any but the projected keys' own. */
    section: Exclude<ConfigSection, typeof PROJECTED_SECTION>;
    proxyDefault?: undefined;
    proxyProjected?: undefined;
    proxyPath?: undefined;
    sinceProxyVersion?: undefined;
  };

/** Force-projected into the proxy config.json at `agent start` as `stored ?? proxyDefault`
 *  (always written). Use for keys copilot-env has an opinion on. `proxyDefault` doubles as
 *  the rendered default. */
type ForceProjectedConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & ApplySpec
  & ProjectedKeyFields
  & {
    proxyDefault: NonNullable<CopilotEnvConfigData[K]>;
    defaultValue?: undefined;
    proxyProjected?: undefined;
  };

/** Opt-in projection: written into the proxy config.json ONLY while our store holds a value
 *  (at its `proxyPath`), leaving the proxy's own default untouched otherwise. A previously
 *  written value is cleared again once the key is unset -- ownership-tracked per daemon home
 *  (see applyDefaultConfig in src/copilot_api/launch.ts). Use for keys we merely expose
 *  without overriding. */
type OptInProjectedConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & DefaultSpec<K>
  & ApplySpec
  & ProjectedKeyFields
  & {
    proxyProjected: true;
    proxyDefault?: undefined;
  };

/** One config key. The registry literal's `as const satisfies` rejects exactly these shapes
 *  at compile time: `proxyDefault` combined with `proxyProjected`; `proxyPath` or
 *  `sinceProxyVersion` on a non-projected entry; a projected entry outside the "Proxy
 *  features" section or a non-projected entry inside it; a force-projected entry with a
 *  `defaultValue` (`proxyDefault` is its source); and `restartToApply` combined with
 *  `applyHint`. Distributed over ConfigKey so each entry's schema, parse, and default must
 *  fit ITS key's value type. */
export type ConfigKeyDef = {
  [K in ConfigKey]:
    | InternalConfigKeyDef<K>
    | ForceProjectedConfigKeyDef<K>
    | OptInProjectedConfigKeyDef<K>;
}[ConfigKey];

/** The built-in default a read site applies when `def` is unset (`defaultValue`, else
 *  `proxyDefault`), or undefined when unset is itself the default. */
export function configDefaultValue(def: ConfigKeyDef): ConfigValue | undefined {
  return def.defaultValue ?? def.proxyDefault;
}

/** Whether a registry entry is written into the proxy config.json at `agent start` (either
 *  force-projected with a default, or opt-in projected when set). */
export function isProxyProjected(def: ConfigKeyDef): boolean {
  return def.proxyDefault !== undefined || def.proxyProjected === true;
}

// --- Value domains. Each key's accepted domain is stated ONCE, as the valibot schema on
// its registry entry: CONFIG_SCHEMA (below the registry) folds those schemas into the
// lenient read schema, and each `--set` parse is derived from the same schema here (coerce
// the CLI string, then v.parse), so the write and read domains can never disagree again.

/** A key's value domain: the schema plus the `--set` parser derived from it. Spread into
 *  a registry entry (`...BOOL_DOMAIN`). */
interface ConfigDomain<T extends ConfigValue> {
  schema: v.GenericSchema<unknown, T>;
  parse: (raw: string) => T;
  /** The table's `[type]` label for values of this domain. */
  type: string;
}

/** `coerce` only turns the CLI string into the value type (with its own grammar message);
 *  the DOMAIN checks and their friendly messages live on the schema's actions. */
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

/** `unit` names the label (`seconds`, `days`); without one the range itself is the label. */
function wholeNumberDomain(min: number, max: number, unit?: string): ConfigDomain<number> {
  const range = (issue: { input: unknown }) =>
    `must be between ${min} and ${max}, got ${issue.input}`;
  // The coercion grammar only lets digits through, so the sole non-integer reaching
  // v.integer is an overflow's Infinity -- the range message fits it too.
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
  // As above: the grammar bans signs/exponents/NaN, so v.finite only ever sees an
  // overflow's +Infinity -- an over-the-ceiling value.
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
  // Membership is checked here, like BOOL_DOMAIN's words, so the rejection can echo the
  // ORIGINAL raw input rather than the trimmed/lowercased coercion the schema would see.
  (raw) => {
    const t = raw.trim().toLowerCase();
    if (!PASSTHROUGH_VALUES.some((a) => a === t)) {
      throw new Error(`expected one of ${PASSTHROUGH_VALUES.join("|")}, got '${raw}'`);
    }
    return t;
  },
  PASSTHROUGH_VALUES.join("|"),
);

/** Any non-empty string; `type` names what the string is (a model id, a version). */
function nonEmptyDomain(type: string): ConfigDomain<string> {
  return domain(
    v.pipe(v.string(), v.trim(), v.minLength(1, "expected a non-empty value")),
    (raw) => raw,
    type,
  );
}
const MODEL_ID_DOMAIN = nonEmptyDomain("model id");
const PROXY_VERSION_DOMAIN = nonEmptyDomain("version|tag");

/** The `integration-id` value domain (see INTEGRATION_ID_RE). The rejection message is a
 *  FIXED string that never echoes the value: it goes into HTTP headers, and junk pasted
 *  here can be anything -- a token included. On read, an invalid stored pin falls back to
 *  undefined = unset, so reads degrade to the per-credential probe rather than baking a
 *  header-splitting value. */
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

/** The public OpenRouter price list `agent cost` prices at: the `pricing-url` built-in.
 *  Owned here rather than in src/usage/pricing.ts because this module sits in the daemon
 *  shims' import closure and the usage layer must not (test/installer_pinning.test.ts). */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** THE price-list URL rule, for the `--pricing-url` flag and the stored `pricing-url` key
 *  alike: an absolute https URL with no userinfo (fetch refuses a URL carrying
 *  `user:password@`, so such a value could only fail at run time; a token belongs in the
 *  query). Returns the rejection, else null. Both rejections are FIXED strings that never
 *  echo the value, because a custom price-list URL may carry credentials. */
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

/** The price-list URL in its canonical spelling (`new URL().href`: lowercase scheme and
 *  host), so the fetch's own https check and the digest that keys the price cache see one
 *  form; throws the fixed rejection otherwise. */
export function canonicalPricingUrl(raw: string): string {
  const rejection = pricingUrlRejection(raw);
  if (rejection !== null) throw new Error(rejection);
  return new URL(raw).href;
}

/** The `pricing-url` value domain: the one rule above on the schema, so `--set` and a
 *  stored value obey it alike. */
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

/** The single source of truth for config keys, ordered ALPHABETICALLY by CLI name (the
 *  `--get` display order, and the order within each `--help` section; a test pins it, so
 *  insert new keys in place). */
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
    // The proxy's OWN default, which DEFAULT_WEB_SEARCH_MODEL in web_search.ts matches (that
    // module imports this one, so it cannot be referenced here); a registry test pins the two.
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
    // Storage key kept from the proxy's pre-1.14 flat key (renaming it would need a store
    // migration); the projection lands at the nested key the proxy reads today.
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

/** A registry CLI key name; the configDefault* accessors take this instead of a bare
 *  string so a typo'd key is a compile error, not a module-load throw. */
export type ConfigCli = (typeof CONFIG_REGISTRY_LITERAL)[number]["cli"];

/** The registry literal's storage-key union, pinned below to be exactly ConfigKey. */
type RegistryStorageKey = (typeof CONFIG_REGISTRY_LITERAL)[number]["key"];

/** Compile pin: the mapped-record parameter must carry EVERY stored config key.
 *  Exported only for the @ts-expect-error pin tests. */
export type TotalOverConfigKeys<Pin extends { [K in ConfigKey]: K }> = Pin;

/** Registry keys === ConfigKey, both directions. Missing: every CopilotEnvConfigData field
 *  is optional, so a key omitted from CONFIG_REGISTRY_LITERAL would still compile -- written
 *  by set() yet silently stripped by the folded CONFIG_SCHEMA on every read; this pin makes
 *  the omission a compile error naming the key. Extra: ConfigKeyDefCore's `key: K` already
 *  rejects a storage key outside CopilotEnvConfigData at its own entry. */
type _RegistryIsTotalOverConfigKeys = TotalOverConfigKeys<{ [K in RegistryStorageKey]: K }>;

/** The literal list above, widened so consumers see the uniform ConfigKeyDef shape. */
export const CONFIG_REGISTRY: readonly ConfigKeyDef[] = CONFIG_REGISTRY_LITERAL;

/** Lenient read wrapper: the field validates the value we own and FALLS BACK to undefined
 *  (treated as "unset" -> default by callers) rather than throwing on a bad/ill-typed
 *  stored value, so a hand-mangled file still reads. */
function lenientField(
  schema: v.GenericSchema<unknown, ConfigValue>,
): v.GenericSchema<unknown, ConfigValue | undefined> {
  return v.fallback(v.optional(schema), undefined);
}

/**
 * The lenient READ schema, folded from the registry's per-key domains -- so it covers
 * exactly the registry's keys by construction, and a key can never be write-only again.
 * Exported for the settings-bundle parser (src/agents/transfer.ts): it reuses this schema's
 * per-key VALUE validation and hardens the leniency into strict rejections at its own trust
 * boundary.
 *
 * The fromEntries fold erases the key-to-value-type correlation that ConfigKeyDefCore
 * already enforces per entry (each schema's output IS its key's declared field type), so
 * the assertion below only restates what the registry's `satisfies` checked.
 */
export const CONFIG_SCHEMA = v.object(
  Object.fromEntries(CONFIG_REGISTRY.map((def) => [def.key, lenientField(def.schema)])),
) as v.GenericSchema<unknown, CopilotEnvConfigData>;

/** The `codex-host` read for a stored value on `platform`: stored else the built-in
 *  default, and always false on Windows (no farm without POSIX symlinks), whatever a
 *  bundle imported. Shared by the accessor and the settings-import plan. */
export function codexHostEnabledFor(
  stored: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  return stored ?? configDefaultBoolean("codex-host");
}

/** Look up a registry entry by its CLI (kebab) name. */
export function configKeyDef(cli: string): ConfigKeyDef | undefined {
  return CONFIG_REGISTRY.find((d) => d.cli === cli.trim());
}

/** The registry's built-in numeric default for `cli` (configDefaultValue's resolution), for
 *  the CopilotEnvConfig accessors that apply it. A missing or non-numeric entry is a
 *  programmer error. */
export function configDefaultNumber(cli: ConfigCli): number {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "number") {
    throw new Error(`config key '${cli}' has no numeric built-in default`);
  }
  return value;
}

/** The registry's built-in string default for `cli` (same contract as configDefaultNumber). */
export function configDefaultString(cli: ConfigCli): string {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "string") {
    throw new Error(`config key '${cli}' has no string built-in default`);
  }
  return value;
}

/** The registry's built-in boolean default for `cli` (same contract as configDefaultNumber). */
export function configDefaultBoolean(cli: ConfigCli): boolean {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "boolean") {
    throw new Error(`config key '${cli}' has no boolean built-in default`);
  }
  return value;
}

/** One projected proxy config.json value, addressed by its key path into the document
 *  (nested paths follow upstream renames like `contextManagement.responses`). */
export interface ProjectedProxyEntry {
  path: ProxyConfigPath;
  value: ConfigValue;
  /** True for opt-in entries: present only while the preference is set, and ownership-tracked
   *  per daemon home so a later unset clears OUR leftover write (see applyDefaultConfig /
   *  ProxyProjectionState). */
  optIn: boolean;
}

/** Every path an OPT-IN entry projects to, whether currently set or not -- the ownership
 *  ALLOWLIST: applyDefaultConfig only ever deletes recorded paths inside this set, so a
 *  recorded path the registry does not (or no longer does) project opt-in is left alone in
 *  config.json and simply falls out of the record. */
export function optInProxyConfigPaths(): ProxyConfigPath[] {
  const out: ProxyConfigPath[] = [];
  for (const def of CONFIG_REGISTRY) {
    if (def.proxyProjected === true) out.push(def.proxyPath ?? [def.key]);
  }
  return out;
}

/**
 * The proxy `config.json` values this store projects, each resolved to its stored preference
 * or its built-in proxy default and addressed by its `proxyPath` (default: the storage key at
 * the top level). `agent start` writes these into the daemon's config before launch (see
 * applyDefaultConfig in src/copilot_api/launch.ts).
 */
export function projectedProxyConfig(
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): ProjectedProxyEntry[] {
  const prefs = config.read();
  const out: ProjectedProxyEntry[] = [];
  for (const def of CONFIG_REGISTRY) {
    const stored = prefs[def.key];
    if (def.proxyDefault !== undefined) {
      // Force-projected: always written, falling back to copilot-env's chosen default.
      out.push({
        path: def.proxyPath ?? [def.key],
        value: stored ?? def.proxyDefault,
        optIn: false,
      });
    } else if (def.proxyProjected === true && stored !== undefined) {
      // Opt-in: written only when set, so the proxy's own default stands otherwise.
      out.push({ path: def.proxyPath ?? [def.key], value: stored, optIn: true });
    }
  }
  return out;
}

/** How a stored value prints (`--set`'s echo, `--get <key>`, the table). */
export function formatConfigValue(value: ConfigValue): string {
  return String(value);
}

/** Whether `def`'s stored value is INERT on `platform`: a POSIX-only key's stored value (an
 *  imported bundle's) does nothing on Windows -- every read site sees the built-in default
 *  there. The table and `--get <key>` name such a value instead of hiding it. */
export function isStoredValueInert(
  def: ConfigKeyDef,
  data: CopilotEnvConfigData,
  platform: NodeJS.Platform,
): boolean {
  return def.posixOnly === true && platform === "win32" && data[def.key] !== undefined;
}

/**
 * Read/write helper for `preferences.json`, mirroring CopilotEnvState/RunState on top
 * of CopilotApiConfig (sorted keys, 0600, atomic rename, Windows EPERM/EBUSY retry).
 */
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

  /** Current preferences; absent/ill-typed/out-of-range fields come back `undefined`.
   *  The store read is STRICT: an unreadable file THROWS instead of reading as "no
   *  preference set" -- wiring (wire-mcp), the proxy float pin, and the port knobs
   *  are decisions that must never act on an unproven empty. Junk content still
   *  degrades per-field via the lenient schema. */
  read(): CopilotEnvConfigData {
    return v.parse(CONFIG_SCHEMA, this.store.loadStrict());
  }

  /** read() with an unreadable store degraded to "no preferences" (built-in
   *  defaults). ONLY for the best-effort background gates: the in-daemon idle
   *  watchdog's interval tick (idle_watchdog.ts, where a throw would kill the
   *  serving daemon) and the autoupdate preflight. Their flatten direction is the
   *  safe one -- the opt-in lifecycle stays off, the default window applies, no
   *  self-update runs -- warned by load(); every other preference read stays strict. */
  private readDegraded(): CopilotEnvConfigData {
    return v.parse(CONFIG_SCHEMA, this.store.load());
  }

  /** Whether the managed proxy lifecycle (auto-start + idle auto-stop) is enabled.
   *  Watchdog-reachable, so the read degrades (see readDegraded). */
  autoStartEnabled(): boolean {
    return this.readDegraded().autoStart ?? configDefaultBoolean("auto-start");
  }

  /** Whether the once-a-day self-update preflight runs (default off). Preflight-reachable
   *  (a best-effort background path), so the read degrades like auto-start's. */
  autoUpdateEnabled(): boolean {
    return this.readDegraded().autoUpdate ?? configDefaultBoolean("auto-update");
  }

  /** Whether the Claude Desktop config-library wiring is reconciled ON (default) -- entries
   *  kept for the default + every profile while the app is installed -- or OFF (the profile
   *  entries swept, the default's left in place). Read by every Desktop reconcile
   *  (src/claude/desktop.ts). */
  claudeDesktopEnabled(): boolean {
    return this.read().claudeDesktop ?? configDefaultBoolean("claude-desktop");
  }

  /** Whether the per-host CODEX_HOME farm is wanted (stored else default; Windows: false). */
  codexHostEnabled(platform: NodeJS.Platform = process.platform): boolean {
    return codexHostEnabledFor(this.read().codexHost, platform);
  }

  /** Whether the patched Codex model catalog is enabled (opt-in, default off). */
  codexModelCatalogEnabled(): boolean {
    return this.read().codexModelCatalog ?? configDefaultBoolean("codex-model-catalog");
  }

  /** Whether `agent env` defines the opt-in cl/co/cx launcher functions (default off). */
  launchersEnabled(): boolean {
    return this.read().launchers ?? configDefaultBoolean("launchers");
  }

  /** Whether direct Claude wiring registers the MCP server + WebSearch deny (default ON). */
  wireMcpEnabled(): boolean {
    return this.wireMcpResolved().value;
  }

  /** wire-mcp with its provenance, resolved from ONE snapshot -- for status output that
   *  prints value and source together (`agent mcp`) and must never show a torn pair. */
  wireMcpResolved(): { value: boolean; source: "stored" | "default" } {
    const stored = this.read().wireMcp;
    return stored === undefined
      ? { value: configDefaultBoolean("wire-mcp"), source: "default" }
      : { value: stored, source: "stored" };
  }

  /** verify-provenance, stored else default. On the STRICT read on purpose: an
   *  unreadable preference store fails the update rather than reading as "off". */
  verifyProvenanceEnabled(): boolean {
    return this.read().verifyProvenance ?? configDefaultBoolean("verify-provenance");
  }

  /**
   * The pinned Copilot-Integration-Id, or null when unset / `auto` (the probe decides).
   * The sentinel `auto` reads as null so `--set integration-id auto` restores probing
   * without a separate `--del`.
   */
  pinnedIntegrationId(): string | null {
    const value = this.read().integrationId;
    return value === undefined || value.toLowerCase() === "auto" ? null : value;
  }

  /** PAT passthrough override for `agent start`: `on` -> true, `off` -> false, `auto`/unset
   *  -> undefined (the caller decides from the credential's provider/token shape). */
  passthroughOverride(): boolean | undefined {
    const value = this.read().passthrough;
    if (value === "on") return true;
    if (value === "off") return false;
    return undefined;
  }

  /** The configured default proxy port (`agent config --set port`), else the registry
   *  built-in. */
  defaultPort(): number {
    return this.read().port ?? configDefaultNumber("port");
  }

  /** The configured lower bound of the allowed proxy port range, else the registry built-in. */
  minPort(): number {
    return this.read().minPort ?? configDefaultNumber("min-port");
  }

  /** The configured upper bound of the allowed proxy port range, else the registry built-in. */
  maxPort(): number {
    return this.read().maxPort ?? configDefaultNumber("max-port");
  }

  /** Whether `agent start` fails on a busy default port instead of auto-incrementing. */
  strictPortEnabled(): boolean {
    return this.read().strictPort ?? configDefaultBoolean("strict-port");
  }

  /** Whether the proxy writes request logs under `<home>/logs`. */
  proxyLogsEnabled(): boolean {
    return this.read().proxyLogs ?? configDefaultBoolean("proxy-logs");
  }

  /**
   * Idle auto-stop window in whole seconds (`0` disables), else the registry built-in.
   * The per-invocation env layer above this (COPILOT_API_IDLE_TIMEOUT) stays at the read
   * site (src/scripts/idle_watchdog.ts), per the flag/env > stored > default precedence.
   * Watchdog-reachable, so the read degrades (see readDegraded).
   */
  idleTimeoutSeconds(): number {
    return this.readDegraded().idleTimeout ?? configDefaultNumber("idle-timeout");
  }

  /** The price-list URL `agent cost` fetches: stored, else the registry built-in. The
   *  per-run `--pricing-url` layer above this stays at the read site (resolvePricingUrl in
   *  src/usage/cost.ts), per the flag > stored > default precedence. */
  pricingUrl(): string {
    return this.read().pricingUrl ?? configDefaultString("pricing-url");
  }

  /**
   * The stored `update-cooldown` in whole days, else null -- the registry's built-in is
   * "none (immediate)". Autoupdate layers its own policy default on top
   * (effectiveUpdateCooldownDays in src/autoupdate/state.ts).
   */
  updateCooldownDays(): number | null {
    return this.read().updateCooldown ?? null;
  }

  /**
   * The stored web-search model id, else null. The defaults are owned by the read sites
   * (the proxy's own default on the proxy path; DEFAULT_WEB_SEARCH_MODEL in web_search.ts
   * on the MCP path -- that module imports this one, so the registry can't reference it).
   */
  messageApiWebSearchModel(): string | null {
    return this.read().messageApiWebSearchModel ?? null;
  }

  /**
   * Merge `patch`. A null/undefined value (or a blank string) deletes its key (reverting to
   * the default); booleans/numbers are stored as-is, strings are trimmed.
   */
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

  /** Delete one key (revert it to its default). */
  del(key: ConfigKey): void {
    this.set({ [key]: undefined });
  }
}
