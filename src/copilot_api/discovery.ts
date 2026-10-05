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
  directClientHeaders,
  type ProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "./integration_identity.ts";
import { type CatalogModel, ONE_M_SUFFIX, parseCatalogModels } from "./models.ts";
import { PING_TIMEOUT_MS } from "./endpoint_smoke.ts";
import { fetchModelCatalog } from "./models_fetch.ts";
import { CODEX_IDENTITY_NAME } from "./config_registry.ts";
import { CopilotEnvState } from "./env_state.ts";
import { errMessage } from "../utils/error.ts";
import { isDue } from "../utils/time.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

/** What this process already asked Copilot, keyed per credential (a digest of the host and token:
 *  a profile's answers must never serve the default's, since entitlements differ per account, nor
 *  one host's another's) and identity: the catalog under each identity, the oracle's answer per
 *  candidate (its allowlist, or that the candidate itself served), and each DEFINITIVE probe
 *  outcome under the store's verdict key plus the probe's name. A run on the fs overlay (an
 *  import's preview) lands its store write nowhere, so the real run after it takes these from here
 *  instead of paying the requests again, and persists the verdicts. The probes are kept one by
 *  one: a preview whose 1m probe was inconclusive still keeps its small ping's billed answer. */
const catalogs = new Map<string, unknown>();
const oracled = new Map<string, string[] | "servable">();
const probed = new Map<string, { outcome: "yes" | "no"; atMs: number }>();

/** Test hook: the next discovery asks as a fresh process would. */
export function forgetDiscoveryAnswers(): void {
  catalogs.clear();
  oracled.clear();
  probed.clear();
}

/** The identity segment of an answer's key: the header's value, or for the set that sends none its
 *  own name, which the registry refuses as a pin, so no pinned identity can share a key with it. */
function identityKey(integrationId: string | null): string {
  return integrationId ?? CODEX_IDENTITY_NAME;
}

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

interface DiscoveryOptions {
  /** Test seam for EVERY request this module makes. */
  fetchImpl?: ProbeFetch;
  /** Clock seam for the verdict-cache TTL. */
  nowMs?: () => number;
}

interface DiscoveredClaudeModels {
  /** The raw /models body under the wiring's own identity (labels, windows). */
  catalogBody: unknown;
  /** Advertised catalog models plus the VERIFIED unadvertised extras. */
  models: CatalogModel[];
  /** The verified-extra ids (subset of `models`) -- consumers may tag them. */
  unlisted: string[];
}

/**
 * `userAgent` MUST be the versioned codexUserAgent, `integrationId` the baked id (null = default), and
 * `apiBase` the host the wiring bakes (selectDirectIdentityAndHost): every request below goes there.
 * Throws only when the OWN-identity catalog fetch fails; a failing enrichment step keeps the catalog plus
 * every extra already verified under it.
 */
export async function discoverServableClaudeModels(
  token: string,
  userAgent: string,
  integrationId: string | null,
  apiBase: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveredClaudeModels> {
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? defaultFetch;
  const own = wireHeaders(token, userAgent, integrationId);
  const credential = await credentialDigest(`${apiBase}|${token}`);

  const catalogBody = await catalogUnder(
    fetchImpl,
    apiBase,
    token,
    userAgent,
    integrationId,
    credential,
  );
  const advertised = parseCatalogModels(catalogBody);
  const models = [...advertised];
  const unlisted: string[] = [];

  try {
    const extras = await unadvertisedClaudeIds(
      fetchImpl,
      apiBase,
      token,
      userAgent,
      integrationId,
      credential,
      advertised,
    );
    const state = new CopilotEnvState();
    const now = opts.nowMs?.() ?? Date.now();
    for (const id of extras) {
      // `agent profile models` and the Desktop wiring share the persisted verdicts, so a DEFINITIVE one costs its
      // billed ping once per model+identity+credential per day for sequential runs; overlapping runs each
      // probe. An inconclusive probe caches nothing (below), so it pings again on the next invocation.
      const key = `${credential}|${identityKey(integrationId)}|${id}`;
      let verdict = state.readModelVerdict(key);
      if (verdict === null || isDue(verdict.atMs, now)) {
        const ping = await probeOnce(
          `${key}|ping`,
          now,
          () => pingModel(fetchImpl, apiBase, own, id, "x"),
        );
        const oneM = ping.outcome === "yes"
          ? await probeOnce(
            `${key}|1m`,
            now,
            () => pingModel(fetchImpl, apiBase, own, id, "x ".repeat(ONE_M_PROBE_TOKENS)),
          )
          : { outcome: "no" as const, atMs: ping.atMs };
        // Only DEFINITIVE outcomes are cached: a timeout / 429 / 5xx must not wedge
        // a servable model out (or in) for a whole TTL window.
        if (ping.outcome === "unknown" || oneM.outcome === "unknown") {
          if (ping.outcome === "yes") {
            models.push({ id, is1m: false });
            unlisted.push(id);
          }
          continue;
        }
        verdict = {
          servable: ping.outcome === "yes",
          is1m: oneM.outcome === "yes",
          atMs: ping.atMs,
        };
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

/** A short non-reversible digest of the host and token for the verdict-cache key (never the token). */
async function credentialDigest(hostAndToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostAndToken));
  return Array.from(
    new Uint8Array(digest).slice(0, 6),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The raw /models body under `integrationId`, fetched once per credential and identity in this
 *  process; a failure throws with the status (an unusable 2xx body or a network error rethrows its
 *  own error) and is not remembered. */
async function catalogUnder(
  fetchImpl: ProbeFetch,
  apiBase: string,
  token: string,
  userAgent: string,
  integrationId: string | null,
  credential: string,
): Promise<unknown> {
  const key = `${credential}|${identityKey(integrationId)}`;
  if (catalogs.has(key)) return catalogs.get(key);
  const got = await fetchModelCatalog({
    host: apiBase,
    token,
    headers: directClientHeaders(userAgent, integrationId),
    fetchImpl,
  });
  switch (got.kind) {
    case "ok":
      catalogs.set(key, got.body);
      return got.body;
    case "http":
      throw new Error(`GET ${apiBase}/models returned ${got.status}`);
    default:
      throw got.error;
  }
}

/** The wiring's exact bytes plus the credential, for the POSTs; the GETs go through
 *  fetchModelCatalog, which adds the bearer itself. */
function wireHeaders(token: string, userAgent: string, id: string | null): Record<string, string> {
  return { ...directClientHeaders(userAgent, id), "Authorization": `Bearer ${token}` };
}

/** Empty when no gated trigger id exists or the oracle's error shape is not understood: never a guess. */
async function unadvertisedClaudeIds(
  fetchImpl: ProbeFetch,
  apiBase: string,
  token: string,
  userAgent: string,
  integrationId: string | null,
  credential: string,
  advertised: CatalogModel[],
): Promise<string[]> {
  const ownIds = new Set(advertised.map((m) => m.id));

  const candidates: string[] = [];
  for (const id of KNOWN_IDENTITY_IDS) {
    if (id === integrationId) continue;
    try {
      const body = await catalogUnder(fetchImpl, apiBase, token, userAgent, id, credential);
      for (const model of parseCatalogModels(body)) {
        if (!ownIds.has(model.id) && !candidates.includes(model.id)) candidates.push(model.id);
      }
    } catch {
      // One identity's catalog failing must not sink the others.
    }
  }

  const own = wireHeaders(token, userAgent, integrationId);
  for (const candidate of candidates.slice(0, ORACLE_ATTEMPTS)) {
    const key = `${credential}|${identityKey(integrationId)}|${candidate}`;
    let answer = oracled.get(key);
    if (answer === undefined) {
      const asked = await oracleAllowlist(fetchImpl, apiBase, own, candidate);
      if (asked === null) continue;
      answer = asked;
      oracled.set(key, answer);
    }
    if (answer === "servable") continue;
    return answer.filter(
      (id) => id.startsWith("claude-") && !id.endsWith(ONE_M_SUFFIX) && !ownIds.has(id),
    );
  }
  return [];
}

/** The allowlist the rejection printed; "servable" for a 2xx (the id turned out servable, and
 *  max_output_tokens caps the accident at one billed token); null for an unrecognized error
 *  shape. */
async function oracleAllowlist(
  fetchImpl: ProbeFetch,
  apiBase: string,
  headers: Record<string, string>,
  gatedId: string,
): Promise<string[] | "servable" | null> {
  const res = await fetchImpl(`${apiBase}/responses`, {
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
  if (res.ok) return "servable";
  const match = text.match(/Available models: \[([^\]]*)\]/);
  if (match === null || match[1] === undefined) return null;
  const ids = match[1].split(/\s+/).filter((id) => id !== "");
  return ids.length > 0 ? ids : null;
}

/** One probe's outcome, taken once per process while it holds (the verdict TTL); "unknown" is never
 *  kept, so the next run probes again. */
async function probeOnce(
  key: string,
  now: number,
  probe: () => Promise<ProbeOutcome>,
): Promise<{ outcome: ProbeOutcome; atMs: number }> {
  const known = probed.get(key);
  if (known !== undefined && !isDue(known.atMs, now)) return known;
  const outcome = await probe();
  if (outcome !== "unknown") probed.set(key, { outcome, atMs: now });
  return { outcome, atMs: now };
}

/** DEFINITIVE outcomes only; "unknown" is never cached. The oversized-prompt variant doubles as the 1M probe.
 *    200            -> yes
 *    400            -> no: the model-level rejection class for our fixed request shape (unsupported model, exceeded prompt cap)
 *    anything else  -> unknown (another 2xx, auth, rate-limit, 5xx, network, timeout) */
type ProbeOutcome = "yes" | "no" | "unknown";

async function pingModel(
  fetchImpl: ProbeFetch,
  apiBase: string,
  headers: Record<string, string>,
  model: string,
  content: string,
): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(`${apiBase}/v1/messages`, {
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
