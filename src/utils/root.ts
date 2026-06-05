import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this module's own directory to the nearest ancestor holding a
 * package.json — the project root, where node_modules lives. Robust to however
 * deep this file is nested (no fixed dirname() hop count), so moving it doesn't
 * break resolution. Bounded so a missing marker can't loop; used only as the
 * COPILOT_ENV_ROOT fallback.
 */
function findProjectRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return start;
}

const PROJECT_ROOT = findProjectRoot();

/**
 * The directory copilot-env's node_modules lives in — and the dir cli.ts is run
 * from. The bin shims export COPILOT_ENV_ROOT (the path user_cache.ts printed):
 * the checkout itself for an in-place run, or the per-user cache for a
 * --local-cache run. Falls back to the project root (nearest package.json) for a
 * direct `bun src/cli.ts`. Anchors module resolution (createRequire) and labels
 * the runtime location in start/stop output.
 */
export function moduleRoot(): string {
  return process.env.COPILOT_ENV_ROOT?.trim() || PROJECT_ROOT;
}
