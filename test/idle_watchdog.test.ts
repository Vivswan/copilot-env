import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import {
  armIdleWatchdog,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  defaultCheckIntervalMs,
  IDLE_TIMEOUT_ENV,
  idleCheck,
  idleTimeoutMs,
  isIdle,
  lastInferenceActivityMs,
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

test("lastInferenceActivityMs: newest responses/messages handler-log mtime; ignores other files", () => {
  tmpHome();
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const write = (name: string, mtimeSec: number) => {
    const p = join(logs, name);
    writeFileSync(p, "x");
    utimesSync(p, mtimeSec, mtimeSec); // atime, mtime in seconds
  };
  // Inference logs: the newest of these two should win.
  write("responses-handler-2026-06-26.log", 1000);
  write("messages-handler-2026-06-27.log", 2000); // newest inference -> the answer
  // Non-inference / non-matching files with EVEN NEWER mtimes must be ignored.
  write("models-handler-2026-06-28.log", 9000); // model-list polling, not inference
  write(".log", 9999); // the daemon access log (liveness GET / lands here)
  write("notes.txt", 9999);

  expect(lastInferenceActivityMs()).toBe(2000 * 1000); // mtimeMs of the newest inference log
});

test("lastInferenceActivityMs: returns 0 when there are no inference logs (or no logs dir)", () => {
  tmpHome();
  expect(lastInferenceActivityMs()).toBe(0); // logs dir absent
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "logs", ".log"), "x"); // only the access log, no handler logs
  expect(lastInferenceActivityMs()).toBe(0);
});

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

test("idleCheck: lifecycle OFF (auto-start unset) returns without exiting, even when idle", () => {
  tmpHome();
  // auto-start is unset (default false) in this fresh temp home -> the managed lifecycle is
  // disabled, so idleCheck must disengage and leave the daemon running. idleCheck(0, 1) is
  // long-idle + a 1ms timeout, which WOULD trip process.exit(0) if the OFF gate were removed.
  // Stub process.exit so that regression throws (fails loudly) instead of silently terminating
  // the whole `bun test` run with code 0 -- the bug this test exists to catch.
  expect(new CopilotEnvConfig().autoStartEnabled()).toBe(false);
  const realExit = process.exit;
  let exited = false;
  process.exit = ((code?: number): never => {
    exited = true;
    throw new Error(`idleCheck unexpectedly exited (${code})`);
  }) as typeof process.exit;
  try {
    idleCheck(0, 1);
  } finally {
    process.exit = realExit;
  }
  expect(exited).toBe(false);
});

test("idleCheck: lifecycle OFF also short-circuits before touching run-state", () => {
  tmpHome();
  // Seed a run-state pid; the OFF early-return happens before clearIfPid, so the state must be
  // left untouched. Guard process.exit too: a broken gate would clearIfPid THEN exit(0), which
  // would end the runner before the assertions -- the stub turns that into a loud failure.
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4141, lastEnsureAt: 1 });
  const realExit = process.exit;
  process.exit = ((code?: number): never => {
    throw new Error(`idleCheck unexpectedly exited (${code})`);
  }) as typeof process.exit;
  try {
    idleCheck(0, 1); // idle + tiny timeout, but lifecycle OFF -> no clear, no exit
  } finally {
    process.exit = realExit;
  }
  const after = state.read();
  expect(after.pid).toBe(process.pid);
  expect(after.port).toBe(4141);
  expect(after.lastEnsureAt).toBe(1);
});

test("armIdleWatchdog: COPILOT_API_IDLE_TIMEOUT=0 arms no timer", () => {
  tmpHome();
  process.env[IDLE_TIMEOUT_ENV] = "0"; // timeoutMs <= 0 disables the watchdog
  // Stub setInterval to detect whether a timer is armed; armIdleWatchdog must return before it.
  const realSetInterval = globalThis.setInterval;
  let armed = false;
  globalThis.setInterval = ((): ReturnType<typeof realSetInterval> => {
    armed = true;
    return { unref() {} } as unknown as ReturnType<typeof realSetInterval>;
  }) as typeof realSetInterval;
  try {
    armIdleWatchdog();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  expect(armed).toBe(false);
});

test("armIdleWatchdog: a positive timeout DOES arm an unref'd timer", () => {
  tmpHome();
  process.env[IDLE_TIMEOUT_ENV] = "5"; // positive -> watchdog enabled
  const realSetInterval = globalThis.setInterval;
  let armed = false;
  let unrefCalled = false;
  const fakeTimer = {
    unref() {
      unrefCalled = true;
      return fakeTimer;
    },
  };
  globalThis.setInterval = ((): ReturnType<typeof realSetInterval> => {
    armed = true;
    return fakeTimer as unknown as ReturnType<typeof realSetInterval>;
  }) as typeof realSetInterval;
  try {
    armIdleWatchdog();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  expect(armed).toBe(true); // contrast with the timeout=0 case: here a timer IS armed
  expect(unrefCalled).toBe(true); // the timer is unref'd so it never holds the loop open alone
});
