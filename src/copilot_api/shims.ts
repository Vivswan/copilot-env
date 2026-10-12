// Lives apart from process.ts because the spawn picks a SUBSET per credential/config while the proxy
// float installs the dependencies of EVERY shim into the proxy home (the daemon runs with auto-install
// off, so a missing one is a launch failure), and process.ts already imports the float.
import { join } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

export const DAEMON_SHIM_FILES = [
  "daemon_lock_preload.ts",
  "token_argv_preload.ts",
  "daemon_runtime_preload.ts",
  "copilot_host_preload.ts",
  "client_headers_preload.ts",
  "pat_passthrough_preload.ts",
  "idle_watchdog_preload.ts",
  "log_mute_preload.ts",
] as const;

export type DaemonShimFile = (typeof DAEMON_SHIM_FILES)[number];

/** The npm packages the shims' import closure reaches (the loggers, the table renderers, the
 *  config schemas). A compiled install has no node_modules beside the shims, so the float
 *  installs these into the proxy home at this build's ranges and the daemon resolves them from
 *  there through NODE_PATH. test/install/installer_pinning.e2e.test.ts pins the list to the closure. */
export const DAEMON_SHIM_DEPENDENCIES = [
  "consola",
  "json-stable-stringify",
  "string-width",
  "valibot",
  "wrap-ansi",
] as const;

export function shimPath(name: DaemonShimFile): string {
  return join(PROJECT_ROOT, "src", "scripts", name);
}
