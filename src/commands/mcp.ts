// `agent mcp`: run the copilot-env MCP stdio server (the default), or --remove the
// managed Claude wiring for it. The flag bag is parsed ONCE into a two-armed action
// so contradictory states (--remove plus a serve-only flag) are rejected at the
// boundary and never reach the server or the removal path.
import { resolveClaudeHome, syncDefaultWebSearchWiring } from "../claude/config.ts";
import { removeClaudeMcpRegistration } from "../claude/mcp_registration.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { assertProfileName, type Profile } from "../copilot_api/profile.ts";
import { runMcpServer } from "../mcp/server.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

export interface McpArgs {
  remove?: boolean;
  profile?: string;
  model?: string;
}

type McpAction = { kind: "serve"; profile: Profile; model?: string } | { kind: "remove" };

function parseMcpAction(args: McpArgs): McpAction {
  if (args.remove) {
    if (args.profile !== undefined || args.model !== undefined) {
      throw new Error(
        "--remove takes no --profile/--model (it removes the machine-global Claude wiring)",
      );
    }
    return { kind: "remove" };
  }
  const profile = args.profile?.trim() ?? "";
  if (args.profile !== undefined && profile === "") {
    // A supplied-but-blank --profile (e.g. an unset shell var) must never silently
    // serve the default credential; `profile: null` is only reachable via an ABSENT flag.
    throw new Error("--profile expects a profile name; omit it for the default credential");
  }
  if (profile !== "") assertProfileName(profile);
  const model = args.model?.trim() ?? "";
  if (args.model !== undefined && model === "") {
    throw new Error("--model expects a non-empty model id");
  }
  return {
    kind: "serve",
    profile: profile === "" ? null : profile,
    model: model === "" ? undefined : model,
  };
}

export async function runMcp(args: McpArgs): Promise<void> {
  const action = parseMcpAction(args);
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
