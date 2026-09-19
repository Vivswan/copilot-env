// Whose token is this? Asked of GitHub itself over GraphQL, so the answer needs no `gh` install and every
// token kind (a device-flow gho_, a classic or fine-grained PAT) reads the same way. The device flow that
// mints such a token lives here too: copilot-env runs it itself, so the token lands in our store and never
// in a file of the proxy's, whose layout floats with its version.
import { isRecord } from "../utils/json.ts";
import { errMessage } from "../utils/error.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";
import type { ProbeFetch } from "./integration_identity.ts";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** The OAuth app copilot-api logs in as (VS Code's Copilot app): the daemon's Copilot token exchange
 *  accepts a `gho_` minted for it, and `read:user` is all the exchange needs. */
export const COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98"; // gitleaks:allow - a public OAuth client id, not a secret
export const COPILOT_OAUTH_SCOPE = "read:user";
const VIEWER_QUERY = "query { viewer { login } }";
const LOOKUP_TIMEOUT_MS = 5000;
const DEVICE_FLOW_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** GitHub's `slow_down` asks for 5 more seconds between polls. */
const SLOW_DOWN_EXTRA_S = 5;

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

/** What GitHub hands back for the user to act on; `deviceCode` is the poll handle. */
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInS: number;
  intervalS: number;
}

export interface DeviceFlowDeps {
  fetchImpl?: ProbeFetch;
  /** Waits `ms` between polls; the test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Tells the user where to go and what to type; runs once, before polling starts. */
  announce: (code: DeviceCode) => void;
}

const DEVICE_FLOW_HEADERS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": COPILOT_ENV_USER_AGENT,
};

async function postJson(
  fetchImpl: ProbeFetch,
  url: string,
  body: Record<string, string>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: DEVICE_FLOW_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`GitHub could not be reached at ${url}: ${errMessage(e)}`);
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} at ${url}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`GitHub's answer from ${url} could not be read: ${errMessage(e)}`);
  }
}

function parseDeviceCode(body: unknown): DeviceCode {
  const b = isRecord(body) ? body : {};
  const { device_code, user_code, verification_uri, expires_in, interval } = b;
  if (
    typeof device_code !== "string" || typeof user_code !== "string" ||
    typeof verification_uri !== "string"
  ) {
    throw new Error("GitHub answered the device-code request without a device code");
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresInS: typeof expires_in === "number" ? expires_in : 900,
    intervalS: typeof interval === "number" ? interval : 5,
  };
}

/**
 * GitHub's OAuth device flow, start to token: one device-code request, then polling at GitHub's
 * interval until it grants, refuses, or the code expires. The token is RETURNED, never written; the
 * caller's single store write is where it lands. `authorization_pending` and `slow_down` are the
 * flow's own waiting words; any other error field ends it with GitHub's own description.
 */
export async function githubDeviceFlowLogin(deps: DeviceFlowDeps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? defaultLoginFetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const code = parseDeviceCode(
    await postJson(fetchImpl, GITHUB_DEVICE_CODE_URL, {
      client_id: COPILOT_OAUTH_CLIENT_ID,
      scope: COPILOT_OAUTH_SCOPE,
    }),
  );
  deps.announce(code);
  let intervalS = code.intervalS;
  const deadline = Date.now() + code.expiresInS * 1000;
  while (true) {
    // Judged BEFORE the wait: a poll past the code's lifetime can only be answered expired.
    if (Date.now() + intervalS * 1000 >= deadline) {
      throw new Error("device-flow login failed: the code expired before it was entered");
    }
    await sleep(intervalS * 1000);
    const body = await postJson(fetchImpl, GITHUB_ACCESS_TOKEN_URL, {
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: DEVICE_FLOW_GRANT,
    });
    const answer = isRecord(body) ? body : {};
    if (typeof answer.access_token === "string" && answer.access_token !== "") {
      return answer.access_token;
    }
    const error = typeof answer.error === "string" ? answer.error : "";
    if (error === "slow_down") intervalS += SLOW_DOWN_EXTRA_S;
    else if (error !== "authorization_pending") {
      const description = typeof answer.error_description === "string"
        ? answer.error_description
        : error || "GitHub answered without a token";
      throw new Error(`device-flow login failed: ${description}`);
    }
  }
}
