import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { ensureAuthenticated } from "./auth.ts";
import { configureBothAgents, printGuidance } from "./configure_agents.ts";

export interface InitArgs {
  mode: RequestedMode;
}

export async function runInit(args: InitArgs): Promise<void> {
  // Every mode, proxy included: a failed login throws, so no agent is configured without a
  // credential. The auto probe below then judges THIS credential's Direct access.
  await ensureAuthenticated();

  const { codex, claude, failedAgents } = await configureBothAgents(args.mode);

  // configureBothAgents wrote only the default's Desktop entry; this covers the named profiles.
  await reconcileClaudeDesktopWiring();

  printGuidance(codex, claude, new CopilotEnvState().read().githubToken !== null, failedAgents);
}
