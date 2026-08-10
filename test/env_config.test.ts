import { afterEach, expect, test } from "bun:test";

import { runConfig } from "../src/commands/config.ts";
import {
  CONFIG_REGISTRY,
  CopilotEnvConfig,
  configDefaultLabel,
  configDefaultNumber,
  configKeyDef,
  isProxyProjected,
  optInProxyConfigPaths,
  type ProjectedProxyEntry,
  projectedProxyConfig,
} from "../src/copilot_api/env_config.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "../src/copilot_api/web_search.ts";
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
});

test("the registry parsers accept valid input and reject bad input with a clear message", () => {
  expect(configKeyDef("auto-start")?.parse("true")).toBe(true);
  expect(configKeyDef("auto-start")?.parse("off")).toBe(false);
  expect(configKeyDef("passthrough")?.parse("AUTO")).toBe("auto");
  expect(configKeyDef("idle-timeout")?.parse("300")).toBe(300);
  expect(configKeyDef("proxy-logs")?.parse("false")).toBe(false);
  expect(configKeyDef("port")?.parse("4141")).toBe(4141);
  expect(configKeyDef("codex-model-catalog")?.parse("yes")).toBe(true);

  expect(() => configKeyDef("auto-start")?.parse("maybe")).toThrow();
  expect(() => configKeyDef("passthrough")?.parse("sometimes")).toThrow();
  expect(() => configKeyDef("idle-timeout")?.parse("-5")).toThrow();
  expect(() => configKeyDef("port")?.parse("70000")).toThrow(); // out of range
  expect(() => configKeyDef("codex-model-catalog")?.parse("bogus")).toThrow();
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

test("the registry covers exactly the documented keys, in alphabetical order", () => {
  const clis = CONFIG_REGISTRY.map((d) => d.cli);
  expect(clis).toEqual([
    "auto-start",
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
    ["messageApiWebSearchModel"],
    ["contextManagement", "responses"],
  ]);
  // No two projected entries (force or opt-in, set or not) may share a path: a force entry
  // always re-emits its path, which would permanently disable the opt-in clearing pass for it.
  const allProjectedPaths = CONFIG_REGISTRY.filter(isProxyProjected).map((d) =>
    JSON.stringify(d.proxyPath ?? [d.key]),
  );
  expect(new Set(allProjectedPaths).size).toBe(allProjectedPaths.length);
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
  // The composite websearch label's mcp half is owned by web_search.ts (which imports
  // env_config, so the registry cannot reference it); pin the copy instead.
  expect(configDefaultLabel(configKeyDef("message-websearch-model")!)).toBe(
    `gpt-5-mini (proxy) / ${DEFAULT_WEB_SEARCH_MODEL} (mcp)`,
  );
});
