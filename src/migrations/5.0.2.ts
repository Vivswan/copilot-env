// Away from 5.0.2, two fix-ups.
//
// `proxy.small-model` landed in each daemon's config.json under `smallModel`, a key the floating
// proxy stopped reading when it keyed its small model per provider (`smallModels.copilot`, the
// registry's path now). The proxy keeps every key it does not know, so the old one would ride in
// the file forever; it goes here, once, named as it goes.
//
// A Claude Desktop entry named a generated wrapper script under `<rootHome>/helpers/` as its
// credential helper, because the app took a bare path and no arguments. The app takes the
// arguments now (`inferenceCredentialHelperArgs`), so an entry names the `agent` launcher itself
// and the scripts are debris: the entries are re-rendered first, then the directory goes. A pass
// can leave an entry on its script (the key off keeps the default's entry as the user's; a
// malformed library or a Direct slot without its pair blocks the write), so the step names every
// owned entry it leaves pointing at a removed script, with the repair.

import { isAbsolute, join, relative } from "node:path";
import { consola } from "consola";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import { readFileOrNull } from "../claude/desktop_library.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig, configSetCommand } from "../copilot_api/env_config.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { allDaemonHomes, PROXY_CONFIG_FILENAME, resolveRootHome } from "../copilot_api/paths.ts";
import * as fs from "../utils/fs_facade.ts";
import { parseJsonRecord } from "../utils/json.ts";
import { caught, scannable } from "../utils/message.ts";
import type { Migration } from "./index.ts";

/** The retired top-level key, the proxy's own spelling. */
const RETIRED_SMALL_MODEL_KEY = "smallModel";

/** Where the wrapper scripts lived under the root home; nothing writes there now. */
const RETIRED_HELPERS_DIR_NAME = "helpers";

/** Exported for the migration test; `homes` isolates. A config.json that cannot be read or
 *  parsed is named and left: the next `agent start` refuses it with the same reason. */
export function removeRetiredSmallModelKey(homes: readonly string[]): void {
  for (const home of homes) {
    const config = new CopilotApiConfig(join(home, PROXY_CONFIG_FILENAME));
    if (!(RETIRED_SMALL_MODEL_KEY in config.load())) continue;

    try {
      config.update((d) => {
        delete d[RETIRED_SMALL_MODEL_KEY];
      });
    } catch (e) {
      consola.warn(
        caught(e, (message) => `  could not update ${config.path} (${message}); left as it is`),
      );
      continue;
    }
    consola.info(
      `  removed ${RETIRED_SMALL_MODEL_KEY} from ${config.path} (the proxy reads smallModels.copilot now)`,
    );
  }
}

export const v502SmallModelKey: Migration = {
  version: "5.0.2",
  description: "drop the retired smallModel key from every daemon's config.json",
  run: () => removeRetiredSmallModelKey(allDaemonHomes()),
};

/** Whether `path` sits under `dir`, as the platform compares paths (case-blind on Windows). */
function isUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..");
}

/** Every owned Desktop entry whose credential helper sits under `dir`: read from the ledger's
 *  claims, not the library index, so a malformed `_meta.json` hides none. An unreadable ledger or
 *  entry throws (the runner warns and the step is re-run), never reads as "none". */
function entriesNamingScriptsUnder(dir: string): string[] {
  const naming: string[] = [];
  for (const path of new OwnershipLedger().ownedPaths("claudeDesktop")) {
    const doc = parseJsonRecord(readFileOrNull(path) ?? "");
    const helper = doc?.inferenceCredentialHelper;
    if (typeof helper === "string" && isUnder(dir, helper)) naming.push(path);
  }
  return naming;
}

/** The repair for an entry the pass left on its script: with the key off, nothing manages the
 *  entry until it is turned on; with the key on, the status check names each entry's own. */
function repairActions(): [string, string][] {
  if (!new CopilotEnvConfig().claudeDesktopEnabled()) {
    return [
      [configSetCommand("claude.desktop", "true"), "manages the entries again"],
      ["agent profile sync --claude", "re-renders the default's entry to the launcher"],
    ];
  }
  return [["agent profile check --claude", "names each entry's repair"]];
}

/** Exported for the migration test; `rootHome` and `reconcile` isolate. The wiring pass comes
 *  first, so no entry it re-renders names a script this step removes. */
export async function removeDesktopHelperScripts(
  rootHome: string = resolveRootHome(),
  reconcile: () => Promise<void> = () => reconcileClaudeDesktopWiring(),
): Promise<void> {
  const dir = join(rootHome, RETIRED_HELPERS_DIR_NAME);
  if (fs.entryAbsent(dir)) return;

  await reconcile();
  const left = entriesNamingScriptsUnder(dir);
  fs.rm(dir, { recursive: true, force: true, detail: "the retired Claude Desktop helper scripts" });
  consola.info(
    `  removed ${dir} (a Claude Desktop entry names the agent launcher and its arguments now)`,
  );
  if (left.length === 0) return;

  consola.warn(
    scannable({
      headline: `${left.length} Claude Desktop ${left.length === 1 ? "entry still names" : "entries still name"} a removed script.`,
      evidence: left,
      lead: "Fix:",
      actions: repairActions(),
    }),
  );
}

export const v502DesktopHelperScripts: Migration = {
  version: "5.0.2",
  description: "remove the Claude Desktop helper scripts; the entries name the launcher itself",
  run: () => removeDesktopHelperScripts(),
};
