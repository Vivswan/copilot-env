// Runs inside the daemon, so server and watchdog are one unit.
//   the daemon is killed   -> the watchdog goes with it
//   the watchdog trips     -> it stops the server by exiting
//   GET /, GET /v1/models  -> liveness, not activity: `agent health` and shell keepalives leave the
//                             timer where it was
//   importing this module  -> arms nothing; idle_watchdog_preload.ts does
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { DAEMON_KEEP_PORT_ENV } from "../copilot_api/paths.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { shutdownDaemon } from "./daemon_shutdown.ts";
import { lastObservedInferenceMs } from "./inference_activity.ts";

/** Whole seconds; `0` or negative disables the watchdog. */
export const IDLE_TIMEOUT_ENV = "COPILOT_API_IDLE_TIMEOUT";
const MAX_CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_INTERVAL_MS = 1_000;

/** A non-numeric env value falls through to the config rather than throwing: a bad env var must
 *  never crash the detached daemon. */
export function idleTimeoutMs(): number {
  const raw = process.env[IDLE_TIMEOUT_ENV]?.trim();
  // A negative value must parse (it disables) rather than fall through to the config.
  if (raw !== undefined && /^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }
  return new CopilotEnvConfig().idleTimeoutSeconds() * 1000;
}

export function defaultCheckIntervalMs(timeoutMs: number): number {
  return Math.max(
    MIN_CHECK_INTERVAL_MS,
    Math.min(MAX_CHECK_INTERVAL_MS, Math.floor(timeoutMs / 4)),
  );
}

export function isIdle(lastActiveMs: number, now: number, timeoutMs: number): boolean {
  return now - lastActiveMs >= timeoutMs;
}

/** Shared with the health report's watchdog check (src/health/checks.ts), which passes the signals
 *  it can see from outside the daemon, so adding or dropping a signal moves the daemon and the
 *  displayed numbers together. */
export function lastActivityMs(signals: {
  startedAtMs?: number;
  inferenceMs: number | null;
  ensureAtMs: number | null;
}): number {
  return Math.max(signals.startedAtMs ?? 0, signals.inferenceMs ?? 0, signals.ensureAtMs ?? 0);
}

export function idleCheck(startedAtMs: number, timeoutMs: number): void {
  if (!new CopilotEnvConfig().autoStartEnabled()) return;
  const state = new CopilotEnvRunState();
  const snapshot = state.read();
  // The in-memory mark, not the persisted `.activity.json` copy (that one is for out-of-process
  // readers). `startedAtMs` floors it so a freshly launched, quiet daemon is not idle before its
  // first request.
  const lastActivity = lastActivityMs({
    startedAtMs,
    inferenceMs: lastObservedInferenceMs(),
    ensureAtMs: snapshot.lastEnsureAt ?? null,
  });
  if (!isIdle(lastActivity, Date.now(), timeoutMs)) return;
  // A newer daemon may have replaced us between ticks, so we stop either way but clear only what
  // is still ours.
  //   run-state pid/port     -> cleared inside clearIfPid's read-modify-write, ours only
  //   a named profile's port -> kept as its stable reservation; the default's port reverts
  //   `.activity.json`       -> left alone, it cannot be pid-guarded; `agent stop` removes it
  try {
    state.clearIfPid(process.pid, process.env[DAEMON_KEEP_PORT_ENV] === "1");
  } catch {
    // best-effort: a failed state clear must not stop us from shutting down
  }
  void shutdownDaemon(0);
}

/** unref'd: the timer alone must never hold the process open once the server is gone. */
export function armIdleWatchdog(): void {
  const timeoutMs = idleTimeoutMs();
  if (timeoutMs <= 0) return;
  const startedAtMs = Date.now();
  const timer = setInterval(
    () => idleCheck(startedAtMs, timeoutMs),
    defaultCheckIntervalMs(timeoutMs),
  );
  timer.unref?.();
}
