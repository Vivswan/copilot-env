import { configDefaultNumber } from "../../src/copilot_api/config_registry.ts";
import {
  resetDaemonShutdownForTests,
  shutdownInFlightForTests,
} from "../../src/copilot_api/daemon_shutdown.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import {
  armIdleWatchdog,
  defaultCheckIntervalMs,
  IDLE_TIMEOUT_ENV,
  idleCheck,
  idleTimeoutMs,
  isIdle,
  lastActivityMs,
} from "../../src/copilot_api/idle_watchdog.ts";
import {
  markInference,
  resetInferenceActivityForTests,
} from "../../src/copilot_api/inference_activity.ts";
import { DAEMON_KEEP_PORT_ENV } from "../../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../../src/copilot_api/run_state.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { writeRunState } from "../helpers/fixtures.ts";
import { afterEach, expect, test } from "../helpers/testing.ts";

const restoreEnv = envSnapshot([IDLE_TIMEOUT_ENV, DAEMON_KEEP_PORT_ENV]);

afterEach(() => {
  resetInferenceActivityForTests();
  resetDaemonShutdownForTests();
  restoreEnv();
});

// Isolate the config store (idleTimeoutMs reads it when the env knob is unset).
function tmpHome(): void {
  isolateProxyHome("copilot-idle-");
}

/** The exit stub's throw: the real process.exit never returns, and a stub that returned would arm
 *  the shutdown path's late-listener timer, whose exit the restored real process.exit would carry
 *  out between tests. */
const stubbedExit = new Error("process.exit stubbed");

/**
 * idleCheck's exit decision as data: the code the shared shutdown path passed to process.exit, or
 * null when it started no shutdown. The stub stays installed until the shutdown idleCheck may
 * have started has settled, which is a microtask after the call: a stub restored at idleCheck's
 * return hands the real exit the rest of the file's run.
 */
async function idleCheckExit(startedAtMs: number, timeoutMs: number): Promise<number | null> {
  const realExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number): never => {
    exitCode = code ?? 0;
    throw stubbedExit;
  }) as typeof process.exit;
  try {
    idleCheck(startedAtMs, timeoutMs);
    await shutdownInFlightForTests()?.catch((reason: unknown) => {
      if (reason !== stubbedExit) throw reason;
    });
  } finally {
    process.exit = realExit;
  }
  return exitCode;
}

test("idleCheck: recent observed inference keeps a long-started daemon alive", async () => {
  tmpHome();
  // Managed lifecycle ON, started long ago, tiny timeout -- WOULD exit if idle. A fresh
  // in-memory inference mark (what the observer records on a real model call) must hold it up.
  new CopilotEnvConfig().set({ "daemon.auto-start": true });
  writeRunState({ pid: process.pid, port: 4141 });
  markInference(Date.now());
  const exitCode = await idleCheckExit(0, 60_000); // started at epoch, 1-minute window: only the mark is recent
  // never cleared -- the daemon stayed up
  expect({ exitCode, pid: new CopilotEnvRunState().read().pid }).toEqual({
    exitCode: null,
    pid: process.pid,
  });
});

// All marks ancient -> idle -> the shared shutdown path. No server was recorded in this process,
// so there is nothing to drain and the exit follows at once. clearIfPid wipes the daemon tracking
// (pid matches this process); whether the port goes with it is the spawn's keep-port value: unset
// or the default daemon's "0" releases it, a named profile's "1" keeps the stable reservation the
// baked wiring points at.
test("idleCheck: with no activity past the window, clears run state and exits; keep-port decides the port", async () => {
  const rows: { keepPort: string | undefined; port: number | undefined }[] = [
    { keepPort: undefined, port: undefined },
    { keepPort: "0", port: undefined },
    { keepPort: "1", port: 4242 },
  ];
  for (const row of rows) {
    tmpHome();
    // The previous row's shutdown is the "already shutting down" state a new call would join.
    resetDaemonShutdownForTests();
    new CopilotEnvConfig().set({ "daemon.auto-start": true });
    const state = new CopilotEnvRunState();
    state.set({ pid: process.pid, port: 4242, lastEnsureAt: 1 });
    if (row.keepPort === undefined) delete process.env[DAEMON_KEEP_PORT_ENV];
    else process.env[DAEMON_KEEP_PORT_ENV] = row.keepPort;
    const exitCode = await idleCheckExit(2, 1);
    const after = state.read();
    expect({
      ...row,
      exitCode,
      pid: after.pid,
      lastEnsureAt: after.lastEnsureAt,
      port: after.port,
    }).toEqual({
      ...row,
      exitCode: 0,
      pid: undefined,
      lastEnsureAt: undefined,
    });
  }
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
  expect(lastActivityMs({ inferenceMs: null, ensureAtMs: null })).toBe(0);
});

test("isIdle: true exactly at and past the timeout boundary, false before it", () => {
  const timeout = 1000;
  expect(isIdle(0, 999, timeout)).toBe(false);
  expect(isIdle(0, 1000, timeout)).toBe(true);
  expect(isIdle(0, 1500, timeout)).toBe(true);
});

test("idleCheck: lifecycle OFF (auto-start unset) returns before touching run-state, even when idle", async () => {
  tmpHome();
  // auto-start unset disables the managed lifecycle, so idleCheck must disengage before clearIfPid.
  // idleCheck(0, 1) is long-idle with a 1ms timeout: without the OFF gate it would clearIfPid and
  // call shutdownDaemon(0), which the stub reports as an exit code here instead of ending the
  // file's run.
  expect(new CopilotEnvConfig().autoStartEnabled()).toBe(false);
  const state = new CopilotEnvRunState();
  state.set({ pid: process.pid, port: 4141, lastEnsureAt: 1 });
  const exitCode = await idleCheckExit(0, 1);
  const after = state.read();
  expect({ exitCode, pid: after.pid, port: after.port, lastEnsureAt: after.lastEnsureAt }).toEqual({
    exitCode: null,
    pid: process.pid,
    port: 4141,
    lastEnsureAt: 1,
  });
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
    }) as unknown as typeof realSetInterval;
    try {
      armIdleWatchdog();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect({ env: row.env, armed, unrefCalled }).toEqual(row);
  }
});
