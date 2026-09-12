// Copilot's inference hosts gate each request on a client identity (the `Copilot-Integration-Id` header
// plus editor/user-agent headers), and which identities accept which credential class is undocumented
// server behavior that has changed over time. So instead of per-token-shape rules we PROBE an ordered
// candidate list (GET /models, first 2xx wins), each mode against the host its result is USED on, with
// each mode's long-standing default FIRST so a credential the default accepts stays byte-identical.
// Verified July 2026, on individual AND enterprise-plan seats:
//   fine-grained PAT under `vscode-chat`            -> 400 "Personal Access Tokens are not supported for this endpoint"
//   fine-grained PAT under `copilot-developer-cli`  -> accepted
//   `gho_` OAuth token under either                 -> accepted
//   any PAT at the editor token exchange            -> 403, so a passthrough token lives or dies by this header alone
import { consola, type ConsolaInstance } from "consola";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import type { AuthProvider } from "./env_state.ts";

/** The gating header. Its VALUES below are external contracts: never rename. */
export const INTEGRATION_ID_HEADER = "Copilot-Integration-Id";
/** copilot-api's own upstream identity (the VS Code Chat extension). */
export const VSCODE_CHAT_INTEGRATION_ID = "vscode-chat";
/** GitHub Copilot CLI's identity, the one verified to accept fine-grained PATs. */
export const COPILOT_CLI_INTEGRATION_ID = "copilot-developer-cli";
/** Tried after the CLI one; accepts PATs on some plans. */
export const COPILOT_SANDBOX_INTEGRATION_ID = "copilot-developer-sandbox";
/** Direct mode's default identity: Codex CLI impersonation, no id header. */
export const CODEX_IDENTITY_NAME = "codex";
/** Owned here, the layer-neutral home, so codexUserAgent (codex layer, appends `/<version>`) and the
 *  /responses web-search client (this layer, version-free) derive from ONE spelling. */
export const CODEX_EXEC_USER_AGENT = "codex_exec";

/** The passthrough preload (src/scripts/pat_passthrough_preload.ts) reads this and rewrites
 *  INTEGRATION_ID_HEADER on requests to *.githubcopilot.com hosts. Not a secret, so plain env, no argv splice. */
export const DAEMON_INTEGRATION_ID_ENV = "COPILOT_ENV_DAEMON_INTEGRATION_ID";

/** Where the account's designated API base is discovered (best-effort). */
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
/** The individual-plan host; the fallback when the account lookup fails. */
export const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

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
}

/** Version-free on purpose so nothing here drifts against a client release; never sent by an agent
 *  (the daemon and the baked direct configs carry their own real client UAs). */
const PROBE_USER_AGENT = "copilot-env";

export interface IntegrationIdentity {
  /** For passthrough candidates it IS the integration-id value. */
  name: string;
  /** Authorization is added by callers. */
  headers: Record<string, string>;
}

/**
 * vscode-chat first: no daemon rewrite when it works. The verdict is gated solely on the integration id
 * (verified: reproducing the daemon's full editor headers and flipping ONLY this field flips
 * acceptance), so the probe sends just that id and has no editor/plugin version to drift against a client release.
 */
export const PASSTHROUGH_IDENTITY_CANDIDATES: readonly [
  IntegrationIdentity,
  ...IntegrationIdentity[],
] = [
  {
    name: VSCODE_CHAT_INTEGRATION_ID,
    headers: { [INTEGRATION_ID_HEADER]: VSCODE_CHAT_INTEGRATION_ID },
  },
  {
    name: COPILOT_CLI_INTEGRATION_ID,
    headers: { [INTEGRATION_ID_HEADER]: COPILOT_CLI_INTEGRATION_ID },
  },
  {
    name: COPILOT_SANDBOX_INTEGRATION_ID,
    headers: { [INTEGRATION_ID_HEADER]: COPILOT_SANDBOX_INTEGRATION_ID },
  },
];

/**
 * THE single builder: the DIRECT probe candidates and every writer that bakes the result (Codex `http_headers`,
 * Claude ANTHROPIC_CUSTOM_HEADERS, the /responses web-search client) go through it, so the probe can
 * never validate a header set the agents do not actually send. The id is omitted when null so the
 * default identity stays byte-identical.
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

/** `userAgent` rides in as a parameter because this module must not import the codex layer: callers pass
 *  either the detected codexUserAgent() or the version-free CODEX_EXEC_USER_AGENT (web_search.ts). */
export function directIdentityCandidates(
  userAgent: string,
): [IntegrationIdentity, ...IntegrationIdentity[]] {
  return [
    { name: CODEX_IDENTITY_NAME, headers: directClientHeaders(userAgent) },
    {
      name: COPILOT_CLI_INTEGRATION_ID,
      headers: directClientHeaders(userAgent, COPILOT_CLI_INTEGRATION_ID),
    },
    {
      name: COPILOT_SANDBOX_INTEGRATION_ID,
      headers: directClientHeaders(userAgent, COPILOT_SANDBOX_INTEGRATION_ID),
    },
  ];
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
  /** The API base actually probed (the account's designated host when readable). */
  apiBase: string;
  /** In probe order. */
  outcomes: IdentityProbeOutcome[];
}

export interface IdentityProbeDeps {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /** A caller deadline over the WHOLE probe chain, combined with each request's own timeout. */
  signal?: AbortSignal;
  /** The verdict must reflect where the result is used: direct mode bakes DEFAULT_COPILOT_API_BASE and
   *  passes it here; passthrough omits it so the probe hits the host the daemon resolves for itself. */
  apiBase?: string;
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
 * Probing the REAL host matters: acceptance rules can differ per plan host, and the daemon talks to this
 * host, not the fallback. `inconclusive` marks a TRANSIENT lookup failure: the fallback host may not be
 * where this credential is served, so an all-reject on it must not read as a definitive verdict.
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
    const apiBase = typeof api === "string" && api.startsWith("https://")
      ? api
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

/** Never throws; `conclusive` marks a verdict worth acting on, and it has two shapes.
 *
 *  a candidate accepted                                            -> identity set, conclusive
 *  base lookup OK or 400/401, every candidate rejected 400/401     -> identity null, conclusive
 *  base lookup or a candidate 403/404/408/429/5xx/network error    -> identity null, inconclusive
 */
export async function probeIntegrationIdentity(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps = {},
): Promise<IdentityProbeResult> {
  const fetchImpl = deps.fetchImpl ?? defaultProbeFetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { apiBase, inconclusive: baseInconclusive } = deps.apiBase
    ? { apiBase: deps.apiBase, inconclusive: false }
    : await accountApiBase(token, fetchImpl, timeoutMs, deps.signal);
  const outcomes: IdentityProbeOutcome[] = [];
  let sawInconclusive = baseInconclusive;
  for (const candidate of candidates) {
    try {
      const res = await fetchImpl(`${apiBase}/models`, {
        headers: { Authorization: `Bearer ${token}`, ...candidate.headers },
        signal: requestSignal(timeoutMs, deps.signal),
      });
      if (res.ok) {
        outcomes.push({ name: candidate.name, detail: "ok" });
        return { identity: candidate, conclusive: true, apiBase, outcomes };
      }
      let body = "";
      try {
        body = await res.text();
      } catch {
        body = "";
      }
      if (!isDefinitiveRejection(res.status)) sawInconclusive = true;
      outcomes.push({ name: candidate.name, detail: truncate(`${res.status} ${body}`) });
    } catch (e) {
      sawInconclusive = true;
      outcomes.push({
        name: candidate.name,
        detail: truncate(`network error: ${errMessage(e)}`),
      });
    }
  }
  return { identity: null, conclusive: !sawInconclusive, apiBase, outcomes };
}

// Memoized so the probe sites in one process (both agents at init, start narration + launch, catalog
// fetches) share one network round. Process-lifetime and never invalidated: a CLI invocation ends in
// seconds, while the MCP server (src/mcp/server.ts, reached through web_search.ts) keeps its verdict
// until the transport closes.
const probeMemo = new Map<string, Promise<IdentityProbeResult>>();

export async function probeIntegrationIdentityCached(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps = {},
): Promise<IdentityProbeResult> {
  // Injected I/O bypasses the memo: it is keyed on inputs only, so two stubs sharing a (token, candidates)
  // pair would collide. So does a caller deadline: an aborted probe must not be memoized as this
  // process's verdict.
  if (deps.fetchImpl !== undefined || deps.timeoutMs !== undefined || deps.signal !== undefined) {
    return probeIntegrationIdentity(token, candidates, deps);
  }
  const key = JSON.stringify([token, candidates, deps.apiBase ?? null]);
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
}

export function identityRejectionHints(): string[] {
  return [
    "a fine-grained PAT needs the 'Copilot Requests' permission (repo-less, on your personal account)",
    "classic PATs and PATs on accounts without a Copilot seat are rejected outright",
    "run `agent auth` to switch to a gh-cli login or the Copilot device flow, which always work",
  ];
}

export interface ResolveIdentityOptions extends IdentityProbeDeps {
  /** The `integration-id` config pin, or null to probe. */
  pinned?: string | null;
  /** Callers whose stdout is a contract (`agent auth --get`) pass a stderr logger. */
  narrator?: Pick<ConsolaInstance, "info">;
}

/**
 * THE single PAT-shape predicate, shared by the passthrough shim and the identity probe gates. A PAT is
 * the only credential the DEFAULT identity was seen to refuse (July 2026: gho_/ghu_ OAuth, device-flow and
 * gh-cli were all accepted), so nothing else is worth a probe's network round.
 * Unprefixed 40-hex classic PATs are NOT detectable by shape: use `config passthrough on` / `config integration-id`.
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
 * THROWS with the real reason when every candidate is definitively rejected (the caller's mode cannot
 * work with this credential); returns the default on an inconclusive result, so a transient failure
 * degrades to today's behavior instead of blocking a launch.
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
  throw new Error(
    [
      `${probe.apiBase} rejects this credential under every known client identity:`,
      ...probe.outcomes.map((o) => `  - ${o.name}: ${o.detail}`),
      ...identityRejectionHints().map((h) => `  ${h}`),
    ].join("\n"),
  );
}

/** Narrated once, so `agent start`/`init` explain a surprising id. */
function narrateIdentity(
  chosen: string,
  defaultName: string,
  pinned: boolean,
  narrator: Pick<ConsolaInstance, "info"> = consola,
): void {
  if (pinned) {
    narrator.info(
      `Copilot integration identity: ${chosen} (pinned via \`agent config integration-id\`).`,
    );
  } else if (chosen !== defaultName) {
    narrator.info(
      `Copilot integration identity: ${chosen} (the default ${defaultName} rejected this credential).`,
    );
  }
}

/**
 * null = the default Codex identity, which every gho_/device credential accepts. A null token (nothing
 * resolved) cannot be probed, so the pin (or null) is returned as-is.
 */
export async function resolveDirectIntegrationId(
  token: string | null,
  userAgent: string,
  opts: ResolveIdentityOptions = {},
): Promise<string | null> {
  const { pinned = null, narrator, ...deps } = opts;
  if (pinned !== null) {
    narrateIdentity(pinned, CODEX_IDENTITY_NAME, true, narrator);
    return pinned;
  }
  // Only PATs are rejected by the default identity, so only they justify a probe's network round.
  if (token === null || !isPatShapedToken(token)) return null;
  const candidates = directIdentityCandidates(userAgent);
  // Direct mode bakes DEFAULT_COPILOT_API_BASE as the agents' base_url, so THAT host is probed: the
  // verdict must reflect where the agents will actually send traffic.
  const identity = await acceptedIdentity(token, candidates, {
    ...deps,
    apiBase: deps.apiBase ?? DEFAULT_COPILOT_API_BASE,
  });
  narrateIdentity(identity.name, CODEX_IDENTITY_NAME, false, narrator);
  return bakedIntegrationId(identity);
}

/** Always returns an id (the proxy sends one); `agent start` only overrides the daemon default when it
 *  differs from vscode-chat. */
export async function resolvePassthroughIntegrationId(
  token: string,
  opts: ResolveIdentityOptions = {},
): Promise<string> {
  const { pinned = null, narrator, ...deps } = opts;
  if (pinned !== null) {
    narrateIdentity(pinned, VSCODE_CHAT_INTEGRATION_ID, true, narrator);
    return pinned;
  }
  // Only PATs are rejected under the daemon's default vscode-chat identity, so only they justify a probe.
  if (!isPatShapedToken(token)) return VSCODE_CHAT_INTEGRATION_ID;
  const identity = await acceptedIdentity(token, PASSTHROUGH_IDENTITY_CANDIDATES, deps);
  narrateIdentity(identity.name, VSCODE_CHAT_INTEGRATION_ID, false, narrator);
  return bakedIntegrationId(identity) ?? VSCODE_CHAT_INTEGRATION_ID;
}
