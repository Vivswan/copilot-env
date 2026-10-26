// The default profile's writers: one credential, ONE mode, always both agents. The record (`mode`
// in the default slot) and the Direct pair land only after BOTH agents' writes succeeded, so a
// half-written default never reads as wired. The one other writer of the record is the default's
// `add` with no credential yet (src/commands/profile.ts), which records the mode alone.

import { claudeAdapter } from "../claude/config.ts";
import { codexAdapter } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { directOverlay, storeProbedPair } from "../copilot_api/direct_pair.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { bold } from "../utils/ansi.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { caught, type Message, ScannableError } from "../utils/message.ts";
import {
  type AgentAdapter,
  type AgentRunAction,
  type AgentRunOptions,
  decideDefaultMode,
  type ManagedAgentId,
  type ManagedMode,
  probedVerdict,
  resolveDefaultMode,
  writeDefaultAgent,
} from "./configure.ts";
import { bothAgents, directPairIncomplete, renderDirectWiring } from "./profile_wiring.ts";
import type { AgentProviderMode, ManagedAgentMode, RequestedMode } from "./provider_mode.ts";

// One stderr logger: interleaves in order with the per-agent probe narration, never touches stdout.
const logger = createStderrLogger();

function initCommand(mode: RequestedMode): string {
  return mode === "auto" ? "agent init" : `agent init --${mode}`;
}

/**
 * One agent's re-render behind `agent profile sync --codex|--claude` and the launchers' proxy
 * re-sync. It never writes the record or the pair: one agent's write cannot set what both agents
 * share, so the two states with nothing to re-render land BOTH agents, as `agent init` would.
 * `adapters` is that landing's pair (the test seam).
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
      throw new ScannableError({
        headline: "could not wire the default profile.",
        evidence: outcome.failures,
      });
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
    throw new ScannableError({
      headline: `the default profile records ${recorded} as the one mode for both agents.`,
      evidence: [`a ${action.mode} write of ${adapter.id} alone, leaving the two apart`],
      lead: "Fix:",
      actions: [[`agent init --${action.mode}`, "move both agents together"]],
    });
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
    const ghToken = opts.ghToken === undefined ? new Credential().resolve() : opts.ghToken;
    await writeDefaultAgent(adapter, { mode: "direct", direct: rendered }, ghToken);
    return recorded;
  }
  const ghToken = opts.ghToken === undefined ? new Credential().resolve() : opts.ghToken;
  await writeDefaultAgent(adapter, { mode: "proxy" }, ghToken);
  return recorded;
}

export async function runClaude(action: AgentRunAction): Promise<void> {
  await runAgentConfig(claudeAdapter(), action);
}

export async function runCodex(action: AgentRunAction): Promise<void> {
  await runAgentConfig(codexAdapter(), action);
}

/** null leaves that agent alone (its own re-render, or nothing) unless the default has no record,
 *  where the other agent's request is the first landing and wires both. Indexed by `adapter.id`,
 *  so a new agent in bothAgents() is a compile error here until the request names it.
 *    ghToken    -> the pre-resolved default credential for BOTH writers (undefined = each writer
 *                  resolves from the store itself; see AgentRunOptions.ghToken)
 *    onVerdict  -> a both-`auto` request whose probe verdict differs from the recorded mode asks it
 *                  which one lands (the CLI asks the user; a script or a dry run keeps the record);
 *                  absent, the verdict lands, as on a fresh default */
interface DefaultAgentRequest {
  codex: RequestedMode | null;
  claude: RequestedMode | null;
  ghToken?: string | null;
  onVerdict?: (recorded: ProfileMode, verdict: ProfileMode) => Promise<ProfileMode>;
}

/** What configureDefaultAgents landed; `failures` keeps each thrown scannable's parts under its
 *  agent's name. */
interface DefaultAgentsOutcome {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
  failures: Message[];
  failedAgents: ManagedAgentId[];
}

/** The both-`auto` landing: the probes' verdict for each agent, or, when the record disagrees and
 *  the request asks, the mode the request picks, re-resolved per agent so the same landing `agent
 *  init --<recorded>` runs, selection included. */
async function probedModes(
  request: DefaultAgentRequest,
  adapters: readonly AgentAdapter[],
  ghToken: string | null,
): Promise<Map<ManagedAgentId, ManagedMode>> {
  const chosen = new Map<ManagedAgentId, ManagedMode>();
  for (const [id, mode] of await decideDefaultMode(adapters, ghToken)) chosen.set(id, mode);
  const verdict = probedVerdict(chosen);
  const recorded = new CopilotEnvState().readProfileSlot(null).mode;
  const landing =
    recorded === null || recorded === verdict || request.onVerdict === undefined
      ? verdict
      : await request.onVerdict(recorded, verdict);
  if (landing === verdict) return chosen;
  // The record stays: the same landing `agent init --<recorded>` runs, selection included.
  chosen.clear();
  for (const adapter of adapters) {
    chosen.set(adapter.id, await resolveDefaultMode(adapter, landing, ghToken));
  }
  return chosen;
}

/** What every agent's write in one configureDefaultAgents pass shares. */
interface DefaultLanding {
  adapters: readonly AgentAdapter[];
  bothNamed: boolean;
  chosen: Map<ManagedAgentId, ManagedMode>;
  ghToken: string | null;
}

/** One agent's default write and the mode it landed. With both named, the landing with the mode
 *  chosen for it (resolved here when the probes did not choose one); alone, the agent's own
 *  re-render (runAgentConfig). */
async function landDefaultAgent(
  adapter: AgentAdapter,
  mode: RequestedMode,
  landing: DefaultLanding,
): Promise<AgentProviderMode> {
  if (landing.bothNamed) {
    const resolved =
      landing.chosen.get(adapter.id) ?? (await resolveDefaultMode(adapter, mode, landing.ghToken));
    landing.chosen.set(adapter.id, resolved);
    await writeDefaultAgent(adapter, resolved, landing.ghToken);
    return resolved.mode;
  }
  const landed = await runAgentConfig(
    adapter,
    { kind: "configure", mode },
    { ghToken: landing.ghToken },
    landing.adapters,
  );
  return landed ?? "none";
}

/**
 * Warns per agent and keeps going; `failures` lets a stricter caller (the settings-bundle import)
 * fail the run instead of printing success over a broken wiring. The modes are what each write
 * LANDED, never read back off the agent files: an agent whose write failed reports `none` and is
 * named in `failedAgents`, so a caller can say "unchanged" rather than "not configured".
 */
export async function configureDefaultAgents(
  request: DefaultAgentRequest,
  adapters: readonly AgentAdapter[] = bothAgents(),
): Promise<DefaultAgentsOutcome> {
  const failures: Message[] = [];
  const failedAgents: ManagedAgentId[] = [];
  const landed: { codex: AgentProviderMode; claude: AgentProviderMode } = {
    codex: "none",
    claude: "none",
  };
  const named = adapters.filter((adapter) => request[adapter.id] !== null);
  const bothNamed = named.length === adapters.length;
  const bothAuto = bothNamed && named.every((adapter) => request[adapter.id] === "auto");
  const ghToken = request.ghToken === undefined ? new Credential().resolve() : request.ghToken;
  const chosen = bothAuto
    ? await probedModes(request, adapters, ghToken)
    : new Map<ManagedAgentId, ManagedMode>();
  const landing: DefaultLanding = { adapters, bothNamed, chosen, ghToken };
  for (const adapter of named) {
    const mode = request[adapter.id];
    if (mode === null) continue;
    logger.log("");
    logger.log(bold(`▸ ${adapter.label}`));
    try {
      landed[adapter.id] = await landDefaultAgent(adapter, mode, landing);
    } catch (e) {
      logger.warn(caught(e, (message) => `  Could not configure ${adapter.label}: ${message}`));
      failures.push(caught(e, (message) => `${adapter.label}: ${message}`));
      failedAgents.push(adapter.id);
    }
  }
  if (bothNamed) {
    // The repair names the mode the request spelled; `auto` asked for no mode, so its repair is
    // the bare command (the probes decide again).
    const requested =
      request.codex === request.claude && request.codex !== "auto" ? request.codex : null;
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
    ? (modes[0] ?? null)
    : null;
  if (failedAgents.length > 0 || decided === null) {
    const stayed = adapters
      .filter((adapter) => failedAgents.includes(adapter.id))
      .map((adapter) => adapter.label)
      .join(" and ");
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
