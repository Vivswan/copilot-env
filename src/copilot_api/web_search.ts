// Claude Code wired Direct cannot use its builtin WebSearch (an Anthropic server-side tool Copilot's
// compat layer rejects with a 400), but `POST /responses` with `tools: [{"type":"web_search"}]` runs
// the search on Copilot's backend. This is the plain client behind the `agent profile mcp --serve` server's
// `web_search` tool; it lives here, not in the MCP server, so that server stays a thin protocol adapter.

import { abortable } from "@std/async/abortable";
import { defaultFetch } from "../utils/fetch.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { caught } from "../utils/message.ts";
import { directRequestIdentity, fetchRawModels } from "./catalog.ts";
import { Credential } from "./credential.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import { ghTokenEnvVarsList, ghTokenFromEnv } from "./gh_cli.ts";
import {
  CODEX_EXEC_USER_AGENT,
  directClientHeaders,
  type IdentityAndHost,
  type ProbeFetch,
} from "./integration_identity.ts";
import {
  type AvailableModel,
  catalogModelPick,
  generateAliases,
  parseAvailableModels,
  parseCatalogModels,
} from "./models.ts";
import type { Profile } from "./profile.ts";

const logger = createStderrLogger();

/**
 * The same model the proxy defaults to on its Messages-API web-search path (the registry's
 * proxy.message-websearch-model default; a test pins the two), so one stored key and one default
 * drive both surfaces. Must stay a RAW catalog id, never an alias: the default is looked up in the
 * catalog as it is, with no alias resolution, and gives way to the catalog's cheapest Responses
 * model when the catalog lacks it (catalogModelPick).
 */
export const DEFAULT_WEB_SEARCH_MODEL = "gpt-5-mini";

const WEB_SEARCH_TIMEOUT_MS = 120_000;

const SEARCH_INSTRUCTIONS =
  "Search the web to answer the user's query. Answer concisely from the search results and cite the source URLs.";

/** Rejects on abort WITHOUT cancelling the work (abortable only races): the identity probe's
 *  memoized result is worth keeping even when this call stops waiting for it. An MCP cancellation
 *  carries a plain string as the reason, which the race surfaces as it is; the tool error needs
 *  an Error. */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  try {
    return await abortable(promise, signal);
  } catch (e) {
    if (!signal.aborted || e !== signal.reason || e instanceof Error) throw e;
    throw new Error(`web_search was cancelled: ${String(signal.reason)}`);
  }
}

interface WebSearchOptions {
  /** A named profile NEVER falls back to the default credential. */
  profile?: Profile;
  /** Wins over stored config. */
  model?: string;
  /** Test seam for both the identity probe and the POST. */
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One catalog fetch, read two ways: the alias map a configured value resolves through, and the
 *  model the default lands. */
interface CatalogView {
  aliases: Record<string, string>;
  /** DEFAULT_WEB_SEARCH_MODEL while the catalog lists it, else the cheapest Responses model it does. */
  defaultModel: string;
}

// Memoized per host and token so a long-lived MCP server pays the catalog fetch once. An injected
// fetchImpl bypasses the memo (the memo discipline of integration_identity.ts): test stubs sharing
// a token must not collide.
const catalogMemo = new Map<string, Promise<CatalogView>>();

export function resetWebSearchCatalogCache(): void {
  catalogMemo.clear();
}

function viewOf(raw: unknown): CatalogView {
  const available: AvailableModel[] = parseAvailableModels(raw);
  return {
    aliases: generateAliases(parseCatalogModels(raw)),
    defaultModel: catalogModelPick(available, DEFAULT_WEB_SEARCH_MODEL, "responses"),
  };
}

function catalogView(
  profile: Profile,
  token: string,
  pair: IdentityAndHost,
  fetchImpl?: ProbeFetch,
): Promise<CatalogView> {
  const { apiBase, integrationId } = pair;
  const build = async () =>
    viewOf(
      await fetchRawModels("direct", {
        profile,
        directToken: token,
        pair,
        fetchImpl,
        // The catalog names models for the /responses call below, so it is asked on that call's
        // host under that call's own identity (the version-free UA it sends).
        identity: { kind: "agents", userAgent: CODEX_EXEC_USER_AGENT },
      }),
    );
  if (fetchImpl !== undefined) return build();
  // Copilot gates the catalog per identity, so two profiles on one token and host with different
  // stored identities must not read each other's catalog.
  const key = `${apiBase}|${integrationId ?? ""}|${token}`;
  let pending = catalogMemo.get(key);
  if (pending === undefined) {
    pending = build();
    // A failed fetch must not poison the memo for a long-lived server.
    pending.catch(() => catalogMemo.delete(key));
    catalogMemo.set(key, pending);
  }
  return pending;
}

/**
 * The model the POST names, from the one `proxy.message-websearch-model` value the proxy reads
 * too (start.ts), so both surfaces agree:
 *   a configured value       -> resolved as an alias the way the proxy does; with no alias for it,
 *                               sent as-is (generateAliases skips identity mappings)
 *   nothing configured       -> the catalog view's default (DEFAULT_WEB_SEARCH_MODEL while the
 *                               catalog lists it, else its cheapest Responses model), said on
 *                               stderr as the daemon says its own pick at `agent start`
 *   the catalog fetch fails  -> warn and send the raw value
 */
async function resolveWebSearchModel(
  configured: string | null,
  profile: Profile,
  token: string,
  pair: IdentityAndHost,
  fetchImpl?: ProbeFetch,
): Promise<string> {
  const requested = configured ?? DEFAULT_WEB_SEARCH_MODEL;
  let view: CatalogView;
  try {
    view = await catalogView(profile, token, pair, fetchImpl);
  } catch (e) {
    logger.warn(
      caught(
        e,
        (message) =>
          `could not resolve '${requested}' against the live catalog (${message}); sending it as-is`,
      ),
    );
    return requested;
  }

  if (configured !== null) return view.aliases[configured] ?? configured;
  if (view.defaultModel !== DEFAULT_WEB_SEARCH_MODEL) {
    logger.info(
      `${DEFAULT_WEB_SEARCH_MODEL} is not in this credential's catalog; searching with ${view.defaultModel} (the cheapest Responses model it lists)`,
    );
  }
  return view.defaultModel;
}

/**
 * The ONE extra rule over Credential: an env fallback (GH_TOKEN et al.) when the default slot has no
 * provider recorded at all, so a bare clone (`GH_TOKEN=... bin/agent profile mcp --serve`) works without
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
  // No fetch is injected in production, so a probe stays MEMOIZED: a cancelled tool call stops
  // WAITING for a cold probe while the probe runs on and fills its memo for the next call.
  // The User-Agent is deliberately VERSION-FREE: the versioned codexUserAgent lives in the codex
  // layer, which this module must not import. Identity and host come as one pair, the profile's
  // stored pair under the pin and literal (directRequestIdentity), and the catalog fetch below
  // reuses the host, so one host and one identity serve every request here.
  const config = new CopilotEnvConfig();
  const pair = await raceWithAbort(
    directRequestIdentity(profile, token, CODEX_EXEC_USER_AGENT, {
      fetchImpl: opts.fetchImpl,
      narrator: logger,
    }),
    opts.signal,
  );
  const { integrationId, apiBase } = pair;
  const clientHeaders = directClientHeaders(CODEX_EXEC_USER_AGENT, integrationId);
  const configured = opts.model ?? config.messageApiWebSearchModel(profile);
  const model = await raceWithAbort(
    resolveWebSearchModel(configured, profile, token, pair, opts.fetchImpl),
    opts.signal,
  );
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...clientHeaders,
  };
  const url = `${apiBase}/responses`;
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? defaultFetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search" }],
      // Without this the model may answer from its own weights, and the tool's whole contract is
      // "the answer came from the live web".
      tool_choice: { type: "web_search" },
      instructions: SEARCH_INSTRUCTIONS,
      input: query,
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
    title !== "" ? `- ${title}: ${sourceUrl}` : `- ${sourceUrl}`,
  );
  return `${answer}\n\nSources:\n${lines.join("\n")}`;
}
