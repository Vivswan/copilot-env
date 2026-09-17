// The preference store behind `agent config`: one key registry, every key scoped to a profile or to
// the machine, and ONE precedence rule (resolveSettingIn): explicit flag > the profile's own value >
// the global value > the built-in default. The store holds a global map and one section per
// profile; the type keeps a profile-scoped key out of the global map.
import * as path from "node:path";
import * as v from "valibot";
import { type CopilotApiConfig, ensureDict } from "./config.ts";
import { rootStateStore } from "./state_store.ts";
import type { Profile, ProfileName } from "./profile.ts";
import { isRecord } from "../utils/json.ts";
import { SECONDS_PER_DAY } from "../utils/time.ts";

export type PassthroughPref = "auto" | "on" | "off";

/** Which agents' configs carry the credential VALUE (`static-key`); the rest name the resolver command. */
export const STATIC_KEY_SCOPES = ["none", "claude", "codex", "all"] as const;
export type StaticKeyScope = (typeof STATIC_KEY_SCOPES)[number];
/** An agent a scope can single out; the same ids as src/agents/configure.ts's ManagedAgentId. */
export type StaticKeyAgent = Exclude<StaticKeyScope, "none" | "all">;
const STATIC_KEY_DEFAULT: StaticKeyScope = "none";

/** Every key's value type, keyed by its name: the CLI spelling AND the stored JSON key. A dotted
 *  name's first segment is its group (the config menu); a flat name is a profile key. Each key's
 *  meaning is its registry entry's `describe`; an absent or ill-typed stored field reads back as
 *  `undefined`, which the resolution treats as "apply the next layer". */
export interface ConfigValueTypes {
  "claude.desktop": boolean;
  "claude.wire-mcp": boolean;
  "codex.home": string;
  "codex.host": boolean;
  "codex.model-catalog": boolean;
  "cost.credits-target": number;
  "cost.pricing-url": string;
  "daemon.auto-start": boolean;
  "daemon.idle-timeout": number;
  "daemon.logs": boolean;
  "daemon.max-port": number;
  "daemon.min-port": number;
  "daemon.port": number;
  "daemon.release-cooldown": number;
  "daemon.strict-port": boolean;
  "daemon.version": string;
  "host": string;
  "identity": string;
  "passthrough": PassthroughPref;
  "proxy.alpha-search.codex-priority": boolean;
  "proxy.alpha-search.model": string;
  "proxy.claude-auto-model": string;
  "proxy.claude-token-multiplier": number;
  "proxy.message-websearch-model": string;
  "proxy.messages-api": boolean;
  "proxy.responses.context-management": boolean;
  "proxy.responses.websearch": boolean;
  "proxy.responses.websocket": boolean;
  "proxy.small-model": string;
  "shell.launchers": boolean;
  "static-key": StaticKeyScope;
  "update.auto": boolean;
  "update.cooldown": number;
  "update.verify-provenance": boolean;
}

export type ConfigKey = keyof ConfigValueTypes;
export type ConfigValue = boolean | number | string;

/**
 * Who a key belongs to:
 *   profile         -> the value follows the credential; lives in the profile's section only
 *   profile-default -> the global value is every profile's default; a profile may override it
 *   global          -> how this machine runs; a profile never carries it
 */
export type ConfigScope = "profile" | "profile-default" | "global";

/** A flat name IS a profile key and a grouped name never is, so a key cannot land as global under
 *  a flat name or as profile-only under a group. */
type ScopeFor<K extends ConfigKey> = K extends `${string}.${string}`
  ? Exclude<ConfigScope, "profile">
  : "profile";

/** The menu tree's first level; a dotted key's prefix must be one of these (pinned below). */
export const CONFIG_GROUPS = [
  "profile",
  "daemon",
  "proxy",
  "codex",
  "claude",
  "shell",
  "update",
  "cost",
] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

type GroupOf<K extends ConfigKey> = K extends `${infer G}.${string}` ? G : "profile";
type AssertTrue<T extends true> = T;
type _EveryGroupIsKnown = AssertTrue<GroupOf<ConfigKey> extends ConfigGroup ? true : false>;

/** The group a key displays under. */
export function configGroup(key: ConfigKey): ConfigGroup {
  const dot = key.indexOf(".");
  // The pin above proves every prefix is a group; the find only restates it for the type.
  return CONFIG_GROUPS.find((g) => g === (dot < 0 ? "profile" : key.slice(0, dot))) ?? "profile";
}

/** The keys the proxy reads from its config.json; only these may be projected. */
type ProxyGroupKey = Extract<ConfigKey, `proxy.${string}`>;

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

/** Direct's default identity (integration_identity.ts): Codex CLI impersonation with NO id header.
 *  Owned here, beside the pin domain that refuses it, because this module sits in the daemon shims'
 *  import closure and the identity module does not. */
export const CODEX_IDENTITY_NAME = "codex";

/** A key path into the proxy config.json document, e.g. `["contextManagement", "responses"]`. */
export type ProxyConfigPath = readonly [string, ...string[]];

/** The generic ties `schema` and `parse` to the key's OWN value type, so a key can never be write-only
 *  again (accepted by `--set`, stripped by the folded read schema). `scope` is required, and its type
 *  follows the name (ScopeFor), so a new key without one, or grouped as a profile key, does not compile. */
interface ConfigKeyDefCore<K extends ConfigKey = ConfigKey> {
  key: K;
  scope: ScopeFor<K>;
  describe: string;
  /** The config table's `[type]` cell: `bool`, `1-65535`, `model id`, ... */
  type: string;
  /** The single source CONFIG_SCHEMA folds; `parse` is derived from it by the domain builders. */
  schema: v.GenericSchema<unknown, ConfigValueTypes[K]>;
  parse: (raw: string) => ConfigValueTypes[K];
  /** `agent config --set` refuses the key on Windows. */
  posixOnly?: true;
}

/** Absent when "unset" IS the default (a disabled override, a floating pin), rendered `<unset>`. On an
 *  opt-in projected key it is the PROXY'S own default, informational only and never projected. */
interface DefaultSpec<K extends ConfigKey = ConfigKey> {
  defaultValue?: ConfigValueTypes[K];
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
  /** The proxy's own key in config.json (an external contract, so it never follows our name). */
  proxyPath: ProxyConfigPath;
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
    proxyDefault?: undefined;
    proxyProjected?: undefined;
    proxyPath?: undefined;
    sinceProxyVersion?: undefined;
  };

/** Always written at `agent start` as `resolved ?? proxyDefault`, for keys copilot-env has an opinion on. */
type ForceProjectedConfigKeyDef<K extends ConfigKey = ConfigKey> =
  & ConfigKeyDefCore<K>
  & ApplySpec
  & ProjectedKeyFields
  & {
    proxyDefault: ConfigValueTypes[K];
    defaultValue?: undefined;
    proxyProjected?: undefined;
  };

/** Written only while a value resolves for the daemon's profile, so the proxy's own default stands
 *  otherwise. A previous write is cleared once the key is unset, ownership-tracked per daemon home
 *  (applyDefaultConfig in launch.ts). */
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
 *    a key without `scope`, or a flat key that is not `profile`  -> ScopeFor
 *    proxyDefault + proxyProjected                                -> the two projection shapes are exclusive
 *    a projected key outside the `proxy` group                    -> only the proxy's knobs land in config.json
 *    an unprojected key inside the `proxy` group                  -> it would promise a projection that never happens
 *    force-projected + defaultValue                               -> proxyDefault is its source
 *    restartToApply + applyHint                                   -> one notice per key */
export type ConfigKeyDef = {
  [K in ConfigKey]: K extends ProxyGroupKey
    ? ForceProjectedConfigKeyDef<K> | OptInProjectedConfigKeyDef<K>
    : InternalConfigKeyDef<K>;
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

/** A closed word list. Membership is checked in the coercion so the rejection echoes the ORIGINAL
 *  input, not the lowercased form the schema would see. */
function picklistDomain<const T extends string>(values: readonly T[]): ConfigDomain<T> {
  return domain(
    v.picklist(values),
    (raw) => {
      const t = raw.trim().toLowerCase();
      if (!values.some((a) => a === t)) {
        throw new Error(`expected one of ${values.join("|")}, got '${raw}'`);
      }
      return t;
    },
    values.join("|"),
  );
}

const PASSTHROUGH_DOMAIN = picklistDomain(PASSTHROUGH_VALUES);
const STATIC_KEY_DOMAIN = picklistDomain(STATIC_KEY_SCOPES);

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
 *  as unset, so reads fall back to the probe rather than baking a header-splitting value.
 *  `codex` is refused because that identity IS the absence of the header: a pin is always sent as
 *  the header's value, so no pin can express it, and `auto` already selects it whenever Direct
 *  accepts the credential under it. */
const INTEGRATION_ID_DOMAIN: ConfigDomain<string> = domain(
  v.pipe(
    v.string(),
    v.trim(),
    v.regex(
      INTEGRATION_ID_RE,
      "expected a header-safe identity token (1-64 chars of [A-Za-z0-9._-]) or `auto`",
    ),
    v.check(
      (id) => id.toLowerCase() !== CODEX_IDENTITY_NAME,
      `\`${CODEX_IDENTITY_NAME}\` is Direct's default identity (it sends no integration-id header) ` +
        "and cannot be pinned; `auto` already selects it when the credential accepts it",
    ),
  ),
  (raw) => raw,
  "id|auto",
);

/** The one validator behind `agent config --set identity` and `agent auth --identity`. */
export function parseIntegrationIdPin(raw: string): string {
  return INTEGRATION_ID_DOMAIN.parse(raw);
}

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

/** `auto` = the derived home. The path is used as typed: `~` is the shell's expansion and never
 *  happens here, so `~/x` is refused rather than written as a directory named `~` under the cwd. On
 *  Windows a rooted-but-driveless `\Codex` is refused too: path.isAbsolute accepts it, yet it lands on
 *  whichever drive the process runs from. */
const CODEX_HOME_AUTO = "auto";
function isFullyQualifiedPath(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  return process.platform !== "win32" || path.parse(p).root.length > 1;
}
const ABSOLUTE_PATH_DOMAIN: ConfigDomain<string> = domain(
  v.pipe(
    v.string(),
    v.trim(),
    v.check(
      (p) => p.toLowerCase() === CODEX_HOME_AUTO || isFullyQualifiedPath(p),
      "expected an absolute path or `auto` (`~` is not expanded; on Windows the drive is required)",
    ),
  ),
  (raw) => raw,
  "path|auto",
);

/** `auto` (probed per credential by the select*IdentityAndHost pair, integration_identity.ts) or an https origin
 *  (a GitHub Enterprise Server serves Copilot at `https://copilot-api.<ghe-domain>`). Stored as the
 *  origin alone: a path, query, or userinfo is a typo, not a host. */
export const COPILOT_HOST_AUTO = "auto";

/** THE one loopback test for a URL's hostname (as `new URL().hostname` spells it): the whole
 *  127.0.0.0/8 block, `::1` and its IPv4-mapped forms (bracketed), and `localhost` with or without
 *  the trailing dot. Owned here, beside the `host` validator, so isDirectBaseUrl
 *  (integration_identity.ts) and the validator can never disagree on what a Copilot host is not. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost") return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1") return true;
  // An IPv4-mapped address arrives as the URL parser serialises it: two hex groups (`::ffff:7f00:1`),
  // or dotted when hand-spelled elsewhere.
  const mapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const v4 = mapped !== null
    ? `${Number.parseInt(mapped[1] ?? "0", 16) >> 8}.0.0.0`
    : bare.startsWith("::ffff:")
    ? bare.slice("::ffff:".length)
    : bare;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function copilotHostRejection(raw: string): string | null {
  const expected = "expected `auto` or an https:// origin";
  if (!URL.canParse(raw)) return expected;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return expected;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return "expected an https:// origin without a path or query";
  }
  // A loopback origin is the proxy's shape, never a Copilot host (isDirectBaseUrl agrees).
  if (isLoopbackHostname(url.hostname)) return "expected an https:// origin that is not loopback";
  return null;
}

const COPILOT_HOST_DOMAIN: ConfigDomain<string> = domain(
  v.pipe(
    v.string(),
    v.trim(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      if (dataset.value.toLowerCase() === COPILOT_HOST_AUTO) return COPILOT_HOST_AUTO;
      const rejection = copilotHostRejection(dataset.value);
      if (rejection !== null) {
        addIssue({ message: rejection });
        return NEVER;
      }
      return new URL(dataset.value).origin;
    }),
  ),
  (raw) => raw,
  "url|auto",
);

const WIRING_HINT =
  "Applies at the next `agent init` / `agent claude` / `agent codex` / `agent profile` wiring";

/** Ordered ALPHABETICALLY by key: that is `--help`'s order within a group, and a test pins it, so
 *  insert new keys in place. */
const CONFIG_REGISTRY_LITERAL = [
  {
    key: "claude.desktop",
    scope: "global",
    describe: "Wire Claude Desktop's config library; false unwires profiles only",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint:
      "Applies at the next `agent init`/`agent claude`/`agent profile` wiring; setting the key writes no Desktop files itself.",
  },
  {
    key: "claude.wire-mcp",
    scope: "global",
    describe: "Wire the copilot-env MCP server + WebSearch deny on direct writes",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint: "Applies at the next `agent claude`/`agent init` direct wiring.",
  },
  {
    key: "codex.home",
    scope: "global",
    describe: "Root of the Codex home copilot-env writes and exports; auto is ~/.codex, or the " +
      "shell's CODEX_HOME (never our own farm export) while codex.host is off; codex.host farms " +
      "under it",
    ...ABSOLUTE_PATH_DOMAIN,
    defaultValue: CODEX_HOME_AUTO,
    applyHint:
      "Applies at the next `agent codex`/`agent init` wiring (the config write lands there) and to the " +
      "shell on the next `agent` command, whose wrapper re-evals `agent env`; a removal reaches new shells only.",
  },
  {
    key: "codex.host",
    scope: "global",
    describe: "Per-host CODEX_HOME at <codex.home>/hosts/<hostname> via `agent env` (Linux/macOS)",
    ...BOOL_DOMAIN,
    defaultValue: false,
    posixOnly: true,
    applyHint:
      "Applies at the next `agent codex`/`agent init` wiring, which builds or removes the farm.",
  },
  {
    key: "codex.model-catalog",
    scope: "global",
    describe: "Patched Codex model catalog with Copilot's real context windows",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next Codex auth refresh (within ~5 minutes) or `agent codex`/`agent init` wiring.",
  },
  {
    key: "cost.credits-target",
    scope: "global",
    describe:
      "Copilot AI credits (100 to the dollar) to stay under per month; unset paces against the plan's entitlement alone",
    ...wholeNumberDomain(1, MAX_CREDITS, "credits"),
    applyHint: "Applies to the next `agent credits` run.",
  },
  {
    key: "cost.pricing-url",
    scope: "global",
    describe: "OpenRouter models API URL for `agent cost`; `--pricing-url` overrides once",
    ...HTTPS_URL_DOMAIN,
    defaultValue: OPENROUTER_MODELS_URL,
    applyHint: "Applies to the next `agent cost` run.",
  },
  {
    key: "daemon.auto-start",
    scope: "global",
    describe: "Auto-start the proxy on agent open and auto-stop it when idle",
    ...BOOL_DOMAIN,
    defaultValue: false,
  },
  {
    key: "daemon.idle-timeout",
    scope: "global",
    describe: "Idle auto-stop window; 0 disables",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 3600,
    restartToApply: true,
  },
  {
    key: "daemon.logs",
    scope: "global",
    describe: "Proxy request logging under <home>/logs; false discards the writes",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    key: "daemon.max-port",
    scope: "global",
    describe: "Upper bound of the allowed proxy port range",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 65535,
    restartToApply: true,
  },
  {
    key: "daemon.min-port",
    scope: "global",
    describe: "Lower bound of the allowed proxy port range",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 1024,
    restartToApply: true,
  },
  {
    key: "daemon.port",
    scope: "global",
    describe: "Default proxy port; the next free one is used when busy",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 4141,
    restartToApply: true,
  },
  {
    key: "daemon.release-cooldown",
    scope: "global",
    describe: "Age a proxy release must reach before the float adopts it",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 7 * SECONDS_PER_DAY,
  },
  {
    key: "daemon.strict-port",
    scope: "global",
    describe: "Fail start on a busy port instead of auto-incrementing",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    key: "daemon.version",
    scope: "global",
    describe: "Pin the floated proxy to a version or tag; unset floats to the latest",
    ...PROXY_VERSION_DOMAIN,
  },
  {
    key: "host",
    scope: "profile",
    describe:
      "Copilot API host for every mode: `auto` probes api.githubcopilot.com and falls back to the account's designated host, or an https origin",
    ...COPILOT_HOST_DOMAIN,
    defaultValue: COPILOT_HOST_AUTO,
    applyHint:
      "Applies at the next `agent init`/`agent codex`/`agent claude` wiring and the next proxy start.",
  },
  {
    key: "identity",
    scope: "profile",
    describe: "Copilot-Integration-Id header to send; auto probes it per credential",
    ...INTEGRATION_ID_DOMAIN,
    defaultValue: "auto",
    applyHint: "Applies to Direct at the next `agent init`/`agent profile --add` (rewires the " +
      "agent configs) and to the profile's proxy at its next daemon launch (a running daemon " +
      "keeps its identity until restarted).",
  },
  {
    key: "passthrough",
    scope: "profile",
    describe: "Use a PAT-shaped token as the bearer directly; auto detects the token",
    ...PASSTHROUGH_DOMAIN,
    defaultValue: "auto",
    restartToApply: true,
  },
  {
    key: "proxy.alpha-search.codex-priority",
    scope: "profile-default",
    describe: "Prefer Codex for the proxy's /alpha/search (Codex search)",
    ...BOOL_DOMAIN,
    defaultValue: true,
    proxyProjected: true,
    proxyPath: ["alphaSearchCodexPriority"],
    sinceProxyVersion: "1.15.0",
  },
  {
    key: "proxy.alpha-search.model",
    scope: "profile-default",
    describe: "Responses model for /alpha/search when the requested model cannot search",
    ...MODEL_ID_DOMAIN,
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    proxyPath: ["alphaSearchModel"],
    sinceProxyVersion: "1.16.3",
  },
  {
    key: "proxy.claude-auto-model",
    scope: "profile-default",
    describe: "Model for Claude Code's background security-monitor requests; unset disables",
    ...MODEL_ID_DOMAIN,
    proxyProjected: true,
    proxyPath: ["claudeAutoModel"],
    sinceProxyVersion: "1.14.22",
  },
  {
    key: "proxy.claude-token-multiplier",
    scope: "profile-default",
    describe: "Multiplier the proxy applies when estimating Claude token usage",
    ...positiveDecimalDomain(MAX_TOKEN_MULTIPLIER),
    defaultValue: 1.15,
    proxyProjected: true,
    proxyPath: ["claudeTokenMultiplier"],
  },
  {
    key: "proxy.message-websearch-model",
    scope: "profile-default",
    describe: "Web-search model: proxy Messages-API path and MCP web_search tool",
    ...MODEL_ID_DOMAIN,
    // Must equal DEFAULT_WEB_SEARCH_MODEL in web_search.ts, which imports this module and so cannot be
    // referenced here; a registry test pins the two.
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    proxyPath: ["messageApiWebSearchModel"],
    applyHint:
      "The MCP web_search tool reads it on every call; the proxy surface at its next start.",
  },
  {
    key: "proxy.messages-api",
    scope: "profile-default",
    describe: "Proxy Messages-API (Anthropic-shaped) endpoint",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useMessagesApi"],
  },
  {
    key: "proxy.responses.context-management",
    scope: "profile-default",
    describe: "Proxy Responses-API server-side context management",
    ...BOOL_DOMAIN,
    defaultValue: false,
    proxyProjected: true,
    proxyPath: ["contextManagement", "responses"],
  },
  {
    key: "proxy.responses.websearch",
    scope: "profile-default",
    describe: "Proxy Responses-API web search",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useResponsesApiWebSearch"],
  },
  {
    key: "proxy.responses.websocket",
    scope: "profile-default",
    describe: "Proxy Responses-API over WebSocket instead of HTTP/SSE",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useResponsesApiWebSocket"],
  },
  {
    key: "proxy.small-model",
    scope: "profile-default",
    describe: "Small/fast model the proxy uses",
    ...MODEL_ID_DOMAIN,
    proxyDefault: "gpt-5-mini",
    proxyPath: ["smallModel"],
  },
  {
    key: "shell.launchers",
    scope: "global",
    describe: "Shell launchers cl / co / cx (+ clx / cox / cxx) in `agent env`",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint: "New shells pick a change up; the current one picks up an ENABLE on the next " +
      "`agent` command (a disable applies to new shells only).",
  },
  {
    key: "static-key",
    scope: "profile",
    describe: "Whose config carries the credential value itself, not a resolver command",
    ...STATIC_KEY_DOMAIN,
    defaultValue: STATIC_KEY_DEFAULT,
    applyHint: `${WIRING_HINT}. ` +
      "A baked value does not follow a credential change: re-run the wiring after `agent auth`.",
  },
  {
    key: "update.auto",
    scope: "global",
    describe: "Daily self-update on `agent start`, honoring update.cooldown",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next `agent start` (checked once a day); `agent update` updates now, `agent update --auto-status` shows the last check.",
  },
  {
    key: "update.cooldown",
    scope: "global",
    describe: "Min release age for updates; unset means none by hand, 7 for auto",
    ...wholeNumberDomain(0, MAX_DAYS, "days"),
  },
  {
    key: "update.verify-provenance",
    scope: "global",
    describe: "Verify `agent update` downloads against Sigstore provenance",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint:
      "Applies to the next `agent update` / autoupdate run; `agent update --no-verify` skips a single run.",
  },
] as const satisfies readonly ConfigKeyDef[];

type RegistryEntry = (typeof CONFIG_REGISTRY_LITERAL)[number];

/** Exported only for the @ts-expect-error pin tests. */
export type TotalOverConfigKeys<Pin extends { [K in ConfigKey]: K }> = Pin;

/** Every ConfigValueTypes key is optional in the stores, so a key omitted from the registry would
 *  still compile: written by set() yet silently stripped by CONFIG_SCHEMA on every read. This pin
 *  names the omission. */
type _RegistryIsTotalOverConfigKeys = TotalOverConfigKeys<
  { [K in RegistryEntry["key"]]: K }
>;

export const CONFIG_REGISTRY: readonly ConfigKeyDef[] = CONFIG_REGISTRY_LITERAL;

// --- the two maps, typed from the registry's scopes ---------------------------------------

type KeysOfScope<S extends ConfigScope> = Extract<RegistryEntry, { scope: S }>["key"];
export type ProfileKey = KeysOfScope<"profile">;
export type ProfileDefaultKey = KeysOfScope<"profile-default">;
export type GlobalKey = KeysOfScope<"global">;
/** What the global map may hold: never a profile key. */
export type GlobalMapKey = GlobalKey | ProfileDefaultKey;
/** What a profile's section may hold: never a global key. */
export type ProfileMapKey = ProfileKey | ProfileDefaultKey;

export type GlobalConfigData = { [K in GlobalMapKey]?: ConfigValueTypes[K] };
export type ProfileConfigData = { [K in ProfileMapKey]?: ConfigValueTypes[K] };

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

// The `agent config` commands a message may point at, spelled ONCE. The key is typed, so a renamed
// key cannot leave a stale hint behind, and test/config_key_lint.test.ts refuses a hand-spelled one.

function profileFlag(profile: Profile): string {
  return profile === null ? "" : ` --profile ${profile}`;
}

export function configSetCommand(key: ConfigKey, value: string, profile: Profile = null): string {
  return `agent config --set ${key} ${value}${profileFlag(profile)}`;
}

export function configDelCommand(key: ConfigKey, profile: Profile = null): string {
  return `agent config --del ${key}${profileFlag(profile)}`;
}

export function configGetCommand(key: ConfigKey, profile: Profile = null): string {
  return `agent config --get ${key}${profileFlag(profile)}`;
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

/** The store read once, then resolveSettingIn. */
export function resolveSetting<K extends ConfigKey>(
  key: K,
  opts: ResolveOptions<ConfigValueTypes[K]>,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): ResolvedSetting<ConfigValueTypes[K]> {
  return config.resolve(key, opts);
}

/** A stored value is what `--del` can revert: anything resolved from either map. */
export function isStoredSource(source: SettingSource): boolean {
  return source === "profile" || source === "global";
}

// --- registry lookups --------------------------------------------------------------------

/** The two Codex-home keys, folded ONCE for the derivation (src/codex/host.ts) and the
 *  settings-import plan, which resolves them from the bundle before the store is replaced. */
export interface CodexHomePrefs {
  /** The `codex.home` path; null for `auto` or unset, when the derivation starts at ~/.codex. */
  explicit: string | null;
  /** The `codex.host` farm is in effect. Always false on Windows whatever a bundle imported: no farm
   *  without POSIX symlinks. */
  hostFarm: boolean;
}

export function codexHomePrefsFor(
  stored: Pick<GlobalConfigData, "codex.home" | "codex.host">,
  platform: NodeJS.Platform = process.platform,
): CodexHomePrefs {
  const home = stored["codex.home"];
  return {
    explicit: home === undefined || home.toLowerCase() === CODEX_HOME_AUTO ? null : home,
    hostFarm: platform !== "win32" && (stored["codex.host"] ?? configDefaultBoolean("codex.host")),
  };
}

/** For a CLI string; undefined when it names no key. */
export function configKeyDef(key: string): ConfigKeyDef | undefined {
  return CONFIG_REGISTRY.find((d) => d.key === key.trim());
}

/** For a typed key: the totality pin above proves the entry exists. */
function registryEntry(key: ConfigKey): ConfigKeyDef {
  const def = configKeyDef(key);
  if (def === undefined) throw new Error(`config key '${key}' is not in the registry`);
  return def;
}

/** The registry's scope for a key; the two guards below are the same fact as type narrowing. */
export function configScope(key: ConfigKey): ConfigScope {
  return registryEntry(key).scope;
}

export function isGlobalMapKey(key: ConfigKey): key is GlobalMapKey {
  return configScope(key) !== "profile";
}

export function isProfileMapKey(key: ConfigKey): key is ProfileMapKey {
  return configScope(key) !== "global";
}

/** A missing or non-numeric entry is a programmer error. */
export function configDefaultNumber(key: ConfigKey): number {
  const value = configDefaultValue(registryEntry(key));
  if (typeof value !== "number") {
    throw new Error(`config key '${key}' has no numeric built-in default`);
  }
  return value;
}

export function configDefaultString(key: ConfigKey): string {
  const value = configDefaultValue(registryEntry(key));
  if (typeof value !== "string") {
    throw new Error(`config key '${key}' has no string built-in default`);
  }
  return value;
}

export function configDefaultBoolean(key: ConfigKey): boolean {
  const value = configDefaultValue(registryEntry(key));
  if (typeof value !== "boolean") {
    throw new Error(`config key '${key}' has no boolean built-in default`);
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
    if (def.proxyProjected === true) out.push(def.proxyPath);
  }
  return out;
}

/** What `agent start` writes into `profile`'s daemon config.json before launch (applyDefaultConfig
 *  in launch.ts): each proxy knob as it resolves FOR THAT PROFILE. */
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
      out.push({ path: def.proxyPath, value: resolved.value ?? def.proxyDefault, optIn: false });
    } else if (def.proxyProjected === true) {
      const resolved = resolveSettingIn(data, def.key, { profile });
      if (isStoredSource(resolved.source) && resolved.value !== undefined) {
        out.push({ path: def.proxyPath, value: resolved.value, optIn: true });
      }
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

/** Which map a `--set`/`--del` lands in. */
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

  private value<K extends GlobalKey>(key: K): ConfigValueTypes[K] | undefined {
    return this.resolve(key, { profile: null }).value;
  }

  /** Watchdog-reachable, so the read degrades. */
  autoStartEnabled(): boolean {
    return resolveSettingIn(this.readDegraded(), "daemon.auto-start", { profile: null }).value ??
      configDefaultBoolean("daemon.auto-start");
  }

  /** Preflight-reachable, so the read degrades. */
  autoUpdateEnabled(): boolean {
    return resolveSettingIn(this.readDegraded(), "update.auto", { profile: null }).value ??
      configDefaultBoolean("update.auto");
  }

  /** OFF sweeps the profile entries and leaves the default's in place (src/claude/desktop.ts). */
  claudeDesktopEnabled(): boolean {
    return this.value("claude.desktop") ?? configDefaultBoolean("claude.desktop");
  }

  codexHomePrefs(platform: NodeJS.Platform = process.platform): CodexHomePrefs {
    return codexHomePrefsFor(this.read().global, platform);
  }

  codexHostEnabled(platform: NodeJS.Platform = process.platform): boolean {
    return this.codexHomePrefs(platform).hostFarm;
  }

  codexModelCatalogEnabled(): boolean {
    return this.value("codex.model-catalog") ?? configDefaultBoolean("codex.model-catalog");
  }

  launchersEnabled(): boolean {
    return this.value("shell.launchers") ?? configDefaultBoolean("shell.launchers");
  }

  /** The agents in scope get the credential value baked by their writer (src/agents/configure.ts
   *  resolves it once per write) and run no copilot-env process at request time. */
  staticKeyScope(profile: Profile): StaticKeyScope {
    return this.resolve("static-key", { profile }).value ?? STATIC_KEY_DEFAULT;
  }

  /** The per-agent question every writer asks, so no call site compares scope strings. */
  staticKeyFor(agent: StaticKeyAgent, profile: Profile): boolean {
    const scope = this.staticKeyScope(profile);
    return scope === "all" || scope === agent;
  }

  wireMcpEnabled(): boolean {
    return this.wireMcpResolved().value;
  }

  /** Value and source from ONE snapshot, so `agent mcp` never prints a torn pair. */
  wireMcpResolved(): { value: boolean; source: "stored" | "default" } {
    const resolved = this.resolve("claude.wire-mcp", { profile: null });
    return {
      value: resolved.value ?? configDefaultBoolean("claude.wire-mcp"),
      source: isStoredSource(resolved.source) ? "stored" : "default",
    };
  }

  /** On the STRICT read on purpose: an unreadable store fails the update rather than reading as "off". */
  verifyProvenanceEnabled(): boolean {
    return this.value("update.verify-provenance") ??
      configDefaultBoolean("update.verify-provenance");
  }

  /** `profile`'s `host` literal, or null for `auto`: the caller then resolves the host per credential
   *  (the select*IdentityAndHost pair, integration_identity.ts). */
  copilotHost(profile: Profile): string | null {
    const value = this.resolve("host", { profile }).value;
    return value === undefined || value === COPILOT_HOST_AUTO ? null : value;
  }

  /** `auto` reads as null so `--set identity auto` restores probing without a separate `--del`. */
  pinnedIntegrationId(profile: Profile): string | null {
    const value = this.resolve("identity", { profile }).value;
    return value === undefined || value.toLowerCase() === "auto" ? null : value;
  }

  /** undefined = `auto` or unset; the caller decides from the credential's provider and token shape. */
  passthroughOverride(profile: Profile): boolean | undefined {
    const value = this.resolve("passthrough", { profile }).value;
    if (value === "on") return true;
    if (value === "off") return false;
    return undefined;
  }

  defaultPort(): number {
    return this.value("daemon.port") ?? configDefaultNumber("daemon.port");
  }

  minPort(): number {
    return this.value("daemon.min-port") ?? configDefaultNumber("daemon.min-port");
  }

  maxPort(): number {
    return this.value("daemon.max-port") ?? configDefaultNumber("daemon.max-port");
  }

  strictPortEnabled(): boolean {
    return this.value("daemon.strict-port") ?? configDefaultBoolean("daemon.strict-port");
  }

  proxyLogsEnabled(): boolean {
    return this.value("daemon.logs") ?? configDefaultBoolean("daemon.logs");
  }

  /** The `daemon.version` pin, or undefined to float (the COPILOT_API_VERSION env layer stays at the
   *  read site, src/proxy_float.ts). */
  proxyVersionPin(): string | undefined {
    return this.value("daemon.version");
  }

  /** The COPILOT_API_MIN_RELEASE_AGE env layer stays at the read site (src/proxy_float.ts). */
  releaseCooldownSeconds(): number {
    return this.value("daemon.release-cooldown") ?? configDefaultNumber("daemon.release-cooldown");
  }

  /** The COPILOT_API_IDLE_TIMEOUT env layer stays at the read site (src/scripts/idle_watchdog.ts).
   *  Watchdog-reachable, so the read degrades. */
  idleTimeoutSeconds(): number {
    return resolveSettingIn(this.readDegraded(), "daemon.idle-timeout", { profile: null }).value ??
      configDefaultNumber("daemon.idle-timeout");
  }

  /** The per-run `--pricing-url` layer stays at the read site (resolvePricingUrl in src/usage/cost.ts). */
  pricingUrl(): string {
    return this.value("cost.pricing-url") ?? configDefaultString("cost.pricing-url");
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

  /** Every setting goes with the profile (`agent profile --del`): a deleted profile leaves no
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

  /** The `agent config --set`/`--del` write: the key's scope decides the map (settingTarget), so the
   *  rule sits at the one mutation point. `value` null deletes. Returns where it landed for the
   *  caller to say. */
  assign(
    def: ConfigKeyDef,
    value: ConfigValue | null,
    profile: Profile | undefined,
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
 * Which map a key lands in, from its scope:
 *
 *   global key          -> the global map; a --profile is an error (the key has no profile value)
 *   profile key         -> the named profile's section, the default's without --profile
 *   profile-default key -> the named profile's section, the GLOBAL map without --profile
 */
export function settingTarget(def: ConfigKeyDef, profile: Profile | undefined): SettingTarget {
  switch (def.scope) {
    case "global":
      if (profile !== undefined) {
        throw new Error(
          `'${def.key}' is a global setting (scope ${def.scope}): it has no per-profile value, so --profile does not apply`,
        );
      }
      return { kind: "global" };
    case "profile":
      return { kind: "profile", profile: profile ?? null };
    case "profile-default":
      return profile === undefined ? { kind: "global" } : { kind: "profile", profile };
  }
}
