import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConfig } from "../src/commands/config.ts";
import { CONFIG_REGISTRY, CopilotEnvConfig, configKeyDef } from "../src/copilot_api/env_config.ts";

// CopilotEnvConfig reads/writes the SHARED prefs store under COPILOT_API_HOME, so isolate
// each test in a temp home.
const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-envconfig-"));
  process.env.COPILOT_API_HOME = dir;
}

test("each typed key round-trips and del() reverts it to undefined (default)", () => {
  tmpHome();
  const cfg = new CopilotEnvConfig();
  expect(cfg.read()).toEqual({});

  cfg.set({
    autoStart: true,
    passthrough: "on",
    idleTimeout: 120,
    smallModel: "gpt-5-mini",
    port: 4242,
    proxyVersion: "1.2.3",
    releaseCooldown: 86400,
    updateCooldown: 7,
  });
  expect(cfg.read()).toEqual({
    autoStart: true,
    passthrough: "on",
    idleTimeout: 120,
    smallModel: "gpt-5-mini",
    port: 4242,
    proxyVersion: "1.2.3",
    releaseCooldown: 86400,
    updateCooldown: 7,
  });
  expect(cfg.autoStartEnabled()).toBe(true);

  cfg.del("autoStart");
  expect(cfg.read().autoStart).toBeUndefined();
  expect(cfg.autoStartEnabled()).toBe(false);
  // Deleting one key leaves the others intact.
  expect(cfg.read().port).toBe(4242);
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
  expect(configKeyDef("port")?.parse("4141")).toBe(4141);

  expect(() => configKeyDef("auto-start")?.parse("maybe")).toThrow();
  expect(() => configKeyDef("passthrough")?.parse("sometimes")).toThrow();
  expect(() => configKeyDef("idle-timeout")?.parse("-5")).toThrow();
  expect(() => configKeyDef("port")?.parse("70000")).toThrow(); // out of range
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

test("the registry covers exactly the eight documented keys", () => {
  expect(CONFIG_REGISTRY.map((d) => d.cli)).toEqual([
    "auto-start",
    "passthrough",
    "idle-timeout",
    "small-model",
    "port",
    "proxy-version",
    "release-cooldown",
    "update-cooldown",
  ]);
});
