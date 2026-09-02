// Configure the agents' DEFAULT selections, resiliently (a failure on one only
// warns, the other still runs) and per-agent. This is the shared write half of
// `agent init` (both agents, one mode) and the settings-bundle import (per-agent
// recorded modes, either skippable) -- it needs BOTH src/codex/ and src/claude/,
// so it lives in src/agents/ like wiring.ts, not in src/commands/.
import { runClaude } from "../claude/config.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { runCodex } from "../codex/config.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { bold } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import type { AgentProviderMode, RequestedMode } from "./provider_mode.ts";
import { readAgentModesSafe } from "./wiring.ts";

// All output goes to stderr (one logger) so it interleaves deterministically with
// the per-agent probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

/** What to write per agent: a requested mode, or null to leave that agent alone. */
export interface DefaultAgentRequest {
  codex: RequestedMode | null;
  claude: RequestedMode | null;
  /** Pre-resolved default credential for BOTH writers (undefined = each writer
   *  resolves from the store itself) -- see AgentConfigArgs.ghToken. */
  ghToken?: string | null;
}

/**
 * Configure the requested agents' default selections and report BOTH resulting
 * modes (a skipped agent still reports its current wiring) plus every per-agent
 * failure -- the warn here keeps init's narration, and the returned `failures`
 * let callers with a stricter contract (the settings-bundle import) fail the
 * run instead of printing success over a broken wiring. `runCodex`/`runClaude`
 * read the provisioned GitHub token from the shared store themselves (the single
 * source of truth), so callers persist the token separately. Each agent's
 * narration is grouped under a header with blank-line spacing. `catalogDeps` is
 * runCodex's catalog test seam, threaded through untouched.
 */
export async function configureDefaultAgents(
  request: DefaultAgentRequest,
  catalogDeps?: CodexCatalogDeps,
): Promise<{
  codex: AgentProviderMode;
  claude: AgentProviderMode;
  failures: string[];
}> {
  const failures: string[] = [];
  if (request.codex !== null) {
    logger.log("");
    logger.log(bold("▸ Codex"));
    try {
      await runCodex({ mode: request.codex, ghToken: request.ghToken }, catalogDeps);
    } catch (e) {
      logger.warn(`  Could not configure Codex: ${errMessage(e)}`);
      failures.push(`Codex: ${errMessage(e)}`);
    }
  }

  if (request.claude !== null) {
    logger.log("");
    logger.log(bold("▸ Claude"));
    try {
      await runClaude({ mode: request.claude, ghToken: request.ghToken });
    } catch (e) {
      logger.warn(`  Could not configure Claude: ${errMessage(e)}`);
      failures.push(`Claude: ${errMessage(e)}`);
    }
  }

  // Read-back is also best-effort: a config-read error must not abort the caller.
  const modes = readAgentModesSafe();
  recordDefaultModeSafe(modes);
  return { ...modes, failures };
}

/**
 * Record the default slot's desired mode from the just-written wiring: one
 * managed mode when BOTH agents landed on it, null when they diverge (or could
 * not be read back -- the record is derived state the next successful configure
 * re-derives, so clearing beats keeping a value the artifacts contradict).
 * Best-effort like the read-back it derives from: a store-write failure only
 * warns, never fails an otherwise-successful wiring.
 */
function recordDefaultModeSafe(
  modes: { codex: AgentProviderMode; claude: AgentProviderMode },
): void {
  const agreed: ProfileMode | null =
    modes.codex === modes.claude && (modes.codex === "direct" || modes.codex === "proxy")
      ? modes.codex
      : null;
  try {
    new CopilotEnvState().recordDefaultMode(agreed);
  } catch (e) {
    logger.warn(`  Could not record the default wiring mode: ${errMessage(e)}`);
  }
}
