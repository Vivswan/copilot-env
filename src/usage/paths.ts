// pricing.ts must not import index.ts (it loads node:sqlite), so the shared directory name lives
// here.
import { join } from "node:path";
import { resolveRootHome } from "../copilot_api/paths.ts";

/** Holds the price-list cache as well as the index, despite the name. */
export const USAGE_INDEX_DIR_NAME = "usage-index";

export function usageIndexDir(): string {
  return join(resolveRootHome(), USAGE_INDEX_DIR_NAME);
}
