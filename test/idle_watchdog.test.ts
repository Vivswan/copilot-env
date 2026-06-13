import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  defaultCheckIntervalMs,
  IDLE_TIMEOUT_ENV,
  idleTimeoutMs,
  isIdle,
} from "../src/scripts/idle_watchdog.ts";

const SAVED = process.env[IDLE_TIMEOUT_ENV];

afterEach(() => {
  if (SAVED === undefined) delete process.env[IDLE_TIMEOUT_ENV];
  else process.env[IDLE_TIMEOUT_ENV] = SAVED;
});

test("idleTimeoutMs: default is 1 hour; the env knob overrides in whole seconds", () => {
  delete process.env[IDLE_TIMEOUT_ENV];
  expect(idleTimeoutMs()).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS * 1000);
  expect(idleTimeoutMs()).toBe(3600 * 1000);

  process.env[IDLE_TIMEOUT_ENV] = "5";
  expect(idleTimeoutMs()).toBe(5000);
});

test("idleTimeoutMs: 0 disables (<=0 means no watchdog); a malformed value falls back", () => {
  process.env[IDLE_TIMEOUT_ENV] = "0";
  expect(idleTimeoutMs()).toBe(0);

  // Non-numeric -> default (a bad env var must not crash the in-daemon watchdog).
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
