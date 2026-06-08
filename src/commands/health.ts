// `agent health`: verifies the tracked local gateway process and port are healthy.
import { consola } from "consola";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { isCopilotApiPid } from "../copilot_api/process.ts";
import { CopilotApiState } from "../copilot_api/state.ts";

/**
 * `health`: report whether OUR gateway is up — both HTTP-reachable on the
 * tracked port AND backed by the tracked copilot-api pid (so a foreign service
 * squatting the port doesn't read as healthy). Exits non-zero otherwise, so it's
 * usable in scripts / the shell wrappers' readiness check.
 */
export async function runHealth(): Promise<void> {
  const port = copilotApiResolvePort();
  const pid = new CopilotApiState().read().pid ?? null;
  const tracked = pid !== null && (await isCopilotApiPid(pid));

  let reachable = false;
  try {
    // Any HTTP response (even an error status) means something is listening.
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
    reachable = true;
  } catch {
    reachable = false;
  }

  const pidStr = pid === null ? "untracked" : `pid ${pid}${tracked ? "" : " stale/foreign"}`;
  if (reachable && tracked) {
    consola.success(`copilot-api is up on port ${port} — ${pidStr}`);
  } else if (reachable) {
    consola.warn(`Port ${port} is in use but not by a tracked copilot-api — ${pidStr}`);
    process.exitCode = 1;
  } else {
    consola.warn(`copilot-api is NOT reachable on port ${port} — ${pidStr}`);
    process.exitCode = 1;
  }
}
