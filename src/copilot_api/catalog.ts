// Live GitHub Copilot model-catalog fetch: the raw `/models` body, from either
// source that serves it. Shared by every raw-catalog reader (`agent models`,
// the Codex catalog limits overlay in src/codex/catalog.ts) so the two roads
// to the same catalog live in one place:
//   - proxy:  the running local daemon's `GET /models` (via CopilotAdminClient)
//   - direct: upstream api.githubcopilot.com with the resolved GitHub credential,
//     under the client identity that credential is accepted by (integration_identity.ts:
//     the default for OAuth/device, copilot-developer-cli for a fine-grained PAT).
// Failures THROW with actionable messages; best-effort callers catch.
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
import { type Profile, profileLabel } from "./profile.ts";
import { createStderrLogger } from "../utils/logger.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

/** The direct catalog endpoint. DERIVED from the shared base so the host this fetches and
 *  the host the identity probe validates against can never drift apart. */
export const DIRECT_MODELS_URL = `${DEFAULT_COPILOT_API_BASE}/models`;
const DIRECT_FETCH_TIMEOUT_MS = 5000;

export interface FetchRawModelsOptions {
  /**
   * An already-resolved credential for the direct fetch. Passing one skips
   * re-resolving, which for a gh-cli provider re-runs `gh auth token` (up to 5s).
   */
  directToken?: string;
  /**
   * The proxy port to read. Callers that just confirmed liveness pass the port
   * they probed so the fetch cannot race a restart onto a different port;
   * otherwise the recorded/configured port is resolved here.
   */
  port?: number;
  /**
   * The named profile whose catalog to read (null/absent = the default). Proxy:
   * the profile daemon's own home (its config.json holds ITS api/admin keys) and
   * its resolved port. Direct: the profile's own credential -- a named profile
   * never falls back to the default one.
   */
  profile?: Profile;
  /** Injection seam for tests (direct source only: the identity probe and the GET). */
  fetchImpl?: ProbeFetch;
  /** A deadline over the whole direct fetch, identity probe included (each request keeps its own timeout too). */
  signal?: AbortSignal;
}

/** Fetch the raw `/models` body from `source`. */
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
  const token = opts.directToken ?? new Credential(undefined, profile).resolve();
  if (token === null) {
    throw new Error(
      profile === null
        ? "no GitHub credential configured (run `agent auth`)"
        : `no GitHub credential for ${
          profileLabel(profile)
        } - run \`agent auth --profile ${profile}\` ` +
          "to log in (a named profile never falls back to the default credential)",
    );
  }
  // The catalog endpoint gates on the same client identity as inference: a fine-grained
  // PAT is rejected under the default vscode-chat and needs copilot-developer-cli. Resolve
  // it (pin > probe; network-free for non-PAT credentials) so `agent models` works for a
  // PAT Direct setup too -- probing DIRECT_MODELS_URL's own host, the one this fetch uses,
  // so the verdict can't be rendered against a different (account-designated) host.
  // Narrate on stderr: `agent auth --get` runs this fetch and its stdout is the token.
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
