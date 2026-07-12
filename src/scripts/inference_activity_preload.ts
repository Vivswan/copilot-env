// `bun --preload` entry for the inference-activity observer. Loaded INTO the copilot-api
// daemon by launchDaemon (src/copilot_api/process.ts) on every start. This file's only job
// is to install the `Bun.serve` wrap on load; all logic lives in inference_activity.ts.
// Tests import that module, never this entry, so installing here is unconditional -- only
// the daemon's `bun --preload` ever loads it.
import { installInferenceObserver } from "./inference_activity.ts";

installInferenceObserver();
