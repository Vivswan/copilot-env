import * as v from "valibot";
import {
  runConfig,
  sinceProxyVersionWarning,
  unreadProjectedKeyWarnings,
} from "../src/commands/config.ts";
import {
  CONFIG_REGISTRY,
  type ConfigCli,
  configDefaultLabel,
  configDefaultNumber,
  type ConfigKey,
  type ConfigKeyDef,
  configKeyDef,
  CopilotEnvConfig,
  isProxyProjected,
  optInProxyConfigPaths,
  projectedProxyConfig,
  type ProjectedProxyEntry,
  type TotalOverConfigKeys,
} from "../src/copilot_api/env_config.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "../src/copilot_api/web_search.ts";
import { DEFAULT_RELEASE_COOLDOWN_SECONDS } from "../src/proxy_float.ts";
import { SECONDS_PER_DAY } from "../src/utils/time.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

// CopilotEnvConfig reads/writes the SHARED prefs store under COPILOT_API_HOME, so isolate
// each test in a temp home.
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-envconfig-");
}

/** The projected value at `path`, or undefined when no entry addresses it. */
function projectedValue(
  entries: readonly ProjectedProxyEntry[],
  path: readonly string[],
): boolean | number | string | undefined {
  return entries.find((e) => e.path.length === path.length && e.path.every((k, i) => k === path[i]))
    ?.value;
}

test("each typed key round-trips and del() reverts it to undefined (default)", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.read()).toEqual({});

  cfg.set({
    autoStart: true,
    passthrough: "on",
    idleTimeout: 120,
    proxyLogs: false,
    smallModel: "gpt-5-mini",
    useResponsesApiWebSocket: false,
    useResponsesApiWebSearch: false,
    useMessagesApi: false,
    useResponsesApiContextManagement: false,
    messageApiWebSearchModel: "gpt-5-mini",
    alphaSearchCodexPriority: false,
    alphaSearchModel: "gpt-5",
    claudeAutoModel: "claude-haiku-4.5",
    claudeTokenMultiplier: 1.15,
    port: 4242,
    minPort: 2000,
    maxPort: 60000,
    strictPort: true,
    proxyVersion: "1.2.3",
    releaseCooldown: 86400,
    updateCooldown: 7,
    codexModelCatalog: true,
    wireMcp: false,
  });
  expect(cfg.read()).toEqual({
    autoStart: true,
    passthrough: "on",
    idleTimeout: 120,
    proxyLogs: false,
    smallModel: "gpt-5-mini",
    useResponsesApiWebSocket: false,
    useResponsesApiWebSearch: false,
    useMessagesApi: false,
    useResponsesApiContextManagement: false,
    messageApiWebSearchModel: "gpt-5-mini",
    alphaSearchCodexPriority: false,
    alphaSearchModel: "gpt-5",
    claudeAutoModel: "claude-haiku-4.5",
    claudeTokenMultiplier: 1.15,
    port: 4242,
    minPort: 2000,
    maxPort: 60000,
    strictPort: true,
    proxyVersion: "1.2.3",
    releaseCooldown: 86400,
    updateCooldown: 7,
    codexModelCatalog: true,
    wireMcp: false,
  });
  expect(cfg.autoStartEnabled()).toBe(true);
  expect(cfg.codexModelCatalogEnabled()).toBe(true);
  expect(cfg.wireMcpEnabled()).toBe(false);

  cfg.del("autoStart");
  expect(cfg.read().autoStart).toBeUndefined();
  expect(cfg.autoStartEnabled()).toBe(false);
  // Deleting one key leaves the others intact.
  expect(cfg.read().port).toBe(4242);

  cfg.del("codexModelCatalog");
  expect(cfg.read().codexModelCatalog).toBeUndefined();
  expect(cfg.codexModelCatalogEnabled()).toBe(false);

  // wire-mcp is opt-OUT: unset reads as enabled.
  cfg.del("wireMcp");
  expect(cfg.read().wireMcp).toBeUndefined();
  expect(cfg.wireMcpEnabled()).toBe(true);
});

test("the read schema is lenient: ill-typed / out-of-range stored values fall back to default", () => {
  tmpHome();
  // Write a junk value past the typed setter (port out of range, wrong types).
  new CopilotEnvConfig().set({ port: 70000 as unknown as number });
  // 70000 > 65535 -> schema fallback -> undefined (NOT a thrown error).
  expect(new CopilotEnvConfig().read().port).toBeUndefined();

  // A stored non-positive multiplier is equally junk: reads back as unset.
  new CopilotEnvConfig().set({ claudeTokenMultiplier: 0 as unknown as number });
  expect(new CopilotEnvConfig().read().claudeTokenMultiplier).toBeUndefined();
  new CopilotEnvConfig().set({ claudeTokenMultiplier: -1.5 as unknown as number });
  expect(new CopilotEnvConfig().read().claudeTokenMultiplier).toBeUndefined();
  new CopilotEnvConfig().set({ claudeTokenMultiplier: 5000 as unknown as number });
  expect(new CopilotEnvConfig().read().claudeTokenMultiplier).toBeUndefined();
});

test("the registry parsers accept valid input and reject bad input with a clear message", () => {
  expect(configKeyDef("auto-start")?.parse("true")).toBe(true);
  expect(configKeyDef("auto-start")?.parse("off")).toBe(false);
  expect(configKeyDef("passthrough")?.parse("AUTO")).toBe("auto");
  expect(configKeyDef("idle-timeout")?.parse("300")).toBe(300);
  expect(configKeyDef("proxy-logs")?.parse("false")).toBe(false);
  expect(configKeyDef("port")?.parse("4141")).toBe(4141);
  expect(configKeyDef("codex-model-catalog")?.parse("yes")).toBe(true);
  expect(configKeyDef("alpha-search-codex-priority")?.parse("false")).toBe(false);
  expect(configKeyDef("alpha-search-model")?.parse(" gpt-5 ")).toBe("gpt-5");
  expect(configKeyDef("claude-auto-model")?.parse("claude-haiku-4.5")).toBe("claude-haiku-4.5");
  expect(configKeyDef("claude-token-multiplier")?.parse("1.15")).toBe(1.15);
  expect(configKeyDef("claude-token-multiplier")?.parse("2")).toBe(2);
  expect(configKeyDef("claude-token-multiplier")?.parse(" 1.5 ")).toBe(1.5);

  expect(() => configKeyDef("auto-start")?.parse("maybe")).toThrow();
  expect(() => configKeyDef("passthrough")?.parse("sometimes")).toThrow();
  // The rejection echoes the ORIGINAL raw input, not the trimmed/lowercased coercion.
  expect(() => configKeyDef("passthrough")?.parse(" BAD ")).toThrow(
    "expected one of auto|on|off, got ' BAD '",
  );
  expect(() => configKeyDef("idle-timeout")?.parse("-5")).toThrow();
  expect(() => configKeyDef("port")?.parse("70000")).toThrow(); // out of range
  expect(() => configKeyDef("codex-model-catalog")?.parse("bogus")).toThrow();
  expect(() => configKeyDef("alpha-search-model")?.parse("  ")).toThrow();
  expect(() => configKeyDef("claude-token-multiplier")?.parse("0")).toThrow(/greater than 0/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("-1.5")).toThrow(/positive decimal/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("1.2.3")).toThrow(/positive decimal/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("fast")).toThrow(/positive decimal/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("1e2")).toThrow(/positive decimal/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("NaN")).toThrow(/positive decimal/);
  expect(() => configKeyDef("claude-token-multiplier")?.parse("Infinity")).toThrow(
    /positive decimal/,
  );
  expect(() => configKeyDef("claude-token-multiplier")?.parse("1001")).toThrow(/at most 1000/);
  // Overflow-sized digit strings coerce to Infinity; the schema's own integer/finite
  // actions still answer with the range wording, not a bare valibot default.
  expect(() => configKeyDef("port")?.parse("9".repeat(400))).toThrow(
    /between 1 and 65535, got Infinity/,
  );
  expect(() => configKeyDef("claude-token-multiplier")?.parse("9".repeat(400))).toThrow(
    /at most 1000, got Infinity/,
  );
  expect(configKeyDef("nope")).toBeUndefined();
});

test("runConfig --set validates + persists; --del reverts; unknown key / bad value error", () => {
  tmpHome();
  runConfig({ set: ["idle-timeout", "45"] });
  expect(new CopilotEnvConfig().read().idleTimeout).toBe(45);

  runConfig({ del: "idle-timeout" });
  expect(new CopilotEnvConfig().read().idleTimeout).toBeUndefined();

  expect(() => runConfig({ set: ["bogus-key", "1"] })).toThrow(/unknown config key/);
  expect(() => runConfig({ set: ["port", "notanumber"] })).toThrow(/invalid value for 'port'/);
  expect(() => runConfig({ set: ["auto-start"] })).toThrow(/usage/); // missing value
  expect(() => runConfig({ del: "bogus-key" })).toThrow(/unknown config key/);
  expect(() => runConfig({ set: ["auto-start", "true"], del: "port" })).toThrow(
    /mutually exclusive/,
  );
});

test("runConfig --get cannot combine with --set/--del (never silently dropped)", () => {
  tmpHome();
  // `--set port 5000 --get` used to write the key and drop --get; the boundary
  // parse now rejects the combination (both --get spellings: bare and keyed).
  expect(() => runConfig({ set: ["port", "5000"], get: true })).toThrow(
    "--get reads a preference and cannot combine with --set/--del",
  );
  expect(() => runConfig({ del: "port", get: "port" })).toThrow(
    "--get reads a preference and cannot combine with --set/--del",
  );
  // The rejected --set wrote nothing.
  expect(new CopilotEnvConfig().read().port).toBeUndefined();
});

test("integration-id is header-safe end to end: --set rejects without echoing, stored junk reads unset", () => {
  tmpHome();
  // The pin lands in HTTP headers (and wins over probed identities), so a
  // header-splitting value is rejected -- and never echoed (no-echo rule: junk
  // pasted here can be anything, a token included).
  let message = "";
  try {
    runConfig({ set: ["integration-id", "evil\nX-Injected: 1"] });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("invalid value for 'integration-id'");
  expect(message).toContain("header-safe");
  expect(message).not.toContain("evil");
  expect(new CopilotEnvConfig().read().integrationId).toBeUndefined();

  // The probe sentinel and real identities still parse.
  runConfig({ set: ["integration-id", "auto"] });
  expect(new CopilotEnvConfig().read().integrationId).toBe("auto");
  runConfig({ set: ["integration-id", "copilot-developer-cli"] });
  expect(new CopilotEnvConfig().pinnedIntegrationId()).toBe("copilot-developer-cli");

  // A hand-mangled STORED value degrades to unset (= probe per credential),
  // never a baked header-splitting pin.
  new CopilotEnvConfig().set({ integrationId: "evil\nX-Injected: 1" });
  expect(new CopilotEnvConfig().read().integrationId).toBeUndefined();
  expect(new CopilotEnvConfig().pinnedIntegrationId()).toBeNull();
});

test("runConfig --get <key> prints just the value to stdout (script-friendly)", () => {
  tmpHome();
  new CopilotEnvConfig().set({ smallModel: "gpt-5-mini" });
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  try {
    runConfig({ get: "small-model" });
  } finally {
    process.stdout.write = orig;
  }
  expect(written.join("")).toBe("gpt-5-mini\n");
});

// One valid `--set` string per registry key, typed over ConfigCli: adding a registry key
// without extending this map is a compile error, so the round trip below provably covers
// EVERY key.
const ROUND_TRIP_RAW: Record<ConfigCli, string> = {
  "alpha-search-codex-priority": "false",
  "alpha-search-model": "gpt-5",
  "auto-start": "true",
  "claude-auto-model": "claude-haiku-4.5",
  "claude-token-multiplier": "1.3",
  "codex-model-catalog": "true",
  "idle-timeout": "120",
  "integration-id": "copilot-developer-cli",
  "max-port": "60000",
  "message-websearch-model": "gpt-5",
  "messages-api": "false",
  "min-port": "2000",
  "passthrough": "on",
  "port": "4242",
  "proxy-logs": "false",
  "proxy-version": "1.2.3",
  "release-cooldown": "86400",
  "responses-context-management": "true",
  "responses-websearch": "false",
  "responses-websocket": "false",
  "small-model": "gpt-5-mini",
  "strict-port": "true",
  "update-cooldown": "7",
  "wire-mcp": "false",
};

test("every registry key round-trips: a CLI-set value survives read() and reaches the projection", () => {
  tmpHome();
  for (const def of CONFIG_REGISTRY) {
    runConfig({ set: [def.cli, ROUND_TRIP_RAW[def.cli as ConfigCli]] });
  }
  const data = new CopilotEnvConfig().read();
  const projected = projectedProxyConfig();
  for (const def of CONFIG_REGISTRY) {
    const expected = def.parse(ROUND_TRIP_RAW[def.cli as ConfigCli]);
    // The read schema is folded from the registry, so a registry key can never be
    // write-only: read() returns the stored value, never the stripped-back default.
    expect(data[def.key]).toBe(expected);
    // ... and the projection reads through the same schema, so a projected key sees it.
    if (isProxyProjected(def)) {
      expect(projectedValue(projected, def.proxyPath ?? [def.key])).toBe(expected);
    }
  }
});

test("the registry covers exactly the documented keys, in alphabetical order", () => {
  const clis = CONFIG_REGISTRY.map((d) => d.cli);
  expect(clis).toEqual([
    "alpha-search-codex-priority",
    "alpha-search-model",
    "auto-start",
    "claude-auto-model",
    "claude-token-multiplier",
    "codex-model-catalog",
    "idle-timeout",
    "integration-id",
    "max-port",
    "message-websearch-model",
    "messages-api",
    "min-port",
    "passthrough",
    "port",
    "proxy-logs",
    "proxy-version",
    "release-cooldown",
    "responses-context-management",
    "responses-websearch",
    "responses-websocket",
    "small-model",
    "strict-port",
    "update-cooldown",
    "wire-mcp",
  ]);
  // The display order IS alphabetical -- a new key must be inserted in place.
  expect(clis).toEqual([...clis].sort());
  // Storage keys are unique: the CONFIG_SCHEMA fold is fromEntries, where a duplicate
  // would silently overwrite the earlier entry's read schema.
  const keys = CONFIG_REGISTRY.map((d) => d.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("projectedProxyConfig() force-projects the opinionated keys and opt-in keys only when set", () => {
  tmpHome();
  // Empty store -> the FORCE-projected keys (smallModel + the three flags) resolve to their
  // built-in defaults; the OPT-IN keys (context-management, websearch-model) are absent so
  // the proxy's own defaults stand.
  const empty = projectedProxyConfig();
  expect(projectedValue(empty, ["smallModel"])).toBe("gpt-5-mini");
  expect(projectedValue(empty, ["useResponsesApiWebSocket"])).toBe(true);
  expect(projectedValue(empty, ["useResponsesApiWebSearch"])).toBe(true);
  expect(projectedValue(empty, ["useMessagesApi"])).toBe(true);
  expect(empty).toHaveLength(4);
  expect(empty.every((e) => !e.optIn)).toBe(true);
  // A stored override on a force key is honored; a stored opt-in key now appears too.
  new CopilotEnvConfig().set({
    autoStart: true,
    useResponsesApiWebSocket: false,
    messageApiWebSearchModel: "gpt-5",
  });
  const projected = projectedProxyConfig();
  expect(projectedValue(projected, ["useResponsesApiWebSocket"])).toBe(false);
  expect(projectedValue(projected, ["messageApiWebSearchModel"])).toBe("gpt-5");
  expect(projected.find((e) => e.path[0] === "messageApiWebSearchModel")?.optIn).toBe(true);
  // Copilot-env-internal keys (autoStart) never leak into the proxy projection.
  expect(projectedValue(projected, ["autoStart"])).toBeUndefined();
});

test("responses-context-management projects to the proxy's NESTED contextManagement.responses", () => {
  tmpHome();
  new CopilotEnvConfig().set({ useResponsesApiContextManagement: true });
  const projected = projectedProxyConfig();
  expect(projectedValue(projected, ["contextManagement", "responses"])).toBe(true);
  expect(projected.find((e) => e.path[0] === "contextManagement")?.optIn).toBe(true);
  // The pre-1.14 flat proxy key (still our storage key) is never projected.
  expect(projectedValue(projected, ["useResponsesApiContextManagement"])).toBeUndefined();
  expect(configDefaultLabel(configKeyDef("responses-context-management")!)).toBe(
    "false (proxy default)",
  );
  // The ownership allowlist is exactly the opt-in entries' paths, set or not.
  expect(optInProxyConfigPaths()).toEqual([
    ["alphaSearchCodexPriority"],
    ["alphaSearchModel"],
    ["claudeAutoModel"],
    ["claudeTokenMultiplier"],
    ["messageApiWebSearchModel"],
    ["contextManagement", "responses"],
  ]);
  // No two projected entries (force or opt-in, set or not) may share a path: a force entry
  // always re-emits its path, which would permanently disable the opt-in clearing pass for it.
  const allProjectedPaths = CONFIG_REGISTRY.filter(isProxyProjected).map((d) =>
    JSON.stringify(d.proxyPath ?? [d.key])
  );
  expect(new Set(allProjectedPaths).size).toBe(allProjectedPaths.length);
});

test("the alpha-search and claude proxy keys are opt-in projections at the top level", () => {
  tmpHome();
  // Unset -> absent from the projection, so the proxy's own defaults stand.
  const empty = projectedProxyConfig();
  const keys = [
    "alphaSearchCodexPriority",
    "alphaSearchModel",
    "claudeAutoModel",
    "claudeTokenMultiplier",
  ];
  for (const key of keys) {
    expect(projectedValue(empty, [key])).toBeUndefined();
  }
  // Set through the CLI path -> each appears under its own top-level proxy key.
  runConfig({ set: ["alpha-search-codex-priority", "false"] });
  runConfig({ set: ["alpha-search-model", "gpt-5"] });
  runConfig({ set: ["claude-auto-model", "claude-haiku-4.5"] });
  runConfig({ set: ["claude-token-multiplier", "1.3"] });
  const projected = projectedProxyConfig();
  expect(projectedValue(projected, ["alphaSearchCodexPriority"])).toBe(false);
  expect(projectedValue(projected, ["alphaSearchModel"])).toBe("gpt-5");
  expect(projectedValue(projected, ["claudeAutoModel"])).toBe("claude-haiku-4.5");
  expect(projectedValue(projected, ["claudeTokenMultiplier"])).toBe(1.3);
  for (
    const cli of [
      "alpha-search-codex-priority",
      "alpha-search-model",
      "claude-auto-model",
      "claude-token-multiplier",
    ]
  ) {
    expect(isProxyProjected(configKeyDef(cli)!)).toBe(true);
    expect(configKeyDef(cli)?.proxyDefault).toBeUndefined();
  }
});

test("sinceProxyVersion pins the upstream introduction of the version-gated keys", () => {
  // Verified against upstream: the aged float target can legitimately install a proxy
  // older than these, which would silently ignore the projected key.
  expect(configKeyDef("claude-auto-model")?.sinceProxyVersion).toBe("1.14.22");
  expect(configKeyDef("alpha-search-codex-priority")?.sinceProxyVersion).toBe("1.15.0");
  expect(configKeyDef("alpha-search-model")?.sinceProxyVersion).toBe("1.16.3");
  // claude-token-multiplier predates the proxy floor, so it carries no gate.
  expect(configKeyDef("claude-token-multiplier")?.sinceProxyVersion).toBeUndefined();
  // Every pin must be strict x.y.z: versionLessThan fails OPEN on a malformed operand,
  // so a typo'd pin would silently disable its warning.
  for (const def of CONFIG_REGISTRY) {
    if (def.sinceProxyVersion !== undefined) {
      expect(def.sinceProxyVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  }
});

test("sinceProxyVersionWarning fires only when the installed proxy predates the key", () => {
  const def = configKeyDef("alpha-search-model")!;
  const warning = sinceProxyVersionWarning(def, "1.14.21");
  expect(warning).toBe(
    "The installed proxy 1.14.21 does not read 'alpha-search-model' (added in copilot-api " +
      "1.16.3); it applies once the proxy is >= 1.16.3.",
  );
  expect(sinceProxyVersionWarning(def, "1.16.3")).toBeNull(); // equal: reads it
  expect(sinceProxyVersionWarning(def, "1.17.0")).toBeNull(); // newer: reads it
  // No proxy installed (a Direct-only setup may set keys for later): no warning.
  expect(sinceProxyVersionWarning(def, null)).toBeNull();
  // An ungated key never warns, however old the proxy.
  expect(sinceProxyVersionWarning(configKeyDef("claude-token-multiplier")!, "1.11.0")).toBeNull();
});

test("unreadProjectedKeyWarnings covers stored gated keys at start time", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  // Nothing stored: nothing to warn about, however old the proxy.
  expect(unreadProjectedKeyWarnings(cfg, "1.11.0")).toEqual([]);

  cfg.set({ alphaSearchModel: "gpt-5", claudeTokenMultiplier: 1.5, autoStart: true });
  // The stored gated key warns on an older proxy; the ungated and internal keys never do.
  const warnings = unreadProjectedKeyWarnings(cfg, "1.14.21");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("alpha-search-model");
  // New-enough or missing proxy: silent.
  expect(unreadProjectedKeyWarnings(cfg, "1.16.3")).toEqual([]);
  expect(unreadProjectedKeyWarnings(cfg, null)).toEqual([]);
});

test("the union rejects sinceProxyVersion on internal (non-projected) entries", () => {
  // @ts-expect-error - sinceProxyVersion exists only on the projected shapes
  const bad: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    describe: "bogus",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
    sinceProxyVersion: "1.0.0",
  };
  expect(bad.cli).toBe("bogus");
});

test("the entry type forces a schema matching the key's own value type", () => {
  // Every registry entry must carry the key's VALUE domain schema: CONFIG_SCHEMA is folded
  // from these, so an entry that compiled without one would be write-only (accepted by
  // --set, stripped by the read schema) -- the exact bug the fold removes.
  // @ts-expect-error - schema is required on every entry
  const missing: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    describe: "bogus",
    parse: () => true,
    defaultValue: false,
  };
  expect(missing.cli).toBe("bogus");
  // ... and the schema's output must BE the key's declared field type, so one key's entry
  // cannot smuggle in another key's domain (autoStart is a boolean field; a number schema
  // cannot serve it).
  // @ts-expect-error - the schema must validate the key's own value type
  const mismatched: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    describe: "bogus",
    schema: v.number(),
    parse: () => true,
    defaultValue: false,
  };
  expect(mismatched.cli).toBe("bogus");
});

test("the registry's storage keys are pinned total over CopilotEnvConfigData", () => {
  // Every CopilotEnvConfigData field is optional, so a registry literal missing one would
  // still compile: the key would be written by set() yet silently stripped by the folded
  // read schema. The totality pin in env_config.ts makes the omission a compile error.
  // @ts-expect-error - a mapped record missing a stored key (autoStart) fails the pin
  type _Missing = TotalOverConfigKeys<{ [K in Exclude<ConfigKey, "autoStart">]: K }>;
  // ... and the other direction: a storage key OUTSIDE CopilotEnvConfigData is rejected
  // per entry by ConfigKeyDefCore's `key`, so the pinned union can never grow an extra key.
  const extra: ConfigKeyDef = {
    cli: "bogus",
    // @ts-expect-error - 'bogus' is not a key of CopilotEnvConfigData
    key: "bogus",
    describe: "bogus",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
  };
  expect(extra.cli).toBe("bogus");
});

test("isProxyProjected marks force + opt-in keys, not copilot-env-internal ones", () => {
  expect(isProxyProjected(configKeyDef("responses-websocket")!)).toBe(true); // force
  expect(isProxyProjected(configKeyDef("message-websearch-model")!)).toBe(true); // opt-in
  expect(isProxyProjected(configKeyDef("auto-start")!)).toBe(false);
  // proxy-logs is launch wiring, not a projection -- but it still needs a daemon restart,
  // like the other keys `agent start` reads when launching (passthrough, idle-timeout, port).
  expect(isProxyProjected(configKeyDef("proxy-logs")!)).toBe(false);
  expect(configKeyDef("proxy-logs")?.restartToApply).toBe(true);
  expect(configKeyDef("passthrough")?.restartToApply).toBe(true);
  expect(configKeyDef("idle-timeout")?.restartToApply).toBe(true);
  expect(configKeyDef("port")?.restartToApply).toBe(true);
  // auto-start stays unmarked: the resolver and the in-daemon watchdog read it live (though
  // ATTACHING a watchdog to an already-running unmanaged daemon still takes a relaunch).
  expect(configKeyDef("auto-start")?.restartToApply).toBeUndefined();
  expect(configKeyDef("small-model")?.proxyDefault).toBe("gpt-5-mini");
  expect(configKeyDef("responses-websocket")?.proxyDefault).toBe(true);
  expect(configKeyDef("message-websearch-model")?.proxyDefault).toBeUndefined();
  expect(configKeyDef("message-websearch-model")?.proxyProjected).toBe(true);
  // codex-model-catalog is copilot-env-internal (read at auth/wiring time, never
  // projected into the proxy) and needs no daemon restart.
  expect(isProxyProjected(configKeyDef("codex-model-catalog")!)).toBe(false);
  expect(configKeyDef("codex-model-catalog")?.restartToApply).toBeUndefined();
  expect(configDefaultLabel(configKeyDef("codex-model-catalog")!)).toBe("false");
});

test("registry defaults are single-sourced: labels derive from the owned default value", () => {
  for (const def of CONFIG_REGISTRY) {
    // One source per entry: an owned value (defaultValue or proxyDefault, never both) OR a
    // hand-written label for defaults owned elsewhere (proxy-internal / composite).
    const owned = def.defaultValue ?? def.proxyDefault;
    if (owned !== undefined) {
      expect(def.defaultValue === undefined || def.proxyDefault === undefined).toBe(true);
      expect(def.defaultLabel).toBeUndefined();
      expect(configDefaultLabel(def)).toBe(`${owned}${def.defaultSuffix ?? ""}`);
    } else {
      expect(def.defaultLabel).toBeTruthy();
      expect(def.defaultSuffix).toBeUndefined();
    }
    // Every key still renders a non-empty default in `--help` / `--get`.
    expect(configDefaultLabel(def).length).toBeGreaterThan(0);
  }

  // The read sites consume the registry's values (via the CopilotEnvConfig accessors), so
  // these pins guard ONE fact each.
  expect(configDefaultNumber("port")).toBe(4141);
  expect(configDefaultNumber("min-port")).toBe(1024);
  expect(configDefaultNumber("max-port")).toBe(65535);
  expect(configDefaultNumber("idle-timeout")).toBe(3600);

  // Rendered labels keep their exact wording (external contract of `--help` / `--get`).
  expect(configDefaultLabel(configKeyDef("port")!)).toBe("4141 (then next free)");
  expect(configDefaultLabel(configKeyDef("integration-id")!)).toBe("auto (probe per credential)");
  expect(configDefaultLabel(configKeyDef("small-model")!)).toBe("gpt-5-mini");
  expect(configDefaultLabel(configKeyDef("alpha-search-codex-priority")!)).toBe(
    "true (proxy default)",
  );
  expect(configDefaultLabel(configKeyDef("alpha-search-model")!)).toBe(
    "gpt-5-mini (proxy default)",
  );
  expect(configDefaultLabel(configKeyDef("claude-auto-model")!)).toBe("unset (disabled)");
  expect(configDefaultLabel(configKeyDef("claude-token-multiplier")!)).toBe("1.15 (proxy default)");
  // The composite websearch label's mcp half is owned by web_search.ts (which imports
  // env_config, so the registry cannot reference it); pin the copy instead.
  expect(configDefaultLabel(configKeyDef("message-websearch-model")!)).toBe(
    `gpt-5-mini (proxy) / ${DEFAULT_WEB_SEARCH_MODEL} (mcp)`,
  );
});

test("the release-cooldown label tracks the built-in default it describes", () => {
  // The one hand-written label with an importable in-repo source of truth: proxy_float.ts
  // owns the constant but imports env_config, so the registry cannot reference it directly.
  // Derive the label from the constant here, like the other cross-module literal pins.
  const days = DEFAULT_RELEASE_COOLDOWN_SECONDS / SECONDS_PER_DAY;
  expect(configDefaultLabel(configKeyDef("release-cooldown")!)).toBe(`${days} days (built-in)`);
});
