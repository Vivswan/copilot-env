// Loaded into the daemon by launchDaemon (src/copilot_api/process.ts) only when the `daemon.auto-start`
// key is on. Only the daemon loads this entry; tests import idle_watchdog.ts.
import { armIdleWatchdog } from "../copilot_api/idle_watchdog.ts";

armIdleWatchdog();
