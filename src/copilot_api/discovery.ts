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

import { defaultFetch } from "../utils/fetch.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { caught } from "../utils/message.ts";
import { isDue } from "../utils/time.ts";
import { CODEX_IDENTITY_NAME } from "./config_registry.ts";
import { PING_TIMEOUT_MS } from "./endpoint_smoke.ts";
import { CopilotEnvState, type ModelVerdict } from "./env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  directClientHeaders,
  type ProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "./integration_identity.ts";
import { type CatalogModel, ONE_M_SUFFIX, parseCatalogModels } from "./models.ts";
import { fetchModelCatalog } from "./models_fetch.ts";

/** Narration on stderr: a caller's stdout may be a listing. */
const logger = createStderrLogger();

/** Raw /models bodies, keyed per credential and identity: entitlements differ per account and host. */
const catalogs = new Map<string, unknown>();

/** oracleAllowlist's answer per candidate: the allowlist a rejection printed, or "servable" for a 2xx. */
const oracled = new Map<string, string[] | "servable">();

/** Ping verdicts with their time, so the TTL (isDue) can expire them; an "unknown" is never kept. */
const probed = new Map<string, { outcome: "yes" | "no"; atMs: number }>();

/** Test hook: the next discovery asks as a fresh process would. The three memos hold what this
 *  process already asked Copilot: a run on the fs overlay lands its store write nowhere, so the real
 *  run after it pays none of these again, and probes are kept one by one so a definitive small
 *  ping survives an inconclusive 1m probe. */
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

/** How many gated candidates the oracle is asked before discovery gives up on an allowlist. */
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

/** What every request of one discovery goes out with. */
interface DiscoveryWire {
  /** The test seam for EVERY request this module makes. */
  fetchImpl: ProbeFetch;

  /** The host the wiring bakes (selectDirectIdentityAndHost). */
  apiBase: string;

  /** The credential's bearer. */
  token: string;

  /** The versioned codexUserAgent. */
  userAgent: string;

  /** The baked id; null = the default identity (no Copilot-Integration-Id header). */
  integrationId: string | null;

  /** The wiring's exact bytes plus the credential, for the POSTs (the GETs go through fetchModelCatalog, which adds the bearer). */
  headers: Record<string, string>;

  /** The verdict-cache key segment for the host and token (credentialDigest). */
  credential: string;
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
  const wire: DiscoveryWire = {
    fetchImpl: opts.fetchImpl ?? defaultFetch,
    apiBase,
    token,
    userAgent,
    integrationId,
    headers: { ...directClientHeaders(userAgent, integrationId), Authorization: `Bearer ${token}` },
    credential: await credentialDigest(`${apiBase}|${token}`),
  };

  const catalogBody = await catalogUnder(wire, integrationId);
  const advertised = parseCatalogModels(catalogBody);
  const models = [...advertised];
  const unlisted: string[] = [];

  try {
    const extras = await unadvertisedClaudeIds(wire, advertised);
    const state = new CopilotEnvState();
    const now = opts.nowMs?.() ?? Date.now();
    for (const id of extras) {
      // `agent profile models` and the Desktop wiring share the persisted verdicts, so a DEFINITIVE one costs its
      // billed ping once per model+identity+credential per day for sequential runs; overlapping runs each
      // probe. An inconclusive probe caches nothing (probeExtra), so it pings again on the next invocation.
      const key = `${wire.credential}|${identityKey(integrationId)}|${id}`;
      let verdict = state.readModelVerdict(key);
      if (verdict === null || isDue(verdict.atMs, now)) {
        const probed = await probeExtra(wire, id, key, now);
        verdict = probed.verdict;
        if (probed.definitive) state.setModelVerdict(key, verdict);
      }
      if (verdict.servable) {
        models.push({ id, is1m: verdict.is1m });
        unlisted.push(id);
      }
    }
  } catch (e) {
    logger.warn(
      caught(
        e,
        (message) => `  model discovery: enrichment failed (${message}); using the catalog alone.`,
      ),
    );
  }
  return { catalogBody, models, unlisted };
}

/** A short non-reversible digest of the host and token for the verdict-cache key (never the token). */
async function credentialDigest(hostAndToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostAndToken));
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The raw /models body under `integrationId` (the wiring's own, or another identity's for the
 *  trigger), fetched once per credential and identity in this process; a failure throws with the
 *  status (an unusable 2xx body or a network error rethrows its own error) and is not remembered. */
async function catalogUnder(wire: DiscoveryWire, integrationId: string | null): Promise<unknown> {
  const key = `${wire.credential}|${identityKey(integrationId)}`;
  if (catalogs.has(key)) return catalogs.get(key);
  const got = await fetchModelCatalog({
    host: wire.apiBase,
    token: wire.token,
    headers: directClientHeaders(wire.userAgent, integrationId),
    fetchImpl: wire.fetchImpl,
  });
  switch (got.kind) {
    case "ok":
      catalogs.set(key, got.body);
      return got.body;
    case "http":
      throw new Error(`GET ${wire.apiBase}/models returned ${got.status}`);
    default:
      throw got.error;
  }
}

/** Empty when no gated trigger id exists or the oracle's error shape is not understood: never a guess. */
async function unadvertisedClaudeIds(
  wire: DiscoveryWire,
  advertised: CatalogModel[],
): Promise<string[]> {
  const ownIds = new Set(advertised.map((m) => m.id));
  const candidates = await gatedTriggerIds(wire, ownIds);
  for (const candidate of candidates.slice(0, ORACLE_ATTEMPTS)) {
    const key = `${wire.credential}|${identityKey(wire.integrationId)}|${candidate}`;
    let answer = oracled.get(key);
    if (answer === undefined) {
      const asked = await oracleAllowlist(wire, candidate);
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

/** The ids the OTHER identities' catalogs list that the wiring's own does not: real but gated under
 *  ours, so any one of them makes the oracle print its allowlist. First seen first, no duplicates. */
async function gatedTriggerIds(
  wire: DiscoveryWire,
  ownIds: ReadonlySet<string>,
): Promise<string[]> {
  const candidates: string[] = [];
  for (const id of KNOWN_IDENTITY_IDS) {
    if (id === wire.integrationId) continue;
    try {
      const body = await catalogUnder(wire, id);
      for (const model of parseCatalogModels(body)) {
        if (!ownIds.has(model.id) && !candidates.includes(model.id)) candidates.push(model.id);
      }
    } catch {
      // One identity's catalog failing must not sink the others.
    }
  }
  return candidates;
}

/** The allowlist the rejection printed; "servable" for a 2xx (the id turned out servable, and
 *  max_output_tokens caps the accident at one billed token); null for an unrecognized error
 *  shape. */
async function oracleAllowlist(
  wire: DiscoveryWire,
  gatedId: string,
): Promise<string[] | "servable" | null> {
  const res = await wire.fetchImpl(`${wire.apiBase}/responses`, {
    method: "POST",
    headers: { ...wire.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: gatedId,
      input: "x",
      stream: false,
      max_output_tokens: 1,
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

/** A fresh probe of one extra: the small ping, then the 1m probe when it answered. `definitive`
 *  is false when either came back "unknown" (a timeout / 429 / 5xx), and only a definitive verdict
 *  may be cached: an inconclusive one must not wedge a servable model out (or in) for a whole TTL
 *  window, so it is used once (servable while the ping answered, never 1m) and probed again next time. */
async function probeExtra(
  wire: DiscoveryWire,
  id: string,
  key: string,
  now: number,
): Promise<{ verdict: ModelVerdict; definitive: boolean }> {
  const ping = await probeOnce(`${key}|ping`, now, () => pingModel(wire, id, "x"));
  let oneM: ProbeOutcome = "no";
  if (ping.outcome === "yes") {
    const probe = await probeOnce(`${key}|1m`, now, () =>
      pingModel(wire, id, "x ".repeat(ONE_M_PROBE_TOKENS)),
    );
    oneM = probe.outcome;
  }
  return {
    verdict: { servable: ping.outcome === "yes", is1m: oneM === "yes", atMs: ping.atMs },
    definitive: ping.outcome !== "unknown" && oneM !== "unknown",
  };
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
  wire: DiscoveryWire,
  model: string,
  content: string,
): Promise<ProbeOutcome> {
  try {
    const res = await wire.fetchImpl(`${wire.apiBase}/v1/messages`, {
      method: "POST",
      headers: {
        ...wire.headers,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1,
        messages: [{ role: "user", content: content }],
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
