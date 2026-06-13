// Preloaded into the copilot-api daemon (via `bun --preload`) when `agent start`
// decides to use PAT passthrough (`usePatPassthrough` in start.ts: auto for a PAT-shaped
// credential, or forced via the `passthrough` config key). A PAT can't perform copilot-api's
// editor token exchange (`GET .../copilot_internal/v2/token` -> 403 "Resource not accessible by
// personal access token"), but IS accepted directly by api.githubcopilot.com under the
// `vscode-chat` integration -- which copilot-api's DEFAULT path already sends.
//
// So we intercept ONLY the exchange request and return the token itself as the Copilot
// token. copilot-api then proceeds down its normal default path -- correct vscode-chat
// editor headers, the token as the bearer -- and `/models` + completions return 200.
//
// This is a RUNTIME shim, not a patch-package patch: it touches none of copilot-api's
// files, so it never pins the floated proxy version. It depends only on copilot-api
// using `globalThis.fetch` (the bun daemon does; `bindElectronFetch` only replaces it
// inside the Electron app, never here) and on the exchange URL + `{ token, refresh_in }`
// response shape -- both long-stable. The load decision lives in start.ts; here we act
// whenever a `--github-token` is present in argv (and only on the exchange URL).

const TOKEN_FLAG = "--github-token";
const EXCHANGE_PATH = "/copilot_internal/v2/token";
// The PAT never expires the way a minted Copilot token does; pick a long refresh so the
// loop rarely re-runs (each re-run just hits this same interceptor again -- harmless).
const REFRESH_IN_SECONDS = 21_600;

/** The bearer copilot-api was launched with (`--github-token <value>`), or null. */
function tokenFromArgv(): string | null {
  const i = process.argv.indexOf(TOKEN_FLAG);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

// Act whenever this shim was preloaded with a token. The decision to load it at all is
// `usePatPassthrough` in start.ts (auto for a PAT, or forced via the `passthrough` config
// key), so the
// shim does NOT re-check the token shape -- that would defeat a forced run for a token
// start.ts couldn't classify (e.g. a legacy unprefixed classic PAT).
const token = tokenFromArgv();
if (token !== null) {
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
    return originalFetch(input, init);
  };
  // Preserve fetch's own `preconnect` method so the replacement is a complete `fetch`.
  globalThis.fetch = Object.assign(wrapped, { preconnect: originalFetch.preconnect });
}
