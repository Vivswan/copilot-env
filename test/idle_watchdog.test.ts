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
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, writeRunState } from "./helpers.ts";

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
  new CopilotEnvConfig().set({ "daemon.auto-start": true });
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
  new CopilotEnvConfig().set({ "daemon.auto-start": true });
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
  new CopilotEnvConfig().set({ "daemon.auto-start": true });
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4242, lastEnsureAt: 1 });
  // A named profile's daemon is spawned with keep-port "1": auto-stop clears the pid, but the
  // port (the profile's stable reservation the baked wiring points at) must survive. The default
  // daemon's "0" is pinned above (port cleared).
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

// The knob's precedence is env > config > default, in whole seconds; 0 or a negative value
// disables (armIdleWatchdog reads <= 0 as no watchdog), and a non-numeric env must fall through
// rather than crash the watchdog.
test("idleTimeoutMs: env > config > default in whole seconds; 0 and negatives disable; a malformed env falls through", () => {
  tmpHome();
  const defaultMs = configDefaultNumber("daemon.idle-timeout") * 1000;
  const rows: { env: string | undefined; config: number | undefined; ms: number }[] = [
    { env: undefined, config: undefined, ms: defaultMs },
    { env: "5", config: undefined, ms: 5000 },
    { env: undefined, config: 90, ms: 90_000 },
    { env: "7", config: 90, ms: 7000 },
    { env: "0", config: undefined, ms: 0 },
    { env: "-1", config: undefined, ms: -1000 },
    { env: "notanumber", config: undefined, ms: defaultMs },
  ];
  for (const row of rows) {
    if (row.env === undefined) delete process.env[IDLE_TIMEOUT_ENV];
    else process.env[IDLE_TIMEOUT_ENV] = row.env;
    new CopilotEnvConfig().set({ "daemon.idle-timeout": row.config ?? null });
    expect({ ...row, ms: idleTimeoutMs() }).toEqual(row);
  }
});

test("defaultCheckIntervalMs: a quarter of the window, clamped to [1s, 60s]", () => {
  expect(defaultCheckIntervalMs(3600 * 1000)).toBe(60_000);
  expect(defaultCheckIntervalMs(5000)).toBe(1250);
  expect(defaultCheckIntervalMs(1000)).toBe(1000);
});

// The daemon's idleCheck and the health report's watchdog check both derive "last activity"
// from this one function, with different signals available (health cannot see startedAtMs).
test("lastActivityMs: picks the most recent signal; absent signals don't count", () => {
  expect(lastActivityMs({ startedAtMs: 100, inferenceMs: 300, ensureAtMs: 200 })).toBe(300);
  expect(lastActivityMs({ startedAtMs: 500, inferenceMs: 300, ensureAtMs: null })).toBe(500);
  expect(lastActivityMs({ inferenceMs: null, ensureAtMs: 200 })).toBe(200);
  // No signal at all reads as 0 ("no activity recorded").
  expect(lastActivityMs({ inferenceMs: null, ensureAtMs: null })).toBe(0);
});

test("isIdle: true exactly at and past the timeout boundary, false before it", () => {
  const timeout = 1000;
  expect(isIdle(0, 999, timeout)).toBe(false);
  expect(isIdle(0, 1000, timeout)).toBe(true);
  expect(isIdle(0, 1500, timeout)).toBe(true);
});

test("idleCheck: lifecycle OFF (auto-start unset) returns before touching run-state, even when idle", () => {
  tmpHome();
  // auto-start unset disables the managed lifecycle, so idleCheck must disengage before clearIfPid.
  // idleCheck(0, 1) is long-idle with a 1ms timeout: without the OFF gate it would clearIfPid and
  // call shutdownDaemon(0), whose Deno.exit the process.exit stub below does not intercept, so a
  // broken gate ends the whole `deno test` run with code 0 rather than failing here.
  expect(new CopilotEnvConfig().autoStartEnabled()).toBe(false);
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4141, lastEnsureAt: 1 });
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
  const after = state.read();
  expect(after.pid).toBe(process.pid);
  expect(after.port).toBe(4141);
  expect(after.lastEnsureAt).toBe(1);
});

// A timeout <= 0 arms nothing; a positive one arms an unref'd interval, so the timer never holds
// the event loop open on its own.
test("armIdleWatchdog: a timeout of 0 arms no timer; a positive one arms an unref'd timer", () => {
  tmpHome();
  const rows: { env: string; armed: boolean; unrefCalled: boolean }[] = [
    { env: "0", armed: false, unrefCalled: false },
    { env: "5", armed: true, unrefCalled: true },
  ];
  for (const row of rows) {
    process.env[IDLE_TIMEOUT_ENV] = row.env;
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
    expect({ env: row.env, armed, unrefCalled }).toEqual(row);
  }
});
