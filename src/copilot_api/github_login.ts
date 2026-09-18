// Whose token is this? Asked of GitHub itself over GraphQL, so the answer needs no `gh` install and every
// token kind (a device-flow gho_, a classic or fine-grained PAT) reads the same way. The device flow that
// mints such a token lives here too: copilot-env runs it itself, so the token lands in our store and never
// in a file of the proxy's, whose layout floats with its version.
import * as v from "valibot";
import { errMessage } from "../utils/error.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { jsonObject } from "../utils/json.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

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

export type LoginFetch = (input: string, init?: RequestInit) => Promise<Response>;

// A module-level seam so `runAuth` and `addProfile` stay hermetic in tests without threading a fetch through
// every layer; the interactive pickers reach this through several calls.
let defaultLoginFetch: LoginFetch = defaultFetch;

/** Test hook. */
export function setGithubLoginFetch(fetchImpl: LoginFetch | null): void {
  defaultLoginFetch = fetchImpl ?? defaultFetch;
}

/** STRICTLY a label input, never a gate: a missed look names why, and the caller still proceeds. */
export type GithubLoginLook =
  | { login: string }
  | { login: null; detail: string };

/** A field of another shape reads as absent; GitHub's answer is a label input, never a gate. */
const OPTIONAL_TEXT = v.fallback(v.optional(v.string()), undefined);
const NAMED = v.fallback(v.optional(v.pipe(v.string(), v.nonEmpty())), undefined);

const VIEWER_ANSWER_SCHEMA = v.fallback(
  v.object({
    "data": v.fallback(
      v.optional(v.object({
        "viewer": v.fallback(v.optional(v.object({ "login": NAMED })), undefined),
      })),
      undefined,
    ),
    "errors": v.fallback(
      v.array(
        v.fallback(
          v.nullable(v.pipe(jsonObject(), v.object({ "message": OPTIONAL_TEXT }))),
          null,
        ),
      ),
      [],
    ),
  }),
  { data: undefined, errors: [] },
);

function parseViewerLogin(body: unknown): GithubLoginLook {
  const answer = v.parse(VIEWER_ANSWER_SCHEMA, body);
  const login = answer.data?.viewer?.login;
  if (login !== undefined) return { login };
  const message = answer.errors.find((error) => error !== null)?.message;
  return {
    login: null,
    detail: message === undefined
      ? "GitHub answered without a viewer login"
      : `GitHub said: ${message}`,
  };
}

export async function githubLoginLook(
  token: string,
  fetchImpl: LoginFetch = defaultLoginFetch,
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
  fetchImpl?: LoginFetch;
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
  fetchImpl: LoginFetch,
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

/** GitHub's documented defaults stand in for absent timings. */
const DEVICE_CODE_SCHEMA = v.object({
  "device_code": v.string(),
  "user_code": v.string(),
  "verification_uri": v.string(),
  "expires_in": v.fallback(v.number(), 900),
  "interval": v.fallback(v.number(), 5),
});

function parseDeviceCode(body: unknown): DeviceCode {
  const parsed = v.safeParse(DEVICE_CODE_SCHEMA, body);
  if (!parsed.success) {
    throw new Error("GitHub answered the device-code request without a device code");
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = parsed.output;
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresInS: expires_in,
    intervalS: interval,
  };
}

/** One poll's answer: the token once granted, else GitHub's error word and its description. */
const TOKEN_ANSWER_SCHEMA = v.fallback(
  v.object({
    "access_token": NAMED,
    "error": v.fallback(v.string(), ""),
    "error_description": OPTIONAL_TEXT,
  }),
  { error: "" },
);

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
    const answer = v.parse(TOKEN_ANSWER_SCHEMA, body);
    if (answer.access_token !== undefined) return answer.access_token;
    if (answer.error === "slow_down") intervalS += SLOW_DOWN_EXTRA_S;
    else if (answer.error !== "authorization_pending") {
      const description = answer.error_description ??
        (answer.error || "GitHub answered without a token");
      throw new Error(`device-flow login failed: ${description}`);
    }
  }
}
