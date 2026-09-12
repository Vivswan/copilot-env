import * as net from "node:net";

import { BOUNDED_LOCK_POLICY, withFileLockSync } from "../utils/file_lock.ts";
import { CopilotEnvConfig } from "./env_config.ts";
import { CopilotApiPaths, profileHomeNames } from "./paths.ts";
import type { Profile, ProfileName } from "./profile.ts";
import { CopilotEnvRunState } from "./state.ts";

// --- the per-daemon policy ------------------------------------------------------

/** Where a daemon's port comes from when its run state records none. */
export type DaemonPortSource =
  | { readonly source: "config" }
  | { readonly source: "reservation"; readonly name: ProfileName };

/**
 * THE one place the default profile's default-only behavior is decided: launch, status, and stop
 * read these fields instead of re-deriving from `profile === null`. Two literal shapes, so a
 * contradictory combination is unrepresentable. No home field on purpose: a daemon's home is paths.ts's
 * to resolve.
 */
export type DaemonPolicy =
  | {
    readonly port: { readonly source: "config" };
    readonly strictPortEligible: true;
    readonly releasesPortOnStop: true;
    /** Follow-up-command hints carry this suffix. */
    readonly flagSuffix: "";
  }
  | {
    readonly port: { readonly source: "reservation"; readonly name: ProfileName };
    /** A named profile's reservation is soft and always auto-increments. */
    readonly strictPortEligible: false;
    /** The baked agent wiring points at the reservation, so it survives a stop. */
    readonly releasesPortOnStop: false;
    readonly flagSuffix: ` --profile ${string}`;
  };

export function daemonPolicy(profile: Profile): DaemonPolicy {
  if (profile === null) {
    return {
      port: { source: "config" },
      strictPortEligible: true,
      releasesPortOnStop: true,
      flagSuffix: "",
    };
  }
  return {
    port: { source: "reservation", name: profile },
    strictPortEligible: false,
    releasesPortOnStop: false,
    flagSuffix: ` --profile ${profile}`,
  };
}

export function minProxyPort(): number {
  return new CopilotEnvConfig().minPort();
}

export function maxProxyPort(): number {
  return new CopilotEnvConfig().maxPort();
}

export function proxyPortInRange(port: number): boolean {
  return Number.isInteger(port) && port >= minProxyPort() && port <= maxProxyPort();
}

export function defaultProxyPort(): number {
  return new CopilotEnvConfig().defaultPort();
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

/** No range policy: for callers honoring a port the range no longer covers (an existing profile
 *  reservation after min/max narrowed). */
export function proxyPortFree(port: number): Promise<boolean> {
  return portFree(port);
}

export async function checkProxyPort(port: number): Promise<"free" | "busy" | "out-of-range"> {
  if (!proxyPortInRange(port)) {
    return "out-of-range";
  }
  return (await portFree(port)) ? "free" : "busy";
}

export async function copilotApiFindPort(start: number = defaultProxyPort()): Promise<number> {
  const maxAttempts = 50;
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
    `no free port found in range ${from}-${
      to - 1
    }; free a port or run \`agent config --set port <n>\` to start the search elsewhere`,
  );
}

/**
 * READ-ONLY: `--check` and `--dry-run` callers must never mutate state, so an unreserved named
 * profile gets the CANDIDATE its reservation would pick without recording it. WRITE paths go
 * through reserveProfilePort.
 */
export function copilotApiResolvePort(profile: Profile = null): string {
  const statePort = CopilotEnvRunState.forProfile(profile).read().port;
  if (statePort !== undefined) return String(statePort);
  return String(copilotApiFallbackPort(profile));
}

/**
 * Independent of the addressed profile's own run state (its record is EXCLUDED from the candidate
 * scan), so a caller holding a state snapshot (health's fact gathering) can fall back without a
 * concurrent write to that file steering the answer.
 */
export function copilotApiFallbackPort(profile: Profile): number {
  const port = daemonPolicy(profile).port;
  return port.source === "config" ? defaultProxyPort() : candidateProfilePort(port.name);
}

function recordedPorts(excluding: Profile): Set<number> {
  const ports = new Set<number>([defaultProxyPort()]);
  const defaultPort = new CopilotEnvRunState().read().port;
  if (defaultPort !== undefined) ports.add(defaultPort);
  for (const name of profileHomeNames()) {
    if (name === excluding) continue;
    const port = CopilotEnvRunState.forProfile(name).read().port;
    if (port !== undefined) ports.add(port);
  }
  return ports;
}

/** The scan starts just past the default daemon's port so profile reservations cluster beside it,
 *  then wraps to the bottom of the range. */
function candidateProfilePort(excluding: Profile = null): number {
  const min = minProxyPort();
  const max = maxProxyPort();
  if (min > max) {
    throw new Error(
      `invalid port range: min-port (${min}) is greater than max-port (${max}); fix it with \`agent config --set min-port <n>\` / \`--set max-port <n>\`.`,
    );
  }
  const used = recordedPorts(excluding);
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

/**
 * Best-effort serialization: the scan-then-write holds the shared BOUNDED_LOCK_POLICY lock, and past its
 * bounded wait it runs UNLOCKED rather than deadlock, so two profiles wired at once can still collide there.
 * An EXISTING reservation is honored even if min/max has since narrowed: the range governs NEW allocations only.
 *
 *   reservation busy at bind time  -> `start` re-records the LIVE-BOUND port outside this lock
 *   a reserver that raced it       -> finds ITS port busy at its own start and moves too; collisions self-heal there
 */
export function reserveProfilePort(profile: ProfileName): number {
  const state = CopilotEnvRunState.forProfile(profile);
  const recorded = state.read().port;
  if (recorded !== undefined) return recorded;
  const lockPath = new CopilotApiPaths().profilePortsLock;
  return withFileLockSync(lockPath, BOUNDED_LOCK_POLICY, () => {
    // A concurrent reserver may have recorded one during the wait.
    const raced = state.read().port;
    if (raced !== undefined) return raced;
    const port = candidateProfilePort();
    state.set({ port });
    return port;
  });
}

/**
 * The WRITE-path port for `profile`'s agent wiring (src/claude/config.ts, src/codex/config.ts):
 * PERSISTED, so the baked base URLs and the daemon agree across restarts. Read-only checks use
 * copilotApiResolvePort, which peeks without recording.
 */
export function wiringPortFor(profile: Profile): string {
  const port = daemonPolicy(profile).port;
  return port.source === "config" ? copilotApiResolvePort() : String(reserveProfilePort(port.name));
}

/** 127.0.0.1, never `localhost`: the daemon binds IPv4 only, and on Windows `localhost` resolves to
 *  ::1 first with no IPv4 fallback in fetch or the agent CLIs, so a `localhost` URL would
 *  ECONNREFUSED while the proxy is up. */
export function proxyLoopbackOrigin(port: number | string): string {
  return `http://127.0.0.1:${port}`;
}

export function openaiBaseUrl(port: string): string {
  return `${proxyLoopbackOrigin(port)}/v1`;
}

/** `localhost` is accepted on read: a hand-edit that still means the local proxy. Each read site
 *  layers its own port/path expectation on top (matchesProxyOrigin, or a bare null-test in `agent env`). */
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

/** "" is the bare origin Claude bakes; "/v1" is Codex's OpenAI-wire base. */
export type ProxyPathContract = "" | "/v1";

export function matchesProxyOrigin(
  url: string,
  expectedPort: number,
  expectedPath: ProxyPathContract,
): boolean {
  const parsed = parseLoopbackProxyUrl(url);
  return parsed !== null && parsed.port === String(expectedPort) && parsed.path === expectedPath;
}
