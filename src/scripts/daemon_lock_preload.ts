// The first daemon shim launchDaemon (src/copilot_api/process.ts) loads, so the lock is taken
// before anything else touches the home. Only the daemon loads this entry; tests import
// daemon_lock.ts.
//
// The throw aborts the launch before the proxy serves; the message lands in the daemon log the
// start pipeline tails on failure.
import { resolveHome } from "../copilot_api/paths.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "./daemon_lock.ts";

const home = resolveHome();
if (!acquireDaemonLockForLife(home)) {
  throw new Error(
    `another process holds ${daemonLockPath(home)}; refusing to run two daemons in one home`,
  );
}
