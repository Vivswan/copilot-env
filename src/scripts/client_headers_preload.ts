// The proxy sends its own client identity upstream (`Copilot-Integration-Id: vscode-chat` and an
// editor User-Agent), and Copilot gates the catalog and some models on that pair. copilot-env
// resolves ONE identity per credential (src/copilot_api/integration_identity.ts) that the Direct
// configs bake and this preload applies to the daemon, so both modes see one catalog. Loaded for
// every daemon that runs with a credential (src/copilot_api/process.ts); the launcher hands the
// header set over as JSON:
//   a string value -> the header is SET to it
//   a null value   -> the header is DELETED (the codex identity sends no integration id)
// Applied where the bytes leave the process, AFTER copilot-api's own header preparation (its
// /v1/messages path rewrites the User-Agent and drops the id before fetching), on both upstream
// transports to the Copilot API hosts:
//   every HTTP call             -> one wrap of `globalThis.fetch`, which the proxy uses throughout
//   the /responses WS handshake -> `new WebSocket(url, { headers })` with the class the proxy imports
//                                  from "undici", re-pointed at undici_identity.ts by a load hook
//                                  over the proxy's own chunks (the files beside process.argv[1])
// The hook exists because bun answers "undici" with a built-in whose WebSocket export is a native
// binding (not a `globalThis.WebSocket` read) and refuses a plugin over a built-in module. It stays
// off the proxy's dependencies: a CommonJS module fed back through a load hook loses its named
// exports.

// Duplicates DAEMON_CLIENT_HEADERS_ENV (integration_identity.ts) and DAEMON_COPILOT_HOST_ENV: this
// preload stays import-free so it drags no CLI module into the daemon.
const CLIENT_HEADERS_ENV = "COPILOT_ENV_DAEMON_CLIENT_HEADERS";
const COPILOT_HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";

/** The launcher's JSON: header name -> value to set, or null to delete. */
type ClientHeaderSet = Record<string, string | null>;

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
 *  Compared by host, not origin, so a pin's scheme never decides. Exported for tests. */
export function isCopilotApiHost(url: string, configuredHost: string | null = null): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "githubcopilot.com" ||
      parsed.hostname.endsWith(".githubcopilot.com") ||
      (configuredHost !== null && parsed.host === new URL(configuredHost).host)
    );
  } catch {
    return false;
  }
}

/** `current` with the set applied: every named header set or deleted, everything else kept. */
function applyClientHeaders(current: HeadersInit | undefined, set: ClientHeaderSet): Headers {
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

/** The second argument of `new WebSocket(url, init)`: the protocols alone, or bun's options object
 *  (`headers`, `protocols`, `proxy`, `tls` among them). */
export type HandshakeInit =
  | string
  | string[]
  | { headers?: HeadersInit; [option: string]: unknown };

const rawSet = process.env[CLIENT_HEADERS_ENV]?.trim() || null;
const identity =
  rawSet === null
    ? null
    : {
        set: parseClientHeaderSet(rawSet),
        configuredHost: process.env[COPILOT_HOST_ENV]?.trim() || null,
      };

/** `init` for a handshake to `url`: the header set applied for a Copilot API host, `init` as given
 *  for any other (the Codex backend's WebSocket carries that backend's own headers). The
 *  WebSocket subclass in undici_identity.ts calls this from the proxy's own construction. */
export function handshakeInit(
  url: string | URL,
  init: HandshakeInit | undefined,
): HandshakeInit | undefined {
  if (identity === null || !isCopilotApiHost(String(url), identity.configuredHost)) return init;
  // bun takes a bare protocol string, but under `protocols` only a sequence.
  const options: Exclude<HandshakeInit, string | string[]> =
    typeof init === "string"
      ? { protocols: [init] }
      : Array.isArray(init)
        ? { protocols: init }
        : { ...init };
  return {
    ...options,
    headers: Object.fromEntries(applyClientHeaders(options.headers, identity.set)),
  };
}

const IDENTITY_MODULE_URL = new URL("./undici_identity.ts", import.meta.url);
/** The module's path as the hook sees it, so an entry whose directory holds the shims (one under
 *  the install root) never has the module's own "undici" import re-pointed at itself. */
const IDENTITY_MODULE_PATH = Bun.fileURLToPath(IDENTITY_MODULE_URL);
/** The static and the dynamic import of "undici", whichever quote: the specifier is the one token
 *  the hook replaces, so every import shape (named, aliased, namespace) keeps its bindings. */
const UNDICI_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])undici\2/g;

/** The proxy's chunks sit beside its entry (the daemon's `dist/main.js`, a test's target file):
 *  that directory at any depth, minus a `node_modules` below it, since a dependency's CommonJS
 *  module fed back through the hook loses its named exports (the entry's own directory may sit
 *  under one). Separators match either way and Windows compares case-insensitively, the spelling
 *  src/copilot_api/process.ts uses for the same paths. */
/** The filter's comparison for one path: case-insensitive on Windows, exact elsewhere. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function entryDirectoryFilter(): RegExp {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("client-headers preload: no entry script to cover");
  const path = Bun.fileURLToPath(Bun.pathToFileURL(entry));
  const directory = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  const escaped = directory
    .split(/[\\/]/)
    .map((segment) => RegExp.escape(segment))
    .join("[\\\\/]");
  const segment = "(?!node_modules[\\\\/])[^\\\\/]+[\\\\/]";
  return new RegExp(
    `^${escaped}[\\\\/](?:${segment})*[^\\\\/]+\\.(js|mjs|ts)$`,
    process.platform === "win32" ? "i" : "",
  );
}

if (identity !== null) {
  const { set, configuredHost } = identity;
  const originalFetch = globalThis.fetch;
  const wrappedFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isCopilotApiHost(url, configuredHost)) return originalFetch(input, init);
    return originalFetch(input, { ...init, headers: fetchHeaders(input, init, set) });
  };
  globalThis.fetch = wrappedFetch as typeof fetch;

  Bun.plugin({
    name: "copilot-env-websocket-identity",
    setup(build) {
      build.onLoad({ filter: entryDirectoryFilter() }, async (args) => {
        const text = await Bun.file(args.path).text();
        const loader = args.path.endsWith(".ts") ? "ts" : "js";
        if (samePath(args.path, IDENTITY_MODULE_PATH)) return { contents: text, loader };
        return {
          contents: text.replace(
            UNDICI_SPECIFIER,
            (_match, lead: string) => `${lead}${JSON.stringify(IDENTITY_MODULE_URL.href)}`,
          ),
          loader,
        };
      });
    },
  });
}
