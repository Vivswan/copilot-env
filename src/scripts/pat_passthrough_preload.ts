// A PAT cannot do copilot-api's editor token exchange (`GET .../copilot_internal/v2/token` -> 403
// "Resource not accessible by personal access token"), but the Copilot API hosts accept it directly
// as the bearer. Loaded when src/copilot_api/launch.ts decides on passthrough; one fetch wrap answers
// the exchange request with the PAT itself as the Copilot token. The client identity the daemon
// sends upstream is client_headers_preload.ts's job, passthrough or not.
//
// Relies on copilot-api using `globalThis.fetch` (`bindElectronFetch` replaces it only inside the
// Electron app) and on the exchange URL and `{ token, refresh_in }` response shape.

const TOKEN_FLAG = "--github-token";
const EXCHANGE_PATH = "/copilot_internal/v2/token";
// A PAT never expires the way a minted token does; a six-hour refresh leaves copilot-api's refresh
// loop re-running rarely, and each re-run only hits this interceptor again.
const REFRESH_IN_SECONDS = 21_600;

function tokenFromArgv(): string | null {
  const i = process.argv.indexOf(TOKEN_FLAG);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

// No token-shape re-check here: it would defeat a forced run for a credential the shape predicate
// cannot detect (a legacy unprefixed classic PAT).
const token = tokenFromArgv();
if (token !== null) {
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
    return originalFetch(input, init);
  };
  globalThis.fetch = wrapped;
}
