// Port selection and discovery helpers for the local copilot-api proxy.
import * as net from "node:net";
import { join } from "node:path";

import { acquireFileLockBounded, releaseFileLock } from "../utils/file_lock.ts";
import { CopilotEnvConfig, configDefaultNumber } from "./env_config.ts";
import { profileHomeNames, resolveRootHome } from "./paths.ts";
import type { Profile, ProfileName } from "./profile.ts";
import { CopilotEnvRunState } from "./state.ts";

/** The built-in proxy port when nothing (config `port`, a running daemon, or `--port`)
 *  overrides it. The value is owned by the config registry's `port` entry. */
export const BUILTIN_PROXY_PORT = configDefaultNumber("port");

/** Built-in bounds of the allowed proxy port range, used when the `min-port`/`max-port` config
 *  keys are unset (values owned by the config registry). Privileged ports (<1024) are excluded
 *  by default. */
export const DEFAULT_MIN_PROXY_PORT = configDefaultNumber("min-port");
export const DEFAULT_MAX_PROXY_PORT = configDefaultNumber("max-port");

/** The configured lower bound of the allowed proxy port range (`agent config --set min-port`),
 *  else the built-in default. */
export function minProxyPort(): number {
  return new CopilotEnvConfig().read().minPort ?? DEFAULT_MIN_PROXY_PORT;
}

/** The configured upper bound of the allowed proxy port range (`agent config --set max-port`),
 *  else the built-in default. */
export function maxProxyPort(): number {
  return new CopilotEnvConfig().read().maxPort ?? DEFAULT_MAX_PROXY_PORT;
}

/** Whether `port` is within the allowed proxy range [min-port, max-port] (config-driven). */
export function proxyPortInRange(port: number): boolean {
  return Number.isInteger(port) && port >= minProxyPort() && port <= maxProxyPort();
}

/** The default proxy port: the configured `port` (`agent config --set port`), else the built-in. */
export function defaultProxyPort(): number {
  return new CopilotEnvConfig().read().port ?? BUILTIN_PROXY_PORT;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (available: boolean): void => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(available);
    };
    s.once("connect", () => done(false));
    s.once("error", () => done(true));
    s.connect(port, "127.0.0.1");
  });
}

/** Liveness-only probe (no range policy): whether anything is listening on `port`.
 *  For callers that must honor a port the range no longer covers (an existing
 *  profile reservation after min/max narrowed). */
export function proxyPortFree(port: number): Promise<boolean> {
  return portFree(port);
}

/** Probe whether the proxy can bind `port`. Out-of-range is its own verdict: the proxy runs
 *  unprivileged (binding <1024 fails anyway) and the range is a deliberate policy. */
export async function checkProxyPort(port: number): Promise<"free" | "busy" | "out-of-range"> {
  if (!proxyPortInRange(port)) {
    return "out-of-range";
  }
  return (await portFree(port)) ? "free" : "busy";
}

export async function copilotApiFindPort(start: number = defaultProxyPort()): Promise<number> {
  const maxAttempts = 50;
  // Search only within the configured range: clamp the base into [min, max] and never scan past
  // the ceiling, so the automatic search can't wander outside the allowed range.
  const min = minProxyPort();
  const max = maxProxyPort();
  const from = Math.min(Math.max(start, min), max);
  const to = Math.min(from + maxAttempts, max + 1);
  for (let port = from; port < to; port++) {
    if (await portFree(port)) {
      return port;
    }
  }
  throw new Error(
    `no free port found in range ${from}-${to - 1}; free a port or run \`agent config --set port <n>\` to start the search elsewhere`,
  );
}

/**
 * The wiring/probe port for `profile`'s daemon (null = the default daemon). READ-ONLY:
 * `--check`/`--dry-run` style callers must never mutate state, so an unreserved named
 * profile gets the CANDIDATE its reservation would pick, without recording it -- the
 * WRITE paths (wiring a proxy profile, `agent start --profile`) go through
 * `reserveProfilePort`, which persists the pick under a lock.
 *
 * Default: the port recorded in run state by `start` (removed by `stop`), else the
 * configured/built-in default -- so config wiring matches what a fresh `start` would bind.
 */
export function copilotApiResolvePort(profile: Profile = null): string {
  const statePort = CopilotEnvRunState.forProfile(profile).read().port;
  if (statePort !== undefined) return String(statePort);
  if (profile === null) return String(defaultProxyPort());
  return String(candidateProfilePort());
}

/** Every port currently reserved/recorded across the default and all profile daemons. */
function recordedPorts(): Set<number> {
  const ports = new Set<number>([defaultProxyPort()]);
  const defaultPort = new CopilotEnvRunState().read().port;
  if (defaultPort !== undefined) ports.add(defaultPort);
  for (const name of profileHomeNames()) {
    const port = CopilotEnvRunState.forProfile(name).read().port;
    if (port !== undefined) ports.add(port);
  }
  return ports;
}

/** The smallest in-range port no daemon has spoken for: scan upward from just past the
 *  default daemon's port (so profile reservations cluster predictably beside it), then
 *  wrap to the bottom of the range. Pure -- records nothing. */
function candidateProfilePort(): number {
  const min = minProxyPort();
  const max = maxProxyPort();
  if (min > max) {
    throw new Error(
      `invalid port range: min-port (${min}) is greater than max-port (${max}); fix it with \`agent config --set min-port <n>\` / \`--set max-port <n>\`.`,
    );
  }
  const used = recordedPorts();
  const from = Math.min(Math.max(defaultProxyPort() + 1, min), max);
  for (let port = from; port <= max; port++) {
    if (!used.has(port)) return port;
  }
  for (let port = min; port < from; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(
    `no free port left in range ${min}-${max} to reserve for a profile; ` +
      "widen it with `agent config --set max-port <n>`.",
  );
}

// The reservation is a cross-profile scan-then-write, so concurrent reservers (two
// profiles being wired at once) must be serialized or both could record the same port.
// Same best-effort bounded-wait contract as the JSON store's update lock -- literally:
// both use acquireFileLockBounded (utils/file_lock.ts), the shared stale/wait/retry policy.

/**
 * Reserve (and persist) a stable port for the named profile: the recorded one when it
 * exists, else the smallest in-range port not spoken for by the default daemon or another
 * profile -- so the profile's baked agent wiring (base URLs) and its daemon agree on a
 * deterministic port across restarts. The scan+write runs under a root-home lock so two
 * concurrent reservers can't pick the same port. An EXISTING reservation is honored even
 * if the min/max range has since narrowed (the same round-trip contract the default's
 * recorded port has; the range governs NEW allocations). `start` may later re-record a
 * different LIVE-BOUND port outside this lock when the reservation was busy at bind time
 * -- a reserver that raced it simply finds ITS port busy at its own start and moves too,
 * so collisions self-heal at bind time.
 */
export function reserveProfilePort(profile: ProfileName): number {
  const state = CopilotEnvRunState.forProfile(profile);
  const recorded = state.read().port;
  if (recorded !== undefined) return recorded;
  const lockPath = join(resolveRootHome(), ".profile-ports.lock");
  const held = acquireFileLockBounded(lockPath); // best-effort: proceed unlocked, never deadlock
  try {
    // Re-check under the lock: a concurrent reserver may have just recorded one.
    const raced = state.read().port;
    if (raced !== undefined) return raced;
    const port = candidateProfilePort();
    state.set({ port });
    return port;
  } finally {
    if (held) releaseFileLock(lockPath);
  }
}

/**
 * The port a WRITE path bakes into `profile`'s agent wiring: the default daemon's
 * resolved port, or the named profile's stable reservation -- PERSISTED via
 * reserveProfilePort, so the baked base URLs and the daemon agree across restarts.
 * Read-only checks use copilotApiResolvePort instead, which peeks without recording.
 * Shared by the two agent writers (src/claude/config.ts, src/codex/config.ts).
 */
export function wiringPortFor(profile: Profile): string {
  return profile === null ? copilotApiResolvePort() : String(reserveProfilePort(profile));
}

/** The proxy's loopback origin for `port` (single source for the emitted string, no path, no
 *  trailing slash). Uses the 127.0.0.1 literal, not `localhost`: the daemon binds 0.0.0.0
 *  (IPv4), but on Windows `localhost` resolves to ::1 first with no IPv4 fallback in fetch or
 *  the agent CLIs -- so a `localhost` URL would ECONNREFUSED (or read DOWN) while the proxy is
 *  up. 127.0.0.1 always hits the IPv4 listener. */
export function proxyLoopbackOrigin(port: number | string): string {
  return `http://127.0.0.1:${port}`;
}

/** The OpenAI-wire proxy base URL for `port`: the loopback origin plus the `/v1` path contract.
 *  Host rationale on proxyLoopbackOrigin. */
export function openaiBaseUrl(port: string): string {
  return `${proxyLoopbackOrigin(port)}/v1`;
}

/** Parse `url` as a candidate managed local-proxy URL -- the read-side inverse of the
 *  writers above. An http URL on `127.0.0.1` (what we write) or `localhost` (a hand-edit
 *  that still means the local proxy) yields its port and path (trailing slash tolerated);
 *  anything else is null. Each read site layers its own expected port/path on top --
 *  matchesProxyOrigin for the strict per-port checks, a bare null-test for the
 *  port-agnostic ones (`agent env`). */
export function parseLoopbackProxyUrl(url: string): { port: string; path: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return null;
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    return { port: u.port, path: u.pathname.replace(/\/$/, "") };
  } catch {
    return null;
  }
}

/** The two written path contracts: "" for the bare origin Claude bakes (proxyLoopbackOrigin),
 *  "/v1" for Codex's OpenAI-wire base (openaiBaseUrl). */
export type ProxyPathContract = "" | "/v1";

/** Whether `url` is the managed proxy URL for `expectedPort` with exactly `expectedPath`. */
export function matchesProxyOrigin(
  url: string,
  expectedPort: number,
  expectedPath: ProxyPathContract,
): boolean {
  const parsed = parseLoopbackProxyUrl(url);
  return parsed !== null && parsed.port === String(expectedPort) && parsed.path === expectedPath;
}
