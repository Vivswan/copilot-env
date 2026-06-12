// Migration from 3.2.0: rename the managed Claude proxy token helper.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";

import { PROXY_HELPER_NAME, resolveClaudeHome } from "../claude/config.ts";
import type { Migration } from "./index.ts";

// Leaving 3.2.0 behind: the "gateway" -> "proxy" terminology rename also renamed the
// managed Claude proxy-token helper script from copilot-gateway-token.sh to
// copilot-proxy-token.sh. Claude's settings.json points `apiKeyHelper` at the EXACT
// path, and inspectClaudeWiring infers "proxy" mode off that exact path -- so a proxy-
// wired Claude updated from 3.2.0 would otherwise read as "other" (unmanaged) until a
// re-init. Move the on-disk script to the new name and re-point apiKeyHelper. Only the
// default Claude home is reachable here (matching the rest of the migration system);
// a Claude home set via CLAUDE_CONFIG_DIR is re-fixed by the next `agent claude` run.
const OLD_PROXY_HELPER_NAME = "copilot-gateway-token.sh";

export const migration: Migration = {
  version: "3.2.0",
  description:
    "rename the Claude proxy token helper (copilot-gateway-token.sh → copilot-proxy-token.sh)",
  run: () => {
    const home = resolveClaudeHome();
    const oldPath = join(home, OLD_PROXY_HELPER_NAME);
    const newPath = join(home, PROXY_HELPER_NAME);

    // Move the helper script if the old name is still on disk (idempotent: skip when
    // already migrated, and never clobber a new helper that already exists).
    if (existsSync(oldPath) && !existsSync(newPath)) {
      renameSync(oldPath, newPath);
      consola.info(`Renamed ${OLD_PROXY_HELPER_NAME} → ${PROXY_HELPER_NAME}`);
    }

    // Re-point settings.json apiKeyHelper from the old path to the new one.
    const settingsPath = join(home, "settings.json");
    if (!existsSync(settingsPath)) return;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return; // malformed settings.json -- leave it untouched
    }
    if (doc.apiKeyHelper === oldPath) {
      doc.apiKeyHelper = newPath;
      writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
      consola.info("Re-pointed Claude apiKeyHelper to the renamed helper");
    }
  },
};
