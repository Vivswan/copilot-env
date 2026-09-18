import { syncDefaultWebSearch } from "../claude/config.ts";
import {
  inspectMcpRegistration,
  type McpRegistrationStatus,
  removeClaudeMcpRegistration,
} from "../claude/mcp_registration.ts";
import { resolveClaudeHome } from "../claude/paths.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { runMcpServer } from "../mcp/server.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { keyValueLine } from "../utils/table.ts";
import { runDryRun } from "./dry_run.ts";

const logger = createStderrLogger();

export interface McpArgs {
  serve?: boolean;
  remove?: boolean;
  profile?: string;
  model?: string;
  dryRun?: boolean;
}

type McpAction =
  | { kind: "status" }
  | { kind: "serve"; profile: Profile; model?: string }
  | { kind: "remove"; dryRun: boolean };

function parseMcpAction(args: McpArgs): McpAction {
  if (args.serve && args.remove) {
    throw new Error("--serve and --remove are mutually exclusive");
  }
  if (args.dryRun && !args.remove) {
    throw new Error("--dry-run previews --remove (status and --serve write nothing)");
  }
  if (args.remove) {
    if (args.profile !== undefined) {
      throw new Error(
        "--remove takes no profile name: it removes the machine-global Claude wiring " +
          "(`agent mcp --remove`)",
      );
    }
    if (args.model !== undefined) {
      throw new Error("--remove takes no --model (it removes the machine-global Claude wiring)");
    }
    return { kind: "remove", dryRun: Boolean(args.dryRun) };
  }
  if (!args.serve) {
    if (args.model !== undefined) {
      throw new Error("--model applies to --serve (the stdio server); bare `mcp` prints status");
    }
    return { kind: "status" };
  }
  const name: Profile = parseProfileFlag(args.profile);
  const model = args.model?.trim() ?? "";
  if (args.model !== undefined && model === "") {
    throw new Error("--model expects a non-empty model id");
  }
  return {
    kind: "serve",
    profile: name,
    model: model === "" ? undefined : model,
  };
}

const STATUS_LINES: Record<McpRegistrationStatus, string> = {
  "absent": "not registered",
  "ours-current": "registered (current)",
  "ours-stale": "registered by an older or moved copilot-env (a direct rewire upgrades it)",
  "foreign": "a 'copilot-env' entry that is not ours (left alone)",
};

function printStatus(): void {
  const { path, status } = inspectMcpRegistration();
  const line = status === "unreadable" ? `could not read ${path}` : STATUS_LINES[status];
  logger.log(keyValueLine("Claude registration", line));
  logger.log(`  (${path})`);
  // One accessor, so value and provenance come from the same config read.
  const wireMcp = new CopilotEnvConfig().wireMcpResolved();
  logger.log(keyValueLine("claude.wire-mcp", `${wireMcp.value} (${wireMcp.source})`));
  logger.log("");
  logger.log("agent mcp --serve   run the MCP stdio server (what registered clients spawn)");
  logger.log("agent mcp --remove  unregister from Claude Code and opt out (claude.wire-mcp false)");
  logger.log("rewire: `agent init --direct` or `agent init`");
}

/** `claude.wire-mcp false` is stored first so a later direct write respects it; the deny and the
 *  registration then go together, since lifting the deny alone would leave a direct-wired machine
 *  with no search path. The registration is machine-global, so it goes even when settings.json is
 *  foreign and the sync leaves that file's deny alone. Returns whether no managed entry remains. */
function landRemoval(): boolean {
  new CopilotEnvConfig().set({ "claude.wire-mcp": false });
  syncDefaultWebSearch(resolveClaudeHome());
  return removeClaudeMcpRegistration();
}

async function runRemove(dryRun: boolean): Promise<void> {
  if (dryRun) {
    await runDryRun(() => Promise.resolve(landRemoval()));
    return;
  }
  if (landRemoval()) {
    logger.log(
      "Removed the copilot-env MCP registration (and the managed WebSearch deny where " +
        "copilot-env manages settings.json); stored `claude.wire-mcp false` so direct rewires stay opted out.",
    );
  } else {
    logger.warn(
      "Stored `claude.wire-mcp false`, but the 'copilot-env' entry in Claude's .claude.json was not " +
        "removed (not ours, or the file could not be written) - remove it by hand if needed.",
    );
  }
}

export async function runMcp(args: McpArgs): Promise<void> {
  const action = parseMcpAction(args);
  if (action.kind === "status") {
    printStatus();
    return;
  }
  if (action.kind === "serve") {
    await runMcpServer({ profile: action.profile, model: action.model });
    return;
  }
  await runRemove(action.dryRun);
}
