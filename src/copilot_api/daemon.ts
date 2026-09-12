// Status, liveness, heartbeat, and teardown for the proxy daemon, kept out of the command files so
// models, profile, auth, and uninstall never import another command.
import { connect } from "node:net";
import { consola } from "consola";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { daemonLockVerdict } from "../scripts/daemon_lock.ts";
import { assertNever } from "../utils/assert.ts";
import { CopilotApiPaths, profileHomeNames } from "./paths.ts";
import { daemonPolicy, defaultProxyPort } from "./port.ts";
import { classifyDaemonPid, isCopilotApiPid, pidAlive, terminatePid } from "./process.ts";
import type { Profile } from "./profile.ts";
import { CopilotEnvRunState } from "./state.ts";

/** An "up" verdict ALWAYS carries the port it was probed on, so no consumer handles a portless up daemon. */
export type ProxyStatus = { up: false } | { up: true; port: number };

/** proxyStatus() minus the async pid classification and the port probe, for a synchronous renderer
 *  (the `agent config` "restart the proxy to apply" line). A false positive costs a spare hint, never an action. */
export function trackedDaemonAlive(profile: Profile = null): boolean {
  const { pid } = CopilotEnvRunState.forProfile(profile).read();
  if (pid === undefined) return false;
  const lock = daemonLockVerdict(new CopilotApiPaths(profile).home, pid);
  return lock === "alive" || (lock === "unproven" && pidAlive(pid));
}

/** The preferences are account-wide, so a stored daemon-read key needs every daemon restarted,
 *  whichever profile launched it. */
export function anyTrackedDaemonAlive(): boolean {
  return [null, ...profileHomeNames()].some((profile) => trackedDaemonAlive(profile));
}

// pid AND port come from the SAME run-state snapshot, so the port returned is the port probed. What the
// snapshot does NOT settle:
//   lock says dead, pid gone, or a confident "not copilot-api"  -> down, whatever listens
//   unproven lock + unknown pid + no recorded port              -> a recycled pid and any listener on the config-sourced default port read as up
export async function proxyStatus(profile: Profile = null): Promise<ProxyStatus> {
  const { pid, port } = CopilotEnvRunState.forProfile(profile).read();
  if (pid === undefined) {
    return { up: false };
  }
  // The daemon lock rules first: the daemon holds `<home>/daemon.lock` for its whole life, so a held
  // lock naming the tracked pid is OS-proven liveness and a released one is death, immune to pid reuse
  // and cheaper than the Windows WMI classification. "unproven" (a pre-lock daemon, or a marker naming
  // another pid) falls back to the pid checks below.
  const lock = daemonLockVerdict(new CopilotApiPaths(profile).home, pid);
  if (lock === "dead") {
    return { up: false };
  }
  if (lock === "unproven") {
    if (!pidAlive(pid)) {
      return { up: false };
    }
    // Only a CONFIDENT "no" rules the proxy out. "unknown" (the caller's token cannot read the pid's
    // command line, as in Codex's sandboxed app without WMI) falls through to the port probe, so a
    // healthy proxy is not reported down.
    if ((await classifyDaemonPid(pid)) === "no") {
      return { up: false };
    }
  }
  // Only a config-ported daemon has a meaningful fallback port; a reservation-ported daemon's
  // reservation IS the recorded port, so without it there is nothing to probe.
  const probePort = port ??
    (daemonPolicy(profile).port.source === "config" ? defaultProxyPort() : undefined);
  if (probePort === undefined) return { up: false };
  return (await portListening(probePort)) ? { up: true, port: probePort } : { up: false };
}

// A bare TCP connect, no HTTP: `--check` runs from an open agent's resolver and from monitors, and must
// leave no trace in the daemon's access log. Both loopbacks are probed CONCURRENTLY and the FIRST
// success wins (fetch's localhost happy-eyeballs), so only a both-fail result waits, for at most one timeout.
export function portListening(port: number, timeoutMs = 2000): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const finish = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  return new Promise((resolve) => {
    let remaining = 2;
    for (const host of ["127.0.0.1", "::1"]) {
      void tryHost(host).then((ok) => {
        if (ok) {
          resolve(true);
        } else if (--remaining === 0) resolve(false);
      });
    }
  });
}

/** Keeps the in-daemon idle watchdog from stopping a proxy an open agent still uses.
 *  setIfExists: a typo'd `--profile <name>` must not fabricate a phantom profile home. */
export function recordHeartbeat(profile: Profile = null): void {
  CopilotEnvRunState.forProfile(profile).setIfExists({ lastEnsureAt: Date.now() });
}

/**
 * The shared core of `agent stop` and the de-authenticate teardown. `graceMs > 0` waits and escalates
 * to SIGKILL for callers that must be sure; `0` sends one SIGTERM without waiting. `classify` is the test seam.
 *   lock "alive" but the owner-filtered scan cannot confirm ours  -> REFUSED with a warning, tracking kept
 *   kill refused at the SIGKILL boundary (pid recycled)           -> counts as STOPPED: the daemon is provably gone
 */
export async function stopTrackedProxy(
  graceMs = 0,
  profile: Profile = null,
  classify: (pid: number) => Promise<"yes" | "no" | "unknown"> = classifyDaemonPid,
): Promise<{ trackedPid?: number; signalled: boolean; stopped: boolean }> {
  const state = CopilotEnvRunState.forProfile(profile);
  // A named profile's `port` is its stable reservation (the baked agent wiring points at it), so only
  // the default's port tracking reverts on stop.
  const clearPort = daemonPolicy(profile).releasesPortOnStop ? { port: null } : {};
  const trackedPid = state.read().pid;
  if (trackedPid === undefined) {
    // Stale activity marks still go, so a fresh start is not seen as recently active; setIfExists keeps
    // a typo'd `agent stop --profile <name>` from fabricating a profile home.
    state.setIfExists({ lastEnsureAt: null });
    clearPersistedInferenceActivity(profile);
    return { signalled: false, stopped: true };
  }
  // The lock rules first (same table as proxyStatus): "dead" is never signalled however alive the pid
  // table says it is, since the OS may have recycled the pid. "unproven" signals on "yes" AND "unknown"
  // (a sandboxed token that cannot read the pid's identity, e.g. Windows Constrained Language Mode):
  // treating "unknown" as gone would leave a live daemon running while reporting it stopped.
  // On Windows SIGTERM maps to TerminateProcess, a hard kill; SQLite WAL recovery makes that safe.
  const lock = daemonLockVerdict(new CopilotApiPaths(profile).home, trackedPid);
  let signalled: boolean;
  switch (lock) {
    case "alive":
      // "alive" proves a live holder SOMEWHERE, not that the local pid is it: on a home shared across
      // hosts the holder is another HOST's daemon, and the tracked number can sit on any innocent local
      // process. An unconfirmed pid is refused LOUDLY with tracking kept: silently unbinding something
      // provably up would lie.
      if (!(await isCopilotApiPid(trackedPid))) {
        consola.warn(
          `Not stopping pid ${trackedPid}: its daemon.lock is held, but this host cannot identify the pid as our daemon (a shared home's daemon on another host, or an unreadable process table). Stop it from its own host; tracking is left in place.`,
        );
        return { trackedPid, signalled: false, stopped: false };
      }
      signalled = true;
      break;
    case "dead":
      signalled = false;
      break;
    case "unproven": {
      const cls = await classify(trackedPid);
      signalled = cls === "yes" || cls === "unknown";
      break;
    }
    default:
      signalled = assertNever(lock);
  }
  let stopped: boolean;
  if (signalled) {
    const verdict = await terminatePid(trackedPid, graceMs, classify);
    switch (verdict) {
      case "refused-reused-pid":
        // The daemon died inside the grace and the OS recycled its pid onto a FOREIGN process; keeping
        // the tracking would aim every follow-up stop at an innocent bystander. terminatePid already
        // warned that the impostor was spared.
        consola.info(
          `The tracked proxy (pid ${trackedPid}) already exited and its pid now belongs to a different process; cleared the stale tracking.`,
        );
        stopped = true;
        break;
      case "term-only":
      case "died-in-grace":
      case "killed":
        // With graceMs 0 a just-SIGTERMed process can still be alive for a tick; a caller needing
        // certainty passes graceMs > 0.
        stopped = !pidAlive(trackedPid);
        break;
      default:
        stopped = assertNever(verdict);
    }
  } else {
    stopped = true;
  }
  // Tracking survives only when we waited and the daemon is confirmed still alive: a stuck daemon a
  // follow-up `agent stop` must be able to target. The graceMs 0 path cannot confirm death, so it stays optimistic.
  const keepTracking = graceMs > 0 && !stopped;
  state.set(
    keepTracking ? { lastEnsureAt: null } : { pid: null, ...clearPort, lastEnsureAt: null },
  );
  clearPersistedInferenceActivity(profile);
  return { trackedPid, signalled, stopped };
}
