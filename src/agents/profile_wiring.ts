// The write half of a NAMED profile: both agents from the store slot (the source of truth), the
// direct identity resolved once and baked into both. Needs BOTH src/codex/ and src/claude/, so
// it lives in src/agents/ like wiring.ts.
import { claudeAdapter } from "../claude/config.ts";
import { codexAdapter, directWiringFor } from "../codex/config.ts";
import { type DirectOverlay, directOverlay, renderDirectPair } from "../copilot_api/direct_pair.ts";
import type { ProfileMode } from "../copilot_api/env_state.ts";
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import {
  type AgentAdapter,
  type CredentialWiring,
  type DirectWiring,
  directWiring,
  type ManagedMode,
  resolveCredentialWiring,
  resolvedDirectToken,
} from "./configure.ts";

/** THE cross-agent adapter list; the both-agent flows iterate it rather than naming agents, and
 *  Claude comes first because per-agent narration and failure lists come out in this order. */
export function bothAgents(): AgentAdapter[] {
  return [claudeAdapter(), codexAdapter()];
}

/** How a Direct wiring gets its identity and host. `probe`: select afresh on the host in use and
 *  store the pair in the slot (a credential landing: `add`, `agent profile <name> auth`, an import).
 *  `stored`: render the slot's pair under the pin and literal in force (a re-render: `sync`,
 *  the `cl --profile` hook's re-render, the Desktop reconcile); a slot never probed is the
 *  one gap, closed by probing and storing at that re-render. */
export type DirectResolution = "probe" | "stored";

/** Every adapter runs even after one throws, and the collected failures then fail the wiring as
 *  a whole. Direct resolves the client identity ONCE into the ManagedWrite (from
 *  `credentialToken` when the caller already holds the credential), so both agents and their
 *  derived surfaces bake the same value without re-probing. The credential is per agent (the
 *  `static-key` scope) and resolved from the store at most once: the first static resolution's
 *  token feeds the next agent's and the identity probe. */
export function wireBothAgents(
  name: ProfileName,
  mode: ProfileMode,
  quiet: boolean,
  direct: DirectResolution,
  credentialToken?: string | null,
): Promise<void> {
  return wireProfileAgents(name, mode, quiet, direct, bothAgents(), credentialToken);
}

/** wireBothAgents over `agents` alone: `agent profile <name> sync --claude|--codex` re-renders one
 *  agent's files from the same slot the same way. A landing (a credential, a mode) always takes
 *  both agents, so it goes through wireBothAgents. */
export async function wireProfileAgents(
  name: ProfileName,
  mode: ProfileMode,
  quiet: boolean,
  direct: DirectResolution,
  agents: readonly AgentAdapter[],
  credentialToken?: string | null,
): Promise<void> {
  let token = credentialToken;
  const writes: { agent: AgentAdapter; credential: CredentialWiring }[] = [];
  for (const agent of agents) {
    const credential = resolveCredentialWiring(agent.id, mode, name, token);
    token ??= resolvedDirectToken(mode, credential);
    writes.push({ agent, credential });
  }
  // A probing wiring that ends in a definitive refusal throws here, after the credential landed,
  // and the files keep the previous pair: a credential refused under every identity works under
  // none, the error names the repair, and the next credential landing probes again. Deleting the
  // files would take the user's own keys in settings-<name>.json and the Desktop entry with them.
  const identity: ManagedMode = mode === "direct"
    ? {
      mode,
      direct: await (direct === "probe"
        ? directWiringFor(name, token, "land")
        : resolveDirectWiring(name, token)),
    }
    : { mode };
  const failures: string[] = [];
  for (const { agent, credential } of writes) {
    try {
      await agent.configureProfile(name, { ...identity, credential }, { quiet });
    } catch (e) {
      failures.push(`${agent.label}: ${errMessage(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not wire ${profileLabel(name)}:\n  ${failures.join("\n  ")}`);
  }
}

/**
 * Whether `profile`'s next Direct write is a LANDING (the pair probed and stored) rather than a
 * re-render: a half is present when it is STORED or covered by the pin or literal in `overlay`,
 * read from the same store the pair comes from. A pin is never stored, so a half it covers stays
 * unprobed by design and must not read as a gap: a pinned profile probes once, at its landing, and
 * every re-render after that makes zero requests. The default (configureDefaultAgents) and a named
 * profile (resolveDirectWiring) take this one rule; an import's plan passes the overlay the bundle
 * WILL put in force (directOverlayIn), so plan and apply judge the same document.
 */
export function directPairIncomplete(
  profile: Profile,
  overlay: DirectOverlay = directOverlay(profile),
): boolean {
  return renderDirectPair(profile, overlay) === null;
}

/**
 * What a re-render bakes for `profile` (null = the default slot), read from copilot-env's own
 * state alone: the `identity` pin, else the slot's probed identity; the `host` literal, else the
 * slot's probed host. Zero requests and zero reads of the agent files (they are outputs). Null
 * when a half the overlays do not cover was never probed: the caller lands it (directPairIncomplete
 * decides), or, for a read-only status, reports the gap.
 */
export function renderDirectWiring(profile: Profile): DirectWiring | null {
  const rendered = renderDirectPair(profile);
  return rendered === null ? null : directWiring(rendered.integrationId, rendered.apiBase);
}

/** A named profile's re-render: the stored pair rendered under the overlays, or, when the stored
 *  pair is incomplete (directPairIncomplete, the same rule the default takes), the one landing that
 *  probes on the host in use and stores what it answered. Throws when the credential is rejected
 *  under every identity. */
export async function resolveDirectWiring(
  profile: Profile,
  credentialToken?: string | null,
): Promise<DirectWiring> {
  if (directPairIncomplete(profile)) {
    return await directWiringFor(profile, credentialToken, "land");
  }
  const rendered = renderDirectWiring(profile);
  if (rendered === null) {
    throw new Error(`${profileLabel(profile)}'s stored Direct pair did not render`);
  }
  return rendered;
}
