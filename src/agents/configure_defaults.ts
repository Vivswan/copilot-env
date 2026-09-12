// The default-selection write half shared by `agent init` and the settings-bundle import. It
// needs BOTH src/codex/ and src/claude/, so it lives in src/agents/, not src/commands/.
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { bold } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { runAgentConfig } from "./configure.ts";
import { bothAgents } from "./profile_wiring.ts";
import type { AgentProviderMode, RequestedMode } from "./provider_mode.ts";
import { type AgentWiringOptions, readAgentModesSafe } from "./wiring.ts";

// All output goes to stderr (one logger) so it interleaves deterministically with
// the per-agent probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

/** null leaves that agent alone. Indexed by `adapter.id`, so a new agent in bothAgents() is a
 *  compile error here until the request names it. */
export interface DefaultAgentRequest {
  codex: RequestedMode | null;
  claude: RequestedMode | null;
  /** Pre-resolved default credential for BOTH writers (undefined = each writer
   *  resolves from the store itself) -- see AgentRunOptions.ghToken. */
  ghToken?: string | null;
}

/**
 * Warns per agent and keeps going; the returned `failures` let a caller with a stricter contract
 * (the settings-bundle import) fail the run instead of printing success over a broken wiring.
 * The read-back covers both agents, so an agent left alone still reports its current mode.
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
  for (const adapter of bothAgents(catalogDeps)) {
    const mode = request[adapter.id];
    if (mode === null) continue;
    logger.log("");
    logger.log(bold(`▸ ${adapter.label}`));
    try {
      await runAgentConfig(adapter, { kind: "configure", mode }, { ghToken: request.ghToken });
    } catch (e) {
      logger.warn(`  Could not configure ${adapter.label}: ${errMessage(e)}`);
      failures.push(`${adapter.label}: ${errMessage(e)}`);
    }
  }

  // Read-back is also best-effort: a config-read error must not abort the caller.
  const modes = readAgentModesSafe();
  recordDefaultModeSafe(modes);
  return { ...modes, failures };
}

/** Exported for the single-agent rewires (`agent codex` / `agent claude`) so there is ONE
 *  recording path. `opts` is the wiring read's test seam. */
export function recordDefaultModeFromWiring(opts: AgentWiringOptions = {}): void {
  recordDefaultModeSafe(readAgentModesSafe(opts));
}

/** null when the agents diverge or could not be read back: the record is derived state the
 *  next successful configure re-derives, so clearing beats keeping a value the artifacts
 *  contradict. A store-write failure only warns, never fails a successful wiring. */
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
