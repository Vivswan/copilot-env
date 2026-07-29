// copilot-env's account/machine-wide PREFERENCES, managed by `agent config`. Separate from
// the credential store (CopilotEnvState): this holds user-tunable knobs only. Stored in
// `.copilot-env-config.json` under the copilot-api home, built on CopilotApiConfig (the
// atomic JSON store) + a lenient valibot schema, mirroring CopilotEnvState/CopilotEnvRunState.
//
// Precedence for every knob is: explicit flag/env (per-invocation) > this stored config >
// built-in default. Each read site applies that itself; this module is just the store.
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** Passthrough preference: `auto` (detect from token shape), or force `on`/`off`. */
export type PassthroughPref = "auto" | "on" | "off";

/** The persisted preferences (absent/ill-typed fields read back as `undefined` = default). */
export interface CopilotEnvConfigData {
  /** Managed proxy lifecycle (auto-start on agent open + idle auto-stop). */
  autoStart?: boolean;
  /** PAT passthrough default for `agent start`. */
  passthrough?: PassthroughPref;
  /**
   * Pin the Copilot `Copilot-Integration-Id` client identity (e.g.
   * `copilot-developer-cli`), overriding the per-credential probe. `auto`/unset probes.
   */
  integrationId?: string;
  /** Idle auto-stop window in whole seconds (`0` disables). */
  idleTimeout?: number;
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
  /** Default proxy port. */
  port?: number;
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
  /** Patched Codex model catalog with Copilot's real context windows (opt-in). */
  codexModelCatalog?: boolean;
  /** Wire the copilot-env MCP server (+ WebSearch deny) into Claude on direct writes. */
  wireMcp?: boolean;
}

type ConfigPatch = { [K in keyof CopilotEnvConfigData]?: CopilotEnvConfigData[K] | null };

// Lenient read schema: each field validates the value we own and FALLS BACK to undefined
// (treated as "unset" -> default by callers) rather than throwing on a bad/ill-typed value.
const MAX_SECONDS = 365 * 24 * 60 * 60; // a year, a generous ceiling for cooldown/idle knobs
const MAX_DAYS = 3650;

const PASSTHROUGH_VALUES = ["auto", "on", "off"] as const;
const wholeSeconds = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SECONDS));
const wholeDays = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DAYS));
const CONFIG_SCHEMA = v.object({
  autoStart: v.fallback(v.optional(v.boolean()), undefined),
  passthrough: v.fallback(v.optional(v.picklist(PASSTHROUGH_VALUES)), undefined),
  integrationId: v.fallback(v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))), undefined),
  idleTimeout: v.fallback(v.optional(wholeSeconds), undefined),
  proxyLogs: v.fallback(v.optional(v.boolean()), undefined),
  smallModel: v.fallback(v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))), undefined),
  useResponsesApiWebSocket: v.fallback(v.optional(v.boolean()), undefined),
  useResponsesApiWebSearch: v.fallback(v.optional(v.boolean()), undefined),
  useMessagesApi: v.fallback(v.optional(v.boolean()), undefined),
  useResponsesApiContextManagement: v.fallback(v.optional(v.boolean()), undefined),
  messageApiWebSearchModel: v.fallback(
    v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    undefined,
  ),
  port: v.fallback(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    undefined,
  ),
  minPort: v.fallback(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    undefined,
  ),
  maxPort: v.fallback(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    undefined,
  ),
  strictPort: v.fallback(v.optional(v.boolean()), undefined),
  proxyVersion: v.fallback(v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))), undefined),
  releaseCooldown: v.fallback(v.optional(wholeSeconds), undefined),
  updateCooldown: v.fallback(v.optional(wholeDays), undefined),
  codexModelCatalog: v.fallback(v.optional(v.boolean()), undefined),
  wireMcp: v.fallback(v.optional(v.boolean()), undefined),
});

export type ConfigKey = keyof CopilotEnvConfigData;
type ConfigValue = boolean | number | string;

/** One config key: its CLI name (kebab), storage key (camel), help text, a parser from the
 *  `--set <value>` string to the stored value (throws a clear message on bad input), and the
 *  built-in default the read site applies -- rendered into `--help` / `--get` by
 *  configDefaultLabel, so the reported default can never drift from the applied one. */
export interface ConfigKeyDef {
  cli: string;
  key: ConfigKey;
  describe: string;
  parse: (raw: string) => ConfigValue;
  /** Built-in default applied by the read site when the key is unset. THE owned copy:
   *  read sites (port.ts, idle_watchdog.ts, the helpers below) consume it via the
   *  configDefault* accessors, and the rendered default label derives from it. */
  defaultValue?: ConfigValue;
  /** Extra wording appended after the derived default value in `--help` / `--get`. */
  defaultSuffix?: string;
  /** Hand-written default label for keys with no single value this registry owns (an
   *  external, proxy-owned, or composite default). Only read when neither `defaultValue`
   *  nor `proxyDefault` is set. */
  defaultLabel?: string;
  /** Force-projected into the proxy config.json under `key` at `agent start` as
   *  `stored ?? proxyDefault` (always written). Use for keys copilot-env has an opinion on.
   *  Doubles as the rendered default, so no separate `defaultValue` is needed. */
  proxyDefault?: ConfigValue;
  /** Opt-in projection: written into the proxy config.json under `key` ONLY when our store
   *  holds a value, leaving the proxy's own default untouched otherwise. Use for keys we merely
   *  expose without overriding. Mutually exclusive with `proxyDefault`. */
  proxyProjected?: boolean;
  /** Read by `agent start`'s launch wiring (NOT projected into the proxy config.json), yet
   *  still applied only when a daemon launches -- so a change deserves the same restart hint
   *  the projected keys get. */
  restartToApply?: boolean;
  /** Printed by `agent config` set/del INSTEAD of the proxy-restart hint, for keys that apply
   *  through some other mechanism than a daemon launch. */
  applyHint?: string;
}

/** The "built-in default" label shown in `--help` / `--get`: the owned default value
 *  (`defaultValue`, else `proxyDefault`) plus any suffix, else the hand-written label.
 *  An entry with none of the three is a programmer error, same as configDefaultNumber. */
export function configDefaultLabel(def: ConfigKeyDef): string {
  const value = def.defaultValue ?? def.proxyDefault;
  if (value !== undefined) return `${value}${def.defaultSuffix ?? ""}`;
  if (def.defaultLabel === undefined) {
    throw new Error(`config key '${def.cli}' has no built-in default to render`);
  }
  return def.defaultLabel;
}

/** Whether a registry entry is written into the proxy config.json at `agent start` (either
 *  force-projected with a default, or opt-in projected when set). */
export function isProxyProjected(def: ConfigKeyDef): boolean {
  return def.proxyDefault !== undefined || def.proxyProjected === true;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on", "enable", "enabled"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off", "disable", "disabled"]);

function parseBool(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  throw new Error(`expected a boolean (true/false), got '${raw}'`);
}

function parseWholeNumber(raw: string, min: number, max: number): number {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) throw new Error(`expected a whole number, got '${raw}'`);
  const n = Number.parseInt(t, 10);
  if (n < min || n > max) throw new Error(`must be between ${min} and ${max}, got ${n}`);
  return n;
}

function parseEnum<T extends string>(raw: string, allowed: readonly T[]): T {
  const t = raw.trim().toLowerCase();
  const hit = allowed.find((a) => a === t);
  if (hit === undefined) throw new Error(`expected one of ${allowed.join("|")}, got '${raw}'`);
  return hit;
}

function parseNonEmpty(raw: string): string {
  const t = raw.trim();
  if (t === "") throw new Error("expected a non-empty value");
  return t;
}

/** The single source of truth for config keys, ordered ALPHABETICALLY by CLI name (the
 *  `--get` / `--help` display order; a test pins it, so insert new keys in place). */
const CONFIG_REGISTRY_LITERAL = [
  {
    cli: "auto-start",
    key: "autoStart",
    describe: "Managed proxy lifecycle: auto-start on agent open + idle auto-stop (bool)",
    parse: parseBool,
    defaultValue: false,
  },
  {
    cli: "codex-model-catalog",
    key: "codexModelCatalog",
    describe: "Patched Codex model catalog with Copilot's real context windows (bool)",
    parse: parseBool,
    defaultValue: false,
    applyHint:
      "Applies at the next Codex auth refresh (within ~5 minutes) or `agent codex`/`agent init` wiring.",
  },
  {
    cli: "idle-timeout",
    key: "idleTimeout",
    describe: "Idle auto-stop window in seconds (0 disables)",
    parse: (r) => parseWholeNumber(r, 0, MAX_SECONDS),
    defaultValue: 3600,
    restartToApply: true,
  },
  {
    cli: "integration-id",
    key: "integrationId",
    describe:
      "Pin the Copilot client identity (Copilot-Integration-Id), or `auto` to probe per credential",
    parse: parseNonEmpty,
    defaultValue: "auto",
    defaultSuffix: " (probe per credential)",
    applyHint:
      "Applies at the next `agent start` (proxy) and `agent init`/`agent profile --add` (direct wiring).",
  },
  {
    cli: "max-port",
    key: "maxPort",
    describe: "Upper bound of the allowed proxy port range (1-65535)",
    parse: (r) => parseWholeNumber(r, 1, 65535),
    defaultValue: 65535,
    restartToApply: true,
  },
  {
    cli: "message-websearch-model",
    key: "messageApiWebSearchModel",
    describe: "Model id for web search: the proxy's Messages-API path and the MCP web_search tool",
    parse: parseNonEmpty,
    // Composite: the proxy half is the proxy's OWN default; the mcp half is
    // DEFAULT_WEB_SEARCH_MODEL in web_search.ts (which imports this module, so it cannot be
    // referenced here) -- a registry test pins the label to that constant.
    defaultLabel: "gpt-5-mini (proxy) / gpt-5.6-sol (mcp)",
    proxyProjected: true,
    applyHint:
      "Proxy surface applies on the next `agent start`; the MCP web_search tool reads it on every call.",
  },
  {
    cli: "messages-api",
    key: "useMessagesApi",
    describe: "Proxy Messages-API (Anthropic-shaped) endpoint (bool)",
    parse: parseBool,
    proxyDefault: true,
  },
  {
    cli: "min-port",
    key: "minPort",
    describe: "Lower bound of the allowed proxy port range (1-65535)",
    parse: (r) => parseWholeNumber(r, 1, 65535),
    defaultValue: 1024,
    restartToApply: true,
  },
  {
    cli: "passthrough",
    key: "passthrough",
    describe: "PAT passthrough default: auto | on | off",
    parse: (r) => parseEnum(r, PASSTHROUGH_VALUES),
    defaultValue: "auto",
    restartToApply: true,
  },
  {
    cli: "port",
    key: "port",
    describe: "Default proxy port (1-65535)",
    parse: (r) => parseWholeNumber(r, 1, 65535),
    defaultValue: 4141,
    defaultSuffix: " (then next free)",
    restartToApply: true,
  },
  {
    cli: "proxy-logs",
    key: "proxyLogs",
    describe: "Proxy request logging under <home>/logs (false discards the writes)",
    parse: parseBool,
    defaultValue: true,
    restartToApply: true,
  },
  {
    cli: "proxy-version",
    key: "proxyVersion",
    describe: "Pin the floated proxy to a version/tag",
    parse: parseNonEmpty,
    defaultLabel: "latest (floated)",
  },
  {
    cli: "release-cooldown",
    key: "releaseCooldown",
    describe: "Proxy float supply-chain cooldown in seconds",
    parse: (r) => parseWholeNumber(r, 0, MAX_SECONDS),
    defaultLabel: "bunfig minimumReleaseAge",
  },
  {
    cli: "responses-context-management",
    key: "useResponsesApiContextManagement",
    describe: "Proxy Responses-API server-side context management (bool)",
    parse: parseBool,
    defaultLabel: "true (proxy default)",
    proxyProjected: true,
  },
  {
    cli: "responses-websearch",
    key: "useResponsesApiWebSearch",
    describe: "Proxy Responses-API web search (bool)",
    parse: parseBool,
    proxyDefault: true,
  },
  {
    cli: "responses-websocket",
    key: "useResponsesApiWebSocket",
    describe: "Proxy Responses-API transport: WebSocket (true) vs HTTP/SSE (false)",
    parse: parseBool,
    proxyDefault: true,
  },
  {
    cli: "small-model",
    key: "smallModel",
    describe: "Small/fast model id the proxy uses",
    parse: parseNonEmpty,
    proxyDefault: "gpt-5-mini",
  },
  {
    cli: "strict-port",
    key: "strictPort",
    describe: "Fail start when the default port is busy instead of auto-incrementing (bool)",
    parse: parseBool,
    defaultValue: false,
    restartToApply: true,
  },
  {
    cli: "update-cooldown",
    key: "updateCooldown",
    describe: "copilot-env update cooldown in days",
    parse: (r) => parseWholeNumber(r, 0, MAX_DAYS),
    defaultLabel: "none (immediate)",
  },
  {
    cli: "wire-mcp",
    key: "wireMcp",
    describe:
      "Wire the copilot-env MCP server (web_search) and the WebSearch deny into Claude on direct writes (bool)",
    parse: parseBool,
    defaultValue: true,
    applyHint: "Applies at the next `agent claude`/`agent init` direct wiring.",
  },
] as const satisfies readonly ConfigKeyDef[];

/** A registry CLI key name; the configDefault* accessors take this instead of a bare
 *  string so a typo'd key is a compile error, not a module-load throw. */
export type ConfigCli = (typeof CONFIG_REGISTRY_LITERAL)[number]["cli"];

/** The literal list above, widened so consumers see the uniform ConfigKeyDef shape. */
export const CONFIG_REGISTRY: readonly ConfigKeyDef[] = CONFIG_REGISTRY_LITERAL;

/** Look up a registry entry by its CLI (kebab) name. */
export function configKeyDef(cli: string): ConfigKeyDef | undefined {
  return CONFIG_REGISTRY.find((d) => d.cli === cli.trim());
}

/** The registry's built-in numeric default for `cli` (`defaultValue`, else `proxyDefault` --
 *  the same resolution the rendered label uses), for the read sites that apply it
 *  (port bounds, idle timeout). A missing or non-numeric entry is a programmer error. */
export function configDefaultNumber(cli: ConfigCli): number {
  const def = configKeyDef(cli);
  const value = def?.defaultValue ?? def?.proxyDefault;
  if (typeof value !== "number") {
    throw new Error(`config key '${cli}' has no numeric built-in default`);
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

/**
 * The proxy `config.json` keys this store projects, each resolved to its stored preference or
 * its built-in proxy default. `agent start` writes these into the daemon's config before
 * launch (see applyDefaultConfig in src/commands/start.ts); the storage key doubles as the
 * proxy key, so no name mapping is needed.
 */
export function projectedProxyConfig(): Record<string, ConfigValue> {
  const prefs = new CopilotEnvConfig().read();
  const out: Record<string, ConfigValue> = {};
  for (const def of CONFIG_REGISTRY) {
    const stored = prefs[def.key];
    if (def.proxyDefault !== undefined) {
      // Force-projected: always written, falling back to copilot-env's chosen default.
      out[def.key] = stored ?? def.proxyDefault;
    } else if (def.proxyProjected && stored !== undefined) {
      // Opt-in: written only when set, so the proxy's own default stands otherwise.
      out[def.key] = stored;
    }
  }
  return out;
}

/** A help block listing every config key with its built-in default, then its description. */
export function configKeysHelp(): string {
  const cliWidth = CONFIG_REGISTRY.reduce((m, d) => Math.max(m, d.cli.length), 0);
  const defaults = CONFIG_REGISTRY.map((d) => `default: ${configDefaultLabel(d)}`);
  const defWidth = defaults.reduce((m, s) => Math.max(m, s.length), 0);
  const rows = CONFIG_REGISTRY.map(
    (d, i) => `  ${d.cli.padEnd(cliWidth)}  ${defaults[i]?.padEnd(defWidth)}  ${d.describe}`,
  );
  return `Keys:\n${rows.join("\n")}`;
}

/**
 * Read/write helper for `.copilot-env-config.json`, mirroring CopilotEnvState/RunState on top
 * of CopilotApiConfig (sorted keys, 0600, atomic rename, Windows EPERM/EBUSY retry).
 */
export class CopilotEnvConfig {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    this.store = new CopilotApiConfig(path ?? new CopilotApiPaths().envConfigFile);
  }

  /** Current preferences; absent/ill-typed/out-of-range fields come back `undefined`. */
  read(): CopilotEnvConfigData {
    return v.parse(CONFIG_SCHEMA, this.store.load());
  }

  /** Whether the managed proxy lifecycle (auto-start + idle auto-stop) is enabled. */
  autoStartEnabled(): boolean {
    return this.read().autoStart ?? configDefaultBoolean("auto-start");
  }

  /** Whether the patched Codex model catalog is enabled (opt-in, default off). */
  codexModelCatalogEnabled(): boolean {
    return this.read().codexModelCatalog ?? configDefaultBoolean("codex-model-catalog");
  }

  /** Whether direct Claude wiring registers the MCP server + WebSearch deny (default ON). */
  wireMcpEnabled(): boolean {
    return this.read().wireMcp ?? configDefaultBoolean("wire-mcp");
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
