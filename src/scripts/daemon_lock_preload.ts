// `--preload` entry for the daemon liveness lock. Loaded INTO the copilot-api daemon by
// launchDaemon (src/copilot_api/process.ts) on EVERY daemon start, first among the
// daemon shims: the per-home lock is taken before anything else touches the home, and it
// is held until the process dies (see daemon_lock.ts). All logic lives there; tests
// import that module, never this entry, so acquiring here is unconditional -- only the
// daemon's `--preload` ever loads it.
//
// A failed acquisition after the bounded retries means a LIVE process already holds this
// home's lock: two daemons over one home would contend on its sqlite/config.json, so the
// throw below aborts the launch before the proxy serves (the error lands in the daemon
// log, which the start pipeline tails on failure).
import { resolveHome } from "../copilot_api/paths.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "./daemon_lock.ts";

const home = resolveHome();
if (!acquireDaemonLockForLife(home)) {
  throw new Error(
    `another process holds ${daemonLockPath(home)}; refusing to run two daemons in one home`,
  );
}
