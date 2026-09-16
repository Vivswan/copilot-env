// The shared raw `/models` fetch (`agent models`, src/codex/catalog.ts, Desktop, web_search.ts);
// discovery.ts runs its own under each identity it probes.
// Failures THROW with actionable messages; best-effort callers catch.
//   proxy  -> the running local daemon's GET /models
//   direct -> the resolved Copilot host under the identity the credential is accepted by (integration_identity.ts)
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  passthroughIdentity,
  type ProbeFetch,
  resolveCopilotHost,
  resolvePassthroughIntegrationId,
} from "./integration_identity.ts";
import { copilotApiResolvePort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

const DIRECT_FETCH_TIMEOUT_MS = 5000;

export interface FetchRawModelsOptions {
  /** Skips re-resolving, which for a gh-cli provider re-runs `gh auth token` (up to 5s). */
  directToken?: string;
  /** The Copilot host a caller already resolved (resolveCopilotHost); absent, this fetch resolves it. */
  apiBase?: string;
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
  // configured pin wins, a non-PAT token takes vscode-chat unprobed, and only a PAT is probed. The
  // host follows the identity (resolveCopilotHost), so the verdict is never rendered against a
  // different host than the GET below uses. Narration goes to stderr: `agent auth --get` runs this
  // fetch and its stdout is the token.
  const config = new CopilotEnvConfig();
  const narrator = createStderrLogger();
  const integrationId = await resolvePassthroughIntegrationId(token, {
    pinned: config.pinnedIntegrationId(),
    apiBase: DEFAULT_COPILOT_API_BASE,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator,
  });
  const apiBase = opts.apiBase ??
    await resolveCopilotHost(token, passthroughIdentity(integrationId).headers, {
      literal: config.copilotHost(),
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      narrator,
    });
  const url = `${apiBase}/models`;
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      [INTEGRATION_ID_HEADER]: integrationId,
    },
    signal: opts.signal === undefined
      ? AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)
      : AbortSignal.any([opts.signal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}
