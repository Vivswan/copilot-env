// Loaded into the daemon by launchDaemon (src/copilot_api/process.ts) only when the `auto-start`
// key is on. Only the daemon loads this entry; tests import idle_watchdog.ts.
import { armIdleWatchdog } from "./idle_watchdog.ts";

armIdleWatchdog();
