// The configuration page's tables are hand-written, so a new registry key needs its row
// added by hand; this is where a missing one fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_REGISTRY } from "../src/copilot_api/env_config.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

test("every CONFIG_REGISTRY key has a docs/configuration.md table row", () => {
  const page = readFileSync(join(PROJECT_ROOT, "docs", "configuration.md"), "utf8");
  // Only a row's FIRST cell counts (a key echoed in another row's description
  // cell must not satisfy coverage); a combined first cell (`min-port` /
  // `max-port`) counts for both keys.
  const keyCells = page
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|")[1] ?? "")
    .join("\n");
  for (const def of CONFIG_REGISTRY) {
    expect(keyCells).toContain(`\`${def.cli}\``);
  }
});
