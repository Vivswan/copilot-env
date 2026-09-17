import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import {
  configTable,
  configTableOutput,
  runConfig,
  sinceProxyVersionWarning,
  unreadProjectedKeyWarnings,
} from "../src/commands/config.ts";
import {
  codexHomePrefsFor,
  CONFIG_GROUPS,
  CONFIG_REGISTRY,
  configDefaultNumber,
  configDefaultValue,
  configGroup,
  type ConfigKey,
  type ConfigKeyDef,
  configKeyDef,
  type ConfigScope,
  type ConfigValueTypes,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  formatConfigValue,
  GLOBAL_CONFIG_SCHEMA,
  isProxyProjected,
  OPENROUTER_MODELS_URL,
  optInProxyConfigPaths,
  projectedProxyConfig,
  type ProjectedProxyEntry,
  type TotalOverConfigKeys,
} from "../src/copilot_api/env_config.ts";
import { anyTrackedDaemonAlive, trackedDaemonAlive } from "../src/copilot_api/daemon.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "../src/copilot_api/web_search.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { nextProxyVersion } from "../src/proxy_float.ts";
import { COLOR_ENABLED } from "../src/utils/ansi.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// CopilotEnvConfig reads/writes the SHARED prefs store under COPILOT_API_HOME, so isolate
// each test in a temp home.
const restoreEnv = envSnapshot(["COLUMNS"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-envconfig-");
}

const WORK = parseProfileName("work");

/** `--profile <name>` refuses a profile the credential store does not know, so tests that address
 *  one commit it first. */
function createWorkProfile(): void {
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
}

/** Both maps, as read() returns them. */
function stored(
  global: CopilotEnvConfigData["global"],
  profiles: CopilotEnvConfigData["profiles"] = {},
): CopilotEnvConfigData {
  return { global, profiles };
}

function projectedValue(
  entries: readonly ProjectedProxyEntry[],
  path: readonly string[],
): boolean | number | string | undefined {
  return entries.find((e) => e.path.length === path.length && e.path.every((k, i) => k === path[i]))
    ?.value;
}

function stdoutOf(run: () => void): string {
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
}

test("each typed key round-trips and del() reverts it to undefined (default)", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.read()).toEqual(stored({}));

  const patch = {
    "daemon.auto-start": true,
    "daemon.idle-timeout": 120,
    "daemon.logs": false,
    "proxy.small-model": "gpt-5-mini",
    "proxy.responses.websocket": false,
    "proxy.responses.websearch": false,
    "proxy.messages-api": false,
    "proxy.responses.context-management": false,
    "proxy.message-websearch-model": "gpt-5-mini",
    "proxy.alpha-search.codex-priority": false,
    "proxy.alpha-search.model": "gpt-5",
    "proxy.claude-auto-model": "claude-haiku-4.5",
    "proxy.claude-token-multiplier": 1.15,
    "daemon.port": 4242,
    "cost.pricing-url": "https://pricing.example/models",
    "daemon.min-port": 2000,
    "daemon.max-port": 60000,
    "daemon.strict-port": true,
    "daemon.version": "1.2.3",
    "daemon.release-cooldown": 86400,
    "update.cooldown": 7,
    "codex.model-catalog": true,
    "claude.wire-mcp": false,
  } as const;
  cfg.set(patch);
  cfg.setProfile(null, { passthrough: "on" });
  expect(cfg.read()).toEqual(stored(patch, { default: { passthrough: "on" } }));
  expect(cfg.autoStartEnabled()).toBe(true);
  expect(cfg.codexModelCatalogEnabled()).toBe(true);
  expect(cfg.wireMcpEnabled()).toBe(false);
  expect(cfg.pricingUrl()).toBe("https://pricing.example/models");
  expect(cfg.passthroughOverride(null)).toBe(true);

  cfg.del("daemon.auto-start");
  expect(cfg.read().global["daemon.auto-start"]).toBeUndefined();
  expect(cfg.autoStartEnabled()).toBe(false);
  // Deleting one key leaves the others intact.
  expect(cfg.read().global["daemon.port"]).toBe(4242);

  cfg.del("codex.model-catalog");
  expect(cfg.codexModelCatalogEnabled()).toBe(false);

  // claude.wire-mcp is opt-OUT: unset reads as enabled.
  cfg.del("claude.wire-mcp");
  expect(cfg.read().global["claude.wire-mcp"]).toBeUndefined();
  expect(cfg.wireMcpEnabled()).toBe(true);

  cfg.del("cost.pricing-url");
  expect(cfg.pricingUrl()).toBe(OPENROUTER_MODELS_URL);

  // A profile section emptied by its last delete is removed, not left as `{}`.
  cfg.delProfile(null, "passthrough");
  expect(cfg.read().profiles).toEqual({});
  expect(cfg.passthroughOverride(null)).toBeUndefined();
});

test("the read schema is lenient: ill-typed / out-of-range stored values fall back to default", () => {
  tmpHome();
  new CopilotEnvConfig().set({ "daemon.port": 70000 as unknown as number });
  // Out of range reads back as undefined, never a throw.
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBeUndefined();

  // A stored non-positive multiplier is equally junk: reads back as unset.
  for (const junk of [0, -1.5, 5000]) {
    new CopilotEnvConfig().set({ "proxy.claude-token-multiplier": junk as unknown as number });
    expect(new CopilotEnvConfig().read().global["proxy.claude-token-multiplier"]).toBeUndefined();
  }
});

test("the registry parsers accept valid input and reject bad input with a clear message", () => {
  expect(configKeyDef("daemon.auto-start")?.parse("true")).toBe(true);
  expect(configKeyDef("daemon.auto-start")?.parse("off")).toBe(false);
  expect(configKeyDef("passthrough")?.parse("AUTO")).toBe("auto");
  expect(configKeyDef("daemon.idle-timeout")?.parse("300")).toBe(300);
  expect(configKeyDef("daemon.logs")?.parse("false")).toBe(false);
  expect(configKeyDef("daemon.port")?.parse("4141")).toBe(4141);
  expect(configKeyDef("codex.model-catalog")?.parse("yes")).toBe(true);
  expect(configKeyDef("proxy.alpha-search.codex-priority")?.parse("false")).toBe(false);
  expect(configKeyDef("proxy.alpha-search.model")?.parse(" gpt-5 ")).toBe("gpt-5");
  expect(configKeyDef("proxy.claude-auto-model")?.parse("claude-haiku-4.5")).toBe(
    "claude-haiku-4.5",
  );
  const multiplier = configKeyDef("proxy.claude-token-multiplier")!;
  expect(multiplier.parse("1.15")).toBe(1.15);
  expect(multiplier.parse("2")).toBe(2);
  expect(multiplier.parse(" 1.5 ")).toBe(1.5);
  const pricingUrl = configKeyDef("cost.pricing-url")!;
  expect(pricingUrl.parse(" https://pricing.example/models?x=1 ")).toBe(
    "https://pricing.example/models?x=1",
  );
  // Canonical spelling: the fetch's https check and the cache digest see one form.
  expect(pricingUrl.parse("HTTPS://Pricing.Example/Models")).toBe(
    "https://pricing.example/Models",
  );

  expect(() => configKeyDef("daemon.auto-start")?.parse("maybe")).toThrow();
  expect(() => configKeyDef("passthrough")?.parse("sometimes")).toThrow();
  // The rejection echoes the ORIGINAL raw input, not the trimmed/lowercased coercion.
  expect(() => configKeyDef("passthrough")?.parse(" BAD ")).toThrow(
    "expected one of auto|on|off, got ' BAD '",
  );
  // The boolean spelling the key had before it became a scope is refused with the four values.
  expect(() => configKeyDef("static-key")?.parse("true")).toThrow(
    "expected one of none|claude|codex|all, got 'true'",
  );
  expect(() => configKeyDef("daemon.idle-timeout")?.parse("-5")).toThrow();
  expect(() => configKeyDef("daemon.port")?.parse("70000")).toThrow(); // out of range
  expect(() => configKeyDef("codex.model-catalog")?.parse("bogus")).toThrow();
  expect(() => configKeyDef("proxy.alpha-search.model")?.parse("  ")).toThrow();
  expect(() => multiplier.parse("0")).toThrow(/greater than 0/);
  for (const bad of ["-1.5", "1.2.3", "fast", "1e2", "NaN", "Infinity"]) {
    expect(() => multiplier.parse(bad), bad).toThrow(/positive decimal/);
  }
  expect(() => multiplier.parse("1001")).toThrow(/at most 1000/);
  // Overflow-sized digit strings coerce to Infinity; the schema's own integer/finite
  // actions still answer with the range wording, not a bare valibot default.
  expect(() => configKeyDef("daemon.port")?.parse("9".repeat(400))).toThrow(
    /between 1 and 65535, got Infinity/,
  );
  expect(() => multiplier.parse("9".repeat(400))).toThrow(/at most 1000, got Infinity/);
  // Only https parses; the rejection is fixed text (a price-list URL may carry credentials).
  for (
    const bad of ["http://user:secret@pricing.example/models", "pricing.example", "", "ftp://x"]
  ) {
    expect(() => pricingUrl.parse(bad)).toThrow(/^expected an https:\/\/ URL$/);
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
    expect(() => pricingUrl.parse(bad)).toThrow(
      /^expected an https:\/\/ URL without user:password@ credentials \(put a token in the query instead\)$/,
    );
  }
  expect(configKeyDef("nope")).toBeUndefined();
});

test("runConfig --set validates + persists; --del reverts; unknown key / bad value error", () => {
  tmpHome();
  runConfig({ set: ["daemon.idle-timeout", "45"] });
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(45);

  runConfig({ del: "daemon.idle-timeout" });
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBeUndefined();

  expect(() => runConfig({ set: ["bogus-key", "1"] })).toThrow(/unknown config key/);
  expect(() => runConfig({ set: ["daemon.port", "notanumber"] })).toThrow(
    /invalid value for 'daemon.port'/,
  );
  expect(() => runConfig({ set: ["daemon.auto-start"] })).toThrow(/usage/); // missing value
  expect(() => runConfig({ del: "bogus-key" })).toThrow(/unknown config key/);
  expect(() => runConfig({ set: ["daemon.auto-start", "true"], del: "daemon.port" })).toThrow(
    /mutually exclusive/,
  );
});

test("runConfig --get cannot combine with --set/--del (never silently dropped)", () => {
  tmpHome();
  // The bug: `--set port 5000 --get` wrote the key and silently dropped --get. Both --get
  // spellings, bare and keyed, are rejected.
  expect(() => runConfig({ set: ["daemon.port", "5000"], get: true })).toThrow(
    "--get reads a preference and cannot combine with --set/--del",
  );
  expect(() => runConfig({ del: "daemon.port", get: "daemon.port" })).toThrow(
    "--get reads a preference and cannot combine with --set/--del",
  );
  // The rejected --set wrote nothing.
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBeUndefined();
});

test("resolveSetting: flag > profile > global > default, each layer only where the key's scope admits it", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  const at = <K extends ConfigKey>(key: K, profile: Profile, flag?: ConfigValueTypes[K]) =>
    cfg.resolve(key, { profile, flag });

  // A profile-default key: the built-in default, then the global value, then the profile's own
  // override, then the flag; another profile's override never leaks into the default's answer.
  expect(at("proxy.small-model", WORK)).toEqual({ value: "gpt-5-mini", source: "default" });
  cfg.set({ "proxy.small-model": "gpt-5" });
  expect(at("proxy.small-model", WORK)).toEqual({ value: "gpt-5", source: "global" });
  cfg.setProfile(WORK, { "proxy.small-model": "gpt-5-codex" });
  expect(at("proxy.small-model", WORK)).toEqual({ value: "gpt-5-codex", source: "profile" });
  expect(at("proxy.small-model", null)).toEqual({ value: "gpt-5", source: "global" });
  expect(at("proxy.small-model", WORK, "gpt-4.1")).toEqual({ value: "gpt-4.1", source: "flag" });

  // A profile key: the profile's own section or the default; the default profile's pin is not
  // another profile's, and the global map never holds it.
  cfg.setProfile(null, { identity: "copilot-developer-cli" });
  expect(at("identity", null)).toEqual({ value: "copilot-developer-cli", source: "profile" });
  expect(at("identity", WORK)).toEqual({ value: "auto", source: "default" });
  expect(cfg.read().global).not.toHaveProperty("identity");

  // A global key asked with a profile resolves from the global map, never from a section: a
  // hand-mangled section carrying one is stripped by the read schema.
  cfg.set({ "daemon.port": 4242 });
  expect(at("daemon.port", WORK)).toEqual({ value: 4242, source: "global" });
  writeFileSync(
    new CopilotApiPaths().envConfigFile,
    JSON.stringify({ global: {}, profiles: { work: { "daemon.port": 9999 } } }),
  );
  expect(at("daemon.port", WORK)).toEqual({ value: 4141, source: "default" });
  expect(cfg.read().profiles.work).toEqual({});
});

test("runConfig --profile: a profile key lands in that profile's section, never the global map; a global key refuses --profile by scope", () => {
  tmpHome();
  createWorkProfile();
  runConfig({ set: ["identity", "copilot-developer-cli"], profile: "work" });
  const data = new CopilotEnvConfig().read();
  expect(data.profiles).toEqual({ work: { identity: "copilot-developer-cli" } });
  expect(data.global).not.toHaveProperty("identity");
  expect(new CopilotEnvConfig().pinnedIntegrationId(WORK)).toBe("copilot-developer-cli");
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();
  expect(stdoutOf(() => runConfig({ get: "identity", profile: "work" }))).toBe(
    "copilot-developer-cli\n",
  );
  expect(stdoutOf(() => runConfig({ get: "identity" }))).toBe("auto\n");

  // Without --profile a profile key targets the default profile's section.
  runConfig({ set: ["identity", "copilot-developer-sandbox"] });
  expect(new CopilotEnvConfig().read().profiles.default).toEqual({
    identity: "copilot-developer-sandbox",
  });

  // A global key has no per-profile value: refused naming the scope, and nothing is written.
  expect(() => runConfig({ set: ["daemon.port", "4242"], profile: "work" })).toThrow(
    "'daemon.port' is a global setting (scope global)",
  );
  expect(() => runConfig({ del: "daemon.port", profile: "work" })).toThrow(/scope global/);
  expect(new CopilotEnvConfig().read().global).not.toHaveProperty("daemon.port");

  // A profile-default key: the global map without --profile, the profile's own section with it,
  // and --del reverts the same way.
  runConfig({ set: ["proxy.small-model", "gpt-5"] });
  runConfig({ set: ["proxy.small-model", "gpt-5-codex"], profile: "work" });
  expect(new CopilotEnvConfig().read().global["proxy.small-model"]).toBe("gpt-5");
  expect(new CopilotEnvConfig().read().profiles.work?.["proxy.small-model"]).toBe("gpt-5-codex");
  runConfig({ del: "proxy.small-model", profile: "work" });
  expect(new CopilotEnvConfig().read().profiles.work).toEqual({
    identity: "copilot-developer-cli",
  });
  expect(new CopilotEnvConfig().read().global["proxy.small-model"]).toBe("gpt-5");

  // A profile the credential store does not know is refused before anything is written.
  expect(() => runConfig({ set: ["identity", "auto"], profile: "other" })).toThrow();
  expect(new CopilotEnvConfig().read().profiles).not.toHaveProperty("other");
});

test("identity is header-safe end to end: --set rejects without echoing, stored junk reads unset", () => {
  tmpHome();
  // The pin lands in HTTP headers, so a header-splitting value is rejected, and never
  // echoed: junk pasted here may be a token.
  let message = "";
  try {
    runConfig({ set: ["identity", "evil\nX-Injected: 1"] });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("invalid value for 'identity'");
  expect(message).toContain("header-safe");
  expect(message).not.toContain("evil");
  expect(new CopilotEnvConfig().read().profiles).toEqual({});

  // The probe sentinel and real identities still parse.
  runConfig({ set: ["identity", "auto"] });
  expect(new CopilotEnvConfig().read().profiles.default?.identity).toBe("auto");
  runConfig({ set: ["identity", "copilot-developer-cli"] });
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe("copilot-developer-cli");

  // `codex` is the ABSENCE of the header, so a pin (always sent as the header's value) cannot mean
  // it; the store refuses it and keeps the previous pin.
  expect(() => runConfig({ set: ["identity", "codex"] })).toThrow(/cannot be pinned/);
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe("copilot-developer-cli");

  // A hand-mangled STORED value degrades to unset (= probe per credential),
  // never a baked header-splitting pin.
  new CopilotEnvConfig().setProfile(null, { identity: "evil\nX-Injected: 1" });
  expect(new CopilotEnvConfig().read().profiles.default?.identity).toBeUndefined();
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();
});

test("cost.pricing-url: --set rejects a non-https URL without echoing it; stored junk reads as the default", () => {
  tmpHome();
  let message = "";
  try {
    runConfig({ set: ["cost.pricing-url", "http://user:secret@pricing.example/models"] });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("invalid value for 'cost.pricing-url'");
  expect(message).toContain("https://");
  expect(message).not.toContain("secret");
  expect(new CopilotEnvConfig().read().global["cost.pricing-url"]).toBeUndefined();

  runConfig({ set: ["cost.pricing-url", "https://pricing.example/models"] });
  expect(new CopilotEnvConfig().pricingUrl()).toBe("https://pricing.example/models");

  // A hand-mangled STORED value degrades to unset: the built-in URL, never a bad fetch.
  new CopilotEnvConfig().set({ "cost.pricing-url": "not a url" });
  expect(new CopilotEnvConfig().read().global["cost.pricing-url"]).toBeUndefined();
  expect(new CopilotEnvConfig().pricingUrl()).toBe(OPENROUTER_MODELS_URL);
});

test("runConfig --get <key> prints just the value to stdout (script-friendly)", () => {
  tmpHome();
  new CopilotEnvConfig().set({ "proxy.small-model": "gpt-5-mini" });
  expect(stdoutOf(() => runConfig({ get: "proxy.small-model" }))).toBe("gpt-5-mini\n");
  // Unset with no built-in default: a blank line.
  expect(stdoutOf(() => runConfig({ get: "proxy.claude-auto-model" }))).toBe("\n");
});

// One valid `--set` string per registry key, typed over ConfigKey: a new registry key without
// an entry here is a compile error, so the round trip below covers every key.
// Fully qualified on every platform: on Windows this carries the drive the domain requires.
const ABS_CODEX_HOME = resolve("/srv/codex");

const ROUND_TRIP_RAW: Record<ConfigKey, string> = {
  "claude.desktop": "false",
  "claude.wire-mcp": "false",
  "codex.home": ABS_CODEX_HOME,
  "codex.host": "true",
  "codex.model-catalog": "true",
  "cost.credits-target": "8000000",
  "cost.pricing-url": "https://pricing.example/models",
  "daemon.auto-start": "true",
  "daemon.idle-timeout": "120",
  "daemon.logs": "false",
  "daemon.max-port": "60000",
  "daemon.min-port": "2000",
  "daemon.port": "4242",
  "daemon.release-cooldown": "86400",
  "daemon.strict-port": "true",
  "daemon.version": "1.2.3",
  "host": "https://copilot.example",
  "identity": "copilot-developer-cli",
  "passthrough": "on",
  "proxy.alpha-search.codex-priority": "false",
  "proxy.alpha-search.model": "gpt-5",
  "proxy.claude-auto-model": "claude-haiku-4.5",
  "proxy.claude-token-multiplier": "1.3",
  "proxy.message-websearch-model": "gpt-5",
  "proxy.messages-api": "false",
  "proxy.responses.context-management": "true",
  "proxy.responses.websearch": "false",
  "proxy.responses.websocket": "false",
  "proxy.small-model": "gpt-5-mini",
  "shell.launchers": "true",
  "static-key": "all",
  "update.auto": "true",
  "update.cooldown": "7",
  "update.verify-provenance": "false",
};

test("every registry key round-trips: a CLI-set value survives read() and reaches the projection", () => {
  tmpHome();
  for (const def of CONFIG_REGISTRY) {
    // Set as on Linux: the POSIX-only keys refuse `--set` on Windows (own test below).
    runConfig({ set: [def.key, ROUND_TRIP_RAW[def.key]] }, "linux");
  }
  const cfg = new CopilotEnvConfig();
  const data = cfg.read();
  const projected = projectedProxyConfig(null, cfg);
  for (const def of CONFIG_REGISTRY) {
    const expected = def.parse(ROUND_TRIP_RAW[def.key]);
    // The read schema is folded from the registry, so a registry key can never be write-only:
    // the resolution returns the stored value, never the stripped-back default; a profile key
    // sits in the default profile's section and nowhere else.
    expect(cfg.resolve(def.key, { profile: null })).toEqual({
      value: expected,
      source: def.scope === "profile" ? "profile" : "global",
    });
    if (def.scope === "profile") expect(data.global).not.toHaveProperty(def.key);
    // ... and the projection reads through the same schema, so a projected key sees it.
    if (isProxyProjected(def)) {
      expect(projectedValue(projected, def.proxyPath!)).toBe(expected);
    }
  }
});

test("daemon.logs: off by default, a stored value wins", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.proxyLogsEnabled()).toBe(false);
  runConfig({ set: ["daemon.logs", "true"] });
  expect(cfg.proxyLogsEnabled()).toBe(true);
});

test("update.auto: stored else default, degraded read like daemon.auto-start (the preflight is best-effort)", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.autoUpdateEnabled()).toBe(false); // unset -> the built-in default
  runConfig({ set: ["update.auto", "on"] });
  expect(cfg.autoUpdateEnabled()).toBe(true);
  runConfig({ del: "update.auto" });
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

test("codex.home: an absolute path as typed or `auto`; `~` and relative paths are refused with the reason", () => {
  tmpHome();
  const def = configKeyDef("codex.home")!;
  // Trimmed, never expanded or normalized: the export and the write use the exact spelling.
  expect(def.parse(`  ${ABS_CODEX_HOME}  `)).toBe(ABS_CODEX_HOME);
  expect(def.parse("AUTO")).toBe("AUTO");
  for (const bad of ["~/.codex", "relative/dir", "", "  "]) {
    expect(() => def.parse(bad), bad).toThrow("expected an absolute path or `auto`");
  }
  // Rooted but driveless: path.isAbsolute says yes, the drive it lands on says otherwise.
  if (process.platform === "win32") {
    expect(() => def.parse("\\Codex")).toThrow("on Windows the drive is required");
    expect(def.parse("C:\\Codex")).toBe("C:\\Codex");
  }
  expect(() => runConfig({ set: ["codex.home", "~/.codex"] })).toThrow(
    /invalid value for 'codex.home'/,
  );
  expect(new CopilotEnvConfig().read().global["codex.home"]).toBeUndefined();
  // The fold the derivation reads: `auto` and unset are no path; a path leaves the farm key alone
  // (the farm then roots under the path), and Windows still has no farm.
  expect(codexHomePrefsFor({}, "linux")).toEqual({ explicit: null, hostFarm: false });
  expect(codexHomePrefsFor({ "codex.home": "Auto", "codex.host": true }, "linux")).toEqual({
    explicit: null,
    hostFarm: true,
  });
  expect(codexHomePrefsFor({ "codex.home": ABS_CODEX_HOME, "codex.host": true }, "linux"))
    .toEqual({ explicit: ABS_CODEX_HOME, hostFarm: true });
  expect(codexHomePrefsFor({ "codex.home": ABS_CODEX_HOME, "codex.host": true }, "win32"))
    .toEqual({ explicit: ABS_CODEX_HOME, hostFarm: false });
  // A hand-edited relative value reads as unset: the derivation falls back rather than writing
  // under the cwd.
  runConfig({ set: ["codex.home", ABS_CODEX_HOME] }, "win32");
  expect(new CopilotEnvConfig().codexHomePrefs("win32").explicit).toBe(ABS_CODEX_HOME);
  expect(v.parse(GLOBAL_CONFIG_SCHEMA, { "codex.home": "relative/dir" })["codex.home"])
    .toBeUndefined();
});

test("codex.host: stored else default, POSIX-only set, and Windows always reads off", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  // The one platform rule the accessor and the settings-import plan share.
  expect(codexHomePrefsFor({}, "linux").hostFarm).toBe(false);
  expect(codexHomePrefsFor({ "codex.host": true }, "darwin").hostFarm).toBe(true);
  expect(codexHomePrefsFor({ "codex.host": true }, "win32").hostFarm).toBe(false);
  expect(cfg.codexHostEnabled("linux")).toBe(false);
  runConfig({ set: ["codex.host", "true"] }, "darwin");
  expect(cfg.codexHostEnabled("linux")).toBe(true);
  // Windows has no farm: the stored true (e.g. from an imported bundle) reads as off there.
  expect(cfg.codexHostEnabled("win32")).toBe(false);
  // `--set` on Windows is refused with a platform message, and writes nothing.
  runConfig({ del: "codex.host" });
  expect(() => runConfig({ set: ["codex.host", "true"] }, "win32")).toThrow(
    "'codex.host' is only supported on Linux and macOS (this is win32); it cannot be set here.",
  );
  expect(cfg.read().global["codex.host"]).toBeUndefined();
  // A plain (not POSIX-only) key is unaffected by the platform.
  runConfig({ set: ["daemon.auto-start", "true"] }, "win32");
  expect(cfg.autoStartEnabled()).toBe(true);
  // A stored true (an imported bundle) is INERT on Windows: the keyed read answers with
  // the built-in default and the table names the inert value instead of hiding it.
  cfg.set({ "codex.host": true });
  expect(stdoutOf(() => runConfig({ get: "codex.host" }, "linux"))).toBe("true\n");
  expect(stdoutOf(() => runConfig({ get: "codex.host" }, "win32"))).toBe("false\n");
  // The table is stdout too, and the command hands the renderer the same platform.
  expect(stdoutOf(() => runConfig({ get: true }, "win32"))).toBe(
    `${configTableOutput("win32")}\n`,
  );
});

test("configTableOutput() takes the terminal's width from the one table seam: COLUMNS when set, unbounded off a TTY", () => {
  tmpHome();
  const tableAt = (width: number): string =>
    configTable(new CopilotEnvConfig().read(), {
      platform: "linux",
      width,
      profile: null,
      daemonUp: anyTrackedDaemonAlive(),
      profileDaemonUp: trackedDaemonAlive(null),
      proxyVersion: nextProxyVersion(),
      color: COLOR_ENABLED,
    });
  const stdout = process.stdout as unknown as Record<string, unknown>;
  const orig = {
    isTTY: Object.getOwnPropertyDescriptor(stdout, "isTTY"),
    env: process.env.COLUMNS,
  };
  Object.defineProperty(stdout, "isTTY", { value: false, configurable: true, writable: true });
  try {
    delete process.env.COLUMNS;
    expect(tableAt(Number.POSITIVE_INFINITY)).not.toBe(tableAt(80));
    expect(configTableOutput("linux")).toBe(tableAt(Number.POSITIVE_INFINITY));
    process.env.COLUMNS = "80";
    expect(configTableOutput("linux")).toBe(tableAt(80));
  } finally {
    if (orig.isTTY === undefined) Reflect.deleteProperty(stdout, "isTTY");
    else Object.defineProperty(stdout, "isTTY", orig.isTTY);
    if (orig.env === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = orig.env;
  }
});

test("the registry is alphabetical by key, with unique keys", () => {
  const keys = CONFIG_REGISTRY.map((d) => d.key);
  // The order within a group IS alphabetical -- a new key must be inserted in place.
  expect(keys).toEqual([...keys].sort());
  // Keys are unique: configKeyDef() is a find(), so a duplicate would silently resolve to the
  // first entry, and the schema fold is fromEntries, where a duplicate would overwrite.
  expect(new Set(keys).size).toBe(keys.length);
});

const PLAIN_TABLE = {
  platform: "linux",
  width: 80,
  profile: null,
  daemonUp: false,
  profileDaemonUp: false,
  proxyVersion: "1.16.3",
  color: false,
} as const;

test("configTable() renders the header, the groups, and key=value rows with type, default, and description in one 80-column layout", () => {
  // Stored: a plain flag, a key applied without the daemon, a POSIX-only key on Windows (inert
  // there), and the key whose default is a URL too long to share a line with its type.
  const global = {
    "daemon.strict-port": true,
    "shell.launchers": true,
    "codex.host": true,
    "cost.pricing-url": "https://prices.example/api/v1/models/latest",
  };
  const data = stored(global);
  const rendered = configTable(data, { ...PLAIN_TABLE, platform: "win32" });
  const lines = rendered.split("\n");
  // The header's halves pack to the width like words; at 80 the count and the set syntax share
  // the first line, the rest the second.
  expect(lines.slice(0, 4)).toEqual([
    `4 of ${CONFIG_REGISTRY.length} keys set (*).  |  agent config --set <key> <value>`,
    "--del <key> reverts  |  --profile <name> targets another profile",
    "proxy.* set without --profile is every profile's default",
    "",
  ]);
  // Under GLOBAL the group headings come in CONFIG_GROUPS order, each over its keys in registry
  // order; parsing the rows back pins the grouping, not just presence.
  const rowRe = /^ *([* ]) (\S+)=/;
  const globalAt = lines.findIndex((l) => l.startsWith("GLOBAL"));
  const groupRe = /^ {2}(\S+):/;
  const headings = lines.slice(globalAt).flatMap((l) => groupRe.exec(l)?.[1] ?? []);
  expect(headings).toEqual(
    CONFIG_GROUPS.filter((g) =>
      CONFIG_REGISTRY.some((d) => configGroup(d.key) === g && d.scope === "global")
    ),
  );
  const keysUnder = (group: string): string[] => {
    const from = lines.findIndex((l, i) => i >= globalAt && groupRe.exec(l)?.[1] === group) + 1;
    const to = lines.findIndex((l, i) => i >= from && groupRe.test(l));
    return lines.slice(from, to < 0 ? undefined : to).flatMap((l) => l.match(rowRe)?.[2] ?? []);
  };
  for (const group of headings) {
    expect(keysUnder(group)).toEqual(
      CONFIG_REGISTRY.filter((d) => configGroup(d.key) === group && d.scope === "global")
        .map((d) => d.key),
    );
  }
  const rowAt = (key: string): number => {
    const at = lines.findIndex((l) => rowRe.exec(l)?.[2] === key);
    if (at < 0) throw new Error(`no row for '${key}'`);
    return at;
  };
  const row = (key: string): string => lines[rowAt(key)] ?? "";
  // The right column starts where the stored row's `[type]` does, and every type cell in the
  // table shares that column; nothing runs past the width.
  const column = row("daemon.strict-port").indexOf("[");
  expect(column).toBeGreaterThan(2);
  for (const def of CONFIG_REGISTRY) {
    const typeLine = lines.slice(rowAt(def.key)).find((l) => l.includes(`[${def.type}]`)) ?? "";
    expect(typeLine.indexOf("[")).toBe(column);
  }
  // Right-column cells pack to the width like words; the one line past the cap is the URL
  // default, an unbreakable cell wider than the column.
  expect(lines.filter((l) => l.length > PLAIN_TABLE.width)).toEqual([
    " ".repeat(column) + `default ${OPENROUTER_MODELS_URL}`,
  ]);
  // A stored key: the star, the stored value, its type, and its bare default.
  expect(row("daemon.strict-port")).toBe(
    `  * daemon.strict-port=true`.padEnd(column) + "[bool] default false",
  );
  // An unset key shows its built-in default as the value, no star, no `default` cell.
  expect(row("daemon.port")).toBe(`    daemon.port=4141`.padEnd(column) + "[1-65535]");
  // No stored value and no built-in default: `<unset>`.
  expect(row("proxy.claude-auto-model")).toBe(
    `    proxy.claude-auto-model=<unset>`.padEnd(column) + "[model id]",
  );
  // A key=value too long for the column keeps its own line; its right column starts below,
  // and a cell that will not fit beside the type moves down again.
  const url = rowAt("cost.pricing-url");
  expect(lines[url]).toBe(`  * cost.pricing-url=${global["cost.pricing-url"]}`);
  expect(lines[url + 1]).toBe(" ".repeat(column) + "[url]");
  expect(lines[url + 2]).toBe(" ".repeat(column) + `default ${OPENROUTER_MODELS_URL}`);
  // A stored POSIX-only value on Windows is still starred (it IS stored) and named inert, the
  // note packed onto the next line where it does not fit beside the type and default.
  expect(row("codex.host")).toBe(
    `  * codex.host=true`.padEnd(column) + "[bool] default false",
  );
  expect(lines[rowAt("codex.host") + 1]).toBe(" ".repeat(column) + "(inert on this platform)");
  // The description follows the type line at the column, wrapped on spaces to the width and
  // re-joining to the registry text; a long one takes more than one line.
  const describeLines = (key: string): string[] => {
    const out: string[] = [];
    for (const l of lines.slice(rowAt(key) + 1)) {
      if (!l.startsWith(" ".repeat(column)) || l.startsWith(" ".repeat(column + 1))) break;
      out.push(l.slice(column));
    }
    // The right column's `[type]` line sits on the row line, or below it for an overflowing
    // key=value; either way the description is what remains.
    return out.filter((l) => !l.startsWith("["));
  };
  // Among the UNSTORED keys, whose right column is the type line and the description only.
  const longest = CONFIG_REGISTRY.filter((d) => !(d.key in global)).reduce((a, b) =>
    a.describe.length > b.describe.length ? a : b
  );
  expect(longest.describe.length).toBeGreaterThan(PLAIN_TABLE.width - column);
  expect(describeLines(longest.key).length).toBeGreaterThan(1);
  expect(describeLines(longest.key).join(" ")).toBe(longest.describe);
  // With no daemon the restart line never prints; with one, only a stored key the daemon read
  // at launch (projected or restartToApply) gets it -- not a stored key applied another way.
  expect(rendered).not.toContain("restart the proxy to apply");
  const live = configTable(data, { ...PLAIN_TABLE, platform: "win32", daemonUp: true }).split(
    "\n",
  );
  // The right column's cells may wrap before the restart line, so it is looked for anywhere
  // under the row.
  const restartUnder = (out: string[], key: string): boolean => {
    const at = out.findIndex((l) => rowRe.exec(l)?.[2] === key);
    const under = out.slice(at + 1).findIndex((l) => rowRe.test(l) || l === "");
    return out.slice(at + 1, at + 1 + under).includes(
      " ".repeat(column) + "restart the proxy to apply",
    );
  };
  expect(restartUnder(live, "daemon.strict-port")).toBe(true);
  expect(restartUnder(live, "shell.launchers")).toBe(false);
  // A restart line only when the proxy that runs next will read the key.
  //   proxy older than the key's gate  -> no line (`--set` suppresses its hint the same way)
  //   new enough                       -> line
  //   version unknown                  -> no line on any row
  const gated = stored({ ...global, "proxy.alpha-search.model": "gpt-5" });
  const restartLineFor = (proxyVersion: string | null, key: string): boolean =>
    restartUnder(
      configTable(gated, { ...PLAIN_TABLE, daemonUp: true, proxyVersion }).split("\n"),
      key,
    );
  expect(restartLineFor("1.14.21", "proxy.alpha-search.model")).toBe(false);
  expect(restartLineFor("1.16.3", "proxy.alpha-search.model")).toBe(true);
  expect(restartLineFor(null, "daemon.strict-port")).toBe(false);
  // A value from the selected profile's section is read by THAT daemon: another daemon being up
  // earns it no restart line, its own does; a global-map value still follows any daemon.
  const overridden = stored(global, { work: { "proxy.small-model": "gpt-5-codex" } });
  const lineFor = (profileDaemonUp: boolean, key: string): boolean => {
    const out = configTable(overridden, {
      ...PLAIN_TABLE,
      profile: WORK,
      daemonUp: true,
      profileDaemonUp,
    }).split("\n");
    return restartUnder(out, key);
  };
  expect(lineFor(false, "proxy.small-model")).toBe(false);
  expect(lineFor(true, "proxy.small-model")).toBe(true);
  expect(lineFor(false, "daemon.strict-port")).toBe(true);
});

test("configTable() seats each key by its registry scope: PROFILE holds the profile keys and the profile-default groups as this profile resolves them, GLOBAL the global keys", () => {
  tmpHome();
  createWorkProfile();
  const firstOf = (scope: ConfigScope): ConfigKeyDef => {
    const def = CONFIG_REGISTRY.find((d) =>
      d.scope === scope && (scope !== "profile-default" || configDefaultValue(d) !== undefined)
    );
    if (def === undefined) throw new Error(`no ${scope} key with a default in the registry`);
    return def;
  };
  const own = firstOf("profile");
  const machine = firstOf("global");
  const shared = firstOf("profile-default");
  const sharedDefault = formatConfigValue(configDefaultValue(shared) ?? "");
  // The command takes the terminal's width; a wide one keeps every heading on one line.
  process.env.COLUMNS = "200";

  const rowRe = /^ *[* ] (\S+)=/;
  const sections = (out: string): { profile: string[]; global: string[] } => {
    const lines = out.split("\n");
    const profileAt = lines.findIndex((l) => l.startsWith("PROFILE "));
    const globalAt = lines.findIndex((l) => l.startsWith("GLOBAL"));
    expect(profileAt).toBeGreaterThan(0);
    expect(globalAt).toBeGreaterThan(profileAt);
    return { profile: lines.slice(profileAt, globalAt), global: lines.slice(globalAt) };
  };
  const keysIn = (lines: string[]): string[] => lines.flatMap((l) => l.match(rowRe)?.[1] ?? []);
  const rowOf = (lines: string[], key: string): string =>
    lines.slice(lines.findIndex((l) => rowRe.exec(l)?.[1] === key)).slice(0, 3).join("\n");
  const view = (profile?: string) => sections(stdoutOf(() => runConfig({ get: true, profile })));
  // Every profile's PROFILE section lists its own keys, then each profile-default group under a
  // heading; GLOBAL lists the global keys group by group and nothing else.
  const profileKeys = [
    ...CONFIG_REGISTRY.filter((d) => d.scope === "profile").map((d) => d.key),
    ...CONFIG_GROUPS.flatMap((g) =>
      CONFIG_REGISTRY.filter((d) => configGroup(d.key) === g && d.scope === "profile-default")
        .map((d) => d.key)
    ),
  ];
  const globalKeys = CONFIG_GROUPS.flatMap((g) =>
    CONFIG_REGISTRY.filter((d) => configGroup(d.key) === g && d.scope === "global")
      .map((d) => d.key)
  );
  const headingRe = new RegExp(
    `^  ${
      configGroup(shared.key)
    }: +\\(this profile's daemon; \\(global\\) rows inherit the value set without --profile, unstarred rows the built-in default\\)$`,
    "m",
  );

  // Nothing stored: the shared key sits under PROFILE unstarred, with no source cell.
  const empty = view();
  expect(keysIn(empty.profile)).toEqual(profileKeys);
  expect(keysIn(empty.global)).toEqual(globalKeys);
  expect(empty.profile.join("\n")).toMatch(headingRe);
  expect(rowOf(empty.profile, shared.key).startsWith(`    ${shared.key}=`)).toBe(true);
  expect(rowOf(empty.profile, shared.key)).not.toContain("(global)");
  expect(keysIn(empty.profile)).toContain(own.key);
  expect(keysIn(empty.global)).toContain(machine.key);

  // Set globally (no --profile): every profile inherits it, starred and marked (global); the key
  // still has no row under GLOBAL.
  runConfig({ set: [shared.key, sharedDefault] });
  for (const profile of [undefined, "work"]) {
    const v = view(profile);
    expect(v.profile[0]?.startsWith(`PROFILE ${profile ?? "default"}`)).toBe(true);
    expect(rowOf(v.profile, shared.key)).toContain(`  * ${shared.key}=${sharedDefault}`);
    expect(rowOf(v.profile, shared.key)).toContain("(global)");
    expect(keysIn(v.global)).not.toContain(shared.key);
  }
  expect(stdoutOf(() => runConfig({ get: true }))).toMatch(
    new RegExp(`^1 of ${CONFIG_REGISTRY.length} keys set`),
  );

  // Set on work too: work's row is its own value and names the global value it hides; default's
  // row is unchanged. A key set at both levels is one row, so the count stays 1.
  runConfig({ set: [shared.key, sharedDefault], profile: "work" });
  const work = view("work");
  expect(rowOf(work.profile, shared.key)).toContain(`  * ${shared.key}=${sharedDefault}`);
  expect(rowOf(work.profile, shared.key)).toContain(`(overrides global ${sharedDefault})`);
  expect(rowOf(work.profile, shared.key)).not.toContain("(global)");
  expect(rowOf(view().profile, shared.key)).toContain("(global)");
  expect(stdoutOf(() => runConfig({ get: true, profile: "work" }))).toMatch(
    new RegExp(`^1 of ${CONFIG_REGISTRY.length} keys set`),
  );

  // With the global value gone the override hides the built-in default, named once: no
  // `default` cell beside it.
  runConfig({ del: shared.key });
  const overrideRow = rowOf(view("work").profile, shared.key);
  expect(overrideRow).toContain(`  * ${shared.key}=${sharedDefault}`);
  expect(overrideRow).toContain(`(overrides the default ${sharedDefault})`);
  expect(overrideRow).not.toContain(`default ${sharedDefault} `);
});

test("configTable() at width 60 packs the header's parts to the width and keeps every row within it", () => {
  const out = configTable(stored({ "daemon.strict-port": true }), { ...PLAIN_TABLE, width: 60 })
    .split("\n");
  expect(out.slice(0, 5)).toEqual([
    `1 of ${CONFIG_REGISTRY.length} keys set (*).  |  agent config --set <key> <value>`,
    "--del <key> reverts",
    "--profile <name> targets another profile",
    "proxy.* set without --profile is every profile's default",
    "",
  ]);
  expect(out.filter((l) => l.length > 60)).toEqual([]);
});

test("configTable() at width 40 stacks the right column under each key row at a six-space indent", () => {
  const out = configTable(stored({ "daemon.strict-port": true }), { ...PLAIN_TABLE, width: 40 })
    .split("\n");
  const at = out.indexOf("  * daemon.strict-port=true");
  expect(at).toBeGreaterThan(0);
  expect(out[at + 1]).toBe("      [bool] default false");
  expect(out[at + 2]?.startsWith("      Fail start on a busy port")).toBe(true);
  // A banner whose title leaves the note too little room stacks it under the title instead of
  // running past the width: the longest profile name fills the width on its own.
  const longName = parseProfileName("a".repeat(32));
  const long = configTable(stored({}, { [longName]: {} }), {
    ...PLAIN_TABLE,
    width: 40,
    profile: longName,
  }).split("\n");
  const bannerAt = long.findIndex((l) => l.startsWith("PROFILE "));
  expect(long[bannerAt]).toBe(`PROFILE ${longName}`);
  expect(long[bannerAt + 1]?.startsWith("      (per profile;")).toBe(true);
  expect(long.slice(bannerAt, bannerAt + 4).filter((l) => l.length > 40)).toEqual([]);
  // Only the unbreakable pieces run past the width: the key=value leads longer than the width
  // and the URL value.
  expect(out.slice(0, 6)).toEqual([
    `1 of ${CONFIG_REGISTRY.length} keys set (*).`,
    "agent config --set <key> <value>",
    "--del <key> reverts",
    "--profile <name> targets another profile",
    "proxy.* set without --profile is every",
    "profile's default",
  ]);
  expect(out.filter((l) => l.length > 40)).toEqual([
    "    proxy.alpha-search.codex-priority=true",
    "    proxy.message-websearch-model=gpt-5-mini",
    "    proxy.responses.context-management=false",
    `    cost.pricing-url=${OPENROUTER_MODELS_URL}`,
  ]);
});

test("projectedProxyConfig() force-projects the opinionated keys and opt-in keys only when set, per profile", () => {
  tmpHome();
  // Empty store: the force-projected keys resolve to their built-in defaults; the opt-in keys
  // are absent so the proxy's own defaults stand.
  const empty = projectedProxyConfig(null);
  expect(projectedValue(empty, ["smallModel"])).toBe("gpt-5-mini");
  expect(projectedValue(empty, ["useResponsesApiWebSocket"])).toBe(true);
  expect(projectedValue(empty, ["useResponsesApiWebSearch"])).toBe(true);
  expect(projectedValue(empty, ["useMessagesApi"])).toBe(true);
  expect(empty).toHaveLength(4);
  expect(empty.every((e) => !e.optIn)).toBe(true);
  // A stored override on a force key is honored; a stored opt-in key now appears too.
  const cfg = new CopilotEnvConfig();
  cfg.set({
    "daemon.auto-start": true,
    "proxy.responses.websocket": false,
    "proxy.message-websearch-model": "gpt-5",
  });
  const projected = projectedProxyConfig(null);
  expect(projectedValue(projected, ["useResponsesApiWebSocket"])).toBe(false);
  expect(projectedValue(projected, ["messageApiWebSearchModel"])).toBe("gpt-5");
  expect(projected.find((e) => e.path[0] === "messageApiWebSearchModel")?.optIn).toBe(true);
  // Copilot-env-internal keys (daemon.auto-start) never leak into the proxy projection.
  expect(projectedValue(projected, ["autoStart"])).toBeUndefined();
  // A profile's daemon projects the profile's own override over the global value, and a knob set
  // for that profile alone; the default profile's projection is unchanged by either.
  cfg.setProfile(WORK, { "proxy.small-model": "gpt-5-codex", "proxy.claude-token-multiplier": 2 });
  const work = projectedProxyConfig(WORK);
  expect(projectedValue(work, ["smallModel"])).toBe("gpt-5-codex");
  expect(projectedValue(work, ["claudeTokenMultiplier"])).toBe(2);
  expect(projectedValue(work, ["messageApiWebSearchModel"])).toBe("gpt-5");
  expect(projectedProxyConfig(null)).toEqual(projected);
});

test("proxy.responses.context-management projects to the proxy's NESTED contextManagement.responses", () => {
  tmpHome();
  new CopilotEnvConfig().set({ "proxy.responses.context-management": true });
  const projected = projectedProxyConfig(null);
  expect(projectedValue(projected, ["contextManagement", "responses"])).toBe(true);
  expect(projected.find((e) => e.path[0] === "contextManagement")?.optIn).toBe(true);
  // The pre-1.14 flat proxy key is never projected.
  expect(projectedValue(projected, ["useResponsesApiContextManagement"])).toBeUndefined();
  expect(configDefaultValue(configKeyDef("proxy.responses.context-management")!)).toBe(false);
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
    JSON.stringify(d.proxyPath)
  );
  expect(new Set(allProjectedPaths).size).toBe(allProjectedPaths.length);
});

test("the alpha-search and claude proxy keys are opt-in projections at the top level", () => {
  tmpHome();
  // Unset -> absent from the projection, so the proxy's own defaults stand.
  const empty = projectedProxyConfig(null);
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
  runConfig({ set: ["proxy.alpha-search.codex-priority", "false"] });
  runConfig({ set: ["proxy.alpha-search.model", "gpt-5"] });
  runConfig({ set: ["proxy.claude-auto-model", "claude-haiku-4.5"] });
  runConfig({ set: ["proxy.claude-token-multiplier", "1.3"] });
  const projected = projectedProxyConfig(null);
  expect(projectedValue(projected, ["alphaSearchCodexPriority"])).toBe(false);
  expect(projectedValue(projected, ["alphaSearchModel"])).toBe("gpt-5");
  expect(projectedValue(projected, ["claudeAutoModel"])).toBe("claude-haiku-4.5");
  expect(projectedValue(projected, ["claudeTokenMultiplier"])).toBe(1.3);
  for (
    const key of [
      "proxy.alpha-search.codex-priority",
      "proxy.alpha-search.model",
      "proxy.claude-auto-model",
      "proxy.claude-token-multiplier",
    ]
  ) {
    expect(isProxyProjected(configKeyDef(key)!)).toBe(true);
    expect(configKeyDef(key)?.proxyDefault).toBeUndefined();
  }
});

test("sinceProxyVersionWarning fires only when the installed proxy predates the key", () => {
  const def = configKeyDef("proxy.alpha-search.model")!;
  const warning = sinceProxyVersionWarning(def, "1.14.21");
  expect(warning).toBe(
    "The installed proxy 1.14.21 does not read 'proxy.alpha-search.model' (added in copilot-api " +
      "1.16.3); it applies once the proxy is >= 1.16.3.",
  );
  expect(sinceProxyVersionWarning(def, "1.16.3")).toBeNull(); // equal: reads it
  expect(sinceProxyVersionWarning(def, "1.17.0")).toBeNull(); // newer: reads it
  // No proxy installed (a Direct-only setup may set keys for later): no warning.
  expect(sinceProxyVersionWarning(def, null)).toBeNull();
  // An ungated key never warns, however old the proxy.
  expect(sinceProxyVersionWarning(configKeyDef("proxy.claude-token-multiplier")!, "1.11.0"))
    .toBeNull();
  // The gates pin the proxy versions that introduced each key (verified upstream): the aged float
  // target can legitimately install an older proxy, which would silently ignore the projection.
  expect(configKeyDef("proxy.claude-auto-model")?.sinceProxyVersion).toBe("1.14.22");
  expect(configKeyDef("proxy.alpha-search.codex-priority")?.sinceProxyVersion).toBe("1.15.0");
  expect(configKeyDef("proxy.alpha-search.model")?.sinceProxyVersion).toBe("1.16.3");
  // Every pin must be strict x.y.z: versionLessThan fails OPEN on a malformed operand,
  // so a typo'd pin would silently disable its warning.
  for (const d of CONFIG_REGISTRY) {
    if (d.sinceProxyVersion !== undefined) {
      expect(d.sinceProxyVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  }
});

test("unreadProjectedKeyWarnings covers stored gated keys at start time, for the daemon's profile", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  // Nothing stored: nothing to warn about, however old the proxy.
  expect(unreadProjectedKeyWarnings(cfg, "1.11.0")).toEqual([]);

  cfg.set({
    "proxy.alpha-search.model": "gpt-5",
    "proxy.claude-token-multiplier": 1.5,
    "daemon.auto-start": true,
  });
  // The stored gated key warns on an older proxy; the ungated and internal keys never do.
  const warnings = unreadProjectedKeyWarnings(cfg, "1.14.21");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("proxy.alpha-search.model");
  // New-enough or missing proxy: silent.
  expect(unreadProjectedKeyWarnings(cfg, "1.16.3")).toEqual([]);
  expect(unreadProjectedKeyWarnings(cfg, null)).toEqual([]);
  // A gated key set for one profile alone warns for THAT profile's start, not the default's.
  cfg.del("proxy.alpha-search.model");
  cfg.setProfile(WORK, { "proxy.alpha-search.codex-priority": false });
  expect(unreadProjectedKeyWarnings(cfg, "1.14.21", null)).toEqual([]);
  const forWork = unreadProjectedKeyWarnings(cfg, "1.14.21", WORK);
  expect(forWork).toHaveLength(1);
  expect(forWork[0]).toContain("'proxy.alpha-search.codex-priority'");
});

test("the entry type refuses a key without a scope, a flat key that is not a profile key, and a projection outside the proxy group", () => {
  // @ts-expect-error - scope is required on every entry
  const _unscoped: ConfigKeyDef = {
    key: "daemon.auto-start",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
  };
  // A flat name IS a profile key: it cannot land as global.
  // @ts-expect-error - a flat key's scope is `profile`
  const _flatGlobal: ConfigKeyDef = {
    key: "identity",
    scope: "global",
    describe: "bogus",
    type: "id|auto",
    schema: v.string(),
    parse: (raw) => raw,
    defaultValue: "auto",
  };
  // ... and a grouped name cannot be profile-only.
  // @ts-expect-error - a grouped key's scope is `profile-default` or `global`
  const _groupedProfile: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "profile",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
  };
  // Only the proxy group's keys land in config.json.
  const _projectedElsewhere: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "global",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
    // @ts-expect-error - proxyProjected exists only on `proxy.*` keys
    proxyProjected: true,
  };
  // @ts-expect-error - sinceProxyVersion exists only on the projected shapes
  const _gatedInternal: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "global",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
    sinceProxyVersion: "1.0.0",
  };
});

test("the entry type forces a schema matching the key's own value type", () => {
  // The read schemas are folded from these entries, so one without a schema would be write-only:
  // accepted by --set, stripped by the read schema.
  // @ts-expect-error - schema is required on every entry
  const _missing: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "global",
    describe: "bogus",
    type: "bool",
    parse: () => true,
    defaultValue: false,
  };
  // ... and the schema's output must be the key's declared value type, so one key's entry
  // cannot smuggle in another key's domain.
  // @ts-expect-error - the schema must validate the key's own value type
  const _mismatched: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "global",
    describe: "bogus",
    type: "bool",
    schema: v.number(),
    parse: () => true,
    defaultValue: false,
  };
  // The default is typed by the key too: the table shows it as the value when unset, so a
  // default outside the key's domain would print something `--set` could never store.
  // @ts-expect-error - the default must be the key's own value type
  const _wrongDefault: ConfigKeyDef = {
    key: "daemon.auto-start",
    scope: "global",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: "yes",
  };
});

test("the registry's keys are pinned total over ConfigValueTypes, and a profile key cannot enter the global map", () => {
  // Every stored field is optional, so a registry missing one would compile and the key would be
  // written by set() yet stripped by the read schema; the totality pin makes the omission a
  // compile error.
  // @ts-expect-error - a mapped record missing a key (daemon.auto-start) fails the pin
  type _Missing = TotalOverConfigKeys<{ [K in Exclude<ConfigKey, "daemon.auto-start">]: K }>;
  // ... and the other direction: a key OUTSIDE ConfigValueTypes is rejected per entry by
  // ConfigKeyDefCore's `key`, so the pinned union can never grow an extra key.
  const _extra: ConfigKeyDef = {
    // @ts-expect-error - 'bogus' is not a key of ConfigValueTypes
    key: "bogus",
    scope: "global",
    describe: "bogus",
    type: "bool",
    schema: v.boolean(),
    parse: () => true,
    defaultValue: false,
  };
  // The store's types keep the four profile keys out of the global map and the global keys out
  // of a profile's section.
  const cfg = new CopilotEnvConfig();
  // @ts-expect-error - identity is a profile key
  const _globalIdentity = () => cfg.set({ identity: "auto" });
  // @ts-expect-error - daemon.port is a global key
  const _profilePort = () => cfg.setProfile(null, { "daemon.port": 4242 });
});

test("isProxyProjected marks force + opt-in keys, not copilot-env-internal ones", () => {
  expect(isProxyProjected(configKeyDef("proxy.responses.websocket")!)).toBe(true); // force
  expect(isProxyProjected(configKeyDef("proxy.message-websearch-model")!)).toBe(true); // opt-in
  expect(isProxyProjected(configKeyDef("daemon.auto-start")!)).toBe(false);
  // daemon.logs is launch wiring, not a projection -- but it still needs a daemon restart,
  // like the other keys `agent start` reads when launching (passthrough, idle-timeout, port).
  expect(isProxyProjected(configKeyDef("daemon.logs")!)).toBe(false);
  for (const key of ["daemon.logs", "passthrough", "daemon.idle-timeout", "daemon.port"]) {
    expect(configKeyDef(key)?.restartToApply, key).toBe(true);
  }
  // daemon.auto-start stays unmarked: the resolver and the in-daemon watchdog read it live (though
  // ATTACHING a watchdog to an already-running unmanaged daemon still takes a relaunch).
  expect(configKeyDef("daemon.auto-start")?.restartToApply).toBeUndefined();
  // codex.model-catalog is copilot-env-internal (read at auth/wiring time, never
  // projected into the proxy) and needs no daemon restart.
  expect(isProxyProjected(configKeyDef("codex.model-catalog")!)).toBe(false);
  expect(configKeyDef("codex.model-catalog")?.restartToApply).toBeUndefined();
});

test("claude.desktop is opt-OUT: unset and deleted read enabled, stored false disables", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.claudeDesktopEnabled()).toBe(true);
  // Internal to copilot-env: setting it projects nothing new into the proxy's config.json.
  const before = projectedProxyConfig(null);
  cfg.set({ "claude.desktop": false });
  expect(cfg.claudeDesktopEnabled()).toBe(false);
  expect(projectedProxyConfig(null)).toEqual(before);
  cfg.del("claude.desktop");
  expect(cfg.claudeDesktopEnabled()).toBe(true);
});

test("one web-search default for both surfaces, and unset IS the default where the read sites layer their own", () => {
  // The proxy's own default must match the MCP tool's DEFAULT_WEB_SEARCH_MODEL, owned by
  // web_search.ts (which imports env_config, so the registry cannot reference it).
  expect(configDefaultValue(configKeyDef("proxy.message-websearch-model")!)).toBe(
    DEFAULT_WEB_SEARCH_MODEL,
  );
  expect(DEFAULT_WEB_SEARCH_MODEL).toBe("gpt-5-mini");
  // Unset IS the default: a disabled override, a floating pin, and the update cooldown (whose
  // two read sites apply different defaults: none for `agent update`, 7 days for autoupdate).
  for (const key of ["proxy.claude-auto-model", "daemon.version", "update.cooldown"] as const) {
    expect(configDefaultValue(configKeyDef(key)!)).toBeUndefined();
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
    cfg.set({ "daemon.auto-start": true, "daemon.idle-timeout": 30, "daemon.port": 5555 });
    const file = new CopilotApiPaths().envConfigFile;
    chmodSync(file, 0o000);
    try {
      expect(() => cfg.read()).toThrow("refusing to treat an unreadable store as empty");
      expect(() => cfg.defaultPort()).toThrow(file);
      expect(() => cfg.wireMcpEnabled()).toThrow(file);
      // The watchdog-reachable gates must NOT throw; they answer the defaults.
      expect(cfg.autoStartEnabled()).toBe(false);
      expect(cfg.idleTimeoutSeconds()).toBe(configDefaultNumber("daemon.idle-timeout"));
    } finally {
      chmodSync(file, 0o600);
    }
    // Control: readable again, every reader answers the stored values.
    expect(cfg.autoStartEnabled()).toBe(true);
    expect(cfg.idleTimeoutSeconds()).toBe(30);
    expect(cfg.defaultPort()).toBe(5555);
  },
);
