// Live GitHub Copilot model-catalog fetch: the raw `/models` body, from either
// source that serves it. Shared by every raw-catalog reader (`agent models`,
// the Codex catalog limits overlay in src/codex/catalog.ts) so the two roads
// to the same catalog live in one place:
//   - proxy:  the running local daemon's `GET /models` (via CopilotAdminClient)
//   - direct: upstream api.githubcopilot.com with the resolved GitHub
//     credential -- Copilot Direct accepts a bearer under the vscode-chat
//     integration (the same integration the proxy uses upstream).
// Failures THROW with actionable messages; best-effort callers catch.
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig } from "./config.ts";
import { Credential } from "./credential.ts";
import { copilotApiResolvePort } from "./port.ts";

/** Where the catalog comes from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

export const DIRECT_MODELS_URL = "https://api.githubcopilot.com/models";
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
}

/** Fetch the raw `/models` body from `source`. */
export async function fetchRawModels(
  source: CatalogSource,
  opts: FetchRawModelsOptions = {},
): Promise<unknown> {
  if (source === "proxy") {
    const config = new CopilotApiConfig();
    const admin = new CopilotAdminClient({
      port: opts.port ?? Number(copilotApiResolvePort()),
      apiKey: config.ensureApiKey(),
      adminKey: config.ensureAdminApiKey(),
    });
    return admin.getRawModels();
  }
  const token = opts.directToken ?? new Credential().resolve();
  if (token === null) {
    throw new Error("no GitHub credential configured (run `agent auth`)");
  }
  const res = await fetch(DIRECT_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Copilot-Integration-Id": "vscode-chat",
    },
    signal: AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${DIRECT_MODELS_URL} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}
