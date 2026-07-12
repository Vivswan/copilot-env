// `agent stop`: terminates the tracked local proxy daemon.
import { consola } from "consola";
import { isCopilotApiPid, pidAlive, terminatePid } from "../copilot_api/process.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

/**
 * Terminate the tracked proxy daemon if it is ours, clearing our run-state tracking and the
 * persisted activity mark. Quiet (no logging, no exit code) -- the shared core of `agent stop`
 * and the de-authenticate teardown. `graceMs > 0` waits that long and escalates to SIGKILL if
 * the daemon is still alive (use it when the caller must be sure it stopped, e.g. de-auth);
 * `0` sends a single SIGTERM without waiting. Returns the tracked pid, whether we signalled it
 * (it was confirmed ours), and whether it is confirmed stopped afterwards.
 */
export async function stopTrackedProxy(
  graceMs = 0,
): Promise<{ trackedPid?: number; signalled: boolean; stopped: boolean }> {
  const state = new CopilotEnvRunState();
  const trackedPid = state.read().pid;
  if (trackedPid === undefined) {
    // Nothing tracked. Still clear any stale activity marks so a fresh start is not seen as
    // recently active.
    state.set({ lastEnsureAt: null });
    clearPersistedInferenceActivity();
    return { signalled: false, stopped: true };
  }
  // Confirm the tracked pid is still OUR daemon before signalling it -- the OS may have
  // recycled a stale pid onto an unrelated process. On Windows there are no POSIX signals:
  // Node maps SIGTERM to an unconditional TerminateProcess (a hard kill; SQLite WAL recovery
  // makes that safe). Killing the daemon also tears down its in-daemon idle watchdog.
  const ours = await isCopilotApiPid(trackedPid);
  if (ours) {
    await terminatePid(trackedPid, graceMs);
  }
  // "stopped" = the tracked daemon is no longer alive as our process. A pid that is NOT ours
  // (already gone / replaced) counts as stopped. With graceMs 0 (no wait) a just-SIGTERMed
  // process can still be alive for a tick, so a caller needing certainty passes graceMs > 0
  // (waited + SIGKILL) before this check.
  const stopped = !ours || !pidAlive(trackedPid);
  // Preserve the pid/port tracking ONLY when we actually waited (graceMs > 0) and the daemon
  // is confirmed still alive -- a genuinely stuck daemon that a follow-up `agent stop` must be
  // able to target. Otherwise clear it (the graceMs 0 path can't confirm death, so it stays
  // optimistic, exactly as `agent stop` always has). Activity marks are cleared either way.
  const keepTracking = graceMs > 0 && !stopped;
  state.set(keepTracking ? { lastEnsureAt: null } : { pid: null, port: null, lastEnsureAt: null });
  clearPersistedInferenceActivity();
  return { trackedPid, signalled: ours, stopped };
}

/** `stop`: terminate the proxy daemon tracked on this host. */
export async function runStop(): Promise<void> {
  const { trackedPid, signalled } = await stopTrackedProxy();

  if (trackedPid === undefined) {
    // Not a crash -- just nothing to do. Friendly note, no stack trace, but a
    // non-zero exit so scripts can still tell "stopped" from "nothing running".
    consola.info("The proxy is not running on this host (nothing to stop).");
    process.exitCode = 1;
    return;
  }
  if (!signalled) {
    consola.info(`The proxy (PID ${trackedPid}) was already stopped; cleared stale tracking.`);
    process.exitCode = 1;
    return;
  }
  consola.info(`Stopped the proxy (PID ${trackedPid})`);
  consola.info(`   Bun env: ${PROJECT_ROOT}`);
}
