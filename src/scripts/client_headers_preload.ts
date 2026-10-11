// The proxy sends its own client identity upstream (`Copilot-Integration-Id: vscode-chat` and an
// editor User-Agent), and Copilot gates the catalog and some models on that pair. copilot-env
// resolves ONE identity per credential (src/copilot_api/integration_identity.ts) that the Direct
// configs bake and this preload applies to the daemon, so both modes see one catalog. Loaded for
// every daemon that runs with a credential (src/copilot_api/process.ts); the launcher hands the
// header set over as JSON:
//   a string value -> the header is SET to it
//   a null value   -> the header is DELETED (the codex identity sends no integration id)
// Applied where the bytes leave the process, AFTER copilot-api's own header preparation (its
// /v1/messages path rewrites the User-Agent and drops the id before fetching): under bun the
// proxy makes every HTTP call to the Copilot API hosts through `globalThis.fetch`, so one wrap of
// the global covers them.
//
// Not covered: the /responses WebSocket handshake. copilot-api imports `WebSocket` from "undici",
// which bun answers with its own built-in, a binding to the native class that no preload can
// replace or compose (bun refuses a plugin over a built-in module), so that transport carries
// the proxy's own identity.

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

const rawSet = process.env[CLIENT_HEADERS_ENV]?.trim() || null;
if (rawSet !== null) {
  const set = parseClientHeaderSet(rawSet);
  const configuredHost = process.env[COPILOT_HOST_ENV]?.trim() || null;
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
}
