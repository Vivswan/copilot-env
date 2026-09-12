// The write half of a NAMED profile: both agents from the store slot (the source of truth), the
// direct identity resolved once and baked into both. Needs BOTH src/codex/ and src/claude/, so
// it lives in src/agents/ like wiring.ts.
import { claudeAdapter } from "../claude/config.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { codexAdapter, probeDirectIntegrationId } from "../codex/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CopilotEnvState,
  type ProfileMode,
  type ProvisionedCredential,
  type StoredCredential,
} from "../copilot_api/env_state.ts";
import { CODEX_IDENTITY_NAME } from "../copilot_api/integration_identity.ts";
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import type { AgentAdapter, ManagedWrite } from "./configure.ts";

/** THE cross-agent adapter list; the both-agent flows iterate it rather than naming agents, and
 *  Claude comes first because per-agent narration and failure lists come out in this order. A
 *  function, not a constant, so the Codex adapter can take `catalogDeps` per call. */
export function bothAgents(catalogDeps?: CodexCatalogDeps): AgentAdapter[] {
  return [claudeAdapter(), codexAdapter(catalogDeps)];
}

/** Every adapter runs even after one throws, and the collected failures then fail the wiring as
 *  a whole. Direct resolves the client identity ONCE into the ManagedWrite (from
 *  `credentialToken` when the caller already holds the credential), so both agents and their
 *  derived surfaces bake the same value without re-probing. */
export async function wireBothAgents(
  name: ProfileName,
  mode: ProfileMode,
  quiet: boolean,
  credentialToken?: string | null,
): Promise<void> {
  const write: ManagedWrite = mode === "direct"
    ? {
      mode,
      directIntegrationId: await resolveAndPersistDirectIdentity(name, credentialToken),
    }
    : { mode };
  const failures: string[] = [];
  for (const agent of bothAgents()) {
    try {
      await agent.configureProfile(name, write, { quiet });
    } catch (e) {
      failures.push(`${agent.label}: ${errMessage(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not wire ${profileLabel(name)}:\n  ${failures.join("\n  ")}`);
  }
}

/**
 * The direct client identity to bake for `profile` (null = the default slot). Throws when the
 * credential is rejected under every identity.
 *
 *   config pin -> persisted slot verdict -> fresh probe, persisted only when it can be keyed to
 *   the credential it ran under (identityCacheKey)
 *
 * The launcher hot path (`--sync` on every `cl --profile`) thus replays the stored verdict
 * offline; a credential change clears the slot (CopilotEnvState.setCredential) and re-arms it.
 */
export async function resolveAndPersistDirectIdentity(
  profile: Profile,
  credentialToken?: string | null,
): Promise<string | null> {
  const pin = new CopilotEnvConfig().pinnedIntegrationId();
  if (pin !== null) return pin;
  const slot = new CopilotEnvState().readProfileSlot(profile);
  // The slot stores the identity NAME, not the header value, so "probed, the default won"
  // (CODEX_IDENTITY_NAME) is distinguishable from "never probed" (null). Only a named
  // integration is a real header; the default sends none.
  if (slot.integrationIdentity !== null) {
    return slot.integrationIdentity === CODEX_IDENTITY_NAME ? null : slot.integrationIdentity;
  }
  const probed = await probeDirectIntegrationId(profile, credentialToken);
  // Keyed to the credential the probe ACTUALLY ran under; null means the two cannot be tied.
  const keyCredential = identityCacheKey(slot.credential, credentialToken);
  if (keyCredential !== null) {
    new CopilotEnvState().setProfileIntegrationIdentity(
      profile,
      probed ?? CODEX_IDENTITY_NAME,
      keyCredential,
    );
  }
  return probed;
}

/** The credential to key a probed identity to: the pre-probe slot snapshot, but only if an
 *  explicit token is that snapshot's own (a stored token byte-for-byte; gh-cli holds no token,
 *  so any explicit token is its live resolution). A mismatch means the slot rotated around the
 *  caller: persist nothing, because the store's CAS alone would key the OLD credential's
 *  verdict to the NEW one and succeed. */
function identityCacheKey(
  snapshot: StoredCredential,
  credentialToken: string | null | undefined,
): ProvisionedCredential | null {
  if (snapshot.kind === "none") return null;
  if (credentialToken === undefined) return snapshot; // the probe resolved the snapshot slot itself
  if (credentialToken === null) return null; // the probe ran credential-free: nothing to key to
  if (snapshot.kind === "gh-cli") return snapshot;
  return snapshot.token === credentialToken ? snapshot : null;
}
