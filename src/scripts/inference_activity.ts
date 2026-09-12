// srvx's deno adapter looks `Deno.serve` up at serve time, so a preload-time wrap of the global
// sees every request before routing or auth: a rejected inference POST still counts as use, and
// liveness pings never do. The same wrap is where the server handle surfaces, so it hands it to
// daemon_shutdown.ts on the way through.
//
// `.activity.json` has exactly one writer (this observer) and stays out of `.state.json` on
// purpose: the CLI writes state concurrently (launch pid/port, resolver heartbeats) and the JSON
// store's load-mutate-save is not atomic across processes. Importing patches nothing;
// daemon_runtime_preload.ts installs the observer.
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { removeReported } from "../utils/report_write.ts";
import { recordDaemonServer } from "./daemon_shutdown.ts";

/** The file is for out-of-process readers (`agent health`); the watchdog reads memory directly. */
export const PERSIST_INTERVAL_MS = 60_000;

/** A string literal contract: `agent health` reads it back by the same name. */
const LAST_INFERENCE_KEY = "lastInferenceAt";

/** The leading slash keeps the suffix match segment-bounded. `/count_tokens` and `/models` are
 *  excluded on purpose: counting or listing is observation, not usage. */
const INFERENCE_PATH_SUFFIXES = [
  "/chat/completions",
  "/messages",
  "/responses",
  "/embeddings",
  "/alpha/search",
  "/images/generations",
  "/images/edits",
] as const;

export function isInferenceRequest(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const clean = pathname.replace(/\/+$/, "");
  return INFERENCE_PATH_SUFFIXES.some((suffix) => clean.endsWith(suffix));
}

let lastInferenceAtMs = 0;
let lastPersistedAtMs = 0;

export function lastObservedInferenceMs(): number {
  return lastInferenceAtMs;
}

export function resetInferenceActivityForTests(): void {
  lastInferenceAtMs = 0;
  lastPersistedAtMs = 0;
}

export function markInference(now: number): void {
  lastInferenceAtMs = now;
  if (now - lastPersistedAtMs < PERSIST_INTERVAL_MS) return;
  lastPersistedAtMs = now;
  try {
    new CopilotApiConfig(new CopilotApiPaths().activityFile).save({ [LAST_INFERENCE_KEY]: now });
  } catch {
    // best-effort: out-of-process readers just see a staler mark
  }
}

/** The out-of-process view of lastObservedInferenceMs, read by `agent health`. Collapsing every
 *  failure to 0 is decided here: the mark only feeds the health display, and 0 already means "no
 *  mark seen". */
export function persistedInferenceMs(profile: Profile = null): number {
  try {
    const value = new CopilotApiConfig(new CopilotApiPaths(profile).activityFile).load()[
      LAST_INFERENCE_KEY
    ];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** `agent stop` calls this so a stopped daemon does not read as recently active. The idle auto-stop
 *  does not: the file cannot be pid-guarded, so an old daemon exiting could clobber its successor's
 *  mark. */
export function clearPersistedInferenceActivity(profile: Profile = null): void {
  try {
    removeReported(new CopilotApiPaths(profile).activityFile);
  } catch {
    // best-effort: a stale mark only staleness-skews the health display
  }
}

type ServeHandler = (this: unknown, request: Request, ...rest: unknown[]) => unknown;

type ServeOptionsLike = Record<string, unknown> & { handler?: ServeHandler };

/** Structural, so the wrap does not have to satisfy or re-declare `Deno.serve`'s overload set. */
type ServeLike = (...args: unknown[]) => unknown;

/** `this` is preserved because deno binds the handler to the server. */
function observed(handler: ServeHandler): ServeHandler {
  return function (this: unknown, request: Request, ...rest: unknown[]): unknown {
    try {
      if (isInferenceRequest(request.method, new URL(request.url).pathname)) {
        markInference(Date.now());
      }
    } catch {
      // observation must never break serving
    }
    return handler.call(this, request, ...rest);
  };
}

/** An argument list matching no known `Deno.serve` shape is returned untouched, so a future
 *  signature still serves, just unobserved. */
export function observeServeArgs(args: readonly unknown[]): unknown[] {
  // A copy, substituted in place, so the call's arity reaches the real serve unchanged.
  const out = [...args];
  const [first, second] = out;
  if (typeof first === "function") {
    out[0] = observed(first as ServeHandler);
    return out;
  }
  if (typeof second === "function") {
    out[1] = observed(second as ServeHandler);
    return out;
  }
  if (typeof first === "object" && first !== null) {
    const options = first as ServeOptionsLike;
    if (typeof options.handler === "function") {
      out[0] = { ...options, handler: observed(options.handler) };
    }
  }
  return out;
}

export function installInferenceObserver(): void {
  try {
    const deno = (globalThis as { Deno?: { serve: ServeLike } }).Deno;
    if (deno === undefined || typeof deno.serve !== "function") return;
    const realServe = deno.serve;
    deno.serve = (...args: unknown[]): unknown => {
      const server = realServe(...observeServeArgs(args));
      recordDaemonServer(server);
      return server;
    };
  } catch {
    // a failed install just means no observed activity; the watchdog still has heartbeats
  }
}
