// The cross-agent write half of a NAMED profile: wire BOTH agents from the
// store slot (the source of truth), resolving the direct client identity once
// and baking it into both. Shared by `agent profile` (add/sync/settings-for)
// and the settings-bundle import (src/agents/transfer.ts) -- it needs BOTH
// src/codex/ and src/claude/, so it lives in src/agents/ like wiring.ts.
import { claudeAdapter } from "../claude/config.ts";
import { claudeDesktopInstalled, syncClaudeDesktopWiring } from "../claude/desktop.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { codexAdapter, probeDirectIntegrationId } from "../codex/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CopilotEnvState,
  type ProfileMode,
  type ProvisionedCredential,
  type StoredCredential,
} from "../copilot_api/env_state.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CODEX_IDENTITY_NAME } from "../copilot_api/integration_identity.ts";
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import type { AgentAdapter, ManagedWrite } from "./configure.ts";
import { readAgentModesSafe } from "./wiring.ts";

const logger = createStderrLogger();

/** BOTH agents' adapters, in the wiring order profile operations use (Claude first --
 *  per-agent narration and failure aggregation keep their long-standing order). Built
 *  fresh per call: adapters are cheap closures and a stale one would pin a stale
 *  effective home. `catalogDeps` is runCodex's catalog test seam, threaded to the
 *  Codex adapter untouched. THE single cross-agent list: every both-agent flow
 *  (profile wiring, teardown, the default-selection writes) iterates it, so a
 *  third agent lands everywhere by construction. */
export function bothAgents(catalogDeps?: CodexCatalogDeps): AgentAdapter[] {
  return [claudeAdapter(), codexAdapter(catalogDeps)];
}

/** Wire BOTH agents for `name` at `mode`. Order and resilience mirror
 *  configureDefaultAgents: try each adapter, report per-agent, fail if either failed.
 *  Direct mode resolves the client identity ONCE (pin > persisted slot > probe,
 *  persisting a freshly probed non-default id so a later launcher `--sync` replays
 *  it offline; a null slot means "re-derive", which is network-free for the
 *  non-PAT common case) and passes it DOWN inside the shared ManagedWrite, so
 *  both agents and their derived surfaces bake the same value without re-probing.
 *  `credentialToken` hands the identity probe an already-resolved credential
 *  (undefined = the probe resolves the slot itself). */
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
 * The direct client identity header to bake for `profile` (null = the default
 * slot): the config pin, else the persisted slot value, else a fresh probe --
 * persisted only when it can be keyed to the credential it ran under, so the
 * launcher hot path (`--settings-for` / `--sync` on every `cl --profile`) and
 * the default's re-wires replay the stored verdict and re-probe only while no
 * verdict could be keyed (a rotation raced the probe, or it ran
 * credential-free).
 *
 * The slot stores the identity NAME, not the header value, so "probed, the default won"
 * (CODEX_IDENTITY_NAME) is distinguishable from "never probed" (null). Only a named
 * integration is a real header; the default sends none. A credential change clears the
 * slot (CopilotEnvState.setCredential), which is what re-arms the probe.
 * `credentialToken` is forwarded to the probe (see wireBothAgents).
 * Throws if the credential is rejected under every identity.
 */
export async function resolveAndPersistDirectIdentity(
  profile: Profile,
  credentialToken?: string | null,
): Promise<string | null> {
  const pin = new CopilotEnvConfig().pinnedIntegrationId();
  if (pin !== null) return pin;
  const slot = new CopilotEnvState().readProfileSlot(profile);
  if (slot.integrationIdentity !== null) {
    return slot.integrationIdentity === CODEX_IDENTITY_NAME ? null : slot.integrationIdentity;
  }
  const probed = await probeDirectIntegrationId(profile, credentialToken);
  // Persist keyed to the credential the probe ACTUALLY ran under, so a rotation
  // racing the probe can only drop the verdict, never attach it to the wrong
  // credential; identityCacheKey returns null when the two cannot be tied.
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

/**
 * The credential to key a probed identity cache entry to: the pre-probe slot
 * snapshot -- but when the probe ran under an EXPLICIT token, only if that
 * token is the snapshot credential's own (a stored token must match
 * byte-for-byte; gh-cli holds no token, so any explicit token is its live
 * resolution). A mismatch means the slot rotated around the caller: return
 * null and persist nothing, because the CAS alone would key the OLD
 * credential's verdict to the NEW credential and succeed.
 */
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

/**
 * `agent claude --desktop`: refresh ONLY the Claude Desktop config-library entries --
 * the default entry mirroring settings.json's CURRENT managed mode (never rewired
 * here; `none`/`other` skips with a hint), then every stored profile slot via the
 * persisted-identity replay (network-free in the common case). Per-entry resilient,
 * like `agent profile --sync`.
 */
export async function refreshClaudeDesktopWiring(): Promise<void> {
  if (!claudeDesktopInstalled()) {
    logger.info("Claude Desktop was not detected on this machine; nothing to wire.");
    return;
  }
  const claudeMode = readAgentModesSafe().claude;
  if (claudeMode === "direct" || claudeMode === "proxy") {
    // Per-entry resilient: a rejected default credential/probe must not abort the
    // profile refreshes below.
    try {
      const ghToken = claudeMode === "direct" ? new Credential().resolve() : undefined;
      // The default slot caches its probed identity like every profile slot, so
      // this refresh replays it instead of re-probing (network-free in the
      // common case, exactly like the profile loop below).
      const write: ManagedWrite = claudeMode === "direct"
        ? {
          mode: "direct",
          directIntegrationId: await resolveAndPersistDirectIdentity(null, ghToken),
        }
        : { mode: "proxy" };
      await syncClaudeDesktopWiring({ ...write, profile: null, directToken: ghToken });
    } catch (e) {
      logger.warn(`  Could not refresh the default entry: ${errMessage(e)}`);
    }
  } else {
    logger.info(
      `  Claude's default wiring is ${claudeMode}; run \`agent claude\` first to manage it. Skipping the default entry.`,
    );
  }
  const state = new CopilotEnvState();
  for (const name of state.profileNames()) {
    const slot = state.readProfileSlot(name);
    // Complete slots only: a partial profile (e.g. de-authed but mode kept) is
    // repair territory, not a launchable entry to mirror into Desktop.
    if (slot.kind !== "complete") continue;
    try {
      const write: ManagedWrite = slot.mode === "direct"
        ? { mode: "direct", directIntegrationId: await resolveAndPersistDirectIdentity(name) }
        : { mode: "proxy" };
      await syncClaudeDesktopWiring({ ...write, profile: name });
    } catch (e) {
      logger.warn(`  Could not refresh ${profileLabel(name)}: ${errMessage(e)}`);
    }
  }
}
