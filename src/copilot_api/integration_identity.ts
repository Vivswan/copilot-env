// Copilot's inference hosts gate each request on a client identity, and which identities accept
// which credential class is undocumented server behavior that has changed over time. So instead of
// per-token-shape rules we PROBE an ordered candidate list (GET /models, first 2xx wins) on the host
// the result is USED on. An identity is a HEADER SET, not an id: the `User-Agent` and the
// `Copilot-Integration-Id` (or its absence) decide together what the host serves. ONE identity per
// credential serves every mode: the Direct configs bake it, and the daemon's client-headers preload
// applies the same set to the proxy's upstream requests, so both see one catalog.
// Verified July 2026, on individual AND enterprise-plan seats:
//   fine-grained PAT under `vscode-chat`            -> 400 "Personal Access Tokens are not supported for this endpoint"
//   fine-grained PAT under `copilot-developer-cli`  -> accepted
//   `gho_` OAuth token under either                 -> accepted
//   any PAT at the editor token exchange            -> 403, so a passthrough token lives or dies by this header alone
// Verified September 2026 (the catalog is gated on the PAIR):
//   codex_exec UA, no id                            -> 50 models, Fable included
//   codex_exec UA with any id                       -> 33-41 models, no Fable
//   the proxy's own editor UA, with or without id   -> 40-41 models, no Fable
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { CODEX_IDENTITY_NAME, isLoopbackHostname } from "./env_config.ts";
import type { AuthProvider } from "./env_state.ts";
import { fetchModelCatalog, type ModelCatalogOutcome } from "./models_fetch.ts";

/** The gating header. Its VALUES below are external contracts: never rename. */
export const INTEGRATION_ID_HEADER = "Copilot-Integration-Id";
/** The VS Code Chat extension's identity, copilot-api's own upstream default before the daemon's
 *  preload replaced it; the last candidate, and discovery consults its catalog for unadvertised
 *  models. */
export const VSCODE_CHAT_INTEGRATION_ID = "vscode-chat";
/** GitHub Copilot CLI's identity, the one verified to accept fine-grained PATs. */
export const COPILOT_CLI_INTEGRATION_ID = "copilot-developer-cli";
/** Tried after the CLI one; accepts PATs on some plans. */
export const COPILOT_SANDBOX_INTEGRATION_ID = "copilot-developer-sandbox";
/** Owned here, the layer-neutral home, so codexUserAgent (codex layer, appends `/<version>`) and the
 *  /responses web-search client (this layer, version-free) derive from ONE spelling. */
export const CODEX_EXEC_USER_AGENT = "codex_exec";

/** The client-headers preload (src/scripts/client_headers_preload.ts) reads this JSON header set
 *  (daemonClientHeaders) and applies it to the daemon's fetch and WebSocket requests to the Copilot
 *  API hosts. Not a secret, so plain env, no argv splice. */
export const DAEMON_CLIENT_HEADERS_ENV = "COPILOT_ENV_DAEMON_CLIENT_HEADERS";

/** Where the account's designated API base is discovered (best-effort). */
export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
/** The generic host, what `host auto` lands on unless it is blocked for the credential. */
export const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

/** The copilot-host preload (src/scripts/copilot_host_preload.ts) reads this and rewrites the
 *  `endpoints.api` the daemon learns from GitHub, so the proxy talks to the same host as Direct. */
export const DAEMON_COPILOT_HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";

/** The base-URL SHAPE of a Direct wiring: an https origin, whatever the host. Detection keys on
 *  copilot-env's own markers (the managed helper, provider name, auth shape) plus this shape, never
 *  on a host list, so a wiring baked for a past plan host or literal stays ours and a rewire moves
 *  it from the slot's stored pair (resolveDirectWiring, src/agents/profile_wiring.ts). */
export function isDirectBaseUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  // The same origin-only shape the `host` validator enforces: a path, query, or userinfo
  // is some other API, and a loopback https origin is nobody's Copilot host.
  return parsed.protocol === "https:" && !isLoopbackHostname(parsed.hostname) &&
    (parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "" &&
    parsed.hash === "" && parsed.username === "" && parsed.password === "";
}

const PROBE_TIMEOUT_MS = 5000;

/** Just the call signature, so a plain stub (or globalThis.fetch, which also has `.preconnect`) is
 *  assignable without ceremony. */
export type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// A module-level seam, not only a per-call arg, so command entry points reached through many layers
// (runClaude, applyCodexConfig, agent start) stay hermetic in tests without threading a dep through every one.
let defaultProbeFetch: ProbeFetch = (input, init) => globalThis.fetch(input, init);

/** Test hook. Clears the memo so a new fetch is actually exercised. */
export function setIntegrationProbeFetch(fetchImpl: ProbeFetch | null): void {
  defaultProbeFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  probeMemo.clear();
  hostMemo.clear();
  verdictMemo.clear();
}

/** Version-free on purpose so nothing here drifts against a client release; never sent by an agent
 *  (the daemon and the baked direct configs carry their own real client UAs). */
const PROBE_USER_AGENT = "copilot-env";

export interface IntegrationIdentity {
  /** The id header's value, or CODEX_IDENTITY_NAME for the set that sends none. */
  name: string;
  /** Authorization is added by callers. */
  headers: Record<string, string>;
}

/** The header set a Direct agent bakes for `id`, through THE single builder. */
export function directIdentity(userAgent: string, id: string): IntegrationIdentity {
  return { name: id, headers: directClientHeaders(userAgent, id) };
}

/**
 * THE single builder: the probe candidates and every writer that applies the result (Codex `http_headers`,
 * Claude ANTHROPIC_CUSTOM_HEADERS, the /responses web-search client, the daemon's client-headers
 * preload through daemonClientHeaders) go through it, so the probe can never validate a header set
 * nothing actually sends. The id is omitted when null: that absence, beside the codex User-Agent, IS
 * the codex identity (the file header's catalog facts).
 */
export function directClientHeaders(
  userAgent: string,
  integrationId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": userAgent,
  };
  if (integrationId) headers[INTEGRATION_ID_HEADER] = integrationId;
  return headers;
}

/** What the daemon's preload applies to an upstream request: every header of the identity's set is
 *  SET, and a null names a header to DELETE, so the proxy's own `vscode-chat` cannot stand in for
 *  the codex identity. Derived from directClientHeaders, never spelled apart from it. */
export type DaemonClientHeaders = Record<string, string | null>;

export function daemonClientHeaders(
  userAgent: string,
  integrationId: string | null,
): DaemonClientHeaders {
  return { [INTEGRATION_ID_HEADER]: null, ...directClientHeaders(userAgent, integrationId) };
}

/**
 * THE candidate list, one for every mode, in probe order: the codex identity (no id header) first,
 * since it is the set the widest catalog was verified under, then the CLI and sandbox ids that
 * accept credentials the codex set refuses (a fine-grained PAT), and copilot-api's former default
 * last, for a credential the three others reject. The order is fixed: a later candidate is reached
 * only once every earlier one has answered without a 2xx. `userAgent` rides in as a parameter
 * because this module must not import the codex layer: callers pass either the detected
 * codexUserAgent() or the version-free CODEX_EXEC_USER_AGENT (web_search.ts).
 */
export function identityCandidates(
  userAgent: string,
): [IntegrationIdentity, ...IntegrationIdentity[]] {
  return [
    { name: CODEX_IDENTITY_NAME, headers: directClientHeaders(userAgent) },
    directIdentity(userAgent, COPILOT_CLI_INTEGRATION_ID),
    directIdentity(userAgent, COPILOT_SANDBOX_INTEGRATION_ID),
    directIdentity(userAgent, VSCODE_CHAT_INTEGRATION_ID),
  ];
}

/** What a pin of `id` sends, for the pin's pre-check: the one header set every mode sends. */
export function pinnedIdentityCandidates(id: string, userAgent: string): IntegrationIdentity[] {
  return [directIdentity(userAgent, id)];
}

export function bakedIntegrationId(identity: IntegrationIdentity): string | null {
  return identity.headers[INTEGRATION_ID_HEADER] ?? null;
}

export interface IdentityProbeOutcome {
  name: string;
  /** "ok", an HTTP rejection ("400 <body snippet>"), or a network error message. */
  detail: string;
}

export interface IdentityProbeResult {
  identity: IntegrationIdentity | null;
  /** false when a network error or an ambiguous status made the run inconclusive, so callers keep the
   *  default rather than failing hard on a flaky network. */
  conclusive: boolean;
  /** The host probed (`IdentityProbeDeps.apiBase`), echoed so a refusal names it. */
  apiBase: string;
  /** In probe order. */
  outcomes: IdentityProbeOutcome[];
}

export interface IdentityProbeDeps {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /** A caller deadline over the WHOLE probe chain, combined with each request's own timeout. */
  signal?: AbortSignal;
  /** The host the verdict is used on: always the caller's, never discovered here
   *  (selectDirectIdentityAndHost owns the host question). */
  apiBase: string;
}

function requestSignal(timeoutMs: number, deadline: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return deadline === undefined ? timeout : AbortSignal.any([deadline, timeout]);
}

/** Error bodies can be huge. */
function truncate(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * The account's designated host, read by the survey (its "designated" column) and by the `auto` host
 * rule once the generic host is blocked. `inconclusive` marks a TRANSIENT lookup failure: the survey
 * shows that column as unknown rather than "the same", since the fallback returned here may not be
 * where this credential is served.
 */
async function accountApiBase(
  token: string,
  fetchImpl: ProbeFetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ apiBase: string; inconclusive: boolean }> {
  try {
    const res = await fetchImpl(COPILOT_USER_URL, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": PROBE_USER_AGENT,
      },
      signal: requestSignal(timeoutMs, signal),
    });
    if (!res.ok) {
      // A definitive status (401, a bad token) just means "no custom host"; a transient one leaves the
      // real host unknown.
      return {
        apiBase: DEFAULT_COPILOT_API_BASE,
        inconclusive: !isDefinitiveRejection(res.status),
      };
    }
    const body: unknown = await res.json();
    const endpoints = isRecord(body) ? body.endpoints : undefined;
    const api = isRecord(endpoints) ? endpoints.api : undefined;
    // The origin alone, so the value compares with the `host` literal and a baked base URL.
    const apiBase = typeof api === "string" && api.startsWith("https://") && URL.canParse(api)
      ? new URL(api).origin
      : DEFAULT_COPILOT_API_BASE;
    return { apiBase, inconclusive: false };
  } catch {
    return { apiBase: DEFAULT_COPILOT_API_BASE, inconclusive: true };
  }
}

/** Only 400 (the verified "Personal Access Tokens are not supported" identity rejection) and 401 (invalid
 *  token) qualify; 403/404/408/429/5xx read inconclusive so a policy blip, an outage, or rate limiting
 *  degrades to the default identity instead of throwing. */
function isDefinitiveRejection(status: number): boolean {
  return status === 400 || status === 401;
}

export type IdentityVerdict =
  /** `models` is the /models catalog size under this identity, counted by the same parse `agent
   *  models` lists (parseModelList: id-less entries dropped, duplicate ids merged), null when the
   *  2xx body was not the catalog shape. */
  | { kind: "accepted"; models: number | null }
  /** A definitive 400/401, as `<status> <body snippet>`. */
  | { kind: "rejected"; detail: string }
  /** A network error (`status` null) or a non-definitive status: the identity may still work. The
   *  host rule reads `status` (genericHostBlockedBy), so the same probe answers both questions. */
  | { kind: "inconclusive"; detail: string; status: number | null };

/** THE one "blocked host" rule (`host auto`): a status the credential could never draw for
 *  an identity reason. 403, 404, and 5xx mean the account is served elsewhere; 2xx serves, 400 is an
 *  identity rejection and 401 a bad token (identical on every host), and a transient 408 or 429
 *  says nothing about the host. A network-level failure counts as blocked at the call site. */
function genericHostBlockedBy(status: number): boolean {
  return status === 403 || status === 404 || status >= 500;
}

// One verdict per (token, host, header set) in a process, shared by the survey, the selectors, and
// the host rule: the table `agent auth --identities` prints and a selection in the same process come
// from the SAME responses, so a status that flips between two request rounds cannot show an
// accepted cell beside a refusal.
// Process-lifetime like probeMemo; injected I/O bypasses it (see probeIntegrationIdentityCached).
const verdictMemo = new Map<string, Promise<IdentityVerdict>>();

/** Whether a probe's deps are the production ones, so its verdicts may be memoized. */
function memoizable(deps: Pick<IdentityProbeDeps, "fetchImpl" | "timeoutMs" | "signal">): boolean {
  return deps.fetchImpl === undefined && deps.timeoutMs === undefined && deps.signal === undefined;
}

/** `<status> <body snippet>` for a rejection, `network error: <reason>` otherwise. */
function failureDetail(
  outcome: Exclude<ModelCatalogOutcome, { kind: "ok" | "unparsable" }>,
): string {
  return truncate(
    outcome.kind === "http"
      ? `${outcome.status} ${outcome.body}`
      : `network error: ${errMessage(outcome.error)}`,
  );
}

/** One GET /models under one identity; never throws. Acceptance is the status alone, as it always
 *  has been: a 2xx whose body is not the catalog counts as accepted with no size. */
function probeCandidate(
  token: string,
  apiBase: string,
  candidate: IntegrationIdentity,
  fetchImpl: ProbeFetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  memoize: boolean,
): Promise<IdentityVerdict> {
  const request = async (): Promise<IdentityVerdict> => {
    const got = await fetchModelCatalog({
      host: apiBase,
      token,
      headers: candidate.headers,
      fetchImpl,
      timeoutMs,
      signal,
    });
    switch (got.kind) {
      case "ok":
        return { kind: "accepted", models: got.models === null ? null : got.models.length };
      case "unparsable":
        return { kind: "accepted", models: null };
      case "http":
        return isDefinitiveRejection(got.status)
          ? { kind: "rejected", detail: failureDetail(got) }
          : { kind: "inconclusive", detail: failureDetail(got), status: got.status };
      case "network":
        return { kind: "inconclusive", detail: failureDetail(got), status: null };
    }
  };
  if (!memoize) return request();
  const key = JSON.stringify([token, apiBase, candidate.headers]);
  let pending = verdictMemo.get(key);
  if (pending === undefined) {
    pending = request();
    verdictMemo.set(key, pending);
  }
  return pending;
}

/** Never throws; `conclusive` marks a verdict worth acting on, and it has two shapes.
 *
 *  a candidate accepted                                        -> identity set, conclusive
 *  every candidate rejected 400/401                            -> identity null, conclusive
 *  a candidate 403/404/408/429/5xx/network error               -> identity null, inconclusive
 */
export async function probeIntegrationIdentity(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps,
): Promise<IdentityProbeResult> {
  const fetchImpl = deps.fetchImpl ?? defaultProbeFetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { apiBase } = deps;
  const outcomes: IdentityProbeOutcome[] = [];
  let sawInconclusive = false;
  for (const candidate of candidates) {
    const verdict = await probeCandidate(
      token,
      apiBase,
      candidate,
      fetchImpl,
      timeoutMs,
      deps.signal,
      memoizable(deps),
    );
    if (verdict.kind === "accepted") {
      outcomes.push({ name: candidate.name, detail: "ok" });
      return { identity: candidate, conclusive: true, apiBase, outcomes };
    }
    if (verdict.kind === "inconclusive") sawInconclusive = true;
    outcomes.push({ name: candidate.name, detail: verdict.detail });
  }
  return { identity: null, conclusive: !sawInconclusive, apiBase, outcomes };
}

/** Why a host is a survey column. */
export type SurveyHostRole = "generic" | "designated" | "configured";

export interface IdentityHostSurvey {
  /** The API base actually probed. */
  apiBase: string;
  role: SurveyHostRole;
  /** In candidate order; every candidate is probed, an acceptance stops nothing. */
  verdicts: { name: string; verdict: IdentityVerdict }[];
}

export interface IdentitySurvey {
  /** The generic host, then the account's designated host when it differs, then the `host`
   *  literal when set and different from both. */
  hosts: IdentityHostSurvey[];
  /** The designated-host lookup failed transiently, so that column is missing, not "the same". */
  designatedUnknown: boolean;
}

export interface IdentitySurveyDeps extends Omit<IdentityProbeDeps, "apiBase"> {
  /** The `host` literal, or null for `auto`. */
  configuredHost?: string | null;
}

/** The full picture behind the first-accepted probe: every candidate on every host that matters,
 *  concurrently. Never throws. */
export async function surveyIntegrationIdentities(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentitySurveyDeps = {},
): Promise<IdentitySurvey> {
  const fetchImpl = deps.fetchImpl ?? defaultProbeFetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const surveyHost = async (
    apiBase: string,
    role: SurveyHostRole,
  ): Promise<IdentityHostSurvey> => {
    const verdicts = await Promise.all(candidates.map(async (candidate) => ({
      name: candidate.name,
      verdict: await probeCandidate(
        token,
        apiBase,
        candidate,
        fetchImpl,
        timeoutMs,
        deps.signal,
        memoizable(deps),
      ),
    })));
    return { apiBase, role, verdicts };
  };
  const designated = await accountApiBase(token, fetchImpl, timeoutMs, deps.signal);
  const hosts: { apiBase: string; role: SurveyHostRole }[] = [
    { apiBase: DEFAULT_COPILOT_API_BASE, role: "generic" },
  ];
  if (designated.apiBase !== DEFAULT_COPILOT_API_BASE) {
    hosts.push({ apiBase: designated.apiBase, role: "designated" });
  }
  const configured = deps.configuredHost ?? null;
  if (configured !== null && !hosts.some((h) => h.apiBase === configured)) {
    hosts.push({ apiBase: configured, role: "configured" });
  }
  return {
    hosts: await Promise.all(hosts.map((h) => surveyHost(h.apiBase, h.role))),
    designatedUnknown: designated.inconclusive,
  };
}

/** The generic host's answer under the caller's identity, read by genericHostBlockedBy. */
type HostProbe = { kind: "kept" } | { kind: "blocked"; detail: string };

/** The SAME memoized probe the survey and the identity selection use (probeCandidate), read as the
 *  host rule: one request per (token, host, header set) in a process, so the table and the host
 *  verdict can never come from different answers. */
async function probeGenericHost(
  token: string,
  headers: Record<string, string>,
  deps: Omit<IdentityProbeDeps, "apiBase">,
): Promise<HostProbe> {
  const verdict = await probeCandidate(
    token,
    DEFAULT_COPILOT_API_BASE,
    { name: headers[INTEGRATION_ID_HEADER] ?? CODEX_IDENTITY_NAME, headers },
    deps.fetchImpl ?? defaultProbeFetch,
    deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    deps.signal,
    memoizable(deps),
  );
  if (verdict.kind !== "inconclusive") return { kind: "kept" };
  const blocked = verdict.status === null || genericHostBlockedBy(verdict.status);
  return blocked ? { kind: "blocked", detail: verdict.detail } : { kind: "kept" };
}

/** Where the host resolver narrates a non-default answer; consola instances and stderr loggers fit. */
export interface HostNarrator {
  info: (message: string) => void;
}

interface ResolveHostOptions extends Omit<IdentityProbeDeps, "apiBase"> {
  /** The `host` literal: returned as-is, nothing probed. Null = `auto`. */
  literal?: string | null;
  /** Callers whose stdout is a contract pass a stderr logger. */
  narrator?: HostNarrator;
}

// The same memo discipline as probeMemo: one network round per (token, identity) in a process,
// injected I/O or a caller deadline bypasses it.
const hostMemo = new Map<string, Promise<string>>();

/**
 * THE `host auto` rule, for every mode. `headers` is the identity's header set the caller
 * will send (the selected identity, or the pin), resolved BEFORE this. Module-private, like the
 * identity step below: only selectDirectIdentityAndHost may call it, so no consumer can select an
 * identity on one host and send to another.
 *
 *   literal set                     -> the literal
 *   no token                        -> the generic host, nothing probed
 *   generic /models 403, 404, 5xx, or a network failure
 *                                   -> the account's designated host, else the generic host
 */
function resolveCopilotHost(
  token: string | null,
  headers: Record<string, string>,
  opts: ResolveHostOptions = {},
): Promise<string> {
  const { literal = null, narrator = consola, ...deps } = opts;
  if (literal !== null) return Promise.resolve(literal);
  if (token === null) return Promise.resolve(DEFAULT_COPILOT_API_BASE);
  const injected = deps.fetchImpl !== undefined || deps.timeoutMs !== undefined ||
    deps.signal !== undefined;
  const key = JSON.stringify([token, headers]);
  const cached = injected ? undefined : hostMemo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveAutoHost(token, headers, deps, narrator);
  if (!injected) hostMemo.set(key, pending);
  return pending;
}

async function resolveAutoHost(
  token: string,
  headers: Record<string, string>,
  deps: Omit<IdentityProbeDeps, "apiBase">,
  narrator: HostNarrator,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? defaultProbeFetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const generic = await probeGenericHost(token, headers, deps);
  if (generic.kind === "kept") return DEFAULT_COPILOT_API_BASE;
  const designated = await accountApiBase(token, fetchImpl, timeoutMs, deps.signal);
  const genericHost = new URL(DEFAULT_COPILOT_API_BASE).host;
  if (designated.apiBase === DEFAULT_COPILOT_API_BASE) {
    narrator.info(
      `Copilot API host: ${genericHost} answered ${generic.detail} and the account host lookup ` +
        "gave no other host; staying on it.",
    );
  } else {
    narrator.info(
      `Copilot API host: ${designated.apiBase} (${genericHost} answered ${generic.detail}).`,
    );
  }
  return designated.apiBase;
}

// Memoized so the probe sites in one process (both agents at init, start narration + launch, catalog
// fetches) share one network round. Process-lifetime and never invalidated: a CLI invocation ends in
// seconds, while the MCP server (src/mcp/server.ts, reached through web_search.ts) keeps its verdict
// until the transport closes.
const probeMemo = new Map<string, Promise<IdentityProbeResult>>();

export async function probeIntegrationIdentityCached(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps,
): Promise<IdentityProbeResult> {
  // Injected I/O bypasses the memo: it is keyed on inputs only, so two stubs sharing a (token, candidates)
  // pair would collide. So does a caller deadline: an aborted probe must not be memoized as this
  // process's verdict.
  if (deps.fetchImpl !== undefined || deps.timeoutMs !== undefined || deps.signal !== undefined) {
    return probeIntegrationIdentity(token, candidates, deps);
  }
  const key = JSON.stringify([token, candidates, deps.apiBase]);
  let pending = probeMemo.get(key);
  if (pending === undefined) {
    pending = probeIntegrationIdentity(token, candidates, deps);
    probeMemo.set(key, pending);
  }
  return pending;
}

/** Test hook. */
export function resetIntegrationIdentityCache(): void {
  probeMemo.clear();
  hostMemo.clear();
  verdictMemo.clear();
}

export function identityRejectionHints(): string[] {
  return [
    "a fine-grained PAT needs the 'Copilot Requests' permission (repo-less, on your personal account)",
    "classic PATs and PATs on accounts without a Copilot seat are rejected outright",
    "run `agent auth` to switch to a gh-cli login or the Copilot device flow, which always work",
  ];
}

export interface ResolveIdentityOptions extends IdentityProbeDeps {
  /** The `identity` config pin, or null to probe. */
  pinned?: string | null;
  /** Callers whose stdout is a contract (`agent auth --get`) pass a stderr logger. */
  narrator?: HostNarrator;
}

/**
 * THE single PAT-shape predicate, behind the passthrough decision (usePatPassthrough): a PAT cannot
 * perform copilot-api's editor token exchange. It decides nothing about the identity: every
 * credential is probed.
 * Unprefixed 40-hex classic PATs are NOT detectable by shape: use the `passthrough` (on) config key.
 */
export function isPatShapedToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("ghp_") || t.startsWith("github_pat_");
}

/**
 * The shim (src/scripts/pat_passthrough_preload.ts) intercepts copilot-api's editor token exchange and
 * hands the token back as the Copilot bearer: a PAT 403s the exchange and a `gh-cli` OAuth token 404s
 * it, yet both are accepted DIRECTLY as the bearer. A no-op for tokens the exchange accepts, which is
 * why the `passthrough` config key may force it either way.
 */
export function usePatPassthrough(opts: {
  force: boolean | undefined;
  token: string | undefined;
  provider?: AuthProvider | null;
}): boolean {
  if (opts.token === undefined) return false; // the shim would be a no-op anyway
  if (opts.force !== undefined) return opts.force;
  // The device-flow `copilot` token CAN perform the exchange (and rotate the short-lived Copilot token),
  // so it is never shimmed whatever its shape; any `gho_` token (e.g. one pasted via gh-token) cannot.
  if (opts.provider === "copilot") return false;
  if (opts.provider === "gh-cli") return true;
  return isPatShapedToken(opts.token) || opts.token.startsWith("gho_");
}

/**
 * THROWS with the real reason when every candidate is definitively rejected (no mode can work with
 * this credential); returns the codex identity (the first candidate) on an inconclusive result, so
 * a transient failure degrades to the default instead of blocking a launch.
 */
async function acceptedIdentity(
  token: string,
  candidates: readonly [IntegrationIdentity, ...IntegrationIdentity[]],
  deps: IdentityProbeDeps,
): Promise<IntegrationIdentity> {
  const probe = await probeIntegrationIdentityCached(token, candidates, deps);
  if (probe.identity !== null) return probe.identity;
  if (!probe.conclusive) {
    consola.warn(
      "Could not verify the Copilot integration identity (transient error); using the default.",
    );
    return candidates[0];
  }
  throw new IdentityRejectedError(
    probe.apiBase,
    [
      `${probe.apiBase} rejects this credential under every known client identity:`,
      ...probe.outcomes.map((o) => `  - ${o.name}: ${o.detail}`),
      ...identityRejectionHints().map((h) => `  ${h}`),
    ].join("\n"),
  );
}

/** Every known identity was definitively rejected on `apiBase`, the host in use at that point (the
 *  generic host, a literal, or the host `auto` moved to): no mode can use this credential, and the
 *  landing (a rewire, a daemon start) fails with the message. */
export class IdentityRejectedError extends Error {
  constructor(readonly apiBase: string, message: string) {
    super(message);
  }
}

/** Narrated once, so `agent start`/`init` explain a surprising id. */
function narrateIdentity(
  chosen: string,
  pinned: boolean,
  narrator: HostNarrator = consola,
): void {
  if (pinned) {
    narrator.info(
      `Copilot integration identity: ${chosen} (pinned via the \`identity\` config key).`,
    );
  } else if (chosen !== CODEX_IDENTITY_NAME) {
    narrator.info(
      `Copilot integration identity: ${chosen} (the default ${CODEX_IDENTITY_NAME} rejected this credential).`,
    );
  }
}

/**
 * null = the codex identity (no id header). A null token (nothing resolved) cannot be probed, so the
 * pin (or the codex identity) is returned as-is.
 */
async function resolveIntegrationId(
  token: string | null,
  userAgent: string,
  opts: ResolveIdentityOptions,
): Promise<string | null> {
  const { pinned = null, narrator, ...deps } = opts;
  if (pinned !== null) {
    narrateIdentity(pinned, true, narrator);
    return pinned;
  }
  if (token === null) return null;
  // Probed on the host the caller passes (the host in use); the first accepted candidate wins.
  const identity = await acceptedIdentity(token, identityCandidates(userAgent), deps);
  narrateIdentity(identity.name, false, narrator);
  return bakedIntegrationId(identity);
}

/** One identity and the one host it was accepted on: what every consumer, Direct config or daemon
 *  launch, sends to, fetches with, or pins to. */
export interface IdentityAndHost {
  /** The id header's value; null = the codex identity, which sends none. */
  integrationId: string | null;
  apiBase: string;
}

export interface IdentityAndHostOptions extends Omit<ResolveIdentityOptions, "apiBase"> {
  /** A host every request goes to (a caller's, else the `host` literal): identity selection
   *  runs there and the host probe is skipped. Null = `auto`. */
  fixedHost?: string | null;
}

/**
 * THE one rule for pairing an identity with a host, for every mode, so no consumer selects on one
 * host and sends to another: identity selection on the host in use (`fixedHost`, else the generic
 * host), then the host under that identity's exact headers (resolveCopilotHost), then, when `auto`
 * moved the host, selection AGAIN there: the first run's answer was the generic host's (a blocked
 * host leaves it at the default), and the moved host is where the identity must be accepted. A pin
 * never re-selects. `userAgent` is the one the caller sends (codexUserAgent() for the agent configs
 * and the daemon; CODEX_EXEC_USER_AGENT for the version-free web-search client).
 */
export async function selectDirectIdentityAndHost(
  token: string | null,
  userAgent: string,
  opts: IdentityAndHostOptions = {},
): Promise<IdentityAndHost> {
  const { fixedHost = null, ...identityOpts } = opts;
  const identityOn = (apiBase: string): Promise<string | null> =>
    resolveIntegrationId(token, userAgent, { ...identityOpts, apiBase });
  const first = await identityOn(fixedHost ?? DEFAULT_COPILOT_API_BASE);
  const apiBase = await resolveCopilotHost(token, directClientHeaders(userAgent, first), {
    literal: fixedHost,
    fetchImpl: identityOpts.fetchImpl,
    signal: identityOpts.signal,
    narrator: identityOpts.narrator,
  });
  const moved = fixedHost === null && (identityOpts.pinned ?? null) === null &&
    apiBase !== DEFAULT_COPILOT_API_BASE;
  return { integrationId: moved ? await identityOn(apiBase) : first, apiBase };
}
