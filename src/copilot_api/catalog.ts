// The shared raw `/models` body (`agent models`, src/codex/catalog.ts, Desktop, web_search.ts);
// discovery.ts fetches its own under each identity it probes. The request itself is
// models_fetch.ts's. Failures THROW with actionable messages; best-effort callers catch.
//   proxy  -> the running local daemon's GET /models
//   direct -> the resolved Copilot host under the identity the CONSUMER names (DirectCatalogIdentity)
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import {
  directClientHeaders,
  type IdentityAndHostOptions,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  selectDirectIdentityAndHost,
  selectPassthroughIdentityAndHost,
} from "./integration_identity.ts";
import { fetchModelCatalog } from "./models_fetch.ts";
import { copilotApiResolvePort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

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
  /** The Copilot host a caller already selected (select*IdentityAndHost); absent, this fetch selects it. */
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
  // Either selector pairs the CONSUMER's identity with the one host it was accepted on
  // (select*IdentityAndHost): a configured pin wins, a non-PAT token takes its default unprobed,
  // only a PAT is probed; a caller's host or the `copilot-host` literal fixes the host, else `auto`
  // resolves it under the consumer's exact header set. Narration goes to stderr: `agent auth --get`
  // runs this fetch and its stdout is the token.
  const config = new CopilotEnvConfig();
  const selectOpts: IdentityAndHostOptions = {
    pinned: config.pinnedIntegrationId(),
    fixedHost: opts.apiBase ?? config.copilotHost(),
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    narrator: createStderrLogger(),
  };
  const identity = opts.identity ?? { kind: "passthrough" };
  const { headers, apiBase } = identity.kind === "agents"
    ? await selectDirectIdentityAndHost(token, identity.userAgent, selectOpts).then((s) => ({
      headers: directClientHeaders(identity.userAgent, s.integrationId),
      apiBase: s.apiBase,
    }))
    : await selectPassthroughIdentityAndHost(token, selectOpts).then((s) => ({
      headers: { [INTEGRATION_ID_HEADER]: s.integrationId },
      apiBase: s.apiBase,
    }));
  const got = await fetchModelCatalog({
    host: apiBase,
    token,
    headers,
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
