import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  defaultCheckIntervalMs,
  IDLE_TIMEOUT_ENV,
  idleTimeoutMs,
  isIdle,
} from "../src/scripts/idle_watchdog.ts";

const SAVED = process.env[IDLE_TIMEOUT_ENV];
const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED === undefined) delete process.env[IDLE_TIMEOUT_ENV];
  else process.env[IDLE_TIMEOUT_ENV] = SAVED;
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// Isolate the config store (idleTimeoutMs reads it when the env knob is unset).
function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-idle-"));
  process.env.COPILOT_API_HOME = dir;
}

test("idleTimeoutMs: default is 1 hour; the env knob overrides in whole seconds", () => {
  tmpHome();
  delete process.env[IDLE_TIMEOUT_ENV];
  expect(idleTimeoutMs()).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS * 1000);
  expect(idleTimeoutMs()).toBe(3600 * 1000);

  process.env[IDLE_TIMEOUT_ENV] = "5";
  expect(idleTimeoutMs()).toBe(5000);
});

test("idleTimeoutMs: precedence env > config > default", () => {
  tmpHome();
  delete process.env[IDLE_TIMEOUT_ENV];
  // config set, env unset -> config wins over the default.
  new CopilotEnvConfig().set({ idleTimeout: 90 });
  expect(idleTimeoutMs()).toBe(90_000);
  // env set -> overrides config.
  process.env[IDLE_TIMEOUT_ENV] = "7";
  expect(idleTimeoutMs()).toBe(7000);
});

test("idleTimeoutMs: 0 disables (<=0 means no watchdog); a malformed value falls back", () => {
  tmpHome();
  process.env[IDLE_TIMEOUT_ENV] = "0";
  expect(idleTimeoutMs()).toBe(0);

  // Non-numeric env -> falls through to config/default (a bad env must not crash the watchdog).
  process.env[IDLE_TIMEOUT_ENV] = "notanumber";
  expect(idleTimeoutMs()).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS * 1000);
});

test("defaultCheckIntervalMs: a quarter of the window, clamped to [1s, 60s]", () => {
  // 1-hour window clamps to the 60s ceiling.
  expect(defaultCheckIntervalMs(3600 * 1000)).toBe(60_000);
  // A short test window polls proportionally faster (5s -> 1.25s).
  expect(defaultCheckIntervalMs(5000)).toBe(1250);
  // Tiny windows clamp up to the 1s floor.
  expect(defaultCheckIntervalMs(1000)).toBe(1000);
});

test("isIdle: true exactly at and past the timeout boundary, false before it", () => {
  const timeout = 1000;
  expect(isIdle(0, 999, timeout)).toBe(false); // 999ms idle < 1000
  expect(isIdle(0, 1000, timeout)).toBe(true); // exactly at the boundary
  expect(isIdle(0, 1500, timeout)).toBe(true); // past it
});
