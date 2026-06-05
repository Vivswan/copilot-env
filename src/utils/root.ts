import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this module's own directory to the nearest ancestor holding a
 * package.json — the project root, where node_modules lives. Robust to however
 * deep this file is nested (no fixed dirname() hop count), so moving it doesn't
 * break resolution. Bounded so a missing marker can't loop.
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

export const PROJECT_ROOT = findProjectRoot();
