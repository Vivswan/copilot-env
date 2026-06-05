import { consola } from "consola";
import { isCopilotApiPid } from "../copilot_api/process.ts";
import { CopilotApiState } from "../copilot_api/state.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

/** `stop`: terminate the copilot-api daemon tracked on this host. */
export async function runStop(): Promise<void> {
  const state = new CopilotApiState();
  const pid = state.read().pid;

  if (pid === undefined) {
    throw new Error("No tracked copilot-api on this host (run 'agent start' first).");
  }

  // Confirm the tracked pid is still OUR daemon before signalling it — the OS
  // may have recycled a stale pid onto an unrelated process.
  if (!(await isCopilotApiPid(pid))) {
    state.set({ pid: null, port: null });
    throw new Error(
      `Tracked pid ${pid} is not a running copilot-api (stopped or reused); cleared.`,
    );
  }

  // On Windows there are no POSIX signals: Node maps SIGTERM (and SIGKILL) to
  // an unconditional TerminateProcess, so this is a hard kill with no graceful
  // SQLite flush. SQLite's WAL recovery makes that safe; just don't expect
  // clean teardown here on Windows.
  process.kill(pid, "SIGTERM");
  state.set({ pid: null, port: null });
  consola.info(`Stopped copilot-api (PID ${pid})`);
  consola.info(`   Bun env: ${PROJECT_ROOT}`);
}
