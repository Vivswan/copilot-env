// Whose token is this? Asked of GitHub itself over GraphQL, so the answer needs no `gh` install and every
// token kind (a device-flow gho_, a classic or fine-grained PAT) reads the same way. The device flow that
// mints such a token lives here too: copilot-env runs it itself (through @octokit/auth-oauth-device), so
// the token lands in our store and never in a file of the proxy's, whose layout floats with its version.
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { request as octokitRequest } from "@octokit/request";
import { isRecord } from "../utils/json.ts";
import { errMessage } from "../utils/error.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";
import type { ProbeFetch } from "./integration_identity.ts";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
/** The OAuth app copilot-api logs in as (VS Code's Copilot app): the daemon's Copilot token exchange
 *  accepts a `gho_` minted for it, and `read:user` is all the exchange needs. */
export const COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98"; // gitleaks:allow - a public OAuth client id, not a secret
export const COPILOT_OAUTH_SCOPE = "read:user";
const VIEWER_QUERY = "query { viewer { login } }";
const LOOKUP_TIMEOUT_MS = 5000;

// A module-level seam so `runAuth` and `addProfile` stay hermetic in tests without threading a fetch through
// every layer; the interactive pickers reach this through several calls.
let defaultLoginFetch: ProbeFetch = defaultFetch;

/** Test hook. */
export function setGithubLoginFetch(fetchImpl: ProbeFetch | null): void {
  defaultLoginFetch = fetchImpl ?? defaultFetch;
}

/** STRICTLY a label input, never a gate: a missed look names why, and the caller still proceeds. */
export type GithubLoginLook =
  | { login: string }
  | { login: null; detail: string };

function parseViewerLogin(body: unknown): GithubLoginLook {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  const viewer = data && isRecord(data.viewer) ? data.viewer : undefined;
  const login = viewer?.login;
  if (typeof login === "string" && login !== "") return { login };
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const first = errors.find(isRecord);
  const message = first && typeof first.message === "string" ? first.message : null;
  return {
    login: null,
    detail: message === null ? "GitHub answered without a viewer login" : `GitHub said: ${message}`,
  };
}

export async function githubLoginLook(
  token: string,
  fetchImpl: ProbeFetch = defaultLoginFetch,
): Promise<GithubLoginLook> {
  let res: Response;
  try {
    res = await fetchImpl(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": COPILOT_ENV_USER_AGENT,
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (e) {
    return { login: null, detail: `GitHub could not be reached: ${errMessage(e)}` };
  }
  if (res.status === 401) return { login: null, detail: "GitHub rejected it, HTTP 401" };
  if (!res.ok) return { login: null, detail: `GitHub answered HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { login: null, detail: `GitHub's answer could not be read: ${errMessage(e)}` };
  }
  return parseViewerLogin(body);
}

// --- the device flow ----------------------------------------------------------------------------

/** What GitHub hands back for the user to act on. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresInS: number;
}

interface DeviceFlowDeps {
  fetchImpl?: ProbeFetch;
  /** Tells the user where to go and what to type; runs once, before polling starts. */
  announce: (code: DeviceCode) => void;
}

/**
 * GitHub's OAuth device flow, start to token, run by @octokit/auth-oauth-device: one device-code
 * request, then polling at GitHub's interval (its `authorization_pending` and `slow_down` are the
 * library's waiting words) until it grants or refuses. The token is RETURNED, never written; the
 * caller's single store write is where it lands. A refusal ends it with GitHub's own description.
 */
export async function githubDeviceFlowLogin(deps: DeviceFlowDeps): Promise<string> {
  const auth = createOAuthDeviceAuth({
    clientType: "oauth-app",
    clientId: COPILOT_OAUTH_CLIENT_ID,
    scopes: [COPILOT_OAUTH_SCOPE],
    request: octokitRequest.defaults({
      headers: { "user-agent": COPILOT_ENV_USER_AGENT },
      request: { fetch: deps.fetchImpl ?? defaultLoginFetch },
    }),
    onVerification: (code) =>
      deps.announce({
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        expiresInS: code.expires_in,
      }),
  });
  try {
    return (await auth({ type: "oauth" })).token;
  } catch (e) {
    throw new Error(`device-flow login failed: ${deviceFlowRefusal(e)}`);
  }
}

/** GitHub's refusal (`access_denied`, `expired_token`) travels as the library's RequestError with
 *  the answer body on `response.data`; anything else (GitHub unreachable) is the error's own words. */
function deviceFlowRefusal(e: unknown): string {
  const response = isRecord(e) && isRecord(e.response) ? e.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const description = data?.error_description;
  return typeof description === "string" && description !== "" ? description : errMessage(e);
}
