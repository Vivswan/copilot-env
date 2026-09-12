// Discover every Claude model this credential can serve on /v1/messages, not just what /models
// advertises: Copilot serves some frontier models WITHOUT listing them in any identity's catalog, and
// the only machine-readable source is the allowlist its inference endpoints print when rejecting a
// gated model. Fully derived, no hand-kept model ids:
//   catalog   -> GET /models under the wiring's own identity
//   trigger   -> GET /models under the OTHER identities; an id they list that ours does not is real-but-gated
//   oracle    -> POST /responses with it; parse `Available models: [...]` from the 400 body
//   verify    -> a 1-token /v1/messages ping per extra under the EXACT headers the wiring bakes
//   1m probe  -> a >200k-token prompt; Copilot bills per REQUEST, so it costs the same as the ping
// Verdicts are identity-exact: meaningful only for the header set the consumer will actually send.
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  type ProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "./integration_identity.ts";
import { type CatalogModel, ONE_M_SUFFIX, parseCatalogModels } from "./models.ts";
import { CopilotEnvState } from "./env_state.ts";
import { isDue } from "../autoupdate/due.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

const MODELS_URL = `${DEFAULT_COPILOT_API_BASE}/models`;
const RESPONSES_URL = `${DEFAULT_COPILOT_API_BASE}/responses`;
const MESSAGES_URL = `${DEFAULT_COPILOT_API_BASE}/v1/messages`;

const CATALOG_TIMEOUT_MS = 5000;
const PING_TIMEOUT_MS = 20_000;
/** Above every 200k window, comfortably below the 1M prompt caps. */
const ONE_M_PROBE_TOKENS = 230_000;
const ORACLE_ATTEMPTS = 3;

/** null = the default identity (no Copilot-Integration-Id header). */
const KNOWN_IDENTITY_IDS: readonly (string | null)[] = [
  null,
  VSCODE_CHAT_INTEGRATION_ID,
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
];

export interface DiscoveryOptions {
  /** Test seam for EVERY request this module makes. */
  fetchImpl?: ProbeFetch;
  /** Clock seam for the verdict-cache TTL. */
  nowMs?: () => number;
}

export interface DiscoveredClaudeModels {
  /** The raw /models body under the wiring's own identity (labels, windows). */
  catalogBody: unknown;
  /** Advertised catalog models plus the VERIFIED unadvertised extras. */
  models: CatalogModel[];
  /** The verified-extra ids (subset of `models`) -- consumers may tag them. */
  unlisted: string[];
}

/**
 * `userAgent` MUST be the versioned codexUserAgent and `integrationId` the baked id (null = default).
 * Throws only when the OWN-identity catalog fetch fails; a failing enrichment step keeps the catalog plus
 * every extra already verified under it.
 */
export async function discoverServableClaudeModels(
  token: string,
  userAgent: string,
  integrationId: string | null,
  opts: DiscoveryOptions = {},
): Promise<DiscoveredClaudeModels> {
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const headers = (id: string | null): Record<string, string> => ({
    ...directClientHeaders(userAgent, id),
    "Authorization": `Bearer ${token}`,
  });

  const catalogBody = await fetchCatalog(fetchImpl, headers(integrationId));
  const advertised = parseCatalogModels(catalogBody);
  const models = [...advertised];
  const unlisted: string[] = [];

  try {
    const extras = await unadvertisedClaudeIds(fetchImpl, headers, integrationId, advertised);
    const state = new CopilotEnvState();
    const now = opts.nowMs?.() ?? Date.now();
    // Verdicts are keyed per credential: a profile's must never answer for the default's, since
    // entitlements differ per account.
    const credential = await credentialDigest(token);
    for (const id of extras) {
      // `agent models` and the Desktop wiring share the persisted verdicts, so a DEFINITIVE one costs its
      // billed ping once per model+identity+credential per day for sequential runs; overlapping runs each
      // probe. An inconclusive probe caches nothing (below), so it pings again on the next invocation.
      const key = `${credential}|${integrationId ?? "default"}|${id}`;
      let verdict = state.readModelVerdict(key);
      if (verdict === null || isDue(verdict.atMs, now)) {
        const servable = await pingModel(fetchImpl, headers(integrationId), id, "x");
        const is1m = servable === "yes"
          ? await pingModel(fetchImpl, headers(integrationId), id, "x ".repeat(ONE_M_PROBE_TOKENS))
          : "no";
        // Only DEFINITIVE outcomes are cached: a timeout / 429 / 5xx must not wedge
        // a servable model out (or in) for a whole TTL window.
        if (servable === "unknown" || is1m === "unknown") {
          if (servable === "yes") {
            models.push({ id, is1m: false });
            unlisted.push(id);
          }
          continue;
        }
        verdict = { servable: servable === "yes", is1m: is1m === "yes", atMs: now };
        state.setModelVerdict(key, verdict);
      }
      if (verdict.servable) {
        models.push({ id, is1m: verdict.is1m });
        unlisted.push(id);
      }
    }
  } catch (e) {
    logger.warn(
      `  model discovery: enrichment failed (${errMessage(e)}); using the catalog alone.`,
    );
  }
  return { catalogBody, models, unlisted };
}

/** A short non-reversible token digest for the verdict-cache key (never the token). */
async function credentialDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(
    new Uint8Array(digest).slice(0, 6),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The body is drained before throwing so a keep-alive socket stays reusable. */
async function fetchCatalog(
  fetchImpl: ProbeFetch,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetchImpl(MODELS_URL, {
    headers,
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error(`GET ${MODELS_URL} returned ${res.status}`);
  }
  return await res.json();
}

/** Empty when no gated trigger id exists or the oracle's error shape is not understood: never a guess. */
async function unadvertisedClaudeIds(
  fetchImpl: ProbeFetch,
  headers: (id: string | null) => Record<string, string>,
  integrationId: string | null,
  advertised: CatalogModel[],
): Promise<string[]> {
  const ownIds = new Set(advertised.map((m) => m.id));

  const candidates: string[] = [];
  for (const id of KNOWN_IDENTITY_IDS) {
    if (id === integrationId) continue;
    try {
      const body = await fetchCatalog(fetchImpl, headers(id));
      for (const model of parseCatalogModels(body)) {
        if (!ownIds.has(model.id) && !candidates.includes(model.id)) candidates.push(model.id);
      }
    } catch {
      // One identity's catalog failing must not sink the others.
    }
  }

  for (const candidate of candidates.slice(0, ORACLE_ATTEMPTS)) {
    const allowlist = await oracleAllowlist(fetchImpl, headers(integrationId), candidate);
    if (allowlist === null) continue;
    return allowlist.filter(
      (id) => id.startsWith("claude-") && !id.endsWith(ONE_M_SUFFIX) && !ownIds.has(id),
    );
  }
  return [];
}

/** A 2xx (the id turned out servable; max_output_tokens caps the accident at one token) or an
 *  unrecognized error shape yields null. */
async function oracleAllowlist(
  fetchImpl: ProbeFetch,
  headers: Record<string, string>,
  gatedId: string,
): Promise<string[] | null> {
  const res = await fetchImpl(RESPONSES_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      "model": gatedId,
      "input": "x",
      "stream": false,
      "max_output_tokens": 1,
    }),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.ok) return null;
  const match = text.match(/Available models: \[([^\]]*)\]/);
  if (match === null || match[1] === undefined) return null;
  const ids = match[1].split(/\s+/).filter((id) => id !== "");
  return ids.length > 0 ? ids : null;
}

/** DEFINITIVE outcomes only; "unknown" is never cached. The oversized-prompt variant doubles as the 1M probe.
 *    200            -> yes
 *    400            -> no: the model-level rejection class for our fixed request shape (unsupported model, exceeded prompt cap)
 *    anything else  -> unknown (another 2xx, auth, rate-limit, 5xx, network, timeout) */
type ProbeOutcome = "yes" | "no" | "unknown";

async function pingModel(
  fetchImpl: ProbeFetch,
  headers: Record<string, string>,
  model: string,
  content: string,
): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": content }],
      }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    // Drained so a keep-alive socket is reusable; the verdict is the status alone.
    await res.text().catch(() => "");
    if (res.status === 200) return "yes";
    return res.status === 400 ? "no" : "unknown";
  } catch {
    return "unknown";
  }
}
