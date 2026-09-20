// The typed key registry behind `agent config`: every key's name (the CLI spelling AND the stored
// JSON key), value type, scope, domain, default, and description, stated ONCE per entry and pinned
// total over ConfigValueTypes at compile time. The store that reads and writes the keys is
// env_config.ts; this module never touches the state file.
import * as path from "node:path";
import * as v from "valibot";
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
  "cost.github-pricing-url": string;
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
  "probe.claude-model": string;
  "probe.codex-model": string;
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
  "probe",
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
const MAX_SECONDS = 365 * SECONDS_PER_DAY;
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

/** A lowercase sha256 hex digest, as the stores persist one (the accepted catalog's digest in
 *  state.json, the price-list cache's URL digest). */
export const SHA256_HEX_SCHEMA = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/** Direct's default identity (integration_identity.ts): Codex CLI impersonation with NO id header.
 *  Owned here, beside the pin domain that refuses it, because this module sits in the daemon shims'
 *  import closure and the identity module does not. */
export const CODEX_IDENTITY_NAME = "codex";

/** A key path into the proxy config.json document, e.g. `["contextManagement", "responses"]`. */
export type ProxyConfigPath = readonly [string, ...string[]];

/** The generic ties `schema` and `parse` to the key's OWN value type, so a key can never be write-only
 *  again (accepted by `set`, stripped by the folded read schema). `scope` is required, and its type
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
  /** `agent config set` refuses the key on Windows. */
  posixOnly?: true;
}

/** Absent when "unset" IS the default (a disabled override, a floating pin), rendered `<unset>`. On an
 *  opt-in projected key it is the PROXY'S own default, informational only and never projected. */
interface DefaultSpec<K extends ConfigKey = ConfigKey> {
  defaultValue?: ConfigValueTypes[K];
}

/** What a `set`/`unset` prints about when a change takes effect; projected keys already get
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

/** Written only while a value is stored for the daemon's profile, so the proxy's own default stands
 *  otherwise: every start clears the path while the key is unset (applyDefaultConfig in launch.ts). */
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
// the read schema and every `set` parse is derived from the same schema, so write and read can never disagree.

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

/** The one validator behind `agent profile [<name>] set identity` and `identity --set`. */
export function parseIntegrationIdPin(raw: string): string {
  return INTEGRATION_ID_DOMAIN.parse(raw);
}

/** Lives here rather than in src/usage/pricing.ts because this module sits in the daemon shims' import
 *  closure and the usage layer must not (test/installer_pinning.test.ts). */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** The data file behind GitHub's Copilot models-and-pricing docs page: the page renders this list
 *  through a Liquid loop, so the file IS the table the page shows. */
export const GITHUB_RATE_CARD_URL =
  "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";

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
  "Applies at the next wiring: `agent init`, `agent profile <name> add`, or `agent profile [<name>] sync`";
/** A re-render of a recorded mode never probes, so only the auto-detect landing reads the key. */
const PROBE_HINT = "Read by the next Direct probe: `agent init` with neither --direct nor --proxy";

/** Ordered ALPHABETICALLY by key: that is `--help`'s order within a group, and a test pins it, so
 *  insert new keys in place. */
const CONFIG_REGISTRY_LITERAL = [
  {
    key: "claude.desktop",
    scope: "global",
    describe: "Also wire Claude Desktop",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint:
      "Applies at the next wiring (`agent init`, `agent profile <name> add`, `agent profile [<name>] sync`); setting the key writes no Desktop files itself.",
  },
  {
    key: "claude.wire-mcp",
    scope: "global",
    describe: "Direct Claude Code web search",
    ...BOOL_DOMAIN,
    defaultValue: true,
    applyHint: "Applies at the next `agent profile sync --claude`/`agent init` direct wiring.",
  },
  {
    key: "codex.home",
    scope: "global",
    describe: "Codex home root; auto detects",
    ...ABSOLUTE_PATH_DOMAIN,
    defaultValue: CODEX_HOME_AUTO,
    applyHint:
      "Applies at the next `agent profile sync --codex`/`agent init` wiring (the config write lands there) and to the " +
      "shell on the next `agent` command, whose wrapper re-evals `agent profile env`; a removal reaches new shells only.",
  },
  {
    key: "codex.host",
    scope: "global",
    describe: "Codex home per host (POSIX)",
    ...BOOL_DOMAIN,
    defaultValue: false,
    posixOnly: true,
    applyHint:
      "Applies at the next `agent profile sync --codex`/`agent init` wiring, which builds or removes the farm.",
  },
  {
    key: "codex.model-catalog",
    scope: "global",
    describe: "Patch the Codex model catalog",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next `agent profile sync --codex`/`agent init` wiring or the next default-profile launch " +
      "(`cl`/`cx` on a proxy default, or a direct `cx`); `cx --profile <name>` never refreshes it.",
  },
  {
    key: "cost.credits-target",
    scope: "global",
    describe: "Monthly credits to stay under",
    ...wholeNumberDomain(1, MAX_CREDITS, "credits"),
    applyHint: "Applies to the next `agent credits` run.",
  },
  {
    key: "cost.github-pricing-url",
    scope: "global",
    describe: "GitHub's Copilot rate card URL",
    ...HTTPS_URL_DOMAIN,
    defaultValue: GITHUB_RATE_CARD_URL,
    applyHint: "Applies to the next `agent cost` run.",
  },
  {
    key: "cost.pricing-url",
    scope: "global",
    describe: "OpenRouter models API URL",
    ...HTTPS_URL_DOMAIN,
    defaultValue: OPENROUTER_MODELS_URL,
    applyHint: "Applies to the next `agent cost` run.",
  },
  {
    key: "daemon.auto-start",
    scope: "global",
    describe: "Auto-start and idle-stop proxy",
    ...BOOL_DOMAIN,
    defaultValue: false,
  },
  {
    key: "daemon.idle-timeout",
    scope: "global",
    describe: "Idle stop in seconds; 0 never",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 3600,
    restartToApply: true,
  },
  {
    key: "daemon.logs",
    scope: "global",
    describe: "Request log in `<home>/logs`",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    key: "daemon.max-port",
    scope: "global",
    describe: "Highest proxy port to try",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 65535,
    restartToApply: true,
  },
  {
    key: "daemon.min-port",
    scope: "global",
    describe: "Lowest proxy port to try",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 1024,
    restartToApply: true,
  },
  {
    key: "daemon.port",
    scope: "global",
    describe: "Proxy port; next free if busy",
    ...wholeNumberDomain(1, 65535),
    defaultValue: 4141,
    restartToApply: true,
  },
  {
    key: "daemon.release-cooldown",
    scope: "global",
    describe: "Min proxy release age, seconds",
    ...wholeNumberDomain(0, MAX_SECONDS, "seconds"),
    defaultValue: 7 * SECONDS_PER_DAY,
  },
  {
    key: "daemon.strict-port",
    scope: "global",
    describe: "Busy port fails (default only)",
    ...BOOL_DOMAIN,
    defaultValue: false,
    restartToApply: true,
  },
  {
    key: "daemon.version",
    scope: "global",
    describe: "Pin the proxy version or tag",
    ...PROXY_VERSION_DOMAIN,
  },
  {
    key: "host",
    scope: "profile",
    describe: "Copilot API host; auto probes",
    ...COPILOT_HOST_DOMAIN,
    defaultValue: COPILOT_HOST_AUTO,
    applyHint:
      "Applies at the next `agent init`/`agent profile sync --codex`/`agent profile sync --claude` wiring and the next proxy start.",
  },
  {
    key: "identity",
    scope: "profile",
    describe: "Client identity; auto probes",
    ...INTEGRATION_ID_DOMAIN,
    defaultValue: "auto",
    applyHint:
      "Applies to Direct at the next `agent init`/`agent profile <name> add` (rewires the " +
      "agent configs) and to the profile's proxy at its next daemon launch (a running daemon " +
      "keeps its identity until restarted).",
  },
  {
    key: "passthrough",
    scope: "profile",
    describe: "Send a PAT as-is; auto detects",
    ...PASSTHROUGH_DOMAIN,
    defaultValue: "auto",
    restartToApply: true,
  },
  {
    key: "probe.claude-model",
    scope: "profile-default",
    describe: "Direct probe's claude model",
    ...MODEL_ID_DOMAIN,
    applyHint: PROBE_HINT,
  },
  {
    key: "probe.codex-model",
    scope: "profile-default",
    describe: "Direct probe's codex model",
    ...MODEL_ID_DOMAIN,
    applyHint: PROBE_HINT,
  },
  {
    key: "proxy.alpha-search.codex-priority",
    scope: "profile-default",
    describe: "Prefer Codex for /alpha/search",
    ...BOOL_DOMAIN,
    defaultValue: true,
    proxyProjected: true,
    proxyPath: ["alphaSearchCodexPriority"],
  },
  {
    key: "proxy.alpha-search.model",
    scope: "profile-default",
    describe: "/alpha/search fallback model",
    ...MODEL_ID_DOMAIN,
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    proxyPath: ["alphaSearchModel"],
  },
  {
    key: "proxy.claude-auto-model",
    scope: "profile-default",
    describe: "Claude security-monitor model",
    ...MODEL_ID_DOMAIN,
    proxyProjected: true,
    proxyPath: ["claudeAutoModel"],
  },
  {
    key: "proxy.claude-token-multiplier",
    scope: "profile-default",
    describe: "Claude token count multiplier",
    ...positiveDecimalDomain(MAX_TOKEN_MULTIPLIER),
    defaultValue: 1.15,
    proxyProjected: true,
    proxyPath: ["claudeTokenMultiplier"],
  },
  {
    key: "proxy.message-websearch-model",
    scope: "profile-default",
    describe: "Web-search model, Messages+MCP",
    ...MODEL_ID_DOMAIN,
    // Must equal DEFAULT_WEB_SEARCH_MODEL in web_search.ts, which imports the store over this module and
    // so cannot be referenced here; a registry test pins the two.
    defaultValue: "gpt-5-mini",
    proxyProjected: true,
    proxyPath: ["messageApiWebSearchModel"],
    applyHint:
      "The MCP web_search tool reads it on every call; the proxy surface at its next start.",
  },
  {
    key: "proxy.messages-api",
    scope: "profile-default",
    describe: "Prefer the native Messages API",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useMessagesApi"],
  },
  {
    key: "proxy.responses.context-management",
    scope: "profile-default",
    describe: "Responses context management",
    ...BOOL_DOMAIN,
    defaultValue: false,
    proxyProjected: true,
    proxyPath: ["contextManagement", "responses"],
  },
  {
    key: "proxy.responses.websearch",
    scope: "profile-default",
    describe: "Responses API web search",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useResponsesApiWebSearch"],
  },
  {
    key: "proxy.responses.websocket",
    scope: "profile-default",
    describe: "Responses API over WebSocket",
    ...BOOL_DOMAIN,
    proxyDefault: true,
    proxyPath: ["useResponsesApiWebSocket"],
  },
  {
    key: "proxy.small-model",
    scope: "profile-default",
    describe: "The proxy's small/fast model",
    ...MODEL_ID_DOMAIN,
    proxyDefault: "gpt-5-mini",
    proxyPath: ["smallModel"],
  },
  {
    key: "shell.launchers",
    scope: "global",
    describe: "Shell launchers cl / co / cx",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint: "New shells pick a change up; the current one picks up an ENABLE on the next " +
      "`agent` command (a disable applies to new shells only).",
  },
  {
    key: "static-key",
    scope: "profile",
    describe: "Which configs bake the token",
    ...STATIC_KEY_DOMAIN,
    defaultValue: STATIC_KEY_DEFAULT,
    applyHint: `${WIRING_HINT}. ` +
      "A baked value does not follow a credential change: re-run the wiring after `agent auth`.",
  },
  {
    key: "update.auto",
    scope: "global",
    describe: "Daily self-update at start",
    ...BOOL_DOMAIN,
    defaultValue: false,
    applyHint:
      "Applies at the next `agent start` (checked once a day); `agent update` updates now, `agent update --auto-status` shows the last check.",
  },
  {
    key: "update.cooldown",
    scope: "global",
    describe: "Min release age in days",
    ...wholeNumberDomain(0, MAX_DAYS, "days"),
  },
  {
    key: "update.verify-provenance",
    scope: "global",
    describe: "Sigstore-verify updates",
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
export function registryEntry(key: ConfigKey): ConfigKeyDef {
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

export function configDefaultBoolean(key: ConfigKey): boolean {
  const value = configDefaultValue(registryEntry(key));
  if (typeof value !== "boolean") {
    throw new Error(`config key '${key}' has no boolean built-in default`);
  }
  return value;
}
