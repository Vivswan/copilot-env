// `agent mcp`: the human-facing status/management command for the copilot-env MCP
// server. Bare = print the registration/config status; `--serve` = run the stdio
// server (the argv MCP clients register); `--remove` = durably opt out. The flag
// bag is parsed ONCE into a three-armed action so contradictory states (--remove
// plus a serve-only flag, --profile without --serve) are rejected at the boundary
// and never reach the server or the removal path.

import { syncDefaultWebSearchWiring } from "../claude/config.ts";
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

const logger = createStderrLogger();

export interface McpArgs {
  serve?: boolean;
  remove?: boolean;
  profile?: string;
  model?: string;
}

type McpAction =
  | { kind: "status" }
  | { kind: "serve"; profile: Profile; model?: string }
  | { kind: "remove" };

function parseMcpAction(args: McpArgs): McpAction {
  if (args.serve && args.remove) {
    throw new Error("--serve and --remove are mutually exclusive");
  }
  if (args.remove) {
    if (args.profile !== undefined || args.model !== undefined) {
      throw new Error(
        "--remove takes no --profile/--model (it removes the machine-global Claude wiring)",
      );
    }
    return { kind: "remove" };
  }
  if (!args.serve) {
    if (args.profile !== undefined || args.model !== undefined) {
      throw new Error(
        "--profile/--model apply to --serve (the stdio server); bare `agent mcp` prints status",
      );
    }
    return { kind: "status" };
  }
  const profile = args.profile?.trim();
  if (profile === "") {
    // A supplied-but-blank --profile (e.g. an unset shell var) must never silently
    // serve the default credential; `profile: null` is only reachable via an ABSENT flag.
    throw new Error("--profile expects a profile name; omit it for the default credential");
  }
  const name: Profile = parseProfileFlag(profile);
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
  logger.log(`Claude registration: ${line}`);
  logger.log(`  (${path})`);
  // Value and provenance come from ONE config snapshot (the accessor reads once).
  const wireMcp = new CopilotEnvConfig().wireMcpResolved();
  logger.log(`wire-mcp: ${wireMcp.value} (${wireMcp.source})`);
  logger.log("");
  logger.log("agent mcp --serve   run the MCP stdio server (what registered clients spawn)");
  logger.log("agent mcp --remove  unregister from Claude Code and opt out (wire-mcp false)");
  logger.log("rewire: `agent claude --direct` or `agent init`");
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
  // --remove: a DURABLE opt-out. Store `wire-mcp false` first so a later direct
  // write respects it, then take back the pair (registration + our deny) in one
  // go -- lifting the deny alone would leave a direct-wired machine with no
  // search path at all. The registration is machine-global, so it is removed
  // even when settings.json is foreign (the sync only manages OUR settings and
  // leaves a foreign file's deny alone). Re-enable: `agent config --set wire-mcp
  // true`, then any direct write (`agent claude` / `agent init`).
  new CopilotEnvConfig().set({ wireMcp: false });
  syncDefaultWebSearchWiring(resolveClaudeHome());
  const unregistered = removeClaudeMcpRegistration();
  if (unregistered) {
    logger.log(
      "Removed the copilot-env MCP registration (and the managed WebSearch deny where " +
        "copilot-env manages settings.json); stored `wire-mcp false` so direct rewires stay opted out.",
    );
  } else {
    logger.warn(
      "Stored `wire-mcp false`, but the 'copilot-env' entry in Claude's .claude.json was not " +
        "removed (not ours, or the file could not be written) - remove it by hand if needed.",
    );
  }
}
