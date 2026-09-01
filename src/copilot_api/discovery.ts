// Discover EVERY Claude model this credential can serve on Copilot's Anthropic surface
// (/v1/messages) -- not just what /models advertises. Copilot serves some frontier
// models (claude-fable-5, verified live) WITHOUT listing them in any identity's
// catalog; the only machine-readable source is the per-integrator allowlist its
// inference endpoints print when rejecting a model the integrator cannot use.
//
// The pipeline is fully derived -- no hand-kept model ids anywhere:
//   1. catalog:    GET /models under the wiring's own identity (labels, windows).
//   2. trigger:    GET /models under the OTHER known identities; any id they list
//                  that ours does not is a real-but-gated id -- requesting it under
//                  our identity provokes the allowlist error.
//   3. oracle:     POST /responses with that id; parse `Available models: [...]`
//                  from the 400 body. The extras are its claude ids minus the catalog.
//   4. verify:     each extra gets a 1-token /v1/messages ping under the EXACT
//                  headers the wiring bakes -- servable or it stays out.
//   5. 1m probe:   a >200k-token prompt per verified extra. Copilot bills per
//                  REQUEST, not per token, so this costs the same as the ping; a 200
//                  proves the 1M window, `model_max_prompt_tokens_exceeded` denies it.
//
// Every request is best-effort and identity-exact: the verdicts are only meaningful
// for the header set the consumer will actually send.
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
/** How many gated-id candidates to try before giving up on the oracle. */
const ORACLE_ATTEMPTS = 3;

/** The identities whose catalogs seed the gated-id trigger (order irrelevant).
 *  null = the default identity (no Copilot-Integration-Id header). */
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
 * Discover the Claude models servable under `token` + the identity the wiring bakes
 * (`userAgent` MUST be the versioned codexUserAgent; `integrationId` the baked id or
 * null for the default identity). Throws only when the OWN-identity catalog fetch
 * fails (the caller falls back); every enrichment step degrades to "catalog only".
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
    // Credential-exact cache key: a profile's verdicts must never answer for the
    // default credential (or vice versa) -- entitlements differ per account.
    const credential = await credentialDigest(token);
    for (const id of extras) {
      // The billed verification pings run at most once per model+identity+credential
      // per day: both consumers (`agent models`, the Desktop wiring) share the
      // persisted verdicts, so listing models never re-pays what a wire just probed.
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

/** GET /models under one identity; throws on any failure (body drained first, so a
 *  keep-alive socket stays reusable). */
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

/**
 * The claude ids the integrator can SERVE but its catalog does not list, via the
 * allowlist oracle. Empty when no gated trigger id exists or the oracle's error
 * shape is not understood (never a guess).
 */
async function unadvertisedClaudeIds(
  fetchImpl: ProbeFetch,
  headers: (id: string | null) => Record<string, string>,
  integrationId: string | null,
  advertised: CatalogModel[],
): Promise<string[]> {
  const ownIds = new Set(advertised.map((m) => m.id));

  // Trigger candidates: ids other identities advertise that ours does not.
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

/** Provoke the integrator-allowlist error with a real-but-gated id and parse it.
 *  A 2xx (the id turned out servable; max_output_tokens caps the accident at one
 *  token) or an unrecognized error shape yields null. */
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

/** One /v1/messages probe under the wiring's own headers. DEFINITIVE outcomes only:
 *  exactly 200 = "yes"; 400 = "no" (the model-level rejection class for our fixed
 *  request shape -- unsupported model or an exceeded prompt cap); anything else
 *  (another 2xx, auth, rate-limit, 5xx, network, timeout) = "unknown", never cached.
 *  The oversized-prompt variant doubles as the 1M probe (request-priced, not
 *  token-priced). */
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
    // Drain so a keep-alive socket is reusable; the verdict is the status alone.
    await res.text().catch(() => "");
    if (res.status === 200) return "yes";
    return res.status === 400 ? "no" : "unknown";
  } catch {
    return "unknown";
  }
}
