// The shared raw `/models` body (`agent profile models`, src/codex/catalog.ts, Desktop, web_search.ts);
// discovery.ts fetches its own under each identity it probes. The request itself is
// models_fetch.ts's. Failures THROW with actionable messages; best-effort callers catch.
//   proxy  -> the running local daemon's GET /models
//   direct -> the resolved Copilot host under the identity the CONSUMER names (DirectCatalogIdentity)
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { directOverlay, renderDirectPair } from "./direct_pair.ts";
import {
  CODEX_EXEC_USER_AGENT,
  directClientHeaders,
  type HostNarrator,
  type IdentityAndHost,
  type ProbeFetch,
  selectDirectIdentityAndHost,
} from "./integration_identity.ts";
import { fetchModelCatalog } from "./models_fetch.ts";
import { copilotApiResolvePort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

/**
 * Which User-Agent the one header set (directClientHeaders) carries on a direct fetch: `agents`
 * names a Direct agent's own (the Codex catalog seed, the web-search aliases); `passthrough` is
 * the version-free codex UA for consumers that feed no agent's requests (Desktop's fallback) and
 * must not resolve the versioned one, whose lookup can spawn `codex --version` and `npm view`.
 */
export type DirectCatalogIdentity =
  | { kind: "passthrough" }
  | { kind: "agents"; userAgent: string };

export interface FetchRawModelsOptions {
  /** Skips re-resolving, which for a gh-cli provider re-runs `gh auth token` (up to 5s). */
  directToken?: string;
  /** The identity and host a caller already resolved for this profile (directRequestIdentity),
   *  so one selection serves its every request; absent, this fetch resolves them. */
  pair?: IdentityAndHost;
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

export interface DirectRequestIdentityOptions {
  fetchImpl?: ProbeFetch;
  signal?: AbortSignal;
  narrator?: HostNarrator;
}

/**
 * THE identity and host a request made on `profile`'s behalf sends: the rendered pair every
 * re-render bakes and the daemon sends (renderDirectPair), so the catalog and web-search requests
 * carry the same identity. A half never probed selects on the host in use and stores nothing
 * (direct_pair.ts: listings never write).
 */
export async function directRequestIdentity(
  profile: Profile,
  token: string,
  userAgent: string,
  opts: DirectRequestIdentityOptions = {},
): Promise<IdentityAndHost> {
  const overlay = directOverlay(profile);
  return renderDirectPair(profile, overlay) ??
    await selectDirectIdentityAndHost(token, userAgent, {
      pinned: overlay.pinned,
      fixedHost: overlay.literal,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      narrator: opts.narrator,
    });
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
  const identity = opts.identity ?? { kind: "passthrough" };
  const userAgent = identity.kind === "agents" ? identity.userAgent : CODEX_EXEC_USER_AGENT;
  // Narration goes to stderr: `agent auth --get` runs this fetch and its stdout is the token.
  const { integrationId, apiBase } = opts.pair ??
    await directRequestIdentity(profile, token, userAgent, {
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      narrator: createStderrLogger(),
    });
  const got = await fetchModelCatalog({
    host: apiBase,
    token,
    headers: directClientHeaders(userAgent, integrationId),
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  });
  switch (got.kind) {
    case "ok":
      return got.body;
    case "http":
      throw new Error(`GET ${apiBase}/models returned ${got.status} ${got.statusText}`);
    default:
      throw got.error;
  }
}
