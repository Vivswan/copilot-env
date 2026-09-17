// Whose token is this? Asked of GitHub itself over GraphQL, so the answer needs no `gh` install and every
// token kind (a device-flow gho_, a classic or fine-grained PAT) reads the same way.
import { isRecord } from "../utils/json.ts";
import { errMessage } from "../utils/error.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const VIEWER_QUERY = "query { viewer { login } }";
const LOOKUP_TIMEOUT_MS = 5000;

export type LoginFetch = (input: string, init?: RequestInit) => Promise<Response>;

// A module-level seam so `runAuth` and `runProfile` stay hermetic in tests without threading a fetch through
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
