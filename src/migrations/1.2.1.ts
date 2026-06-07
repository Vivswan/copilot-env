import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";

import { runShellIntegration } from "../commands/shell_integration.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import type { Migration } from "./index.ts";

// Leaving 1.2.1 behind: the next release relocated the shell-integration files
// (agents.bashrc / agents.ps1) into a shell/ subfolder AND split the cl/co/cx launchers
// into the opt-in agents.launchers.* file. A checkout updated from 1.2.1 or earlier can
// carry two leftovers:
//   1. root-level agents.bashrc / agents.ps1 the release no longer ships -- `agent
//      update`'s mirror prunes them, but a tarball re-install does not, and
//   2. rc / $PROFILE blocks that still `source` those old root paths.
// Remove the stale root files and refresh the owned block(s) in place to the new shell/
// path. `launchers: true` re-wires the launchers block too, so a user who had cl/co/cx
// (always defined before the split) keeps them -- the split is opt-in only for NEW
// installs. `existingOnly` so we never newly-wire a user who opted out of integration.
export const migration: Migration = {
  version: "1.2.1",
  description: "relocate shell integration into shell/, re-point rc blocks, keep cl/co/cx",
  run: () => {
    for (const stale of ["agents.bashrc", "agents.ps1"]) {
      const p = join(PROJECT_ROOT, stale);
      if (existsSync(p)) {
        rmSync(p, { force: true });
        consola.info(`Removed stale root ${stale}`);
      }
    }
    runShellIntegration({ existingOnly: true, launchers: true });
  },
};
