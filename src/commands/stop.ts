// `agent stop`: terminates the tracked local proxy daemon.
import { consola } from "consola";
import { classifyDaemonPid, pidAlive, terminatePid } from "../copilot_api/process.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

/**
 * Terminate the tracked proxy daemon if it is ours, clearing our run-state tracking and the
 * persisted activity mark. Quiet (no logging, no exit code) -- the shared core of `agent stop`
 * and the de-authenticate teardown. `graceMs > 0` waits that long and escalates to SIGKILL if
 * the daemon is still alive (use it when the caller must be sure it stopped, e.g. de-auth);
 * `0` sends a single SIGTERM without waiting. Returns the tracked pid, whether we signalled it,
 * and whether it is confirmed stopped afterwards.
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
  // Classify the tracked pid before signalling it -- the OS may have recycled a stale pid onto
  // an unrelated process. Signal on "yes" (confirmed ours) AND "unknown" (a restricted/sandboxed
  // token that can't read the pid's identity, e.g. Windows Constrained Language Mode): the
  // tracked pid is almost certainly still our daemon, and treating "unknown" as "already gone"
  // would leave a live daemon running while reporting it stopped. Only a confident "no" skips the
  // signal. On Windows there are no POSIX signals: SIGTERM maps to TerminateProcess (a hard kill;
  // SQLite WAL recovery makes that safe). Killing the daemon also tears down its idle watchdog.
  const cls = await classifyDaemonPid(trackedPid);
  const signalled = cls === "yes" || cls === "unknown";
  if (signalled) {
    await terminatePid(trackedPid, graceMs);
  }
  // "stopped" = the tracked daemon is no longer alive as our process. A confident "no" (already
  // gone / replaced) counts as stopped. With graceMs 0 (no wait) a just-SIGTERMed process can
  // still be alive for a tick, so a caller needing certainty passes graceMs > 0 (waited + SIGKILL)
  // before this check.
  const stopped = !signalled || !pidAlive(trackedPid);
  // Preserve the pid/port tracking ONLY when we actually waited (graceMs > 0) and the daemon is
  // confirmed still alive -- a genuinely stuck daemon a follow-up `agent stop` must be able to
  // target. Otherwise clear it (the graceMs 0 path can't confirm death, so it stays optimistic,
  // exactly as `agent stop` always has). Activity marks are cleared either way.
  const keepTracking = graceMs > 0 && !stopped;
  state.set(keepTracking ? { lastEnsureAt: null } : { pid: null, port: null, lastEnsureAt: null });
  clearPersistedInferenceActivity();
  return { trackedPid, signalled, stopped };
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
