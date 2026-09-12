// The shared raw `/models` fetch (`agent models`, src/codex/catalog.ts, Desktop, web_search.ts);
// discovery.ts runs its own under each identity it probes.
// Failures THROW with actionable messages; best-effort callers catch.
//   proxy  -> the running local daemon's GET /models
//   direct -> api.githubcopilot.com under the identity the credential is accepted by (integration_identity.ts)
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  resolvePassthroughIntegrationId,
} from "./integration_identity.ts";
import { copilotApiResolvePort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

/** Derived from the shared base so this fetch and the identity probe can never target different hosts. */
export const DIRECT_MODELS_URL = `${DEFAULT_COPILOT_API_BASE}/models`;
const DIRECT_FETCH_TIMEOUT_MS = 5000;

export interface FetchRawModelsOptions {
  /** Skips re-resolving, which for a gh-cli provider re-runs `gh auth token` (up to 5s). */
  directToken?: string;
  /** Callers that just probed liveness pass that port so the fetch cannot race a restart onto another. */
  port?: number;
  /** null/absent = the default profile. A named profile never falls back to the default credential (credential.ts). */
  profile?: Profile;
  /** Injection seam for tests (direct source only: the identity probe and the GET). */
  fetchImpl?: ProbeFetch;
  /** A deadline over the whole direct fetch, identity probe included (each request keeps its own timeout too). */
  signal?: AbortSignal;
}

export async function fetchRawModels(
  source: CatalogSource,
  opts: FetchRawModelsOptions = {},
): Promise<unknown> {
  const profile = opts.profile ?? null;
  if (source === "proxy") {
    const config = CopilotApiConfig.forProfile(profile);
    const admin = new CopilotAdminClient({
      port: opts.port ?? Number(copilotApiResolvePort(profile)),
      apiKey: config.ensureApiKey(),
      adminKey: config.ensureAdminApiKey(),
    });
    return admin.getRawModels();
  }
  const resolved = typeof opts.directToken === "string"
    ? { token: opts.directToken, reason: null }
    : new Credential(undefined, profile).resolveWithReason();
  if (resolved.token === null) throw new Error(resolved.reason);
  const token = resolved.token;
  // The catalog endpoint gates on the same client identity as inference, so the fetch resolves one: a
  // configured pin wins, a non-PAT token takes vscode-chat unprobed, and only a PAT is probed.
  //   a fine-grained PAT     -> rejected under the default identity; it needs copilot-developer-cli
  //   the probe's apiBase    -> the host this fetch uses, so its verdict is never rendered against a different host
  //   the probe's narration  -> stderr: `agent auth --get` runs this fetch and its stdout is the token
  const integrationId = await resolvePassthroughIntegrationId(token, {
    pinned: new CopilotEnvConfig().pinnedIntegrationId(),
    apiBase: DEFAULT_COPILOT_API_BASE,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator: createStderrLogger(),
  });
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const res = await fetchImpl(DIRECT_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      [INTEGRATION_ID_HEADER]: integrationId,
    },
    signal: opts.signal === undefined
      ? AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)
      : AbortSignal.any([opts.signal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    throw new Error(`GET ${DIRECT_MODELS_URL} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}
