import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import {
  configTable,
  configTableOutput,
  type ConfigView,
  runConfig,
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
  projectedProxyConfig,
  type ProjectedProxyEntry,
} from "../src/copilot_api/env_config.ts";
import { anyTrackedDaemonAlive, trackedDaemonAlive } from "../src/copilot_api/daemon.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "../src/copilot_api/web_search.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { colorEnabled } from "../src/utils/ansi.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";
import { captureChannelsSync } from "./helpers/output.ts";

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

/** A named profile's verbs refuse a profile the credential store does not know, so tests that
 *  address one commit it first. */
function createWorkProfile(): void {
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
}

const CONFIG: ConfigView = { kind: "config" };

/** The face the CLI routes a key to: a named profile, or a profile key, is `agent profile`'s;
 *  a machine key or a shared default with no name is `agent config`'s. */
function face(key: string | undefined, profile: Profile = null): ConfigView {
  if (profile === null && (key === undefined || configKeyDef(key)?.scope !== "profile")) {
    return CONFIG;
  }
  return { kind: "profile", profile };
}

/** Every key a view lists: the config view drops the profile keys, a profile's view the machine's. */
const MACHINE_AND_SHARED_KEYS = CONFIG_REGISTRY.filter((d) => d.scope !== "profile").length;

/** Both maps, as read() returns them. */
function stored(
  global: CopilotEnvConfigData["global"],
  profiles: CopilotEnvConfigData["profiles"] = {},
): CopilotEnvConfigData {
  return { global, profiles };
}

function projectedEntry(
  entries: readonly ProjectedProxyEntry[],
  path: readonly string[],
): ProjectedProxyEntry | undefined {
  return entries.find((e) =>
    e.path.length === path.length && e.path.every((k, i) => k === path[i])
  );
}

function projectedValue(
  entries: readonly ProjectedProxyEntry[],
  path: readonly string[],
): boolean | number | string | undefined {
  return projectedEntry(entries, path)?.value;
}

function stdoutOf(run: () => void): string {
  return captureChannelsSync(run).stdout;
}

test("the typed store: read() starts empty, each accessor answers stored else built-in default and del() reverts it, a whole patch lands beside a profile section", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.read()).toEqual(stored({}));
  const global = (): Record<string, unknown> => cfg.read().global;

  // One accessor per opinionated key: the built-in default when unset, the stored value once
  // `set` lands it (wire-mcp and claude.desktop are opt-OUT: unset reads enabled), the default
  // again after `unset`, which leaves the key absent.
  const accessors: {
    key: ConfigKey;
    raw: string;
    stored: unknown;
    unset: unknown;
    read: (c: CopilotEnvConfig) => unknown;
  }[] = [
    {
      key: "daemon.auto-start",
      raw: "true",
      stored: true,
      unset: false,
      read: (c) => c.autoStartEnabled(),
    },
    {
      key: "codex.model-catalog",
      raw: "true",
      stored: true,
      unset: false,
      read: (c) => c.codexModelCatalogEnabled(),
    },
    {
      key: "claude.wire-mcp",
      raw: "false",
      stored: false,
      unset: true,
      read: (c) => c.wireMcpEnabled(),
    },
    {
      key: "claude.desktop",
      raw: "false",
      stored: false,
      unset: true,
      read: (c) => c.claudeDesktopEnabled(),
    },
    {
      key: "daemon.logs",
      raw: "true",
      stored: true,
      unset: false,
      read: (c) => c.proxyLogsEnabled(),
    },
    {
      key: "update.auto",
      raw: "on", // the boolean alias spelling
      stored: true,
      unset: false,
      read: (c) => c.autoUpdateEnabled(),
    },
    {
      key: "cost.pricing-url",
      raw: "https://pricing.example/models",
      stored: "https://pricing.example/models",
      unset: OPENROUTER_MODELS_URL,
      read: (c) => c.pricingUrl(),
    },
  ];
  for (const a of accessors) {
    expect(a.read(cfg), a.key).toBe(a.unset);
    runConfig({ kind: "set", key: a.key, value: a.raw, view: face(a.key), dryRun: false });
    expect(global()[a.key], a.key).toBe(a.stored);
    expect(a.read(cfg), a.key).toBe(a.stored);
    runConfig({ kind: "unset", key: a.key, view: face(a.key), dryRun: false });
    expect(global()[a.key], a.key).toBeUndefined();
    expect(a.read(cfg), a.key).toBe(a.unset);
  }

  // A whole patch lands as given beside a profile section; deleting one key leaves the others
  // intact, and a section emptied by its last delete is removed, not left as `{}`.
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
  expect(cfg.passthroughOverride(null)).toBe(true);
  cfg.del("daemon.auto-start");
  expect(global()["daemon.auto-start"]).toBeUndefined();
  expect(global()["daemon.port"]).toBe(4242);
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

test("set validates + persists; unset reverts; unknown key / bad value error", () => {
  tmpHome();
  runConfig({
    kind: "set",
    key: "daemon.idle-timeout",
    value: "45",
    view: face("daemon.idle-timeout"),
    dryRun: false,
  });
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(45);

  runConfig({
    kind: "unset",
    key: "daemon.idle-timeout",
    view: face("daemon.idle-timeout"),
    dryRun: false,
  });
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBeUndefined();

  expect(() =>
    runConfig({ kind: "set", key: "bogus-key", value: "1", view: face("bogus-key"), dryRun: false })
  ).toThrow(/unknown config key/);
  expect(() =>
    runConfig({
      kind: "set",
      key: "daemon.port",
      value: "notanumber",
      view: face("daemon.port"),
      dryRun: false,
    })
  ).toThrow(
    /invalid value for 'daemon.port'/,
  );
  expect(() =>
    runConfig({ kind: "unset", key: "bogus-key", view: face("bogus-key"), dryRun: false })
  ).toThrow(/unknown config key/);
});

test("resolve: flag > profile > global > default, each layer only where the key's scope admits it", () => {
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
    new CopilotApiPaths().stateStoreFile,
    JSON.stringify({ global: {}, profiles: { work: { "daemon.port": 9999 } } }),
  );
  expect(at("daemon.port", WORK)).toEqual({ value: 4141, source: "default" });
  expect(cfg.read().profiles).not.toHaveProperty("work"); // stripped of every setting: no section
});

test("a named profile's set: a profile key lands in that profile's section, never the global map; a global key refuses a named profile by scope", () => {
  tmpHome();
  createWorkProfile();
  runConfig({
    kind: "set",
    key: "identity",
    value: "copilot-developer-cli",
    view: face("identity", WORK),
    dryRun: false,
  });
  const data = new CopilotEnvConfig().read();
  expect(data.profiles).toEqual({ work: { identity: "copilot-developer-cli" } });
  expect(data.global).not.toHaveProperty("identity");
  expect(new CopilotEnvConfig().pinnedIntegrationId(WORK)).toBe("copilot-developer-cli");
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();
  expect(stdoutOf(() => runConfig({ kind: "get", key: "identity", view: face("identity", WORK) })))
    .toBe(
      "copilot-developer-cli\n",
    );
  expect(stdoutOf(() => runConfig({ kind: "get", key: "identity", view: face("identity") }))).toBe(
    "auto\n",
  );

  // With no name a profile key targets the default profile's section.
  runConfig({
    kind: "set",
    key: "identity",
    value: "copilot-developer-sandbox",
    view: face("identity"),
    dryRun: false,
  });
  expect(new CopilotEnvConfig().read().profiles.default).toEqual({
    identity: "copilot-developer-sandbox",
  });

  // A global key has no per-profile value: refused naming the scope, and nothing is written.
  expect(() =>
    runConfig({
      kind: "set",
      key: "daemon.port",
      value: "4242",
      view: face("daemon.port", WORK),
      dryRun: false,
    })
  ).toThrow(
    "'daemon.port' is a global setting (scope global)",
  );
  expect(() =>
    runConfig({ kind: "unset", key: "daemon.port", view: face("daemon.port", WORK), dryRun: false })
  ).toThrow(/scope global/);
  expect(new CopilotEnvConfig().read().global).not.toHaveProperty("daemon.port");

  // A profile-default key: the global map with no name, the profile's own section with one, and
  // unset reverts the same way.
  runConfig({
    kind: "set",
    key: "proxy.small-model",
    value: "gpt-5",
    view: face("proxy.small-model"),
    dryRun: false,
  });
  runConfig({
    kind: "set",
    key: "proxy.small-model",
    value: "gpt-5-codex",
    view: face("proxy.small-model", WORK),
    dryRun: false,
  });
  expect(new CopilotEnvConfig().read().global["proxy.small-model"]).toBe("gpt-5");
  expect(new CopilotEnvConfig().read().profiles.work?.["proxy.small-model"]).toBe("gpt-5-codex");
  runConfig({
    kind: "unset",
    key: "proxy.small-model",
    view: face("proxy.small-model", WORK),
    dryRun: false,
  });
  expect(new CopilotEnvConfig().read().profiles.work).toEqual({
    identity: "copilot-developer-cli",
  });
  expect(new CopilotEnvConfig().read().global["proxy.small-model"]).toBe("gpt-5");

  // A profile the credential store does not know is refused before anything is written.
  expect(() =>
    runConfig({
      kind: "set",
      key: "identity",
      value: "auto",
      view: face("identity", parseProfileName("other")),
      dryRun: false,
    })
  ).toThrow();
  expect(new CopilotEnvConfig().read().profiles).not.toHaveProperty("other");
});

test("a credential-shaped key is rejected without echoing the value, and stored junk reads as unset", () => {
  // identity lands in HTTP headers (a header-splitting value is refused); cost.pricing-url may
  // carry a token in its query (https only, no userinfo). Junk pasted at either may be a token,
  // so the rejection never echoes it, and a hand-mangled STORED value degrades to unset (probe
  // per credential / the built-in URL), never a baked header or a bad fetch.
  const cases: {
    key: "identity" | "cost.pricing-url";
    bad: string;
    leak: string;
    reason: string;
    valid: string;
    junk: (c: CopilotEnvConfig) => void;
    stored: (c: CopilotEnvConfig) => unknown;
    reads: (c: CopilotEnvConfig) => unknown;
    defaultReads: unknown;
  }[] = [
    {
      key: "identity",
      bad: "evil\nX-Injected: 1",
      leak: "evil",
      reason: "header-safe",
      valid: "copilot-developer-cli",
      junk: (c) => c.setProfile(null, { identity: "evil\nX-Injected: 1" }),
      stored: (c) => c.read().profiles.default?.identity,
      reads: (c) => c.pinnedIntegrationId(null),
      defaultReads: null,
    },
    {
      key: "cost.pricing-url",
      bad: "http://user:secret@pricing.example/models",
      leak: "secret",
      reason: "https://",
      valid: "https://pricing.example/models",
      junk: (c) => c.set({ "cost.pricing-url": "not a url" }),
      stored: (c) => c.read().global["cost.pricing-url"],
      reads: (c) => c.pricingUrl(),
      defaultReads: OPENROUTER_MODELS_URL,
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    let message = "";
    try {
      runConfig({ kind: "set", key: c.key, value: c.bad, view: face(c.key), dryRun: false });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, c.key).toContain(`invalid value for '${c.key}'`);
    expect(message, c.key).toContain(c.reason);
    expect(message, c.key).not.toContain(c.leak);
    expect(new CopilotEnvConfig().read(), c.key).toEqual(stored({})); // nothing written
    runConfig({ kind: "set", key: c.key, value: c.valid, view: face(c.key), dryRun: false });
    expect(c.stored(new CopilotEnvConfig()), c.key).toBe(c.valid);
    expect(c.reads(new CopilotEnvConfig()), c.key).toBe(c.valid);
    c.junk(new CopilotEnvConfig());
    expect(c.stored(new CopilotEnvConfig()), c.key).toBeUndefined();
    expect(c.reads(new CopilotEnvConfig()), c.key).toBe(c.defaultReads);
  }
  // identity alone: the probe sentinel parses, and `codex` is refused keeping the previous pin
  // (it is the ABSENCE of the header, so a pin, always sent as the header's value, cannot mean it).
  runConfig({ kind: "set", key: "identity", value: "auto", view: face("identity"), dryRun: false });
  expect(new CopilotEnvConfig().read().profiles.default?.identity).toBe("auto");
  runConfig({
    kind: "set",
    key: "identity",
    value: "copilot-developer-cli",
    view: face("identity"),
    dryRun: false,
  });
  expect(() =>
    runConfig({
      kind: "set",
      key: "identity",
      value: "codex",
      view: face("identity"),
      dryRun: false,
    })
  ).toThrow(
    /cannot be pinned/,
  );
  expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe("copilot-developer-cli");
});

test("get <key> prints the value alone on stdout (script-friendly) and where it came from on stderr", () => {
  tmpHome();
  createWorkProfile();
  const get = (key: string, view: ConfigView): { stdout: string; stderr: string } => {
    const { stdout, stderr } = captureChannelsSync(() => runConfig({ kind: "get", key, view }));
    return { stdout, stderr };
  };
  // The built-in default, then the shared default once `agent config set` lands it (the default
  // profile's own get reads the same), then work's own value once it overrides.
  expect(get("proxy.small-model", CONFIG)).toEqual({
    stdout: "gpt-5-mini\n",
    stderr: "proxy.small-model: built-in default\n",
  });
  new CopilotEnvConfig().set({ "proxy.small-model": "gpt-5" });
  const shared = { stdout: "gpt-5\n", stderr: "proxy.small-model: the shared default\n" };
  expect(get("proxy.small-model", CONFIG)).toEqual(shared);
  expect(get("proxy.small-model", { kind: "profile", profile: null })).toEqual(shared);
  expect(get("proxy.small-model", { kind: "profile", profile: WORK })).toEqual(shared);
  new CopilotEnvConfig().setProfile(WORK, { "proxy.small-model": "gpt-5-codex" });
  expect(get("proxy.small-model", { kind: "profile", profile: WORK })).toEqual({
    stdout: "gpt-5-codex\n",
    stderr: "proxy.small-model: stored for profile 'work'\n",
  });
  // A machine key is `stored`, never `shared`; a profile key of the default is stored for it.
  new CopilotEnvConfig().set({ "daemon.port": 4242 });
  expect(get("daemon.port", CONFIG).stderr).toBe("daemon.port: stored\n");
  new CopilotEnvConfig().setProfile(null, { identity: "copilot-developer-cli" });
  expect(get("identity", { kind: "profile", profile: null }).stderr).toBe(
    "identity: stored for default\n",
  );
  // Unset with no built-in default: a blank line.
  expect(get("proxy.claude-auto-model", CONFIG).stdout).toBe("\n");
});

// One valid `set` string per registry key, typed over ConfigKey: a new registry key without
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
  "probe.claude-model": "claude-sonnet-5",
  "probe.codex-model": "gpt-6",
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
  // The registry is total over ConfigKey and holds each key once: configKeyDef() is a find(), so
  // a duplicate would silently resolve to the first entry, and the schema fold is fromEntries.
  expect(CONFIG_REGISTRY.map((d) => d.key).sort()).toEqual(Object.keys(ROUND_TRIP_RAW).sort());
  for (const def of CONFIG_REGISTRY) {
    // Set as on Linux: the POSIX-only keys refuse `set` on Windows (own test below).
    runConfig(
      {
        kind: "set",
        key: def.key,
        value: ROUND_TRIP_RAW[def.key],
        view: face(def.key),
        dryRun: false,
      },
      "linux",
    );
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
  expect(() =>
    runConfig({
      kind: "set",
      key: "codex.home",
      value: "~/.codex",
      view: face("codex.home"),
      dryRun: false,
    })
  ).toThrow(
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
  runConfig({
    kind: "set",
    key: "codex.home",
    value: ABS_CODEX_HOME,
    view: face("codex.home"),
    dryRun: false,
  }, "win32");
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
  runConfig({
    kind: "set",
    key: "codex.host",
    value: "true",
    view: face("codex.host"),
    dryRun: false,
  }, "darwin");
  expect(cfg.codexHostEnabled("linux")).toBe(true);
  // Windows has no farm: the stored true (e.g. from an imported bundle) reads as off there.
  expect(cfg.codexHostEnabled("win32")).toBe(false);
  // `set` on Windows is refused with a platform message, and writes nothing.
  runConfig({ kind: "unset", key: "codex.host", view: face("codex.host"), dryRun: false });
  expect(() =>
    runConfig({
      kind: "set",
      key: "codex.host",
      value: "true",
      view: face("codex.host"),
      dryRun: false,
    }, "win32")
  ).toThrow(
    "'codex.host' is only supported on Linux and macOS (this is win32); it cannot be set here.",
  );
  expect(cfg.read().global["codex.host"]).toBeUndefined();
  // A plain (not POSIX-only) key is unaffected by the platform.
  runConfig({
    kind: "set",
    key: "daemon.auto-start",
    value: "true",
    view: face("daemon.auto-start"),
    dryRun: false,
  }, "win32");
  expect(cfg.autoStartEnabled()).toBe(true);
  // A stored true (an imported bundle) is INERT on Windows: the keyed read answers with
  // the built-in default and the table names the inert value instead of hiding it.
  cfg.set({ "codex.host": true });
  expect(
    stdoutOf(() =>
      runConfig({ kind: "get", key: "codex.host", view: face("codex.host") }, "linux")
    ),
  ).toBe("true\n");
  expect(
    stdoutOf(() =>
      runConfig({ kind: "get", key: "codex.host", view: face("codex.host") }, "win32")
    ),
  ).toBe("false\n");
  // The table is stdout too, and the command hands the renderer the same platform.
  expect(stdoutOf(() => runConfig({ kind: "get", view: face(undefined) }, "win32"))).toBe(
    `${configTableOutput("win32")}\n`,
  );
});

test("configTableOutput() takes the terminal's width from the one table seam: COLUMNS when set, unbounded off a TTY", () => {
  tmpHome();
  const tableAt = (width: number): string =>
    configTable(new CopilotEnvConfig().read(), {
      platform: "linux",
      width,
      view: CONFIG,
      daemonUp: anyTrackedDaemonAlive(),
      profileDaemonUp: trackedDaemonAlive(null),
      color: colorEnabled(),
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

const PLAIN_TABLE = {
  platform: "linux",
  width: 80,
  view: CONFIG,
  daemonUp: false,
  profileDaemonUp: false,
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
    `4 of ${MACHINE_AND_SHARED_KEYS} keys set (*).  |  agent config set <key> <value>`,
    "agent config unset <key> reverts",
    "a profile's own keys: agent profile [<name>] set|unset|get",
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
  for (const def of CONFIG_REGISTRY.filter((d) => d.scope !== "profile")) {
    const typeLine = lines.slice(rowAt(def.key)).find((l) => l.includes(`[${def.type}]`)) ?? "";
    expect(typeLine.indexOf("[")).toBe(column);
  }
  // Right-column cells pack to the width like words; nothing runs past the cap.
  expect(lines.filter((l) => l.length > PLAIN_TABLE.width)).toEqual([]);
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
  // and a cell that will not fit beside the type moves down again, the URL split at the edge
  // under its `default` label.
  const url = rowAt("cost.pricing-url");
  expect(lines[url]).toBe(`  * cost.pricing-url=${global["cost.pricing-url"]}`);
  expect(lines[url + 1]).toBe(" ".repeat(column) + "[url]");
  expect(lines[url + 2]).toBe(" ".repeat(column) + "default");
  const urlLines = lines.slice(url + 3, url + 5);
  expect(urlLines.every((l) => l.startsWith(" ".repeat(column + 2)))).toBe(true);
  expect(urlLines.map((l) => l.trim()).join("")).toBe(OPENROUTER_MODELS_URL);
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
  const longest = CONFIG_REGISTRY.filter((d) => d.scope !== "profile" && !(d.key in global)).reduce(
    (a, b) => a.describe.length > b.describe.length ? a : b,
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
  // A value from the selected profile's section is read by THAT daemon: another daemon being up
  // earns it no restart line, its own does; a global-map value still follows any daemon.
  const overridden = stored(
    { ...global, "proxy.alpha-search.model": "gpt-5" },
    { work: { "proxy.small-model": "gpt-5-codex" } },
  );
  const lineFor = (profileDaemonUp: boolean, key: string): boolean => {
    const out = configTable(overridden, {
      ...PLAIN_TABLE,
      view: { kind: "profile", profile: WORK },
      daemonUp: true,
      profileDaemonUp,
    }).split("\n");
    return restartUnder(out, key);
  };
  expect(lineFor(false, "proxy.small-model")).toBe(false);
  expect(lineFor(true, "proxy.small-model")).toBe(true);
  expect(lineFor(false, "proxy.alpha-search.model")).toBe(true);
});

test("the keyless get lists one view: PROFILE holds the profile keys and the profile-default groups as this profile resolves them; the config view holds SHARED DEFAULTS and GLOBAL", () => {
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
  const keysIn = (lines: string[]): string[] => lines.flatMap((l) => l.match(rowRe)?.[1] ?? []);
  const rowOf = (lines: string[], key: string): string =>
    lines.slice(lines.findIndex((l) => rowRe.exec(l)?.[1] === key)).slice(0, 3).join("\n");
  const listing = (view: ConfigView): string[] =>
    stdoutOf(() => runConfig({ kind: "get", view })).split("\n");
  /** One profile's view: the PROFILE banner and nothing of the config view. */
  const profileView = (profile: Profile): string[] => {
    const lines = listing({ kind: "profile", profile });
    const profileAt = lines.findIndex((l) => l.startsWith("PROFILE "));
    expect(profileAt).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("GLOBAL") || l.startsWith("SHARED DEFAULTS")))
      .toEqual([]);
    return lines.slice(profileAt);
  };
  /** The config view: SHARED DEFAULTS, then GLOBAL, and no PROFILE. */
  const configView = (): { shared: string[]; global: string[] } => {
    const lines = listing(CONFIG);
    const sharedAt = lines.findIndex((l) => l.startsWith("SHARED DEFAULTS"));
    const globalAt = lines.findIndex((l) => l.startsWith("GLOBAL"));
    expect(sharedAt).toBeGreaterThan(0);
    expect(globalAt).toBeGreaterThan(sharedAt);
    expect(lines.filter((l) => l.startsWith("PROFILE "))).toEqual([]);
    return { shared: lines.slice(sharedAt, globalAt), global: lines.slice(globalAt) };
  };
  // A profile's view lists its own keys, then each profile-default group under a heading; the
  // config view lists the profile-default groups, then the global keys group by group.
  const sharedKeys = CONFIG_GROUPS.flatMap((g) =>
    CONFIG_REGISTRY.filter((d) => configGroup(d.key) === g && d.scope === "profile-default")
      .map((d) => d.key)
  );
  const profileKeys = [
    ...CONFIG_REGISTRY.filter((d) => d.scope === "profile").map((d) => d.key),
    ...sharedKeys,
  ];
  const globalKeys = CONFIG_GROUPS.flatMap((g) =>
    CONFIG_REGISTRY.filter((d) => configGroup(d.key) === g && d.scope === "global")
      .map((d) => d.key)
  );
  // Each profile-default group's PROFILE heading names what reads the value for the profile.
  const headingNote: Record<string, string> = {
    probe: "this profile's Direct probe",
    proxy: "this profile's daemon",
  };
  const headingRe = (group: string): RegExp =>
    new RegExp(
      `^  ${group}: +\\(${headingNote[group]}; the shared default is agent config's\\)$`,
      "m",
    );
  const profileDefaultGroups = [
    ...new Set(
      CONFIG_REGISTRY.filter((d) => d.scope === "profile-default").map((d) => configGroup(d.key)),
    ),
  ];

  // Nothing stored: each view lists its keys and none of the other's; the shared key sits under
  // PROFILE unstarred, with no origin cell.
  const empty = profileView(null);
  expect(keysIn(empty)).toEqual(profileKeys);
  for (const group of profileDefaultGroups) {
    expect(empty.join("\n"), group).toMatch(headingRe(group));
  }
  expect(rowOf(empty, shared.key).startsWith(`    ${shared.key}=`)).toBe(true);
  expect(rowOf(empty, shared.key)).not.toContain("(shared default)");
  expect(keysIn(empty)).toContain(own.key);
  const emptyConfig = configView();
  expect(keysIn(emptyConfig.shared)).toEqual(sharedKeys);
  expect(keysIn(emptyConfig.global)).toEqual(globalKeys);
  expect(keysIn(emptyConfig.global)).toContain(machine.key);

  // Set through `agent config` (the shared default): every profile inherits it, starred and
  // marked (shared default); under SHARED DEFAULTS it is the starred row itself, no origin cell,
  // and the key has no row under GLOBAL.
  runConfig({ kind: "set", key: shared.key, value: sharedDefault, view: CONFIG, dryRun: false });
  for (const profile of [null, WORK]) {
    const v = profileView(profile);
    expect(v[0]?.startsWith(`PROFILE ${profile ?? "default"}`)).toBe(true);
    expect(rowOf(v, shared.key)).toContain(`  * ${shared.key}=${sharedDefault}`);
    expect(rowOf(v, shared.key)).toContain("(shared default)");
  }
  const sharedRow = rowOf(configView().shared, shared.key);
  expect(sharedRow).toContain(`  * ${shared.key}=${sharedDefault}`);
  expect(sharedRow).not.toContain("(shared default)");
  expect(keysIn(configView().global)).not.toContain(shared.key);
  expect(listing(CONFIG)[0]).toMatch(new RegExp(`^1 of ${MACHINE_AND_SHARED_KEYS} keys set`));

  // Set on work too: work's row is its own value and names the shared default it hides;
  // default's row is unchanged. A key set at both levels is one row, so the count stays 1.
  runConfig({
    kind: "set",
    key: shared.key,
    value: sharedDefault,
    view: { kind: "profile", profile: WORK },
    dryRun: false,
  });
  const work = profileView(WORK);
  expect(rowOf(work, shared.key)).toContain(`  * ${shared.key}=${sharedDefault}`);
  expect(rowOf(work, shared.key)).toContain(`(overrides the shared default ${sharedDefault})`);
  expect(rowOf(work, shared.key)).not.toContain("(shared default)");
  expect(rowOf(profileView(null), shared.key)).toContain("(shared default)");
  expect(listing({ kind: "profile", profile: WORK })[0]).toMatch(
    new RegExp(`^1 of ${profileKeys.length} keys set`),
  );

  // With the shared default gone the override hides the built-in default, named once: no
  // `default` cell beside it.
  runConfig({ kind: "unset", key: shared.key, view: CONFIG, dryRun: false });
  const overrideRow = rowOf(profileView(WORK), shared.key);
  expect(overrideRow).toContain(`  * ${shared.key}=${sharedDefault}`);
  expect(overrideRow).toContain(`(overrides the built-in default ${sharedDefault})`);
  expect(overrideRow).not.toContain(`default ${sharedDefault} `);
});

test("configTable() narrows with the width: the header packs to it, the right column stacks under the key row at 40, and nothing runs past it: a lead wider than the terminal splits at the edge", () => {
  const at = (width: number): string[] =>
    configTable(stored({ "daemon.strict-port": true }), { ...PLAIN_TABLE, width }).split("\n");
  const headers: [number, string[]][] = [
    [60, [
      `1 of ${MACHINE_AND_SHARED_KEYS} keys set (*).  |  agent config set <key> <value>`,
      "agent config unset <key> reverts",
      "a profile's own keys: agent profile [<name>] set|unset|get",
      "",
    ]],
    [40, [
      `1 of ${MACHINE_AND_SHARED_KEYS} keys set (*).`,
      "agent config set <key> <value>",
      "agent config unset <key> reverts",
      "a profile's own keys: agent profile",
      "[<name>] set|unset|get",
      "",
    ]],
  ];
  for (const [width, header] of headers) {
    expect(at(width).slice(0, header.length), String(width)).toEqual(header);
  }
  // Nothing runs past the width at either: a key=value lead wider than the terminal splits at
  // the edge, with its remainder on the next line.
  expect(at(60).filter((l) => l.length > 60)).toEqual([]);
  const out = at(40);
  expect(out.filter((l) => l.length > 40)).toEqual([]);
  const urlLead = out.indexOf("    cost.pricing-url=https://openrouter.");
  expect(urlLead).toBeGreaterThan(0);
  expect(out[urlLead + 1]).toBe("      ai/api/v1/models");
  // The right column stacks under each key row at a six-space indent.
  const strict = out.indexOf("  * daemon.strict-port=true");
  expect(strict).toBeGreaterThan(0);
  expect(out[strict + 1]).toBe("      [bool] default false");
  expect(out[strict + 2]?.startsWith("      Fail start on a busy port")).toBe(true);
  // A banner whose title leaves the note too little room stacks it under the title instead of
  // running past the width: the longest profile name fills the width on its own.
  const longName = parseProfileName("a".repeat(32));
  const long = configTable(stored({}, { [longName]: {} }), {
    ...PLAIN_TABLE,
    width: 40,
    view: { kind: "profile", profile: longName },
  }).split("\n");
  const bannerAt = long.findIndex((l) => l.startsWith("PROFILE "));
  expect(long[bannerAt]).toBe(`PROFILE ${longName}`);
  expect(long[bannerAt + 1]?.startsWith("      (this profile's keys;")).toBe(true);
  expect(long.slice(bannerAt, bannerAt + 4).filter((l) => l.length > 40)).toEqual([]);
});

test("projectedProxyConfig(): force keys always project (built-in default or stored), opt-in keys project a stored value and clear their path otherwise, per profile, along the registry's paths; internal keys never leak", () => {
  tmpHome();
  // Empty store: the force-projected keys resolve to their built-in defaults; every opt-in key is
  // an entry WITHOUT a value, the clear that lets the proxy's own default stand.
  const empty = projectedProxyConfig(null);
  expect(projectedValue(empty, ["smallModel"])).toBe("gpt-5-mini");
  expect(projectedValue(empty, ["useResponsesApiWebSocket"])).toBe(true);
  expect(projectedValue(empty, ["useResponsesApiWebSearch"])).toBe(true);
  expect(projectedValue(empty, ["useMessagesApi"])).toBe(true);
  expect(empty.filter((e) => e.value !== undefined)).toHaveLength(4);
  for (
    const path of [
      ["alphaSearchCodexPriority"],
      ["alphaSearchModel"],
      ["claudeAutoModel"],
      ["claudeTokenMultiplier"],
      ["messageApiWebSearchModel"],
      ["contextManagement", "responses"],
    ]
  ) {
    expect(projectedEntry(empty, path)).toEqual({ path, value: undefined });
  }
  expect(empty).toHaveLength(10);
  // A stored override on a force key is honored; a stored opt-in key now appears too, each under
  // the proxy's own key (the paths are the proxy's contract): the nested one under
  // contextManagement.responses (the pre-1.14 flat key is never projected).
  const cfg = new CopilotEnvConfig();
  cfg.set({
    "proxy.responses.websocket": false,
    "proxy.message-websearch-model": "gpt-5",
    "proxy.responses.context-management": true,
    "proxy.alpha-search.codex-priority": false,
    "proxy.alpha-search.model": "gpt-5",
    "proxy.claude-auto-model": "claude-haiku-4.5",
  });
  const projected = projectedProxyConfig(null);
  expect(projectedValue(projected, ["useResponsesApiWebSocket"])).toBe(false);
  expect(projectedValue(projected, ["messageApiWebSearchModel"])).toBe("gpt-5");
  expect(projectedValue(projected, ["alphaSearchCodexPriority"])).toBe(false);
  expect(projectedValue(projected, ["alphaSearchModel"])).toBe("gpt-5");
  expect(projectedValue(projected, ["claudeAutoModel"])).toBe("claude-haiku-4.5");
  expect(projectedValue(projected, ["contextManagement", "responses"])).toBe(true);
  expect(projectedValue(projected, ["useResponsesApiContextManagement"])).toBeUndefined();
  // Copilot-env-internal keys never leak into the proxy projection.
  cfg.set({ "daemon.auto-start": true, "claude.desktop": false });
  expect(projectedProxyConfig(null)).toEqual(projected);
  expect(projectedValue(projected, ["autoStart"])).toBeUndefined();
  // A profile's daemon projects the profile's own override over the global value, and a knob set
  // for that profile alone; the default profile's projection is unchanged by either.
  cfg.setProfile(WORK, { "proxy.small-model": "gpt-5-codex", "proxy.claude-token-multiplier": 2 });
  const work = projectedProxyConfig(WORK);
  expect(projectedValue(work, ["smallModel"])).toBe("gpt-5-codex");
  expect(projectedValue(work, ["claudeTokenMultiplier"])).toBe(2);
  expect(projectedValue(work, ["messageApiWebSearchModel"])).toBe("gpt-5");
  expect(projectedProxyConfig(null)).toEqual(projected);
  // No two projected entries (force or opt-in) may share a path: the later entry's set or clear
  // would silently undo the earlier one's on every start.
  const allProjectedPaths = CONFIG_REGISTRY.filter(isProxyProjected).map((d) =>
    JSON.stringify(d.proxyPath)
  );
  expect(new Set(allProjectedPaths).size).toBe(allProjectedPaths.length);
});

test("one web-search default for both surfaces, and unset IS the default where the read sites layer their own", () => {
  // The proxy's own default must match the MCP tool's DEFAULT_WEB_SEARCH_MODEL, owned by
  // web_search.ts (which imports env_config, so the registry cannot reference it).
  expect(configDefaultValue(configKeyDef("proxy.message-websearch-model")!)).toBe(
    DEFAULT_WEB_SEARCH_MODEL,
  );
  // Unset IS the default: a disabled override, a floating pin, and the update cooldown (whose
  // two read sites apply different defaults: none for `agent update`, 7 days for autoupdate).
  for (const key of ["proxy.claude-auto-model", "daemon.version", "update.cooldown"] as const) {
    expect(configDefaultValue(configKeyDef(key)!)).toBeUndefined();
  }
});

// One unreadable prefs file, two contracts. POSIX non-root only: root bypasses file modes.
//   read(), wiring, the float pin, the port knobs  -> throw; never decide on an unproven "no preference"
//   the in-daemon watchdog's tick gates and the update preflight -> built-in defaults; a throw there
//   would kill the serving daemon, and the preflight must never act on an unproven on
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable prefs store: read() throws; the watchdog gates and the update preflight degrade to defaults",
  () => {
    tmpHome();
    const cfg = new CopilotEnvConfig();
    cfg.set({
      "daemon.auto-start": true,
      "daemon.idle-timeout": 30,
      "daemon.port": 5555,
      "update.auto": true,
    });
    const file = new CopilotApiPaths().stateStoreFile;
    chmodSync(file, 0o000);
    try {
      expect(() => cfg.read()).toThrow("refusing to treat an unreadable store as empty");
      expect(() => cfg.defaultPort()).toThrow(file);
      expect(() => cfg.wireMcpEnabled()).toThrow(file);
      // The watchdog-reachable gates and the preflight must NOT throw; they answer the defaults.
      expect(cfg.autoStartEnabled()).toBe(false);
      expect(cfg.idleTimeoutSeconds()).toBe(configDefaultNumber("daemon.idle-timeout"));
      expect(cfg.autoUpdateEnabled()).toBe(false);
    } finally {
      chmodSync(file, 0o600);
    }
    // Control: readable again, every reader answers the stored values.
    expect(cfg.autoStartEnabled()).toBe(true);
    expect(cfg.idleTimeoutSeconds()).toBe(30);
    expect(cfg.defaultPort()).toBe(5555);
    expect(cfg.autoUpdateEnabled()).toBe(true);
  },
);

test("configTable colors through the ungated palette: `color: true` paints even where the environment says no color", () => {
  const esc = String.fromCharCode(27);
  const out = configTable(stored({ "daemon.strict-port": true }), { ...PLAIN_TABLE, color: true });
  expect(out).toContain(`${esc}[36mdaemon.strict-port${esc}[39m`);
  expect(configTable(stored({}), PLAIN_TABLE)).not.toContain(esc);
});
