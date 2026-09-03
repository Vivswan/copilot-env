import { configDefaultNumber, CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { DAEMON_KEEP_PORT_ENV } from "../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import {
  armIdleWatchdog,
  defaultCheckIntervalMs,
  IDLE_TIMEOUT_ENV,
  idleCheck,
  idleTimeoutMs,
  isIdle,
  lastActivityMs,
} from "../src/scripts/idle_watchdog.ts";
import { resetDaemonShutdownForTests } from "../src/scripts/daemon_shutdown.ts";
import {
  markInference,
  resetInferenceActivityForTests,
} from "../src/scripts/inference_activity.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, writeRunState } from "./helpers.ts";

const restoreEnv = envSnapshot([IDLE_TIMEOUT_ENV, DAEMON_KEEP_PORT_ENV]);
let dir = "";

afterEach(() => {
  resetInferenceActivityForTests();
  resetDaemonShutdownForTests();
  restoreEnv();
  dir = removeDir(dir);
});

// Isolate the config store (idleTimeoutMs reads it when the env knob is unset).
function tmpHome(): void {
  dir = isolateProxyHome("copilot-idle-");
}

test("idleCheck: recent observed inference keeps a long-started daemon alive", () => {
  tmpHome();
  // Managed lifecycle ON, started long ago, tiny timeout -- WOULD exit if idle. A fresh
  // in-memory inference mark (what the observer records on a real model call) must hold it up.
  new CopilotEnvConfig().set({ autoStart: true });
  writeRunState({ pid: process.pid, port: 4141 });
  markInference(Date.now());
  // Stub the process-exit primitive the shared shutdown path calls, so a wrong
  // decision surfaces as a failure instead of ending the test run.
  const realExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new Error(`idleCheck unexpectedly stopped the daemon (${code})`);
  }) as typeof Deno.exit;
  try {
    idleCheck(0, 60_000); // started at epoch, 1-minute window: only the mark is recent
  } finally {
    Deno.exit = realExit;
  }
  expect(new CopilotEnvRunState().read().pid).toBe(process.pid); // never cleared -- the daemon stayed up
});

test("idleCheck: with no activity past the window, clears run state and exits", () => {
  tmpHome();
  new CopilotEnvConfig().set({ autoStart: true });
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4141, lastEnsureAt: 1 });
  const realExit = Deno.exit;
  let exitCode: number | undefined = -1;
  Deno.exit = ((code?: number): never => {
    exitCode = code;
    throw new Error("exit"); // the shutdown path ends here, like the real Deno.exit
  }) as typeof Deno.exit;
  try {
    // All marks ancient -> idle -> the shared shutdown path. No server was recorded in
    // this process, so there is nothing to drain and the exit is immediate.
    expect(() => idleCheck(2, 1)).toThrow("exit");
  } finally {
    Deno.exit = realExit;
  }
  expect(exitCode).toBe(0);
  // clearIfPid wiped the daemon tracking (pid matches this process).
  const after = state.read();
  expect(after.pid).toBeUndefined();
  expect(after.port).toBeUndefined();
  expect(after.lastEnsureAt).toBeUndefined();
});

test("idleCheck: the spawn's keep-port value preserves a profile reservation across auto-stop", () => {
  tmpHome();
  new CopilotEnvConfig().set({ autoStart: true });
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4242, lastEnsureAt: 1 });
  // A named profile's daemon is spawned with keep-port "1" (releasesPortOnStop false):
  // auto-stop clears the pid tracking but the port -- the profile's stable reservation
  // the baked agent wiring points at -- must survive. The default daemon's spawn sets
  // "0", which the test above pins (port cleared).
  process.env[DAEMON_KEEP_PORT_ENV] = "1";
  const realExit = Deno.exit;
  Deno.exit = ((): never => {
    throw new Error("exit");
  }) as typeof Deno.exit;
  try {
    expect(() => idleCheck(2, 1)).toThrow("exit");
  } finally {
    Deno.exit = realExit;
  }
  const after = state.read();
  expect(after.pid).toBeUndefined();
  expect(after.port).toBe(4242);
});

test("idleTimeoutMs: default is 1 hour; the env knob overrides in whole seconds", () => {
  tmpHome();
  delete process.env[IDLE_TIMEOUT_ENV];
  expect(idleTimeoutMs()).toBe(configDefaultNumber("idle-timeout") * 1000);
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

  // A negative value parses too (the env knob's contract: "0 or negative disables") -- a <=0
  // result disables the watchdog via armIdleWatchdog, so it must NOT fall through to the default.
  process.env[IDLE_TIMEOUT_ENV] = "-1";
  expect(idleTimeoutMs()).toBe(-1000);

  // Non-numeric env -> falls through to config/default (a bad env must not crash the watchdog).
  process.env[IDLE_TIMEOUT_ENV] = "notanumber";
  expect(idleTimeoutMs()).toBe(configDefaultNumber("idle-timeout") * 1000);
});

test("defaultCheckIntervalMs: a quarter of the window, clamped to [1s, 60s]", () => {
  // 1-hour window clamps to the 60s ceiling.
  expect(defaultCheckIntervalMs(3600 * 1000)).toBe(60_000);
  // A short test window polls proportionally faster (5s -> 1.25s).
  expect(defaultCheckIntervalMs(5000)).toBe(1250);
  // Tiny windows clamp up to the 1s floor.
  expect(defaultCheckIntervalMs(1000)).toBe(1000);
});

// The shared activity rule: the daemon's idleCheck and the health report's watchdog
// check both derive "last activity" from this one function, with different signals
// available (health cannot see startedAtMs).
test("lastActivityMs: picks the most recent signal; absent signals don't count", () => {
  expect(lastActivityMs({ startedAtMs: 100, inferenceMs: 300, ensureAtMs: 200 })).toBe(300);
  expect(lastActivityMs({ startedAtMs: 500, inferenceMs: 300, ensureAtMs: null })).toBe(500);
  expect(lastActivityMs({ inferenceMs: null, ensureAtMs: 200 })).toBe(200);
  // No signal at all reads as 0 ("no activity recorded").
  expect(lastActivityMs({ inferenceMs: null, ensureAtMs: null })).toBe(0);
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
  // the whole `deno test` run with code 0 -- the bug this test exists to catch.
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
