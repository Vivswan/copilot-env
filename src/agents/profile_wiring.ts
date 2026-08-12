// The cross-agent write half of a NAMED profile: wire BOTH agents from the
// store slot (the source of truth), resolving the direct client identity once
// and baking it into both. Shared by `agent profile` (add/sync/settings-for)
// and the settings-bundle import (src/agents/transfer.ts) -- it needs BOTH
// src/codex/ and src/claude/, so it lives in src/agents/ like wiring.ts.
import { claudeAdapter } from "../claude/config.ts";
import { codexAdapter, probeDirectIntegrationId } from "../codex/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { CODEX_IDENTITY_NAME } from "../copilot_api/integration_identity.ts";
import { profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import type { AgentAdapter } from "./configure.ts";

/** BOTH agents' adapters, in the wiring order profile operations use (Claude first --
 *  per-agent narration and failure aggregation keep their long-standing order). Built
 *  fresh per call: adapters are cheap closures and a stale one would pin a stale
 *  effective home. */
export function bothAgents(): AgentAdapter[] {
  return [claudeAdapter(), codexAdapter()];
}

/** Wire BOTH agents for `name` at `mode`. Order and resilience mirror
 *  configureDefaultAgents: try each adapter, report per-agent, fail if either failed.
 *  Direct mode resolves the client identity as pin > persisted slot > probe, persisting
 *  a freshly probed non-default id so a later launcher `--sync` replays it offline (a
 *  null slot means "re-derive", which is network-free for the non-PAT common case).
 *  `credentialToken` hands the identity probe an already-resolved credential
 *  (undefined = the probe resolves the slot itself). */
export async function wireBothAgents(
  name: ProfileName,
  mode: ProfileMode,
  quiet: boolean,
  credentialToken?: string | null,
): Promise<void> {
  const directIntegrationId = mode === "direct"
    ? await resolveAndPersistDirectIdentity(name, credentialToken)
    : undefined;
  const failures: string[] = [];
  for (const agent of bothAgents()) {
    try {
      agent.configureProfile(name, mode, { quiet, directIntegrationId });
    } catch (e) {
      failures.push(`${agent.label}: ${errMessage(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not wire ${profileLabel(name)}:\n  ${failures.join("\n  ")}`);
  }
}

/**
 * The direct client identity header to bake for `name`: the config pin, else the
 * persisted slot value, else a fresh probe (always persisted, so the launcher hot path
 * -- `--settings-for` / `--sync` on every `cl --profile` -- never re-probes).
 *
 * The slot stores the identity NAME, not the header value, so "probed, the default won"
 * (CODEX_IDENTITY_NAME) is distinguishable from "never probed" (null). Only a named
 * integration is a real header; the default sends none. A credential change clears the
 * slot (CopilotEnvState.setCredential), which is what re-arms the probe.
 * `credentialToken` is forwarded to the probe (see wireBothAgents).
 * Throws if the credential is rejected under every identity.
 */
export async function resolveAndPersistDirectIdentity(
  name: ProfileName,
  credentialToken?: string | null,
): Promise<string | null> {
  const pin = new CopilotEnvConfig().pinnedIntegrationId();
  if (pin !== null) return pin;
  const stored = new CopilotEnvState().readProfileSlot(name).integrationIdentity;
  if (stored !== null) return stored === CODEX_IDENTITY_NAME ? null : stored;
  const probed = await probeDirectIntegrationId(name, credentialToken);
  new CopilotEnvState().setProfileIntegrationIdentity(name, probed ?? CODEX_IDENTITY_NAME);
  return probed;
}
