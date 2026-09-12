// Loaded into the daemon by launchDaemon (src/copilot_api/process.ts) on every start: the
// observer's Deno.serve wrap is also what captures the server handle for SIGTERM and the
// idle-watchdog drain. test/inference_activity.test.ts preloads this entry the same way.
import { installTerminationHandler } from "./daemon_shutdown.ts";
import { installInferenceObserver } from "./inference_activity.ts";

installInferenceObserver();
installTerminationHandler();
