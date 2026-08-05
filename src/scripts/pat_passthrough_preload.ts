// Preloaded into the copilot-api daemon (via `bun --preload`) when the daemon launch
// pipeline (src/copilot_api/launch.ts) decides to use PAT passthrough (`usePatPassthrough`
// in integration_identity.ts: auto for a PAT-shaped or gho_ OAuth token or the gh-cli
// provider, or forced via the `passthrough` config key). A PAT can't perform copilot-api's
// editor token exchange (`GET .../copilot_internal/v2/token` -> 403 "Resource not accessible by
// personal access token"), but IS accepted directly by the Copilot API hosts under the
// right client-integration identity (which identity depends on the token class -- see
// src/copilot_api/integration_identity.ts).
//
// The shim does two things, both inside one fetch wrap:
//   1. Intercept ONLY the exchange request and return the token itself as the Copilot
//      token. copilot-api then proceeds down its normal default path with the token as
//      the bearer.
//   2. When the launch pipeline resolved an integration id for this credential (a
//      fine-grained PAT needs `copilot-developer-cli`, copilot-api hardcodes
//      `vscode-chat`), rewrite the `Copilot-Integration-Id` header on requests to the
//      *.githubcopilot.com hosts to that value from COPILOT_ENV_DAEMON_INTEGRATION_ID.
//
// This is a RUNTIME shim: it touches none of copilot-api's
// files, so it never pins the floated proxy version. It depends only on copilot-api
// using `globalThis.fetch` (the bun daemon does; `bindElectronFetch` only replaces it
// inside the Electron app, never here) and on the exchange URL + `{ token, refresh_in }`
// response shape -- both long-stable. The load decision lives in the daemon launch
// pipeline (src/copilot_api/launch.ts); here we act whenever a `--github-token` is
// present in argv (and only on the exchange URL).

const TOKEN_FLAG = "--github-token";
const EXCHANGE_PATH = "/copilot_internal/v2/token";
// Same value as DAEMON_INTEGRATION_ID_ENV (integration_identity.ts); preloads stay
// import-free so a shim never drags CLI modules into the daemon process.
const INTEGRATION_ID_ENV = "COPILOT_ENV_DAEMON_INTEGRATION_ID";
const INTEGRATION_ID_HEADER = "Copilot-Integration-Id";
// The PAT never expires the way a minted Copilot token does; pick a long refresh so the
// loop rarely re-runs (each re-run just hits this same interceptor again -- harmless).
const REFRESH_IN_SECONDS = 21_600;

/** The bearer copilot-api was launched with (`--github-token <value>`), or null. */
function tokenFromArgv(): string | null {
  const i = process.argv.indexOf(TOKEN_FLAG);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

/** True for the Copilot inference hosts (api.githubcopilot.com and the per-plan
 *  api.business./api.enterprise. variants) -- the hosts that gate on the integration id.
 *  Exported for unit testing (importing this module without `--github-token` in argv is a
 *  no-op: the wrap below never installs). */
export function isCopilotApiHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
  } catch {
    return false;
  }
}

/**
 * The request's effective headers with `integrationId` swapped in. Works for every
 * fetch calling shape because `init.headers` (when present) or the Request's own
 * headers are the effective set, and passing the result back through `init`
 * overrides exactly that set and nothing else. Exported for unit testing.
 */
export function headersWithIntegrationId(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  integrationId: string,
): Headers {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  headers.set(INTEGRATION_ID_HEADER, integrationId);
  return headers;
}

// Act whenever this shim was preloaded with a token. The decision to load it at all is
// `usePatPassthrough` (integration_identity.ts), applied by the daemon launch pipeline
// (src/copilot_api/launch.ts): auto for a PAT-shaped or gho_ OAuth token or the gh-cli
// provider, or forced via the `passthrough` config key. The shim does NOT re-check the
// token shape -- that would defeat a forced run for a credential the shape predicate
// can't detect (e.g. a legacy unprefixed classic PAT).
const token = tokenFromArgv();
if (token !== null) {
  // The integration id the launch pipeline resolved for this credential
  // (COPILOT_ENV_DAEMON_INTEGRATION_ID, set in launch.ts). Empty/absent =>
  // no header rewrite, byte-identical to the old shim.
  const integrationId = process.env[INTEGRATION_ID_ENV]?.trim() || null;
  const originalFetch = globalThis.fetch;
  const wrapped = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(EXCHANGE_PATH)) {
      // Synthesize the exchange success copilot-api's setupCopilotToken expects
      // (`{ token, refresh_in }`), handing it the token straight through as the Copilot token.
      return Promise.resolve(
        new Response(JSON.stringify({ token, refresh_in: REFRESH_IN_SECONDS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (integrationId !== null && isCopilotApiHost(url)) {
      return originalFetch(input, {
        ...init,
        headers: headersWithIntegrationId(input, init, integrationId),
      });
    }
    return originalFetch(input, init);
  };
  // Preserve fetch's own `preconnect` method so the replacement is a complete `fetch`.
  globalThis.fetch = Object.assign(wrapped, { preconnect: originalFetch.preconnect });
}
