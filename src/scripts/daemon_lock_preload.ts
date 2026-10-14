// The first daemon shim launchDaemon (src/copilot_api/process.ts) loads, so the lock is taken
// before anything else touches the home, and its OS lock (src/utils/os_lock.ts, bun:ffi over the
// system libc or kernel32) is held by this process until it dies. Only the daemon loads this
// entry; tests import daemon_lock.ts.
//
// The throw aborts the launch before the proxy serves; the message lands in the daemon log the
// start pipeline tails on failure.

import { acquireDaemonLockForLife, daemonLockPath } from "../copilot_api/daemon_lock.ts";
import { resolveHome } from "../copilot_api/paths.ts";

const home = resolveHome();
if (!acquireDaemonLockForLife(home)) {
  throw new Error(
    `another process holds ${daemonLockPath(home)}; refusing to run two daemons in one home`,
  );
}
