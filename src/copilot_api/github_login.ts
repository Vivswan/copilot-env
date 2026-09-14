// Whose token is this? Asked of GitHub itself over GraphQL, so the answer needs no `gh` install and every
// token kind (a device-flow gho_, a classic or fine-grained PAT) reads the same way.
import { isRecord } from "../utils/json.ts";
import { errMessage } from "../utils/error.ts";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const VIEWER_QUERY = "query { viewer { login } }";
const LOOKUP_TIMEOUT_MS = 5000;

/** Version-free like the integration probe: never sent by an agent, so nothing drifts against a client release. */
const LOOKUP_USER_AGENT = "copilot-env";

export type LoginFetch = (input: string, init?: RequestInit) => Promise<Response>;

// A module-level seam so `runAuth` and `runProfile` stay hermetic in tests without threading a fetch through
// every layer; the interactive pickers reach this through several calls.
let defaultLoginFetch: LoginFetch = (input, init) => globalThis.fetch(input, init);

/** Test hook. */
export function setGithubLoginFetch(fetchImpl: LoginFetch | null): void {
  defaultLoginFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
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
        "User-Agent": LOOKUP_USER_AGENT,
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (e) {
    return { login: null, detail: `GitHub could not be reached: ${errMessage(e)}` };
  }
  if (res.status === 401) return { login: null, detail: "GitHub rejected the token (HTTP 401)" };
  if (!res.ok) return { login: null, detail: `GitHub answered HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { login: null, detail: `GitHub's answer could not be read: ${errMessage(e)}` };
  }
  return parseViewerLogin(body);
}

/** The one wording every surface uses next to a token: the picker rows and the "Using ..." line. */
export function describeLoginLook(look: GithubLoginLook): string {
  return look.login === null ? `account unknown: ${look.detail}` : `account ${look.login}`;
}
