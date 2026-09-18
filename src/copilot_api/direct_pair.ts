// THE probe-and-store owner for a profile's Direct pair (the slot's `integrationIdentity` and
// `copilotHost`, env_state.ts), and THE read that renders it. Every landing (a credential landing,
// a wiring of a slot holding no pair, a daemon start finding a half unprobed) goes through
// landDirectPair, so the rule "store only the halves the probe ANSWERED" is spelled once: a pinned
// identity or a literal host is an overlay, rendered at read time by renderDirectPair and never
// written into the slot.
//
// Listings never write. `agent profile models --direct` and the web-search catalog probe a slot holding no
// pair on every call and store nothing: a transient answer there can never overwrite the stored
// pair, and the no-pair state lasts only until the first launch or wiring lands it here.
import {
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  copilotHostIn,
  pinnedIntegrationIdIn,
} from "./env_config.ts";
import { CopilotEnvState } from "./env_state.ts";
import {
  type HostNarrator,
  type IdentityAndHost,
  type ProbeFetch,
  selectDirectIdentityAndHost,
} from "./integration_identity.ts";
import type { Profile } from "./profile.ts";

/** The `identity` pin and `host` literal in force for a profile, read once at the call site so
 *  the probe and the write judge the same overlay. */
export interface DirectOverlay {
  pinned: string | null;
  literal: string | null;
}

export function directOverlay(profile: Profile, config = new CopilotEnvConfig()): DirectOverlay {
  return directOverlayIn(config.read(), profile);
}

/** The overlay a settings document WOULD put in force (an import's plan judges the bundle's config
 *  before the apply stores it), by the store's own rule. */
export function directOverlayIn(config: CopilotEnvConfigData, profile: Profile): DirectOverlay {
  return {
    pinned: pinnedIntegrationIdIn(config, profile),
    literal: copilotHostIn(config, profile),
  };
}

/** What a Direct re-render bakes and a daemon launch sends: the overlay over the slot's stored
 *  halves. Null while either half is unknown (no pin and no stored identity, or no literal and no
 *  stored host): a landing must probe first. No request, no read of the agent files. */
export function renderDirectPair(
  profile: Profile,
  overlay: DirectOverlay = directOverlay(profile),
): IdentityAndHost | null {
  const stored = new CopilotEnvState().readProfileDirectPair(profile);
  const integrationId = overlay.pinned ?? stored.integrationId;
  const host = overlay.literal ?? stored.host;
  if (integrationId === undefined || host === undefined) return null;
  return { integrationId, apiBase: host };
}

export interface LandDirectPairOptions extends DirectOverlay {
  fetchImpl?: ProbeFetch;
  signal?: AbortSignal;
  /** Callers whose stdout is a contract pass a stderr logger. */
  narrator?: HostNarrator;
  /** Test seam: the selection to run instead of the real probe. */
  selectIdentity?: typeof selectDirectIdentityAndHost;
}

/**
 * The landing: identity and host selected as one pair on the host in use
 * (selectDirectIdentityAndHost, under the overlay), then the halves the probe answered stored in
 * the slot. Throws when the credential is rejected under every identity, before anything is
 * written. Returns the pair the caller bakes or sends, overlay applied.
 */
export async function landDirectPair(
  profile: Profile,
  token: string,
  userAgent: string,
  opts: LandDirectPairOptions,
): Promise<IdentityAndHost> {
  const select = opts.selectIdentity ?? selectDirectIdentityAndHost;
  const selected = await select(token, userAgent, {
    pinned: opts.pinned,
    fixedHost: opts.literal,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator: opts.narrator,
  });
  storeProbedPair(profile, selected, opts);
  return selected;
}

/** The store half of a landing, for a caller that probed elsewhere (the default's landing probes
 *  per agent and commits once both files are written, src/agents/configure_defaults.ts): only the
 *  halves the probe ANSWERED under `overlay`, a pinned identity or a literal host never entering
 *  the slot. */
export function storeProbedPair(
  profile: Profile,
  selected: IdentityAndHost,
  overlay: DirectOverlay,
): void {
  new CopilotEnvState().setProfileDirectPair(profile, {
    ...(overlay.pinned === null ? { integrationId: selected.integrationId } : {}),
    ...(overlay.literal === null ? { host: selected.apiBase } : {}),
  });
}
