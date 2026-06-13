// Logic for the idle auto-stop watchdog that runs INSIDE the copilot-api daemon. Running in
// the daemon process means the server and its watchdog are ONE unit: killing the daemon takes
// the watchdog with it, and when the watchdog trips it stops the server by exiting the process
// -- no separate pid, no orphan in either direction, and every daemon (re)start re-attaches it.
//
// Activity is the most recent of the proxy log mtime (real request traffic the daemon writes
// under --verbose) and the `start --record-event` heartbeat (an open agent re-runs its proxy resolver
// on a refresh interval). Idle past the timeout -> the daemon exits.
//
// This module is import-safe -- it never arms a timer on import, so unit tests can exercise the
// pure helpers. idle_watchdog_preload.ts is the tiny `bun --preload` entry that arms it (and is
// never imported by tests), the same split pat_passthrough_preload.ts gets from its own file.
import { statSync } from "node:fs";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";

/** Env knob: idle timeout in whole seconds. `0` (or negative) disables the watchdog. */
export const IDLE_TIMEOUT_ENV = "COPILOT_API_IDLE_TIMEOUT";
/** Default idle window when the env knob is unset: 1 hour. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 3600;
/** Upper bound on the poll interval; short timeouts poll proportionally faster. */
const MAX_CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_INTERVAL_MS = 1_000;

/**
 * The effective idle timeout in milliseconds. Reads `COPILOT_API_IDLE_TIMEOUT` (a whole
 * number of seconds; `0` disables), else the 1-hour default. A malformed value falls back
 * to the default rather than throwing -- the watchdog runs inside the detached daemon, so a
 * bad env var must not crash it (and the proxy would then never auto-stop, the safe way).
 */
export function idleTimeoutMs(): number {
  const raw = process.env[IDLE_TIMEOUT_ENV]?.trim();
  if (raw !== undefined && /^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }
  return DEFAULT_IDLE_TIMEOUT_SECONDS * 1000;
}

/** Default poll interval for a given timeout: a quarter of the window, clamped. */
export function defaultCheckIntervalMs(timeoutMs: number): number {
  return Math.max(
    MIN_CHECK_INTERVAL_MS,
    Math.min(MAX_CHECK_INTERVAL_MS, Math.floor(timeoutMs / 4)),
  );
}

/** Whether `now` is at least `timeoutMs` past the last activity. */
export function isIdle(lastActivityMs: number, now: number, timeoutMs: number): boolean {
  return now - lastActivityMs >= timeoutMs;
}

/** mtime (epoch ms) of the proxy log, or 0 when it is absent/unreadable. */
function logMtimeMs(): number {
  try {
    return statSync(new CopilotApiPaths().logFile).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * One idle check, run on the interval inside the daemon. If the managed lifecycle was
 * turned off (`agent init --no-auto-start`) we disengage and leave the daemon running.
 * Otherwise, when idle past the timeout, clear our run-state tracking (best-effort) and
 * stop the server by exiting this process. `startedAtMs` floors activity so a freshly
 * launched, quiet daemon is not considered idle before its first request/heartbeat.
 */
export function idleCheck(startedAtMs: number, timeoutMs: number): void {
  if (!new CopilotEnvState().autoStartEnabled()) return; // lifecycle disabled -> stay up
  const state = new CopilotEnvRunState();
  const snapshot = state.read();
  const lastActivity = Math.max(startedAtMs, logMtimeMs(), snapshot.lastEnsureAt ?? 0);
  if (!isIdle(lastActivity, Date.now(), timeoutMs)) return;
  // Clear our run-state tracking, but ONLY if it still points at THIS daemon. clearIfPid
  // does the pid check INSIDE the atomic read-modify-write, so a newer daemon that replaced
  // us between ticks can't have its freshly written pid/port clobbered. We exit either way
  // (this daemon is idle / has been replaced).
  try {
    state.clearIfPid(process.pid);
  } catch {
    // best-effort: a failed state clear must not stop us from exiting
  }
  process.exit(0); // stops the daemon (this IS the server process)
}

/**
 * Arm the in-daemon idle timer (called only by the `--preload` entry). A `timeoutMs <= 0`
 * env disables it. The timer is unref'd: the daemon's own server keeps the event loop alive,
 * and we never want the timer alone to hold the process open.
 */
export function armIdleWatchdog(): void {
  const timeoutMs = idleTimeoutMs();
  if (timeoutMs <= 0) return; // disabled
  const startedAtMs = Date.now();
  const timer = setInterval(
    () => idleCheck(startedAtMs, timeoutMs),
    defaultCheckIntervalMs(timeoutMs),
  );
  timer.unref?.();
}
