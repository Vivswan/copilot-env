// Inbound-request activity signal for the copilot-api daemon. The idle auto-stop watchdog
// (idle_watchdog.ts) needs "the proxy is being used for inference" from inside a server we
// never patch on disk; this module observes it at the REQUEST layer by wrapping `Bun.serve`
// before the proxy starts serving (the proxy serves through srvx, whose bun adapter calls
// `Bun.serve` at serve time -- a call-time global lookup, so a preload-time patch
// intercepts it).
//
// Liveness pings (GET /, GET /v1/models) deliberately do NOT count as activity, so
// observing the proxy (health probes, shell keepalives) never resets the idle timer; only a
// POST to an inference endpoint marks activity. The mark is taken at request arrival --
// before routing or auth -- so a rejected inference POST still counts as "someone is using
// this proxy". Marks land in module memory (read by the in-daemon watchdog) and are
// throttle-persisted into `.run/<host>/.activity.json` so out-of-process readers
// (`agent health`) can see them. That file has exactly ONE writer -- this observer, in the
// daemon -- and is deliberately NOT part of `.state.json`: the CLI writes state concurrently
// (launch pid/port, resolver heartbeats), and the JSON store's load-mutate-save is not
// atomic across processes, so sharing the file would risk losing those writes.
//
// This module is import-safe -- importing it never patches anything, so unit tests can
// exercise the pure helpers. inference_activity_preload.ts is the tiny `bun --preload` entry
// that installs the observer (the same split idle_watchdog.ts gets from its preload).
import { rmSync } from "node:fs";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import type { Profile } from "../copilot_api/profile.ts";

/** Persist the in-memory mark into the activity file at most this often (the file is for
 *  out-of-process readers like `agent health`; the watchdog reads memory directly). */
export const PERSIST_INTERVAL_MS = 60_000;

/** The activity file's single JSON key. A string literal contract: `agent health` reads it
 *  back by the same name. */
const LAST_INFERENCE_KEY = "lastInferenceAt";

/** Path suffixes of the proxy's inference endpoints (each with a leading slash, so the
 *  suffix match is segment-bounded). Covers the bare, `/v1/...`, and provider-prefixed
 *  route forms. Deliberately excludes `/count_tokens`, `/models`, and `/` -- counting or
 *  listing models is observation, not usage. */
const INFERENCE_PATH_SUFFIXES = [
  "/chat/completions",
  "/messages",
  "/responses",
  "/embeddings",
] as const;

/** Whether an inbound request targets an inference endpoint (POST; matched on the path
 *  alone, before routing or auth). */
export function isInferenceRequest(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const clean = pathname.replace(/\/+$/, "");
  return INFERENCE_PATH_SUFFIXES.some((suffix) => clean.endsWith(suffix));
}

let lastInferenceAtMs = 0;
let lastPersistedAtMs = 0;

/** Most recent observed inference request (epoch ms), or 0 when none this process. */
export function lastObservedInferenceMs(): number {
  return lastInferenceAtMs;
}

/** Reset the module state. Test-only: production code never rewinds the signal. */
export function resetInferenceActivityForTests(): void {
  lastInferenceAtMs = 0;
  lastPersistedAtMs = 0;
}

/**
 * Record an inference request at `now`: always in memory, and into the activity file at most
 * once per PERSIST_INTERVAL_MS (the first mark persists immediately). The persist is
 * best-effort -- a failed write must never break request serving, and the in-memory signal
 * (what the watchdog trusts) is already set.
 */
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

/** The persisted mark (epoch ms), or 0 when absent/unreadable. The out-of-process view of
 *  lastObservedInferenceMs, read by `agent health`. */
export function persistedInferenceMs(): number {
  try {
    const value = new CopilotApiConfig(new CopilotApiPaths().activityFile).load()[
      LAST_INFERENCE_KEY
    ];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Best-effort removal of the persisted mark; `agent stop` calls this (per daemon, so with
 *  the profile whose daemon it stopped) so a stopped daemon does not read as recently
 *  active. The idle auto-stop deliberately does NOT (the file cannot be pid-guarded, so an
 *  old daemon exiting could clobber its successor's mark). */
export function clearPersistedInferenceActivity(profile: Profile = null): void {
  try {
    rmSync(new CopilotApiPaths(profile).activityFile, { force: true });
  } catch {
    // best-effort: a stale mark only staleness-skews the health display
  }
}

/** The structural slice of Bun's serve options the observer touches; everything else is
 *  passed through untouched. */
type ServeOptionsLike = Record<string, unknown> & {
  fetch?: (this: unknown, request: Request, ...rest: unknown[]) => unknown;
};

type BunLike = { serve?: (options: ServeOptionsLike, ...rest: unknown[]) => unknown };

/**
 * Patch `Bun.serve` so the served fetch handler marks inference activity before delegating.
 * Purely observational: every option and argument passes through (including any future extra
 * serve arguments), `this` is preserved (Bun binds the handler to the server), and a failure
 * anywhere -- installing the patch or observing a request -- is swallowed: a monitoring
 * signal must never be able to break the server it monitors.
 */
export function installInferenceObserver(): void {
  try {
    const bun = (globalThis as Record<string, unknown>).Bun as BunLike | undefined;
    const realServe = bun?.serve;
    if (bun === undefined || typeof realServe !== "function") return; // not a bun runtime
    bun.serve = (options: ServeOptionsLike, ...rest: unknown[]): unknown => {
      const originalFetch = options?.fetch;
      if (typeof originalFetch !== "function") return realServe.call(bun, options, ...rest);
      const observed: ServeOptionsLike = {
        ...options,
        fetch(this: unknown, request: Request, ...fetchRest: unknown[]): unknown {
          try {
            if (isInferenceRequest(request.method, new URL(request.url).pathname)) {
              markInference(Date.now());
            }
          } catch {
            // observation must never break serving
          }
          return originalFetch.call(this, request, ...fetchRest);
        },
      };
      return realServe.call(bun, observed, ...rest);
    };
  } catch {
    // a failed install just means no observed activity; the watchdog still has heartbeats
  }
}
