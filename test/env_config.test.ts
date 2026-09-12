import { chmodSync } from "node:fs";
import * as v from "valibot";
import {
  configTable,
  configTableOutput,
  runConfig,
  sinceProxyVersionWarning,
  unreadProjectedKeyWarnings,
} from "../src/commands/config.ts";
import {
  codexHostEnabledFor,
  CONFIG_REGISTRY,
  CONFIG_SECTIONS,
  type ConfigCli,
  configDefaultNumber,
  configDefaultValue,
  type ConfigKey,
  type ConfigKeyDef,
  configKeyDef,
  CopilotEnvConfig,
  isProxyProjected,
  OPENROUTER_MODELS_URL,
  optInProxyConfigPaths,
  projectedProxyConfig,
  type ProjectedProxyEntry,
  type TotalOverConfigKeys,
} from "../src/copilot_api/env_config.ts";
import { anyTrackedDaemonAlive } from "../src/copilot_api/daemon.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "../src/copilot_api/web_search.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { nextProxyVersion } from "../src/proxy_float.ts";
import { COLOR_ENABLED } from "../src/utils/ansi.ts";
import { SECONDS_PER_DAY } from "../src/utils/time.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

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
    pricingUrl: "https://pricing.example/models",
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
    pricingUrl: "https://pricing.example/models",
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
  expect(cfg.pricingUrl()).toBe("https://pricing.example/models");

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

  cfg.del("pricingUrl");
  expect(cfg.read().pricingUrl).toBeUndefined();
  expect(cfg.pricingUrl()).toBe(OPENROUTER_MODELS_URL);
});

test("the read schema is lenient: ill-typed / out-of-range stored values fall back to default", () => {
  tmpHome();
  new CopilotEnvConfig().set({ port: 70000 as unknown as number });
  // Out of range reads back as undefined, never a throw.
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
  expect(configKeyDef("pricing-url")?.parse(" https://pricing.example/models?x=1 ")).toBe(
    "https://pricing.example/models?x=1",
  );
  // Canonical spelling: the fetch's https check and the cache digest see one form.
  expect(configKeyDef("pricing-url")?.parse("HTTPS://Pricing.Example/Models")).toBe(
    "https://pricing.example/Models",
  );

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
  // Only https parses; the rejection is fixed text (a price-list URL may carry credentials).
  for (
    const bad of ["http://user:secret@pricing.example/models", "pricing.example", "", "ftp://x"]
  ) {
    expect(() => configKeyDef("pricing-url")?.parse(bad)).toThrow(/^expected an https:\/\/ URL$/);
  }
  // Userinfo is rejected up front: fetch refuses such a URL, so storing it could only fail at
  // run time. The rejection names the alternative without echoing the value.
  for (
    const bad of [
      "https://user:secret@pricing.example/models",
      "https://token@pricing.example/",
      "https://:secret@pricing.example/",
    ]
  ) {
    expect(() => configKeyDef("pricing-url")?.parse(bad)).toThrow(
      /^expected an https:\/\/ URL without user:password@ credentials \(put a token in the query instead\)$/,
    );
  }
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
  // The bug: `--set port 5000 --get` wrote the key and silently dropped --get. Both --get
  // spellings, bare and keyed, are rejected.
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
  // The pin lands in HTTP headers, so a header-splitting value is rejected, and never
  // echoed: junk pasted here may be a token.
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

test("pricing-url: --set rejects a non-https URL without echoing it; stored junk reads as the default", () => {
  tmpHome();
  let message = "";
  try {
    runConfig({ set: ["pricing-url", "http://user:secret@pricing.example/models"] });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("invalid value for 'pricing-url'");
  expect(message).toContain("https://");
  expect(message).not.toContain("secret");
  expect(new CopilotEnvConfig().read().pricingUrl).toBeUndefined();

  runConfig({ set: ["pricing-url", "https://pricing.example/models"] });
  expect(new CopilotEnvConfig().pricingUrl()).toBe("https://pricing.example/models");

  // A hand-mangled STORED value degrades to unset: the built-in URL, never a bad fetch.
  new CopilotEnvConfig().set({ pricingUrl: "not a url" });
  expect(new CopilotEnvConfig().read().pricingUrl).toBeUndefined();
  expect(new CopilotEnvConfig().pricingUrl()).toBe(OPENROUTER_MODELS_URL);
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

// One valid `--set` string per registry key, typed over ConfigCli: a new registry key without
// an entry here is a compile error, so the round trip below covers every key.
const ROUND_TRIP_RAW: Record<ConfigCli, string> = {
  "alpha-search-codex-priority": "false",
  "alpha-search-model": "gpt-5",
  "auto-start": "true",
  "auto-update": "true",
  "claude-auto-model": "claude-haiku-4.5",
  "claude-desktop": "false",
  "claude-token-multiplier": "1.3",
  "codex-host": "true",
  "codex-model-catalog": "true",
  "idle-timeout": "120",
  "integration-id": "copilot-developer-cli",
  "launchers": "true",
  "max-port": "60000",
  "message-websearch-model": "gpt-5",
  "messages-api": "false",
  "min-port": "2000",
  "passthrough": "on",
  "port": "4242",
  "pricing-url": "https://pricing.example/models",
  "credits-target": "8000000",
  "proxy-logs": "false",
  "proxy-version": "1.2.3",
  "release-cooldown": "86400",
  "responses-context-management": "true",
  "responses-websearch": "false",
  "responses-websocket": "false",
  "small-model": "gpt-5-mini",
  "strict-port": "true",
  "update-cooldown": "7",
  "verify-provenance": "false",
  "wire-mcp": "false",
};

test("every registry key round-trips: a CLI-set value survives read() and reaches the projection", () => {
  tmpHome();
  for (const def of CONFIG_REGISTRY) {
    // Set as on Linux: the POSIX-only keys refuse `--set` on Windows (own test below).
    runConfig({ set: [def.cli, ROUND_TRIP_RAW[def.cli as ConfigCli]] }, "linux");
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

test("proxy-logs: off by default, a stored value wins", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.proxyLogsEnabled()).toBe(false);
  runConfig({ set: ["proxy-logs", "true"] });
  expect(cfg.proxyLogsEnabled()).toBe(true);
});

test("auto-update: stored else default, degraded read like auto-start (the preflight is best-effort)", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.autoUpdateEnabled()).toBe(false); // unset -> the built-in default
  runConfig({ set: ["auto-update", "on"] });
  expect(cfg.autoUpdateEnabled()).toBe(true);
  runConfig({ del: "auto-update" });
  expect(cfg.autoUpdateEnabled()).toBe(false);
  // An unreadable store degrades to "off" (the preflight must never act on an unproven on).
  chmodSync(new CopilotApiPaths().envConfigFile, 0o000);
  try {
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(cfg.autoUpdateEnabled()).toBe(false);
    }
  } finally {
    chmodSync(new CopilotApiPaths().envConfigFile, 0o600);
  }
});

test("codex-host: stored else default, POSIX-only set, and Windows always reads off", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  // The one platform rule the accessor and the settings-import plan share.
  expect(codexHostEnabledFor(undefined, "linux")).toBe(false);
  expect(codexHostEnabledFor(true, "darwin")).toBe(true);
  expect(codexHostEnabledFor(true, "win32")).toBe(false);
  expect(cfg.codexHostEnabled("linux")).toBe(false);
  runConfig({ set: ["codex-host", "true"] }, "darwin");
  expect(cfg.codexHostEnabled("linux")).toBe(true);
  // Windows has no farm: the stored true (e.g. from an imported bundle) reads as off there.
  expect(cfg.codexHostEnabled("win32")).toBe(false);
  // `--set` on Windows is refused with a platform message, and writes nothing.
  runConfig({ del: "codex-host" });
  expect(() => runConfig({ set: ["codex-host", "true"] }, "win32")).toThrow(
    "'codex-host' is only supported on Linux and macOS (this is win32); it cannot be set here.",
  );
  expect(cfg.read().codexHost).toBeUndefined();
  // A plain (not POSIX-only) key is unaffected by the platform.
  runConfig({ set: ["auto-start", "true"] }, "win32");
  expect(cfg.autoStartEnabled()).toBe(true);
  // A stored true (an imported bundle) is INERT on Windows: the keyed read answers with
  // the built-in default and the table names the inert value instead of hiding it.
  cfg.set({ codexHost: true });
  const stdoutOf = (run: () => void): string => {
    const written: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    };
    try {
      run();
    } finally {
      process.stdout.write = orig;
    }
    return written.join("");
  };
  expect(stdoutOf(() => runConfig({ get: "codex-host" }, "linux"))).toBe("true\n");
  expect(stdoutOf(() => runConfig({ get: "codex-host" }, "win32"))).toBe("false\n");
  // The table is stdout too, and the command hands the renderer the same platform.
  expect(stdoutOf(() => runConfig({ get: true }, "win32"))).toBe(
    `${configTableOutput("win32")}\n`,
  );
});

test("configTableOutput() takes the terminal's width; off a TTY or on a size-less pty it uses 80", () => {
  tmpHome();
  const tableAt = (width: number): string =>
    configTable(new CopilotEnvConfig().read(), {
      platform: "linux",
      width,
      daemonUp: anyTrackedDaemonAlive(),
      proxyVersion: nextProxyVersion(),
      color: COLOR_ENABLED,
    });
  const setColumns = (value: number): void => {
    Object.defineProperty(process.stdout, "columns", { value, configurable: true, writable: true });
  };
  // The test runner's stdout is no TTY: `columns` is absent here, as it is off any TTY.
  const orig = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  expect(process.stdout.columns).toBeUndefined();
  expect(configTableOutput("linux")).toBe(tableAt(80));
  try {
    setColumns(140);
    expect(tableAt(140)).not.toBe(tableAt(80));
    expect(configTableOutput("linux")).toBe(tableAt(140));
    // A size-less pty reports 0 columns: the fallback again, not a zero-width table.
    setColumns(0);
    expect(process.stdout.columns).toBe(0);
    expect(configTableOutput("linux")).toBe(tableAt(80));
  } finally {
    if (orig === undefined) Reflect.deleteProperty(process.stdout, "columns");
    else Object.defineProperty(process.stdout, "columns", orig);
  }
});

test("the registry is alphabetical by CLI name with unique storage keys", () => {
  const clis = CONFIG_REGISTRY.map((d) => d.cli);
  // The display order IS alphabetical -- a new key must be inserted in place.
  expect(clis).toEqual([...clis].sort());
  // CLI names are unique: configKeyDef() is a find(), so a duplicate would silently
  // resolve to the first entry.
  expect(new Set(clis).size).toBe(clis.length);
  // Storage keys are unique: the CONFIG_SCHEMA fold is fromEntries, where a duplicate
  // would silently overwrite the earlier entry's read schema.
  const keys = CONFIG_REGISTRY.map((d) => d.key);
  expect(new Set(keys).size).toBe(keys.length);
});

const PLAIN_TABLE = {
  platform: "linux",
  width: 80,
  daemonUp: false,
  proxyVersion: "1.16.3",
  color: false,
} as const;

test("configTable() renders the header, the sections, and key=value rows with type, default, and description in one 80-column layout", () => {
  // Stored: a plain flag, a key applied without the daemon, a POSIX-only key on Windows (inert
  // there), and the key whose default is a URL too long to share a line with its type.
  const data = {
    strictPort: true,
    launchers: true,
    codexHost: true,
    pricingUrl: "https://prices.example/api/v1/models/latest",
  };
  const rendered = configTable(data, { ...PLAIN_TABLE, platform: "win32" });
  const [header = "", ...blocks] = rendered.split("\n\n");
  expect(header).toBe(
    `4 of ${CONFIG_REGISTRY.length} keys set (*).  agent config --set <key> <value>  |  --del <key> reverts`,
  );
  // Parsing the rows back pins the grouping and order (and that every section has keys),
  // not just presence.
  expect(new Set(CONFIG_SECTIONS).size).toBe(CONFIG_SECTIONS.length);
  const rowRe = /^([* ]) (\S+)=/;
  const parsed = blocks.map((block) => {
    const [heading = "", ...lines] = block.split("\n");
    return { heading, keys: lines.flatMap((l) => l.match(rowRe)?.[2] ?? []) };
  });
  expect(parsed.map((b) => b.heading)).toEqual(CONFIG_SECTIONS.map((s) => `${s}:`));
  expect(parsed.map((b) => b.keys)).toEqual(
    CONFIG_SECTIONS.map((s) => CONFIG_REGISTRY.filter((d) => d.section === s).map((d) => d.cli)),
  );
  const lines = rendered.split("\n");
  const rowAt = (cli: string): number => {
    const at = lines.findIndex((l) => rowRe.exec(l)?.[2] === cli);
    if (at < 0) throw new Error(`no row for '${cli}'`);
    return at;
  };
  const row = (cli: string): string => lines[rowAt(cli)] ?? "";
  // The right column starts where the stored row's `[type]` does, and every type cell in the
  // table shares that column; nothing runs past the width.
  const column = row("strict-port").indexOf("[");
  expect(column).toBeGreaterThan(2);
  for (const def of CONFIG_REGISTRY) {
    const typeLine = lines.slice(rowAt(def.cli)).find((l) => l.includes(`[${def.type}]`)) ?? "";
    expect(typeLine.indexOf("[")).toBe(column);
  }
  // Right-column cells pack to the width like words; the one line past the cap is the URL
  // default, an unbreakable cell wider than the column.
  expect(lines.filter((l) => l.length > PLAIN_TABLE.width)).toEqual([
    " ".repeat(column) + `default ${OPENROUTER_MODELS_URL}`,
  ]);
  // A stored key: the star, the stored value, its type, and its bare default.
  expect(row("strict-port")).toBe(`* strict-port=true`.padEnd(column) + "[bool] default false");
  // An unset key shows its built-in default as the value, no star, no `default` cell.
  expect(row("port")).toBe(`  port=4141`.padEnd(column) + "[1-65535]");
  // No stored value and no built-in default: `<unset>`.
  expect(row("claude-auto-model")).toBe(
    `  claude-auto-model=<unset>`.padEnd(column) + "[model id]",
  );
  // A key=value too long for the column keeps its own line; its right column starts below,
  // and a cell that will not fit beside the type moves down again.
  const url = rowAt("pricing-url");
  expect(lines[url]).toBe(`* pricing-url=${data.pricingUrl}`);
  expect(lines[url + 1]).toBe(" ".repeat(column) + "[url]");
  expect(lines[url + 2]).toBe(" ".repeat(column) + `default ${OPENROUTER_MODELS_URL}`);
  // A stored POSIX-only value on Windows is still starred (it IS stored) and named inert, the
  // note packed onto the next line where it does not fit beside the type and default.
  expect(row("codex-host")).toBe(`* codex-host=true`.padEnd(column) + "[bool] default false");
  expect(lines[rowAt("codex-host") + 1]).toBe(" ".repeat(column) + "(inert on this platform)");
  // The description follows the type line at the column, wrapped on spaces to the width and
  // re-joining to the registry text; a long one takes more than one line.
  const describeLines = (cli: string): string[] => {
    const out: string[] = [];
    for (const l of lines.slice(rowAt(cli) + 1)) {
      if (!l.startsWith(" ".repeat(column)) || l.startsWith(" ".repeat(column + 1))) break;
      out.push(l.slice(column));
    }
    // The right column's `[type]` line sits on the row line, or below it for an overflowing
    // key=value; either way the description is what remains.
    return out.filter((l) => !l.startsWith("["));
  };
  // Among the UNSTORED keys, whose right column is the type line and the description only.
  const longest = CONFIG_REGISTRY.filter((d) => !(d.key in data)).reduce((a, b) =>
    a.describe.length > b.describe.length ? a : b
  );
  expect(longest.describe.length).toBeGreaterThan(PLAIN_TABLE.width - column);
  expect(describeLines(longest.cli).length).toBeGreaterThan(1);
  expect(describeLines(longest.cli).join(" ")).toBe(longest.describe);
  // With no daemon the restart line never prints; with one, only a stored key the daemon read
  // at launch (projected or restartToApply) gets it -- not a stored key applied another way.
  expect(rendered).not.toContain("restart the proxy to apply");
  const live = configTable(data, { ...PLAIN_TABLE, platform: "win32", daemonUp: true }).split(
    "\n",
  );
  const restartAfter = (cli: string): boolean =>
    live[live.findIndex((l) => rowRe.exec(l)?.[2] === cli) + 1] ===
      " ".repeat(column) + "restart the proxy to apply";
  expect(restartAfter("strict-port")).toBe(true);
  expect(restartAfter("launchers")).toBe(false);
  // A restart line only when the proxy that runs next will read the key.
  //   proxy older than the key's gate  -> no line (`--set` suppresses its hint the same way)
  //   new enough                       -> line
  //   version unknown                  -> no line on any row
  const gated = { ...data, alphaSearchModel: "gpt-5" };
  const restartLineFor = (proxyVersion: string | null, cli: string): boolean => {
    const out = configTable(gated, { ...PLAIN_TABLE, daemonUp: true, proxyVersion }).split("\n");
    const at = out.findIndex((l) => rowRe.exec(l)?.[2] === cli);
    return out[at + 1] === " ".repeat(column) + "restart the proxy to apply";
  };
  expect(restartLineFor("1.14.21", "alpha-search-model")).toBe(false);
  expect(restartLineFor("1.16.3", "alpha-search-model")).toBe(true);
  expect(restartLineFor(null, "strict-port")).toBe(false);
});

test("configTable() at width 60 packs the header onto two lines and keeps every row within the width", () => {
  const out = configTable({ strictPort: true }, { ...PLAIN_TABLE, width: 60 }).split("\n");
  expect(out.slice(0, 3)).toEqual([
    `1 of ${CONFIG_REGISTRY.length} keys set (*).`,
    "agent config --set <key> <value>  |  --del <key> reverts",
    "",
  ]);
  expect(out.filter((l) => l.length > 60)).toEqual([]);
});

test("configTable() at width 40 stacks the right column under each key row at a six-space indent", () => {
  const out = configTable({ strictPort: true }, { ...PLAIN_TABLE, width: 40 }).split("\n");
  const at = out.indexOf("* strict-port=true");
  expect(at).toBeGreaterThan(0);
  expect(out[at + 1]).toBe("      [bool] default false");
  expect(out[at + 2]?.startsWith("      Fail start on a busy port")).toBe(true);
  // Only the unbreakable pieces run past the width: the header's syntax half and the URL value.
  expect(out.filter((l) => l.length > 40)).toEqual([
    "agent config --set <key> <value>  |  --del <key> reverts",
    `  pricing-url=${OPENROUTER_MODELS_URL}`,
  ]);
});

test("every registry key carries a type label owned by its value domain", () => {
  for (const def of CONFIG_REGISTRY) expect(def.type.length).toBeGreaterThan(0);
  expect(configKeyDef("port")?.type).toBe("1-65535");
  expect(configKeyDef("idle-timeout")?.type).toBe("seconds");
  expect(configKeyDef("passthrough")?.type).toBe("auto|on|off");
});

test("projectedProxyConfig() force-projects the opinionated keys and opt-in keys only when set", () => {
  tmpHome();
  // Empty store: the force-projected keys resolve to their built-in defaults; the opt-in keys
  // are absent so the proxy's own defaults stand.
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
  expect(configDefaultValue(configKeyDef("responses-context-management")!)).toBe(false);
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
    section: "Proxy daemon",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
    sinceProxyVersion: "1.0.0",
  };
  expect(bad.cli).toBe("bogus");
});

test("the entry type forces a schema matching the key's own value type", () => {
  // CONFIG_SCHEMA is folded from these entries, so one without a schema would be write-only:
  // accepted by --set, stripped by the read schema.
  // @ts-expect-error - schema is required on every entry
  const missing: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    section: "Proxy daemon",
    describe: "bogus",
    type: "bool",
    parse: () => true,
    defaultValue: false,
  };
  expect(missing.cli).toBe("bogus");
  // ... and the schema's output must be the key's declared field type, so one key's entry
  // cannot smuggle in another key's domain.
  // @ts-expect-error - the schema must validate the key's own value type
  const mismatched: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    section: "Proxy daemon",
    describe: "bogus",
    type: "bool",
    schema: v.number(),
    parse: () => true,
    defaultValue: false,
  };
  expect(mismatched.cli).toBe("bogus");
  // The default is typed by the key too: the table shows it as the value when unset, so a
  // default outside the key's domain would print something `--set` could never store.
  // @ts-expect-error - the default must be the key's own value type
  const wrongDefault: ConfigKeyDef = {
    cli: "bogus",
    key: "autoStart",
    section: "Proxy daemon",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: "yes",
  };
  expect(wrongDefault.cli).toBe("bogus");
});

test("the registry's storage keys are pinned total over CopilotEnvConfigData", () => {
  // Every CopilotEnvConfigData field is optional, so a registry missing one would compile and
  // the key would be written by set() yet stripped by the read schema; the totality pin makes
  // the omission a compile error.
  // @ts-expect-error - a mapped record missing a stored key (autoStart) fails the pin
  type _Missing = TotalOverConfigKeys<{ [K in Exclude<ConfigKey, "autoStart">]: K }>;
  // ... and the other direction: a storage key OUTSIDE CopilotEnvConfigData is rejected
  // per entry by ConfigKeyDefCore's `key`, so the pinned union can never grow an extra key.
  const extra: ConfigKeyDef = {
    cli: "bogus",
    // @ts-expect-error - 'bogus' is not a key of CopilotEnvConfigData
    key: "bogus",
    section: "Proxy daemon",
    describe: "bogus",
    type: "bool",
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
  expect(configDefaultValue(configKeyDef("codex-model-catalog")!)).toBe(false);
});

test("claude-desktop is opt-OUT: unset and deleted read enabled, stored false disables", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.claudeDesktopEnabled()).toBe(true);
  // Internal to copilot-env: setting it projects nothing new into the proxy's config.json.
  const before = projectedProxyConfig();
  cfg.set({ claudeDesktop: false });
  expect(cfg.claudeDesktopEnabled()).toBe(false);
  expect(projectedProxyConfig()).toEqual(before);
  cfg.del("claudeDesktop");
  expect(cfg.claudeDesktopEnabled()).toBe(true);
});

test("registry defaults are bare values: what --set stores, or absent when unset is the default", () => {
  // The read sites consume the registry's values (via the CopilotEnvConfig accessors), so
  // these pins guard ONE fact each.
  expect(configDefaultNumber("port")).toBe(4141);
  expect(configDefaultNumber("min-port")).toBe(1024);
  expect(configDefaultNumber("max-port")).toBe(65535);
  expect(configDefaultNumber("idle-timeout")).toBe(3600);
  expect(configDefaultNumber("release-cooldown")).toBe(7 * SECONDS_PER_DAY);
  expect(configDefaultValue(configKeyDef("pricing-url")!)).toBe(OPENROUTER_MODELS_URL);
  expect(configDefaultValue(configKeyDef("integration-id")!)).toBe("auto");
  expect(configDefaultValue(configKeyDef("small-model")!)).toBe("gpt-5-mini");
  // One default for both web-search surfaces: the proxy's own default must match the MCP
  // tool's DEFAULT_WEB_SEARCH_MODEL, owned by web_search.ts (which imports env_config, so
  // the registry cannot reference it).
  expect(configDefaultValue(configKeyDef("message-websearch-model")!)).toBe(
    DEFAULT_WEB_SEARCH_MODEL,
  );
  expect(DEFAULT_WEB_SEARCH_MODEL).toBe("gpt-5-mini");
  // Unset IS the default: a disabled override, a floating pin, and the update cooldown (whose
  // two read sites apply different defaults: none for `agent update`, 7 days for autoupdate).
  for (const cli of ["claude-auto-model", "proxy-version", "update-cooldown"] as const) {
    expect(configDefaultValue(configKeyDef(cli)!)).toBeUndefined();
  }
});

// One unreadable prefs file, two contracts. POSIX non-root only: root bypasses file modes.
//   read(), wiring, the float pin, the port knobs  -> throw; never decide on an unproven "no preference"
//   the in-daemon watchdog's tick gates            -> built-in defaults; a throw there would kill the serving daemon
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable prefs store: read() throws; the watchdog gates degrade to defaults",
  () => {
    tmpHome();
    const cfg = new CopilotEnvConfig();
    cfg.set({ autoStart: true, idleTimeout: 30, port: 5555 });
    const file = new CopilotApiPaths().envConfigFile;
    chmodSync(file, 0o000);
    try {
      expect(() => cfg.read()).toThrow("refusing to treat an unreadable store as empty");
      expect(() => cfg.defaultPort()).toThrow(file);
      expect(() => cfg.wireMcpEnabled()).toThrow(file);
      // The watchdog-reachable gates must NOT throw; they answer the defaults.
      expect(cfg.autoStartEnabled()).toBe(false);
      expect(cfg.idleTimeoutSeconds()).toBe(configDefaultNumber("idle-timeout"));
    } finally {
      chmodSync(file, 0o600);
    }
    // Control: readable again, every reader answers the stored values.
    expect(cfg.autoStartEnabled()).toBe(true);
    expect(cfg.idleTimeoutSeconds()).toBe(30);
    expect(cfg.defaultPort()).toBe(5555);
  },
);
