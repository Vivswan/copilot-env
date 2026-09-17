// The proxy sends its own client identity upstream (`Copilot-Integration-Id: vscode-chat` and an
// editor User-Agent), and Copilot gates the catalog and some models on that pair. copilot-env
// resolves ONE identity per credential (src/copilot_api/integration_identity.ts) that the Direct
// configs bake and this preload applies to the daemon, so both modes see one catalog. Loaded for
// every daemon that runs with a credential (src/copilot_api/process.ts); the launcher hands the
// header set over as JSON:
//   a string value -> the header is SET to it
//   a null value   -> the header is DELETED (the codex identity sends no integration id)
// Applied where the bytes leave the process, AFTER copilot-api's own header preparation (its
// /v1/messages path rewrites the User-Agent and drops the id before fetching):
//   `globalThis.fetch`             -> every HTTP call to the Copilot API hosts
//   undici's global dispatcher     -> the /responses WebSocket handshake: copilot-api imports
//                                     undici's WebSocket, whose upgrade request goes through
//                                     `getGlobalDispatcher()`, never through the global fetch
// undici publishes that dispatcher on `globalThis` under a well-known Symbol.for key precisely so
// another copy of the library can share it; this preload composes the proxy's own instance, so it
// imports nothing and follows whatever undici version the floated proxy brings.

// Duplicates DAEMON_CLIENT_HEADERS_ENV (integration_identity.ts) and DAEMON_COPILOT_HOST_ENV: this
// preload stays import-free so it drags no CLI module into the daemon.
const CLIENT_HEADERS_ENV = "COPILOT_ENV_DAEMON_CLIENT_HEADERS";
const COPILOT_HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";
// undici's lib/global.js: the Dispatcher API version rides in the key, and a data property that is
// writable, so an assignment replaces the instance every undici copy in the process reads.
const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/** The launcher's JSON: header name -> value to set, or null to delete. */
export type ClientHeaderSet = Record<string, string | null>;

/** Throws on anything but a JSON object of strings and nulls: the launcher always writes one, so a
 *  malformed value is a launch bug that must kill the daemon at module load, never run it under
 *  the proxy's own identity. */
function parseClientHeaderSet(raw: string): ClientHeaderSet {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CLIENT_HEADERS_ENV} is not a JSON object`);
  }
  const set: ClientHeaderSet = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== null && typeof value !== "string") {
      throw new Error(`${CLIENT_HEADERS_ENV}: header ${name} is neither a string nor null`);
    }
    set[name] = value;
  }
  return set;
}

/** The hosts that gate on the client identity: api., api.business., api.enterprise., plus the
 *  `host` origin the daemon is pinned to (a GHE Copilot host lives off githubcopilot.com).
 *  Compared by host, not origin, so the wss:// WebSocket URL of an https:// pin matches too.
 *  Exported for tests. */
export function isCopilotApiHost(url: string, configuredHost: string | null = null): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "githubcopilot.com" ||
      parsed.hostname.endsWith(".githubcopilot.com") ||
      (configuredHost !== null && parsed.host === new URL(configuredHost).host);
  } catch {
    return false;
  }
}

/** `current` with the set applied: every named header set or deleted, everything else kept.
 *  Exported for tests. */
export function applyClientHeaders(
  current: HeadersInit | undefined,
  set: ClientHeaderSet,
): Headers {
  const headers = new Headers(current);
  for (const [name, value] of Object.entries(set)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

/** `init.headers` when present, else the Request's own, is the effective set, and passing the
 *  result back through `init` overrides exactly that set. */
function fetchHeaders(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  set: ClientHeaderSet,
): Headers {
  return applyClientHeaders(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
    set,
  );
}

/** undici's header forms: the object its fetch path hands over (name -> value), a flat
 *  `[name, value, ...]` array, or an array of `[name, value]` pairs. */
type DispatchHeaders = Record<string, string | string[] | undefined> | unknown[];

/** The slice of undici's DispatchOptions this preload reads and rewrites. */
interface DispatchOptions {
  origin?: string | URL;
  headers?: DispatchHeaders;
}
type Dispatch = (opts: DispatchOptions, handler: unknown) => boolean;
interface GlobalDispatcher {
  compose(interceptor: (dispatch: Dispatch) => Dispatch): GlobalDispatcher;
}

/** Any of undici's header forms as one Headers object. */
function dispatchHeaders(headers: DispatchHeaders | undefined): Headers {
  const out = new Headers();
  if (headers === undefined) return out;
  const append = (name: unknown, value: unknown): void => {
    if (value === undefined || value === null) return;
    for (const v of Array.isArray(value) ? value : [value]) out.append(String(name), String(v));
  };
  if (!Array.isArray(headers)) {
    for (const [name, value] of Object.entries(headers)) append(name, value);
  } else if (headers.every((item) => Array.isArray(item))) {
    for (const pair of headers as unknown[][]) append(pair[0], pair[1]);
  } else {
    for (let i = 0; i < headers.length; i += 2) append(headers[i], headers[i + 1]);
  }
  return out;
}

/** Composes the proxy's undici dispatcher with the header rewrite for the Copilot API hosts.
 *  Throws when undici has not published its dispatcher: this runs after the proxy's module graph
 *  is evaluated (undici installs it at load), so its absence means the proxy no longer uses undici
 *  this way and its WebSocket transport would run under the proxy's own identity unnoticed. */
function composeUndiciDispatcher(set: ClientHeaderSet, configuredHost: string | null): void {
  const scope = globalThis as unknown as Record<symbol, GlobalDispatcher | undefined>;
  const dispatcher = scope[UNDICI_GLOBAL_DISPATCHER];
  if (dispatcher === undefined || typeof dispatcher.compose !== "function") {
    throw new Error(
      `client_headers_preload: the proxy at ${Deno.mainModule} publishes no undici global ` +
        `dispatcher under ${UNDICI_GLOBAL_DISPATCHER.description}, so its WebSocket transport ` +
        "cannot carry the client identity; refusing to run under the proxy's own. Update this " +
        "preload for the floated proxy version (never the package); until then the `daemon.version` " +
        "config key pins the previous version.",
    );
  }
  scope[UNDICI_GLOBAL_DISPATCHER] = dispatcher.compose((dispatch) => (opts, handler) => {
    const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.href;
    if (origin === undefined || !isCopilotApiHost(origin, configuredHost)) {
      return dispatch(opts, handler);
    }
    const headers = applyClientHeaders(dispatchHeaders(opts.headers), set);
    return dispatch({ ...opts, headers: Object.fromEntries(headers) }, handler);
  });
}

const rawSet = process.env[CLIENT_HEADERS_ENV]?.trim() || null;
if (rawSet !== null) {
  const set = parseClientHeaderSet(rawSet);
  const configuredHost = process.env[COPILOT_HOST_ENV]?.trim() || null;
  // A preload runs before the proxy's module graph even loads, so undici's dispatcher is composed
  // at the proxy's FIRST request to a Copilot host instead: the catalog GET it makes at start-up,
  // before it serves anything, so no WebSocket handshake can precede the rewrite.
  let undiciComposed = false;
  const originalFetch = globalThis.fetch;
  const wrappedFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isCopilotApiHost(url, configuredHost)) return originalFetch(input, init);
    if (!undiciComposed) {
      composeUndiciDispatcher(set, configuredHost);
      undiciComposed = true;
    }
    return originalFetch(input, { ...init, headers: fetchHeaders(input, init, set) });
  };
  globalThis.fetch = wrappedFetch;
}
