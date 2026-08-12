// GitHub Copilot's inference endpoints (api.githubcopilot.com and the per-plan
// api.business./api.enterprise. hosts) gate each request on a CLIENT-INTEGRATION
// identity -- the `Copilot-Integration-Id` header plus editor/user-agent headers --
// and WHICH identities accept WHICH credential class is undocumented server
// behavior that has changed over time. Verified July 2026: a fine-grained PAT
// (`github_pat_`, with the "Copilot Requests" permission) is REJECTED under the
// `vscode-chat` integration ("Personal Access Tokens are not supported for this
// endpoint", on individual AND enterprise-plan seats) but fully accepted under
// GitHub Copilot CLI's own `copilot-developer-cli` id; `gho_` OAuth tokens are
// accepted under both. The editor token exchange (`copilot_internal/v2/token`)
// 403s every PAT regardless of identity, so passthrough tokens live or die by
// this header alone.
//
// Rather than hardcoding per-token-shape rules, we PROBE an ordered candidate
// list with the resolved credential (GET /models; first 2xx wins) and use what
// works. Each mode probes the host its result is USED against: direct mode against
// DEFAULT_COPILOT_API_BASE (the base_url it bakes), passthrough against the
// account's designated host (what the daemon resolves for itself). The probe runs
// at `agent init`/`agent profile --add` (direct bakes the winning headers into the
// agent configs), at `agent start` (passthrough: handed to the daemon's preload via
// DAEMON_INTEGRATION_ID_ENV), and in `agent health`. Candidate order puts each mode's
// long-standing default FIRST, so a credential the default accepts stays byte-identical.
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import type { AuthProvider } from "./env_state.ts";

/** The gating header. Its VALUES below are external contracts -- never rename. */
export const INTEGRATION_ID_HEADER = "Copilot-Integration-Id";
/** copilot-api's own upstream identity (the VS Code Chat extension). */
export const VSCODE_CHAT_INTEGRATION_ID = "vscode-chat";
/** GitHub Copilot CLI's identity -- the one verified to accept fine-grained PATs. */
export const COPILOT_CLI_INTEGRATION_ID = "copilot-developer-cli";
/** A secondary developer identity, tried after the CLI one (accepts PATs on some plans). */
export const COPILOT_SANDBOX_INTEGRATION_ID = "copilot-developer-sandbox";
/** The name of Direct mode's default identity (Codex CLI impersonation, no id header). */
export const CODEX_IDENTITY_NAME = "codex";
/** The Codex CLI's User-Agent product token -- the client identity Copilot's direct
 *  endpoints are addressed under. Owned here (the layer-neutral home of the direct
 *  client identity) so codexUserAgent (codex layer, which appends `/<version>`) and
 *  the /responses web-search client (this layer, version-free) derive from ONE spelling. */
export const CODEX_EXEC_USER_AGENT = "codex_exec";

/**
 * Env var carrying the probed integration id into the proxy daemon; the
 * passthrough preload (src/scripts/pat_passthrough_preload.ts) reads it and
 * rewrites INTEGRATION_ID_HEADER on requests to *.githubcopilot.com hosts. Not a
 * secret, so plain env (no argv splice) is fine.
 */
export const DAEMON_INTEGRATION_ID_ENV = "COPILOT_ENV_DAEMON_INTEGRATION_ID";

/** Where the account's designated API base is discovered (best-effort). */
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
/** Fallback API base when the account lookup fails (the individual-plan host). */
export const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

const PROBE_TIMEOUT_MS = 5000;

/** The subset of `fetch` the probe needs -- just the call signature, so a plain stub
 *  (or globalThis.fetch, which also has `.preconnect`) is assignable without ceremony. */
export type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// The fetch the probe uses when a caller passes no explicit `fetchImpl`. A module-level
// seam (not just a per-call arg) so command entry points reached through many layers
// (runClaude, applyCodexConfig, agent start) stay hermetic in tests without threading a
// dep through every one; production leaves it as the global fetch.
let defaultProbeFetch: ProbeFetch = (input, init) => globalThis.fetch(input, init);

/** Test hook: override (or, with null, restore) the probe's default fetch. Clears the
 *  memo so a new fetch is actually exercised. */
export function setIntegrationProbeFetch(fetchImpl: ProbeFetch | null): void {
  defaultProbeFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  probeMemo.clear();
}

/** A neutral, VERSION-FREE User-Agent for our own probe requests (never sent by an
 *  agent -- the daemon and the baked direct configs carry their own real client UAs).
 *  Kept version-free on purpose so nothing here drifts against a client release. */
const PROBE_USER_AGENT = "copilot-env";

/** One presentable client identity: a stable name plus the exact headers it sends. */
export interface IntegrationIdentity {
  /** Stable name; for passthrough candidates it IS the integration-id value. */
  name: string;
  /** The request headers this identity presents (Authorization is added by callers). */
  headers: Record<string, string>;
}

/**
 * Candidates for the PASSTHROUGH bearer (the proxy daemon's upstream requests and
 * the raw direct /models catalog fetch): copilot-api's own vscode-chat identity
 * first (the long-standing default -- no daemon rewrite when it works), then the
 * Copilot CLI identity that fine-grained PATs require. The verdict is gated solely
 * on the integration id (verified: reproducing the daemon's full editor headers and
 * flipping ONLY this field flips acceptance), so the probe sends just that id -- no
 * editor/plugin version to drift against a client release.
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
 * The header set a DIRECT-mode client presents to the Copilot endpoint: the
 * `Openai-Intent` + User-Agent pair, plus the probed `Copilot-Integration-Id` when
 * one is required (omitted when null, so the default identity stays byte-identical).
 * THE single builder: the probe candidates below and every writer that bakes the
 * result (Codex `http_headers`, Claude ANTHROPIC_CUSTOM_HEADERS, the /responses
 * web-search client) go through it, so the probe can never validate a header set
 * the agents don't actually send.
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

/**
 * Candidates for DIRECT mode (the headers baked into the agents' own configs): the
 * Codex CLI impersonation both agents have always sent first, then the same plus the
 * Copilot CLI integration id (the PAT-compatible variant). `userAgent` is the
 * caller-supplied codexUserAgent() value -- detected from the installed codex binary,
 * so nothing here is version-hardcoded (this module must not import the codex layer).
 */
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

/** The `Copilot-Integration-Id` value an identity sends, or null when it sends none. */
export function bakedIntegrationId(identity: IntegrationIdentity): string | null {
  return identity.headers[INTEGRATION_ID_HEADER] ?? null;
}

/** One candidate's probe outcome, for narration/health details. */
export interface IdentityProbeOutcome {
  name: string;
  /** "ok", an HTTP rejection ("400 <body snippet>"), or a network error message. */
  detail: string;
}

export interface IdentityProbeResult {
  /** The first candidate the endpoint accepted, or null when none was. */
  identity: IntegrationIdentity | null;
  /**
   * true when every candidate received a DEFINITIVE HTTP rejection; false when a
   * network error made the run inconclusive (callers keep the default behavior
   * then, rather than failing hard on a flaky network).
   */
  conclusive: boolean;
  /** The API base actually probed (the account's designated host when readable). */
  apiBase: string;
  /** Per-candidate outcomes, in probe order. */
  outcomes: IdentityProbeOutcome[];
}

export interface IdentityProbeDeps {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /**
   * Probe candidates against THIS base instead of discovering the account's host.
   * The verdict must reflect where the result is actually used: direct mode bakes
   * DEFAULT_COPILOT_API_BASE, so it passes that here (skipping the account lookup);
   * passthrough omits it so the probe hits the same host the daemon resolves.
   */
  apiBase?: string;
}

/** One-line, length-bounded rejection detail (error bodies can be huge). */
function truncate(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * The account's designated Copilot API base from `copilot_internal/user`
 * (`endpoints.api` -- e.g. the enterprise host for an enterprise seat), falling
 * back to the individual-plan host. Probing the REAL host matters: acceptance rules
 * can differ per plan host, and the daemon will talk to this host, not the fallback.
 * `inconclusive` is true when the lookup TRANSIENTLY failed (network error / timeout /
 * 5xx / 429 / 408): the fallback host may not be where this credential is actually
 * served, so a subsequent all-reject on it must not read as a definitive verdict.
 */
async function accountApiBase(
  token: string,
  fetchImpl: ProbeFetch,
  timeoutMs: number,
): Promise<{ apiBase: string; inconclusive: boolean }> {
  try {
    const res = await fetchImpl(COPILOT_USER_URL, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": PROBE_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // A transient status leaves the real host unknown; a definitive one (401, a bad
      // token) just means "no custom host" -> the individual host is the right base.
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

/**
 * Whether an HTTP status is a DEFINITIVE "this identity/token is refused" verdict (vs a
 * transient or ambiguous one we must not hard-fail on). Only 400 (the verified
 * "Personal Access Tokens are not supported" identity rejection) and 401 (invalid token)
 * qualify; 403/404/408/429/5xx are treated as inconclusive so a policy blip, an outage,
 * or rate-limiting degrades to the default identity instead of throwing.
 */
function isDefinitiveRejection(status: number): boolean {
  return status === 400 || status === 401;
}

/**
 * Probe `candidates` in order with `token` as the bearer: GET `<apiBase>/models`
 * with each candidate's headers; the first 2xx wins. Never throws. `conclusive` is
 * true only when EVERY candidate returned a definitive rejection (see
 * isDefinitiveRejection) -- a network error or an ambiguous status leaves it false so
 * callers keep the default rather than hard-failing.
 */
export async function probeIntegrationIdentity(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps = {},
): Promise<IdentityProbeResult> {
  const fetchImpl = deps.fetchImpl ?? defaultProbeFetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  // A caller-supplied base (direct mode) is where traffic will actually go, so skip the
  // account-host lookup entirely; otherwise discover it (passthrough, matching the daemon).
  const { apiBase, inconclusive: baseInconclusive } = deps.apiBase
    ? { apiBase: deps.apiBase, inconclusive: false }
    : await accountApiBase(token, fetchImpl, timeoutMs);
  const outcomes: IdentityProbeOutcome[] = [];
  // A transient host-discovery failure means the fallback host may not be where this
  // credential is served, so an all-reject on it is NOT a definitive verdict.
  let sawInconclusive = baseInconclusive;
  for (const candidate of candidates) {
    try {
      const res = await fetchImpl(`${apiBase}/models`, {
        headers: { Authorization: `Bearer ${token}`, ...candidate.headers },
        signal: AbortSignal.timeout(timeoutMs),
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

// Memoized per (token, candidate list) so the multiple probe sites in one process
// (both agents at init, start narration + launch, catalog fetches) share one
// network round. Process-lifetime cache: every entry point is a short-lived CLI
// invocation, so staleness is bounded by the command's own lifetime.
const probeMemo = new Map<string, Promise<IdentityProbeResult>>();

export async function probeIntegrationIdentityCached(
  token: string,
  candidates: readonly IntegrationIdentity[],
  deps: IdentityProbeDeps = {},
): Promise<IdentityProbeResult> {
  // Injected I/O (tests) bypasses the cache: the memo is keyed on inputs only, so two
  // stubs sharing a (token, candidates) pair would otherwise collide.
  if (deps.fetchImpl !== undefined || deps.timeoutMs !== undefined) {
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

/** Test hook: drop the memo so probes re-run against fresh injected fetches. */
export function resetIntegrationIdentityCache(): void {
  probeMemo.clear();
}

/**
 * The advisory lines shown when no candidate works (a conclusive all-rejected
 * probe): the known reasons a Copilot-enabled credential still gets bounced.
 */
export function identityRejectionHints(): string[] {
  return [
    "a fine-grained PAT needs the 'Copilot Requests' permission (repo-less, on your personal account)",
    "classic PATs and PATs on accounts without a Copilot seat are rejected outright",
    "run `agent auth` to switch to a gh-cli login or the Copilot device flow, which always work",
  ];
}

/** Options common to both resolvers: a config pin (overrides the probe) + injectable I/O. */
export interface ResolveIdentityOptions extends IdentityProbeDeps {
  /** The `integration-id` config pin, or null to probe. */
  pinned?: string | null;
}

/**
 * Whether a GitHub token is a Personal Access Token by its prefix: `ghp_` (classic) or
 * `github_pat_` (fine-grained). THE single PAT-shape predicate -- two separate decisions
 * key off it for the same underlying reason (a PAT is the credential class the Copilot
 * endpoints treat specially): the passthrough shim (`usePatPassthrough` below, because
 * a PAT 403s the editor token exchange) and the identity probe gates in the resolvers
 * below (because a PAT is the only credential the DEFAULT client identity refuses --
 * verified July 2026: every gho_/ghu_ OAuth, device-flow, and gh-cli credential is
 * accepted, so nothing else is worth a probe's network round). Legacy unprefixed 40-hex
 * classic PATs are NOT detectable by shape -- use `config passthrough on` /
 * `config integration-id`.
 */
export function isPatShapedToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("ghp_") || t.startsWith("github_pat_");
}

/**
 * Whether to load the PAT-passthrough preload shim into the daemon
 * (`src/scripts/pat_passthrough_preload.ts`). The shim intercepts copilot-api's
 * editor token exchange and hands the token back as the Copilot token, so the daemon
 * runs its normal path with the token as the bearer -- the only way a
 * credential that can't perform the exchange works through the proxy. Two such credentials:
 * a PAT (`ghp_`/`github_pat_`, 403s the exchange) and a `gh-cli` OAuth token (404s the
 * exchange) -- both are nonetheless accepted DIRECTLY as the Copilot bearer (a PAT under
 * `copilot-developer-cli`, resolved by the identity probe; other credentials under the
 * default `vscode-chat`). It's a no-op for tokens the exchange accepts (the `copilot`
 * device-flow token), so the `passthrough` config key (`on`) can force it for an
 * undetected credential and `off` forces it off.
 *
 * Precedence: an explicit `force` (resolved by the caller from the `passthrough` config:
 * on -> true, off -> false) wins; otherwise (`auto`/unset) auto-enable for the `gh-cli` provider
 * or a PAT-shaped token.
 */
export function usePatPassthrough(opts: {
  force: boolean | undefined;
  token: string | undefined;
  provider?: AuthProvider | null;
}): boolean {
  if (opts.token === undefined) return false; // no token resolved -> the shim is a no-op anyway
  if (opts.force !== undefined) return opts.force;
  // The device-flow `copilot` token CAN perform the editor token exchange (and rotate the
  // short-lived Copilot token), so never shim it -- regardless of shape. A PAT, a gh-cli login,
  // or any `gho_` GitHub-OAuth token (e.g. a gh token pasted via gh-token) CANNOT perform the
  // exchange (403/404) but ARE accepted directly as the Copilot bearer under vscode-chat, so they
  // need the passthrough.
  if (opts.provider === "copilot") return false;
  if (opts.provider === "gh-cli") return true;
  return isPatShapedToken(opts.token) || opts.token.startsWith("gho_");
}

/**
 * The identity the endpoint accepts for `token`, chosen from `candidates` (the caller's
 * default FIRST, so it is also the safe fallback). THROWS with the real reason when every
 * candidate is definitively rejected (the caller's mode cannot work with this credential);
 * returns the default on an inconclusive result, so a transient failure degrades to
 * today's behavior instead of blocking a launch.
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

/** Narrate a non-default choice once, so `agent start`/`init` explain a surprising id. */
function narrateIdentity(chosen: string, defaultName: string, pinned: boolean): void {
  if (pinned) {
    consola.info(
      `Copilot integration identity: ${chosen} (pinned via \`agent config integration-id\`).`,
    );
  } else if (chosen !== defaultName) {
    consola.info(
      `Copilot integration identity: ${chosen} (the default ${defaultName} rejected this credential).`,
    );
  }
}

/**
 * The `Copilot-Integration-Id` to send for a DIRECT-mode credential (baked into the
 * agent configs), or null to send none (the default Codex identity, which every
 * gho_/device credential accepts). Config pin wins; otherwise probe. A null token
 * (nothing resolved) can't be probed, so the pin (or null) is returned as-is.
 */
export async function resolveDirectIntegrationId(
  token: string | null,
  userAgent: string,
  opts: ResolveIdentityOptions = {},
): Promise<string | null> {
  const { pinned = null, ...deps } = opts;
  if (pinned !== null) {
    narrateIdentity(pinned, CODEX_IDENTITY_NAME, true);
    return pinned;
  }
  // Only PATs are rejected by the default identity, so only they justify a probe;
  // every other credential uses the default (no header, no network round).
  if (token === null || !isPatShapedToken(token)) return null;
  const candidates = directIdentityCandidates(userAgent);
  // Direct mode bakes DEFAULT_COPILOT_API_BASE as the agents' base_url, so probe THAT host
  // -- the verdict must reflect where the agents will actually send traffic (no separate
  // account-host lookup, which could probe a different host than the one that gets used).
  const identity = await acceptedIdentity(token, candidates, {
    ...deps,
    apiBase: deps.apiBase ?? DEFAULT_COPILOT_API_BASE,
  });
  narrateIdentity(identity.name, CODEX_IDENTITY_NAME, false);
  return bakedIntegrationId(identity);
}

/**
 * The `Copilot-Integration-Id` for a PASSTHROUGH bearer (the proxy daemon's upstream
 * calls). Config pin wins; otherwise probe. Always returns an id (the proxy sends one);
 * `agent start` only overrides the daemon default when it differs from vscode-chat.
 */
export async function resolvePassthroughIntegrationId(
  token: string,
  opts: ResolveIdentityOptions = {},
): Promise<string> {
  const { pinned = null, ...deps } = opts;
  if (pinned !== null) {
    narrateIdentity(pinned, VSCODE_CHAT_INTEGRATION_ID, true);
    return pinned;
  }
  // Only PATs are rejected under the daemon's default vscode-chat identity; every other
  // passthrough bearer (gho_/device) is accepted, so skip the probe and its network round.
  if (!isPatShapedToken(token)) return VSCODE_CHAT_INTEGRATION_ID;
  const identity = await acceptedIdentity(token, PASSTHROUGH_IDENTITY_CANDIDATES, deps);
  narrateIdentity(identity.name, VSCODE_CHAT_INTEGRATION_ID, false);
  return bakedIntegrationId(identity) ?? VSCODE_CHAT_INTEGRATION_ID;
}
