// The write half of a NAMED profile: both agents from the store slot (the source of truth), the
// direct identity resolved once and baked into both. Needs BOTH src/codex/ and src/claude/, so
// it lives in src/agents/ like wiring.ts.
import { claudeAdapter } from "../claude/config.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { codexAdapter, probeDirectWiring } from "../codex/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CopilotEnvState,
  type ProfileMode,
  type ProvisionedCredential,
  type StoredCredential,
} from "../copilot_api/env_state.ts";
import { CODEX_IDENTITY_NAME } from "../copilot_api/env_config.ts";
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import {
  type AgentAdapter,
  type CredentialWiring,
  type DirectWiring,
  type ManagedMode,
  resolveCredentialWiring,
  resolvedDirectToken,
} from "./configure.ts";

/** THE cross-agent adapter list; the both-agent flows iterate it rather than naming agents, and
 *  Claude comes first because per-agent narration and failure lists come out in this order. A
 *  function, not a constant, so the Codex adapter can take `catalogDeps` per call. */
export function bothAgents(catalogDeps?: CodexCatalogDeps): AgentAdapter[] {
  return [claudeAdapter(), codexAdapter(catalogDeps)];
}

/** Every adapter runs even after one throws, and the collected failures then fail the wiring as
 *  a whole. Direct resolves the client identity ONCE into the ManagedWrite (from
 *  `credentialToken` when the caller already holds the credential), so both agents and their
 *  derived surfaces bake the same value without re-probing. The credential is per agent (the
 *  `static-key` scope) and resolved from the store at most once: the first static resolution's
 *  token feeds the next agent's and the identity probe. */
export async function wireBothAgents(
  name: ProfileName,
  mode: ProfileMode,
  quiet: boolean,
  credentialToken?: string | null,
): Promise<void> {
  let token = credentialToken;
  const writes: { agent: AgentAdapter; credential: CredentialWiring }[] = [];
  for (const agent of bothAgents()) {
    const credential = resolveCredentialWiring(agent.id, mode, name, token);
    token ??= resolvedDirectToken(mode, credential);
    writes.push({ agent, credential });
  }
  const identity: ManagedMode = mode === "direct"
    ? { mode, ...(await resolveAndPersistDirectWiring(name, token)) }
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
 * The Direct facts to bake for `profile` (null = the default slot): the client identity and the
 * Copilot host. Throws when the credential is rejected under every identity.
 *
 *   config pin / `copilot-host` literal -> persisted slot verdict -> fresh probe, persisted only
 *   when it can be keyed to the credential it ran under (identityCacheKey)
 *
 * The launcher hot path (`--sync` on every `cl --profile`) thus replays the stored pair offline; a
 * credential change clears the slot (CopilotEnvState.setCredential). The pair is one verdict: an
 * identity accepted on one host says nothing about another, so a pair that no longer reads back
 * (the literal changed or went away, a pin names another identity) re-probes BOTH; a slot holding
 * only an identity (imported, or cached before hosts were) probes the host under it.
 */
export async function resolveAndPersistDirectWiring(
  profile: Profile,
  credentialToken?: string | null,
): Promise<DirectWiring> {
  const config = new CopilotEnvConfig();
  const state = new CopilotEnvState();
  const slot = state.readProfileSlot(profile);
  // The slot stores the identity NAME, not the header value, so "probed, the default won"
  // (CODEX_IDENTITY_NAME) is distinguishable from "never probed" (null). Only a named
  // integration is a real header; the default sends none.
  const cachedIdentity = slot.integrationIdentity === null
    ? undefined
    : slot.integrationIdentity === CODEX_IDENTITY_NAME
    ? null
    : slot.integrationIdentity;
  const pin = config.pinnedIntegrationId();
  const literal = config.copilotHost();
  // The cached pair reads back only under the identity and host in force (readProfileCopilotHost);
  // a pair that does not is another host's verdict, so its identity is not replayed either.
  const cachedHost = state.readProfileCopilotHost(profile, pin, literal);
  const replayIdentity = cachedHost === null && state.hasProfileCopilotHost(profile)
    ? undefined
    : cachedIdentity;
  const directIntegrationId = pin ?? replayIdentity;
  if (directIntegrationId !== undefined && cachedHost !== null) {
    return { directIntegrationId, directBaseUrl: cachedHost };
  }
  const probed = await probeDirectWiring(
    profile,
    credentialToken,
    directIntegrationId === undefined ? undefined : { directIntegrationId },
  );
  // Keyed to the credential the probe ACTUALLY ran under; null means the two cannot be tied. A pin
  // is configuration, never written as the verdict (the slot keeps what it held, so `--identity
  // auto` returns to it); the pair is cached with the identity it was resolved under, pin or
  // verdict, and how, so it replays exactly while both stay in force.
  const keyCredential = identityCacheKey(slot.credential, credentialToken);
  if (keyCredential !== null) {
    const verdict = probed.directIntegrationId ?? CODEX_IDENTITY_NAME;
    state.setProfileIntegrationIdentity(
      profile,
      pin === null ? verdict : slot.integrationIdentity,
      keyCredential,
      {
        host: probed.directBaseUrl,
        identity: pin ?? verdict,
        source: literal === null ? "auto" : "literal",
      },
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
