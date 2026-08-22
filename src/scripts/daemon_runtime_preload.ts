// `--preload` entry for the daemon-side runtime: the inference-activity observer and the
// shared shutdown path. Loaded INTO the copilot-api daemon by launchDaemon
// (src/copilot_api/process.ts) on EVERY start, because both halves are unconditional --
// the observer's Deno.serve wrap is also what captures the server handle SIGTERM and the
// idle watchdog drain. All logic lives in inference_activity.ts and daemon_shutdown.ts;
// tests import those modules, never this entry, so installing here is unconditional.
import { installTerminationHandler } from "./daemon_shutdown.ts";
import { installInferenceObserver } from "./inference_activity.ts";

installInferenceObserver();
installTerminationHandler();
