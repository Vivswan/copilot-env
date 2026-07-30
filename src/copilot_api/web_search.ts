// Copilot web search over the Responses API. Claude Code wired Direct cannot use
// its builtin WebSearch (an Anthropic server-side tool Copilot's compat layer
// rejects with a 400), but `POST /responses` with `tools: [{"type":"web_search"}]`
// executes the search on Copilot's backend and returns a cited answer. This module
// is the plain client behind the `agent mcp --serve` server's `web_search` tool:
// credential -> client identity -> one POST -> answer text with a `Sources:` list.
// It stays in the copilot_api layer (like admin.ts / catalog.ts, the other REST
// clients) so the MCP server remains a thin protocol adapter over it.
import { ghTokenEnvVarsList, ghTokenFromEnv } from "../utils/direct_probe.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { fetchRawModels } from "./catalog.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  type ProbeFetch,
  resolveDirectIntegrationId,
} from "./integration_identity.ts";
import { generateAliases, parseCatalogModels } from "./models.ts";
import { type Profile, profileLabel } from "./profile.ts";

const logger = createStderrLogger();

/**
 * Built-in default model for THIS surface when `message-websearch-model` is unset.
 * Deliberately different from the proxy's own default for the same stored key
 * (the Messages-API path defaults to a small model inside the proxy); one stored
 * override drives both surfaces. Must remain a RAW catalog id, never an alias:
 * the default path skips alias resolution so it stays fetch-free.
 */
export const DEFAULT_WEB_SEARCH_MODEL = "gpt-5.6-sol";

/**
 * Version-free User-Agent for /responses calls: the shared Codex product token
 * from integration_identity.ts. The VERSIONED form this endpoint normally sees
 * lives in the codex layer (codexUserAgent), which this module must not import;
 * staying version-free mirrors the module-local PROBE_USER_AGENT precedent in
 * integration_identity.ts.
 */
const RESPONSES_USER_AGENT = CODEX_EXEC_USER_AGENT;

const WEB_SEARCH_TIMEOUT_MS = 120_000;

const SEARCH_INSTRUCTIONS =
  "Search the web to answer the user's query. Answer concisely from the search results and cite the source URLs.";

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts -- WITHOUT
 * cancelling the underlying work. Used for the identity probe: its memoized
 * result is worth keeping even when this call stops waiting for it.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abortError = () => {
      // Preserve the caller's reason (MCP cancellations carry a plain string).
      if (signal.reason instanceof Error) return signal.reason;
      if (signal.reason === undefined || signal.reason === null) {
        return new Error("web_search was cancelled");
      }
      return new Error(`web_search was cancelled: ${String(signal.reason)}`);
    };
    if (signal.aborted) {
      promise.catch(() => {}); // abandoned, not cancelled -- swallow its outcome
      reject(abortError());
      return;
    }
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface WebSearchOptions {
  /** Credential slot; a named profile NEVER falls back to the default credential. */
  profile?: Profile;
  /** Explicit model override (already validated non-empty); wins over stored config. */
  model?: string;
  /** Injection seam for tests (both the identity probe and the POST go through it). */
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /** Client-side cancellation (the MCP server passes the request's signal through). */
  signal?: AbortSignal;
}

// Memoized per token so a long-lived MCP server pays the catalog fetch once.
// Injected fetchImpl bypasses the memo (the probeMemo precedent in
// integration_identity.ts): test stubs sharing a token must not collide.
const aliasMemo = new Map<string, Promise<Record<string, string>>>();

/** Test hook: drop the alias memo (mirrors resetIntegrationIdentityCache). */
export function resetWebSearchAliasCache(): void {
  aliasMemo.clear();
}

function catalogAliases(token: string, fetchImpl?: ProbeFetch): Promise<Record<string, string>> {
  const build = async () =>
    generateAliases(
      parseCatalogModels(await fetchRawModels("direct", { directToken: token, fetchImpl })),
    );
  if (fetchImpl !== undefined) return build();
  let pending = aliasMemo.get(token);
  if (pending === undefined) {
    pending = build();
    // A failed fetch must not poison the memo for a long-lived server: drop it
    // so the next call retries.
    pending.catch(() => aliasMemo.delete(token));
    aliasMemo.set(token, pending);
  }
  return pending;
}

/**
 * Resolve a catalog-derived alias (`gpt-latest`, `claude-latest`, `opus[1m]`, ...)
 * the way the proxy does for the same stored key (start.ts), so the ONE
 * `message-websearch-model` value drives both surfaces. BEST-EFFORT: on catalog
 * failure warn and send the raw value (what this client always did). A lookup
 * miss is a pass-through -- generateAliases skips identity mappings, so an exact
 * catalog id sails through unchanged.
 */
async function resolveWebSearchModel(
  model: string,
  token: string,
  fetchImpl?: ProbeFetch,
): Promise<string> {
  try {
    return (await catalogAliases(token, fetchImpl))[model] ?? model;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.warn(
      `could not resolve '${model}' against the live catalog (${detail}); sending it as-is`,
    );
    return model;
  }
}

/**
 * The GitHub token the search runs under, or throw with a pointed message.
 * Provider-driven like every other read of the credential; the ONE extra rule here
 * is an explicit env fallback (GH_TOKEN et al.) when the default slot has no
 * provider recorded at all -- that keeps a bare clone (`GH_TOKEN=... bin/agent mcp --serve`)
 * working without `agent auth`, while a recorded-but-broken provider still errors
 * instead of silently switching credentials.
 */
export function resolveWebSearchCredential(profile: Profile = null): string {
  const credential = new Credential(undefined, profile);
  const token = credential.resolve();
  if (token !== null) return token;
  if (profile !== null) {
    throw new Error(
      `no GitHub credential for ${profileLabel(profile)} - run \`agent auth --profile ${profile}\` ` +
        "to log in (a named profile never falls back to the default credential)",
    );
  }
  if (credential.provider() === null) {
    const fromEnv = ghTokenFromEnv();
    if (fromEnv !== null) return fromEnv;
  }
  throw new Error(
    `no GitHub credential - run \`agent auth\` to log in or set one of ${ghTokenEnvVarsList()}`,
  );
}

/** Search the web through Copilot's /responses endpoint; returns cited answer text. */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<string> {
  const profile = opts.profile ?? null;
  const token = resolveWebSearchCredential(profile);
  const configured = opts.model ?? new CopilotEnvConfig().read().messageApiWebSearchModel ?? null;
  // Only a configured value can be an alias; the built-in default is maintained
  // as a raw catalog id, so the default path stays fetch-free. Like the probe
  // below, a cancelled call stops WAITING but leaves the memo filling.
  const model =
    configured === null
      ? DEFAULT_WEB_SEARCH_MODEL
      : await raceWithAbort(resolveWebSearchModel(configured, token, opts.fetchImpl), opts.signal);
  // The probe stays MEMOIZED (a per-credential result the next call reuses), so no
  // fetch is injected in production -- instead a cancelled tool call merely stops
  // WAITING for a cold PAT probe (raceWithAbort below); the probe runs on and fills
  // its memo for the next call.
  const integrationId = await raceWithAbort(
    resolveDirectIntegrationId(token, RESPONSES_USER_AGENT, {
      pinned: new CopilotEnvConfig().pinnedIntegrationId(),
      apiBase: DEFAULT_COPILOT_API_BASE,
      fetchImpl: opts.fetchImpl,
    }),
    opts.signal,
  );
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    ...directClientHeaders(RESPONSES_USER_AGENT, integrationId),
  };
  const url = `${DEFAULT_COPILOT_API_BASE}/responses`;
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      "stream": false,
      "reasoning": { "effort": "low" },
      "tools": [{ "type": "web_search" }],
      // Force the search: without this the model may answer from its own weights,
      // and this tool's whole contract is "the answer came from the live web".
      "tool_choice": { "type": "web_search" },
      "instructions": SEARCH_INSTRUCTIONS,
      "input": query,
    }),
    signal: opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Cap the upstream body: it lands in MCP error content (model context), and a
    // hostile/huge error page must not flood it.
    const capped = detail.length > 600 ? `${detail.slice(0, 600)}...` : detail;
    throw new Error(`POST ${url} returned ${res.status} ${res.statusText} ${capped}`.trim());
  }
  return parseResponsesOutput(await res.json());
}

/**
 * Reduce a /responses body to answer text plus a `Sources:` list. The `output`
 * array carries `web_search_call` items (ignored) and `message` items whose
 * `content[]` holds `output_text` parts; each part may carry `url_citation`
 * annotations. Exported for fixture tests.
 */
export function parseResponsesOutput(body: unknown): string {
  const output = isRecord(body) && Array.isArray(body.output) ? body.output : [];
  const texts: string[] = [];
  const sources = new Map<string, string>();
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text") continue;
      if (typeof part.text === "string" && part.text.trim() !== "") texts.push(part.text);
      if (!Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
        if (typeof annotation.url !== "string" || annotation.url === "") continue;
        const title = typeof annotation.title === "string" ? annotation.title : "";
        if (!sources.has(annotation.url)) sources.set(annotation.url, title);
      }
    }
  }
  const answer = texts.join("\n").trim();
  if (answer === "") {
    const status = isRecord(body) && typeof body.status === "string" ? body.status : null;
    throw new Error(
      "the /responses body carried no answer text (no message output items)" +
        (status !== null && status !== "completed" ? ` - response status: ${status}` : ""),
    );
  }
  if (sources.size === 0) return answer;
  const lines = [...sources.entries()].map(([sourceUrl, title]) =>
    title !== "" ? `- ${title}: ${sourceUrl}` : `- ${sourceUrl}`,
  );
  return `${answer}\n\nSources:\n${lines.join("\n")}`;
}
