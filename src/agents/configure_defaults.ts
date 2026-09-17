// The default profile's writers. The default is a profile: one credential, ONE mode, always both
// agents, and its record (`mode` in the default slot) plus its Direct pair have one writer here,
// commitDefaultWiring, which runs after BOTH agents' writes succeeded. It needs BOTH src/codex/ and
// src/claude/ (the adapters) and the re-render funnel (src/agents/profile_wiring.ts), so it lives in
// src/agents/, not src/commands/.
//
//   `agent init`, an import naming both agents
//       -> configureDefaultAgents: the landing. Both writes, then the record and pair land together;
//          a failed write leaves the previous record, and the guidance names the agent that did not
//          move and the repair.
//   `agent codex`, `agent claude`, an import naming one agent, the launchers' proxy wire
//       -> runAgentConfig. On a recorded mode: a re-render of it that never moves the record or the
//          pair; a flag naming another mode is refused before any file is written. On NO record, or
//          a Direct record whose slot holds no pair: the landing, so it wires both agents through
//          configureDefaultAgents and says so.
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { codexAdapter } from "../codex/config.ts";
import { claudeAdapter } from "../claude/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { directOverlay, storeProbedPair } from "../copilot_api/direct_pair.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { bold } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  type AgentAdapter,
  type AgentRunAction,
  type AgentRunOptions,
  decideDefaultMode,
  type ManagedAgentId,
  type ManagedMode,
  resolveDefaultMode,
  writeDefaultAgent,
} from "./configure.ts";
import { bothAgents, directPairIncomplete, renderDirectWiring } from "./profile_wiring.ts";
import type { AgentProviderMode, ManagedAgentMode, RequestedMode } from "./provider_mode.ts";

// All output goes to stderr (one logger) so it interleaves deterministically with
// the per-agent probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

function initCommand(mode: RequestedMode): string {
  return mode === "auto" ? "agent init" : `agent init --${mode}`;
}

/**
 * ONE agent's re-render of the recorded default mode (`agent codex`, `agent claude`, the launchers'
 * proxy re-sync). No flag renders the recorded mode; a flag must name it. It never writes the
 * record or the pair: a Direct re-render bakes the slot's stored pair under the pin and literal in
 * force (renderDirectWiring, zero requests). Two states leave one agent nothing to re-render, and
 * one agent's write can set neither the mode both share nor the pair both bake: NO record, and a
 * Direct record whose slot holds no pair (a credential landed since the last wiring). Both land
 * BOTH agents through configureDefaultAgents, as `agent init` spelled with the mode would
 * (profiles are atomic units, the default included), and say so. `adapters` is that landing's pair
 * (the test seam).
 */
export async function runAgentConfig(
  adapter: AgentAdapter,
  action: AgentRunAction,
  opts: AgentRunOptions = {},
  adapters: readonly AgentAdapter[] = bothAgents(),
): Promise<ManagedAgentMode | null> {
  if (action.kind === "check") {
    adapter.check();
    return null;
  }
  const recorded = new CopilotEnvState().readProfileSlot(null).mode;
  const landBoth = async (mode: RequestedMode, why: string): Promise<ManagedAgentMode | null> => {
    logger.log(`  ${why}: wiring both, as \`${initCommand(mode)}\` would.`);
    const outcome = await configureDefaultAgents(
      { codex: mode, claude: mode, ghToken: opts.ghToken },
      adapters,
    );
    if (outcome.failures.length > 0) {
      throw new Error(`could not wire the default profile:\n  ${outcome.failures.join("\n  ")}`);
    }
    const landed = outcome[adapter.id];
    return landed === "direct" || landed === "proxy" ? landed : null;
  };
  if (recorded === null) {
    return await landBoth(
      action.mode,
      "The default profile has no recorded mode yet, and one agent's write cannot set the mode " +
        "both agents share",
    );
  }
  if (action.mode !== "auto" && action.mode !== recorded) {
    throw new Error(
      `the default profile records ${recorded} as the one mode for both agents; \`agent ${adapter.id} ` +
        `--${action.mode}\` would leave the two apart. Move both with \`agent init --${action.mode}\`.`,
    );
  }
  if (recorded === "direct") {
    if (directPairIncomplete(null)) {
      return await landBoth(
        "direct",
        "The default profile's Direct pair is not stored (a credential landed since the last " +
          "wiring), and the pair is committed together with both agents' files",
      );
    }
    // The stored pair is complete, so the render cannot come back null; the overlays render over it.
    const rendered = renderDirectWiring(null);
    if (rendered === null) throw new Error("the default's stored Direct pair did not render");
    const ghToken = opts.ghToken !== undefined ? opts.ghToken : new Credential().resolve();
    await writeDefaultAgent(adapter, { mode: "direct", direct: rendered }, ghToken);
    return recorded;
  }
  const ghToken = opts.ghToken !== undefined ? opts.ghToken : new Credential().resolve();
  await writeDefaultAgent(adapter, { mode: "proxy" }, ghToken);
  return recorded;
}

/** `agent claude`: runAgentConfig over claudeAdapter. */
export async function runClaude(action: AgentRunAction): Promise<void> {
  await runAgentConfig(claudeAdapter(), action);
}

/** `agent codex`: runAgentConfig over codexAdapter. `catalogDeps` is the test seam. */
export async function runCodex(
  action: AgentRunAction,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  await runAgentConfig(codexAdapter(catalogDeps), action);
}

/** null leaves that agent alone (its own re-render, or nothing) unless the default has no record,
 *  where the other agent's request is the first landing and wires both. Indexed by `adapter.id`,
 *  so a new agent in bothAgents() is a compile error here until the request names it. */
export interface DefaultAgentRequest {
  codex: RequestedMode | null;
  claude: RequestedMode | null;
  /** Pre-resolved default credential for BOTH writers (undefined = each writer
   *  resolves from the store itself) -- see AgentRunOptions.ghToken. */
  ghToken?: string | null;
}

export interface DefaultAgentsOutcome {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
  failures: string[];
  failedAgents: ManagedAgentId[];
}

/**
 * Warns per agent and keeps going; the returned `failures` let a caller with a stricter contract
 * (the settings-bundle import) fail the run instead of printing success over a broken wiring. The
 * modes returned are what each write LANDED (never read back off the agent files): an agent left
 * alone reports `none`, and an agent whose write failed reports `none` too and is named in
 * `failedAgents`, so a caller can label it "unchanged" rather than "not configured" (its existing
 * files were not touched).
 *
 * A request naming BOTH agents is the landing that sets or moves the default's mode: the modes are
 * resolved first (one probe pass over both agents when both are `auto`, Direct only when each
 * accepts), then each agent is written, then commitDefaultWiring lands the record and the pair
 * once both writes succeeded. A request naming ONE agent goes through runAgentConfig: that agent's
 * re-render on a recorded mode, or the both-agents landing on none.
 */
export async function configureDefaultAgents(
  request: DefaultAgentRequest,
  adapters: readonly AgentAdapter[] = bothAgents(),
): Promise<DefaultAgentsOutcome> {
  const failures: string[] = [];
  const failedAgents: ManagedAgentId[] = [];
  const landed: { codex: AgentProviderMode; claude: AgentProviderMode } = {
    codex: "none",
    claude: "none",
  };
  const named = adapters.filter((adapter) => request[adapter.id] !== null);
  const bothNamed = named.length === adapters.length;
  const ghToken = request.ghToken !== undefined ? request.ghToken : new Credential().resolve();
  const chosen = new Map<ManagedAgentId, ManagedMode>();
  if (bothNamed) {
    const modes = named.map((adapter) => request[adapter.id]);
    if (modes.every((mode) => mode === "auto")) {
      logger.log("");
      logger.log(bold("▸ Copilot Direct probe (one mode for both agents)"));
      for (const [id, mode] of await decideDefaultMode(adapters, ghToken)) chosen.set(id, mode);
    }
  }
  for (const adapter of named) {
    const mode = request[adapter.id];
    if (mode === null) continue;
    logger.log("");
    logger.log(bold(`▸ ${adapter.label}`));
    try {
      if (!bothNamed) {
        landed[adapter.id] = await runAgentConfig(adapter, { kind: "configure", mode }, {
          ghToken,
        }, adapters) ?? "none";
        continue;
      }
      const resolved = chosen.get(adapter.id) ?? await resolveDefaultMode(adapter, mode, ghToken);
      chosen.set(adapter.id, resolved);
      await writeDefaultAgent(adapter, resolved, ghToken);
      landed[adapter.id] = resolved.mode;
    } catch (e) {
      logger.warn(`  Could not configure ${adapter.label}: ${errMessage(e)}`);
      failures.push(`${adapter.label}: ${errMessage(e)}`);
      failedAgents.push(adapter.id);
    }
  }
  if (bothNamed) {
    // The repair names the mode the request spelled; `auto` asked for no mode, so its repair is
    // the bare command (the probes decide again).
    const requested = request.codex === request.claude && request.codex !== "auto"
      ? request.codex
      : null;
    commitDefaultWiring(adapters, chosen, failedAgents, requested);
  }
  return { ...landed, failures, failedAgents };
}

/**
 * The ONE writer of the default record (`mode`) and the default Direct pair. It lands them only
 * when every agent's write succeeded with one mode, so the record is always the mode both agents
 * share; any failure leaves the previous record (and pair) as they were, and the warning names the
 * agent that did not move and the repair. The pair takes only the halves the probe answered: a
 * pin or literal in force renders over the slot and never enters it.
 */
function commitDefaultWiring(
  adapters: readonly AgentAdapter[],
  chosen: ReadonlyMap<ManagedAgentId, ManagedMode>,
  failedAgents: readonly ManagedAgentId[],
  requested: ManagedAgentMode | null,
): void {
  const state = new CopilotEnvState();
  const previous = state.readProfileSlot(null).mode;
  const modes = adapters.map((adapter) => chosen.get(adapter.id)?.mode ?? null);
  const decided: ProfileMode | null = modes.every((mode) => mode !== null && mode === modes[0])
    ? modes[0] ?? null
    : null;
  if (failedAgents.length > 0 || decided === null) {
    const stayed = adapters.filter((adapter) => failedAgents.includes(adapter.id))
      .map((adapter) => adapter.label).join(" and ");
    // A resolve that threw leaves its agent out of `chosen`, so `decided` is null even when the
    // request spelled one mode; the repair still names that mode.
    const repair = decided ?? requested;
    logger.warn(
      `  ${stayed || "An agent"} did not move, so the default keeps ` +
        `${previous === null ? "no recorded mode" : `its recorded ${previous} mode`} for both ` +
        `agents; fix the cause above and re-run \`agent init${
          repair === null ? "" : ` --${repair}`
        }\`.`,
    );
    return;
  }
  state.recordDefaultMode(decided);
  if (decided !== "direct") return;
  // Both agents landed the same probe; either agent's wiring names the pair.
  const landed = chosen.get(adapters[0]?.id ?? "codex");
  if (landed === undefined || landed.mode !== "direct" || landed.direct === null) return;
  storeProbedPair(
    null,
    { integrationId: landed.direct.directIntegrationId, apiBase: landed.direct.directBaseUrl },
    directOverlay(null),
  );
}
