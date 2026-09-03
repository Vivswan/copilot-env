// Logic for the idle auto-stop watchdog that runs INSIDE the copilot-api daemon. Running in
// the daemon process means the server and its watchdog are ONE unit: killing the daemon takes
// the watchdog with it, and when the watchdog trips it stops the server by exiting the process
// -- no separate pid, no orphan in either direction, and every daemon (re)start re-attaches it.
//
// Activity is the most recent of the in-process inference observer's mark (inbound inference
// POSTs -- /v1/responses, /v1/messages, etc. -- seen at the request layer; see
// inference_activity.ts) and the
// `start --record-event` heartbeat (an open agent re-runs its proxy resolver on a refresh
// interval). Liveness pings (GET /, GET /v1/models) are deliberately NOT activity -- the
// observer only marks inference POSTs -- so `agent health` probes and shell/keepalive pings
// never reset the idle timer. Idle past the timeout -> the daemon exits.
//
// This module is import-safe -- it never arms a timer on import, so unit tests can exercise the
// pure helpers. idle_watchdog_preload.ts is the tiny `--preload` entry that arms it (and is
// never imported by tests), the same split pat_passthrough_preload.ts gets from its own file.
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { DAEMON_KEEP_PORT_ENV } from "../copilot_api/paths.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { shutdownDaemon } from "./daemon_shutdown.ts";
import { lastObservedInferenceMs } from "./inference_activity.ts";

/** Env knob: idle timeout in whole seconds. `0` (or negative) disables the watchdog. */
export const IDLE_TIMEOUT_ENV = "COPILOT_API_IDLE_TIMEOUT";
/** Upper bound on the poll interval; short timeouts poll proportionally faster. */
const MAX_CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_INTERVAL_MS = 1_000;

/**
 * The effective idle timeout in milliseconds. Precedence: `COPILOT_API_IDLE_TIMEOUT` env >
 * config `idleTimeout` > the 1-hour default. `0` (or any negative value) disables the watchdog,
 * as the env knob's contract promises. A NON-numeric env value falls back to the next source
 * rather than throwing -- the watchdog runs inside the detached daemon, so a bad env var must
 * not crash it (and the proxy would then never auto-stop, the safe way).
 */
export function idleTimeoutMs(): number {
  const raw = process.env[IDLE_TIMEOUT_ENV]?.trim();
  // Accept an optional leading `-` so a negative value parses and disables (a <=0 result is
  // treated as "off" by armIdleWatchdog); only a truly non-numeric value falls through.
  if (raw !== undefined && /^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }
  return new CopilotEnvConfig().idleTimeoutSeconds() * 1000;
}

/** Default poll interval for a given timeout: a quarter of the window, clamped. */
export function defaultCheckIntervalMs(timeoutMs: number): number {
  return Math.max(
    MIN_CHECK_INTERVAL_MS,
    Math.min(MAX_CHECK_INTERVAL_MS, Math.floor(timeoutMs / 4)),
  );
}

/** Whether `now` is at least `timeoutMs` past the last activity. */
export function isIdle(lastActiveMs: number, now: number, timeoutMs: number): boolean {
  return now - lastActiveMs >= timeoutMs;
}

/**
 * THE activity rule: last activity is the most recent of the available signals --
 * the daemon-start floor, the inference mark, and the `lastEnsureAt` resolver
 * heartbeat. An absent signal (null/undefined) simply doesn't count; with none at
 * all the result is 0 ("no activity recorded"). Shared by idleCheck below and the
 * health report's watchdog check (src/health/checks.ts) -- which passes the signals
 * it can observe from OUTSIDE the daemon -- so adding or dropping a signal changes
 * the daemon and the displayed idle/remaining numbers together.
 */
export function lastActivityMs(signals: {
  startedAtMs?: number;
  inferenceMs: number | null;
  ensureAtMs: number | null;
}): number {
  return Math.max(signals.startedAtMs ?? 0, signals.inferenceMs ?? 0, signals.ensureAtMs ?? 0);
}

/**
 * One idle check, run on the interval inside the daemon. If the managed lifecycle was
 * turned off (the `auto-start` config key set to false) we disengage and leave the daemon
 * running.
 * Otherwise, when idle past the timeout, clear our run-state tracking (best-effort) and
 * stop the server through the shared shutdown path. `startedAtMs` floors activity so a
 * freshly launched, quiet daemon is not considered idle before its first
 * request/heartbeat.
 * Activity: the in-process observer's mark (same process, always current -- the persisted
 * `.activity.json` copy exists for out-of-process readers, not for us) and the run-state
 * `lastEnsureAt` resolver heartbeat.
 */
export function idleCheck(startedAtMs: number, timeoutMs: number): void {
  if (!new CopilotEnvConfig().autoStartEnabled()) return; // lifecycle disabled -> stay up
  const state = new CopilotEnvRunState();
  const snapshot = state.read();
  const lastActivity = lastActivityMs({
    startedAtMs,
    inferenceMs: lastObservedInferenceMs(),
    ensureAtMs: snapshot.lastEnsureAt ?? null,
  });
  if (!isIdle(lastActivity, Date.now(), timeoutMs)) return;
  // Clear our run-state tracking, but ONLY if it still points at THIS daemon. clearIfPid
  // does the pid check INSIDE the atomic read-modify-write, so a newer daemon that replaced
  // us between ticks can't have its freshly written pid/port clobbered. We stop either way
  // (this daemon is idle / has been replaced). Whether `port` survives is the daemon's
  // releasesPortOnStop policy, transported at spawn in DAEMON_KEEP_PORT_ENV: a named
  // profile's port is its stable reservation (the baked agent wiring points at it), the
  // default's reverts. The persisted `.activity.json` mark is left
  // alone on purpose: it can't be pid-guarded (separate file), so deleting it here could
  // clobber a successor daemon's mark -- `agent stop` (explicit teardown) removes it instead,
  // and a leftover mark is only ever a health-display detail.
  try {
    state.clearIfPid(process.pid, process.env[DAEMON_KEEP_PORT_ENV] === "1");
  } catch {
    // best-effort: a failed state clear must not stop us from shutting down
  }
  // The shared path (daemon_shutdown.ts) drains the server this process IS, then exits --
  // the same teardown a SIGTERM from `agent stop` takes.
  void shutdownDaemon(0);
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
