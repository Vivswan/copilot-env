// Claude Code wired Direct cannot use its builtin WebSearch (an Anthropic server-side tool Copilot's
// compat layer rejects with a 400), but `POST /responses` with `tools: [{"type":"web_search"}]` runs
// the search on Copilot's backend. This is the plain client behind the `agent mcp --serve` server's
// `web_search` tool; it lives here, not in the MCP server, so that server stays a thin protocol adapter.

import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { fetchRawModels } from "./catalog.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import { ghTokenEnvVarsList, ghTokenFromEnv } from "./gh_cli.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  type ProbeFetch,
  resolveDirectIntegrationId,
} from "./integration_identity.ts";
import { generateAliases, parseCatalogModels } from "./models.ts";
import type { Profile } from "./profile.ts";

const logger = createStderrLogger();

/**
 * The same model the proxy defaults to on its Messages-API web-search path, so one stored key and one
 * default drive both surfaces. Must stay a RAW catalog id, never an alias: the default path skips
 * alias resolution so it stays fetch-free.
 */
export const DEFAULT_WEB_SEARCH_MODEL = "gpt-5-mini";

const WEB_SEARCH_TIMEOUT_MS = 120_000;

const SEARCH_INSTRUCTIONS =
  "Search the web to answer the user's query. Answer concisely from the search results and cite the source URLs.";

/** Rejects on abort WITHOUT cancelling the work: the identity probe's memoized result is worth keeping
 *  even when this call stops waiting for it. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abortError = () => {
      // MCP cancellations carry a plain string as the reason.
      if (signal.reason instanceof Error) return signal.reason;
      if (signal.reason === undefined || signal.reason === null) {
        return new Error("web_search was cancelled");
      }
      return new Error(`web_search was cancelled: ${String(signal.reason)}`);
    };
    if (signal.aborted) {
      promise.catch(() => {});
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
  /** A named profile NEVER falls back to the default credential. */
  profile?: Profile;
  /** Wins over stored config. */
  model?: string;
  /** Test seam for both the identity probe and the POST. */
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Memoized per token so a long-lived MCP server pays the catalog fetch once. An injected fetchImpl
// bypasses the memo (the probeMemo precedent in integration_identity.ts): test stubs sharing a token must not collide.
const aliasMemo = new Map<string, Promise<Record<string, string>>>();

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
    // A failed fetch must not poison the memo for a long-lived server.
    pending.catch(() => aliasMemo.delete(token));
    aliasMemo.set(token, pending);
  }
  return pending;
}

/**
 * Resolves an alias the way the proxy does for the same stored key (start.ts), so ONE
 * `message-websearch-model` value drives both surfaces.
 *
 *   the catalog fetch fails  -> warn and send the raw value
 *   no alias for the value   -> sent as-is; generateAliases skips identity mappings
 */
async function resolveWebSearchModel(
  model: string,
  token: string,
  fetchImpl?: ProbeFetch,
): Promise<string> {
  try {
    return (await catalogAliases(token, fetchImpl))[model] ?? model;
  } catch (e) {
    logger.warn(
      `could not resolve '${model}' against the live catalog (${errMessage(e)}); sending it as-is`,
    );
    return model;
  }
}

/**
 * The ONE extra rule over Credential: an env fallback (GH_TOKEN et al.) when the default slot has no
 * provider recorded at all, so a bare clone (`GH_TOKEN=... bin/agent mcp --serve`) works without
 * `agent auth`. A recorded-but-broken provider still errors instead of silently switching credentials.
 */
export function resolveWebSearchCredential(profile: Profile = null): string {
  const credential = new Credential(undefined, profile);
  const { token, reason } = credential.resolveWithReason();
  if (token !== null) return token;
  if (profile === null && credential.provider() === null) {
    const fromEnv = ghTokenFromEnv();
    if (fromEnv !== null) return fromEnv;
    throw new Error(`${reason} or set one of ${ghTokenEnvVarsList()}`);
  }
  throw new Error(reason);
}

export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<string> {
  const profile = opts.profile ?? null;
  const token = resolveWebSearchCredential(profile);
  const configured = opts.model ?? new CopilotEnvConfig().messageApiWebSearchModel();
  // Only a configured value can be an alias; the built-in default is a raw catalog id, so the default
  // path stays fetch-free.
  const model = configured === null
    ? DEFAULT_WEB_SEARCH_MODEL
    : await raceWithAbort(resolveWebSearchModel(configured, token, opts.fetchImpl), opts.signal);
  // No fetch is injected in production, so the probe stays MEMOIZED: a cancelled tool call stops
  // WAITING for a cold PAT probe while the probe runs on and fills its memo for the next call.
  // The User-Agent is deliberately VERSION-FREE: the versioned codexUserAgent lives in the codex
  // layer, which this module must not import.
  const integrationId = await raceWithAbort(
    resolveDirectIntegrationId(token, CODEX_EXEC_USER_AGENT, {
      pinned: new CopilotEnvConfig().pinnedIntegrationId(),
      apiBase: DEFAULT_COPILOT_API_BASE,
      fetchImpl: opts.fetchImpl,
    }),
    opts.signal,
  );
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    ...directClientHeaders(CODEX_EXEC_USER_AGENT, integrationId),
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
      // Without this the model may answer from its own weights, and the tool's whole contract is
      // "the answer came from the live web".
      "tool_choice": { "type": "web_search" },
      "instructions": SEARCH_INSTRUCTIONS,
      "input": query,
    }),
    signal: opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // The body lands in MCP error content (model context); a huge error page must not flood it.
    const capped = detail.length > 600 ? `${detail.slice(0, 600)}...` : detail;
    throw new Error(`POST ${url} returned ${res.status} ${res.statusText} ${capped}`.trim());
  }
  return parseResponsesOutput(await res.json());
}

/** Exported for fixture tests. The `output` array carries `web_search_call` items (ignored) and
 *  `message` items whose `output_text` parts may carry `url_citation` annotations. */
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
    title !== "" ? `- ${title}: ${sourceUrl}` : `- ${sourceUrl}`
  );
  return `${answer}\n\nSources:\n${lines.join("\n")}`;
}
