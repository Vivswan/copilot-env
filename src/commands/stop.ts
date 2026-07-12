// `agent stop`: terminates the tracked local proxy daemon.
import { consola } from "consola";
import { isCopilotApiPid, terminatePid } from "../copilot_api/process.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

/** `stop`: terminate the proxy daemon tracked on this host. */
export async function runStop(): Promise<void> {
  const state = new CopilotEnvRunState();
  const pid = state.read().pid;

  if (pid === undefined) {
    // Not a crash -- just nothing to do. Friendly note, no stack trace, but a
    // non-zero exit so scripts can still tell "stopped" from "nothing running".
    // Still clear any stale activity marks so a fresh start is not seen as recently active.
    state.set({ lastEnsureAt: null });
    clearPersistedInferenceActivity();
    consola.info("The proxy is not running on this host (nothing to stop).");
    process.exitCode = 1;
    return;
  }

  // Confirm the tracked pid is still OUR daemon before signalling it -- the OS
  // may have recycled a stale pid onto an unrelated process.
  if (!(await isCopilotApiPid(pid))) {
    state.set({ pid: null, port: null, lastEnsureAt: null });
    clearPersistedInferenceActivity();
    consola.info(`The proxy (PID ${pid}) was already stopped; cleared stale tracking.`);
    process.exitCode = 1;
    return;
  }

  // On Windows there are no POSIX signals: Node maps SIGTERM to an unconditional
  // TerminateProcess, so this is a hard kill with no graceful SQLite flush.
  // SQLite's WAL recovery makes that safe; just don't expect clean teardown here on
  // Windows. graceMs:0 -- a single SIGTERM, no force-kill escalation.
  // Killing the daemon also tears down its in-daemon idle watchdog (same process).
  await terminatePid(pid, 0);
  state.set({ pid: null, port: null, lastEnsureAt: null });
  clearPersistedInferenceActivity();
  consola.info(`Stopped the proxy (PID ${pid})`);
  consola.info(`   Bun env: ${PROJECT_ROOT}`);
}
