// `bun --preload` entry for the idle auto-stop watchdog. Loaded INTO the copilot-api daemon by
// launchDaemon (src/copilot_api/process.ts) when the managed proxy lifecycle is enabled
// (`agent init --auto-start`). This file's only job is to arm the timer on load; all logic
// lives in idle_watchdog.ts. Tests import that module, never this entry, so arming here is
// unconditional -- only the daemon's `bun --preload` ever loads it.
import { armIdleWatchdog } from "./idle_watchdog.ts";

armIdleWatchdog();
