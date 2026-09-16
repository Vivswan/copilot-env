// The shared raw `/models` fetch (`agent models`, src/codex/catalog.ts, Desktop, web_search.ts);
// discovery.ts runs its own under each identity it probes.
// Failures THROW with actionable messages; best-effort callers catch.
//   proxy  -> the running local daemon's GET /models
//   direct -> the resolved Copilot host under the identity the CONSUMER names (DirectCatalogIdentity)
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  resolveCopilotHost,
  resolveDirectIntegrationId,
  type ResolveIdentityOptions,
  resolvePassthroughIntegrationId,
} from "./integration_identity.ts";
import { copilotApiResolvePort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

const DIRECT_FETCH_TIMEOUT_MS = 5000;

/**
 * Copilot gates the catalog per client identity (identity-exact, discovery.ts), so WHOSE header set
 * a direct fetch carries is the consumer's choice, never inferred from the source:
 *
 *   passthrough -> the proxy daemon's (vscode-chat first, the id header alone); what feeds the
 *                  daemon's own listing, Desktop's proxy fallback included
 *   agents      -> a Direct agent's exact set (directClientHeaders under `userAgent`); what feeds
 *                  that agent's own requests: the Codex catalog seed, the web-search aliases
 */
export type DirectCatalogIdentity =
  | { kind: "passthrough" }
  | { kind: "agents"; userAgent: string };

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
  /** Direct source only; absent = passthrough (see DirectCatalogIdentity). */
  identity?: DirectCatalogIdentity;
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
  // Either resolver: a configured pin wins, a non-PAT token takes its default unprobed, only a PAT
  // is probed (a fine-grained PAT is rejected under both defaults; it needs copilot-developer-cli).
  //   the probe's apiBase    -> the host in use (a caller's, else the `copilot-host` literal, else
  //                             the generic host), so the identity verdict is never rendered against
  //                             a host this fetch does not use
  //   the host               -> a caller's, else resolveCopilotHost under the CONSUMER's exact header
  //                             set, so the host verdict is the consumer's too
  //   the probes' narration  -> stderr: `agent auth --get` runs this fetch and its stdout is the token
  const config = new CopilotEnvConfig();
  const literal = config.copilotHost();
  const narrator = createStderrLogger();
  const resolveOpts: ResolveIdentityOptions = {
    pinned: config.pinnedIntegrationId(),
    apiBase: opts.apiBase ?? literal ?? DEFAULT_COPILOT_API_BASE,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator,
  };
  const identity = opts.identity ?? { kind: "passthrough" };
  const headers: Record<string, string> = identity.kind === "agents"
    ? directClientHeaders(
      identity.userAgent,
      await resolveDirectIntegrationId(token, identity.userAgent, resolveOpts),
    )
    : { [INTEGRATION_ID_HEADER]: await resolvePassthroughIntegrationId(token, resolveOpts) };
  const apiBase = opts.apiBase ?? await resolveCopilotHost(token, headers, {
    literal,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator,
  });
  const url = `${apiBase}/models`;
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const res = await fetchImpl(url, {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    signal: opts.signal === undefined
      ? AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)
      : AbortSignal.any([opts.signal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}
