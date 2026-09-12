// A PAT cannot do copilot-api's editor token exchange (`GET .../copilot_internal/v2/token` -> 403
// "Resource not accessible by personal access token"), but the Copilot API hosts accept it directly
// under the right integration identity (src/copilot_api/integration_identity.ts). Loaded when
// src/copilot_api/launch.ts decides on passthrough; one fetch wrap does both jobs:
//   the exchange request          -> answered with the PAT itself as the Copilot token
//   a *.githubcopilot.com request -> `Copilot-Integration-Id` = COPILOT_ENV_DAEMON_INTEGRATION_ID
//   that var unset or blank       -> the header is left alone, so copilot-api's vscode-chat stands
//
// Relies on copilot-api using `globalThis.fetch` (`bindElectronFetch` replaces it only inside the
// Electron app) and on the exchange URL and `{ token, refresh_in }` response shape.

const TOKEN_FLAG = "--github-token";
const EXCHANGE_PATH = "/copilot_internal/v2/token";
// Duplicates DAEMON_INTEGRATION_ID_ENV (integration_identity.ts): this preload stays import-free
// so it drags no CLI module into the daemon.
const INTEGRATION_ID_ENV = "COPILOT_ENV_DAEMON_INTEGRATION_ID";
const INTEGRATION_ID_HEADER = "Copilot-Integration-Id";
// A PAT never expires the way a minted token does; a six-hour refresh leaves copilot-api's refresh
// loop re-running rarely, and each re-run only hits this interceptor again.
const REFRESH_IN_SECONDS = 21_600;

function tokenFromArgv(): string | null {
  const i = process.argv.indexOf(TOKEN_FLAG);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

/** The hosts that gate on the integration id: api., api.business., api.enterprise. Exported for
 *  tests; importing without `--github-token` in argv installs nothing. */
export function isCopilotApiHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
  } catch {
    return false;
  }
}

/** `init.headers` when present, else the Request's own, is the effective set, and passing the
 *  result back through `init` overrides exactly that set. Exported for tests. */
export function headersWithIntegrationId(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  integrationId: string,
): Headers {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  headers.set(INTEGRATION_ID_HEADER, integrationId);
  return headers;
}

// No token-shape re-check here: it would defeat a forced run for a credential the shape predicate
// cannot detect (a legacy unprefixed classic PAT).
const token = tokenFromArgv();
if (token !== null) {
  const integrationId = process.env[INTEGRATION_ID_ENV]?.trim() || null;
  const originalFetch = globalThis.fetch;
  const wrapped = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(EXCHANGE_PATH)) {
      // The success shape copilot-api's setupCopilotToken expects.
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
  globalThis.fetch = wrapped;
}
