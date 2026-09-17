// The daemon learns its Copilot host from GitHub: `endpoints.api` in the GET /copilot_internal/user
// body (logUser) and in every /copilot_internal/v2/token exchange body (re-applied on each refresh)
// both land in copilot-api's state.copilotApiUrl, which copilotBaseUrl(state) serves for HTTP and
// WebSocket requests alike. launchDaemon (src/copilot_api/process.ts) loads this with the host
// copilot-env selected (`host`, selectDirectIdentityAndHost), so one fetch wrap rewrites that field:
//   a /copilot_internal/ JSON response with endpoints.api -> endpoints.api = COPILOT_ENV_DAEMON_COPILOT_HOST
//   anything else                                        -> untouched
//
// Relies on copilot-api using `globalThis.fetch` for both requests and on the `endpoints.api` shape.

// Duplicates DAEMON_COPILOT_HOST_ENV (integration_identity.ts): this preload stays import-free so
// it drags no CLI module into the daemon.
const COPILOT_HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";
const INTERNAL_PATH = "/copilot_internal/";

/** Mutates `body` in place; true when it carried an `endpoints.api` string. Exported for tests. */
export function rewriteEndpointsApi(body: unknown, host: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const endpoints = (body as Record<string, unknown>).endpoints;
  if (typeof endpoints !== "object" || endpoints === null) return false;
  const record = endpoints as Record<string, unknown>;
  if (typeof record.api !== "string") return false;
  record.api = host;
  return true;
}

/** The body is re-serialised, so the transfer headers describing the old bytes go. */
function rebodied(res: Response, text: string): Response {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

const host = process.env[COPILOT_HOST_ENV]?.trim() || null;
if (host !== null) {
  const originalFetch = globalThis.fetch;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await originalFetch(input, init);
    // Only a 2xx WITH a body can carry the field; a null-body status could not be re-bodied anyway.
    if (!url.includes(INTERNAL_PATH) || !res.ok || res.status === 204 || res.body === null) {
      return res;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rebodied(res, text);
    }
    return rebodied(res, rewriteEndpointsApi(body, host) ? JSON.stringify(body) : text);
  };
  globalThis.fetch = wrapped;
}
