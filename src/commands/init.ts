import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { ensureAuthenticated } from "./auth.ts";
import { configureBothAgents, printGuidance } from "./configure_agents.ts";
import { runDryRun } from "./dry_run.ts";

export interface InitArgs {
  mode: RequestedMode;
  /** Print what the landing would write, attribute by attribute, and write nothing. */
  dryRun?: boolean;
}

export async function runInit(args: InitArgs): Promise<void> {
  const land = async () => {
    // Every mode, proxy included: a failed login throws, so no agent is configured without a
    // credential. The auto probe below then judges THIS credential's Direct access.
    await ensureAuthenticated();
    const outcome = await configureBothAgents(args.mode);
    // configureBothAgents wrote only the default's Desktop entry; this covers the named profiles.
    await reconcileClaudeDesktopWiring();
    return outcome;
  };
  if (args.dryRun) {
    await runDryRun(land);
    return;
  }
  const { codex, claude, failedAgents } = await land();
  printGuidance(codex, claude, new CopilotEnvState().read().githubToken !== null, failedAgents);
}
