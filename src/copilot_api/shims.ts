// The daemon's `--preload` shims: real files on disk that `deno run` loads into the
// proxy process.
//
// The set lives here rather than in process.ts because two callers need it and they
// need different slices: the spawn picks a SUBSET per credential/config, while the
// proxy float must pre-warm EVERY one into its cache (any of them may be loaded by a
// later start, and `--cached-only` gives no second chance). process.ts already imports
// the float, so the float cannot import back from it.
import { join } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

/** Every shim the daemon can load, by filename under `src/scripts/`. */
export const DAEMON_SHIM_FILES = [
  "token_argv_preload.ts",
  "daemon_runtime_preload.ts",
  "pat_passthrough_preload.ts",
  "idle_watchdog_preload.ts",
  "log_mute_preload.ts",
] as const;

export type DaemonShimFile = (typeof DAEMON_SHIM_FILES)[number];

/** Absolute path of one shim. */
export function shimPath(name: DaemonShimFile): string {
  return join(PROJECT_ROOT, "src", "scripts", name);
}

/** Absolute paths of every shim -- the float's cache-warm entrypoint list. */
export function allShimPaths(): string[] {
  return DAEMON_SHIM_FILES.map(shimPath);
}
