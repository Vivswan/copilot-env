// Lives apart from process.ts because the spawn picks a SUBSET per credential/config while the proxy
// float must pre-warm EVERY shim into its cache (`--cached-only` gives no second chance), and
// process.ts already imports the float.
import { join } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

/** Loaded by EVERY proxy spawn, daemon or foreground: it restores node's `fs.existsSync` contract,
 *  without which the proxy dies at module load on Linux. */
export const NODE_COMPAT_SHIM = "node_compat_preload.ts";

/** Filenames under `src/scripts/`. */
export const DAEMON_SHIM_FILES = [
  "node_compat_preload.ts",
  "daemon_lock_preload.ts",
  "token_argv_preload.ts",
  "daemon_runtime_preload.ts",
  "pat_passthrough_preload.ts",
  "idle_watchdog_preload.ts",
  "log_mute_preload.ts",
] as const;

export type DaemonShimFile = (typeof DAEMON_SHIM_FILES)[number];

export function shimPath(name: DaemonShimFile): string {
  return join(PROJECT_ROOT, "src", "scripts", name);
}

/** The float's cache-warm entrypoint list. */
export function allShimPaths(): string[] {
  return DAEMON_SHIM_FILES.map(shimPath);
}
