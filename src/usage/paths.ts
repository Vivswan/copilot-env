// Where `agent cost` keeps its on-disk state under the root copilot-api home. Both
// the usage index (index.ts) and the price-list cache (pricing.ts) live in this one
// directory; pricing.ts must not import index.ts (node:sqlite), so the name lives here.
import { join } from "node:path";
import { resolveRootHome } from "../copilot_api/paths.ts";

/** The `agent cost` state directory under the root copilot-api home. */
export const USAGE_INDEX_DIR_NAME = "usage-index";

export function usageIndexDir(): string {
  return join(resolveRootHome(), USAGE_INDEX_DIR_NAME);
}
