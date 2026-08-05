// The proxy daemon's shared status/stop domain: "is our daemon up?", the raw port
// liveness probe, the idle-watchdog heartbeat, and the tracked-daemon teardown.
// `agent start`/`stop` remain the command handlers, but the logic lives here so the
// other consumers (models, profile, auth, uninstall) import it from this layer
// instead of from another command file.
import { connect } from "node:net";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { defaultProxyPort } from "./port.ts";
import { classifyDaemonPid, pidAlive, terminatePid } from "./process.ts";
import type { Profile } from "./profile.ts";
import { CopilotEnvRunState } from "./state.ts";

/** The `proxyStatus` verdict: a proxy reported up ALWAYS carries the port it was probed
 *  on, so no consumer ever has to handle a tracked-but-portless "up" daemon. */
export type ProxyStatus = { up: false } | { up: true; port: number };

// Whether OUR proxy for `profile` is genuinely up (and on which recorded port): the tracked,
// alive copilot-api pid AND the port it actually recorded both confirm it. Reading pid AND port
// from the SAME run-state snapshot ties the probe to the daemon's real listening port -- so
// a moved port (start chose a different one) or a stranger on the default port can't produce
// a false result, and the returned port matches what was probed. Exported for the other
// commands that need the same "is it up?" answer (`agent models` source auto-pick).
export async function proxyStatus(profile: Profile = null): Promise<ProxyStatus> {
  const { pid, port } = CopilotEnvRunState.forProfile(profile).read();
  if (pid === undefined || !pidAlive(pid)) {
    return { up: false };
  }
  // PID-reuse guard, but liveness-safe: only a CONFIDENT "no" (the recorded pid is gone or is a
  // different, identifiable process) rules the proxy out. "unknown" -- the caller's token can't
  // read the pid's command line, as in Codex's packaged/sandboxed app where WMI is unavailable --
  // falls back to probing OUR recorded pid+port, so a healthy proxy isn't false-reported as down.
  if ((await classifyDaemonPid(pid)) === "no") {
    return { up: false };
  }
  // Only the default daemon has a meaningful port fallback (the configured/built-in
  // default); a named profile with a tracked pid but no recorded port is unprobeable.
  const probePort = port ?? (profile === null ? defaultProxyPort() : undefined);
  if (probePort === undefined) return { up: false };
  // Return the port actually probed (not the raw state field, which can be
  // absent): callers reuse it for follow-up requests, so probe and fetch must
  // name the same port.
  return (await portListening(probePort)) ? { up: true, port: probePort } : { up: false };
}

// A raw TCP-connect liveness probe. It opens (and immediately closes) a loopback socket to
// confirm the daemon is accepting connections WITHOUT sending an HTTP request -- so `--check`
// (run by an open agent's resolver, a monitor, etc.) leaves no trace in the daemon access log.
// The idle watchdog keys off the daemon's inbound-request observer (inference POSTs only),
// not this access log, so a liveness ping never resets the idle clock regardless; a bare
// connect still keeps the access log clean and returns faster than an HTTP round-trip.
// Probes IPv4 and IPv6 loopback
// CONCURRENTLY and settles on the FIRST success (so a healthy proxy returns immediately,
// mirroring fetch's localhost happy-eyeballs) -- only a both-fail result waits, and at most one
// timeout, never two serial.
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
        if (ok)
          resolve(true); // first success wins; later resolve() calls are no-ops
        else if (--remaining === 0) resolve(false); // both failed
      });
    }
  });
}

/**
 * Record an activity heartbeat (`lastEnsureAt`) for `profile`'s daemon so the in-daemon
 * idle watchdog does not stop a proxy an open agent is still using.
 * setIfExists: a typo'd `--profile <name>` must not fabricate a phantom profile home.
 */
export function recordHeartbeat(profile: Profile = null): void {
  CopilotEnvRunState.forProfile(profile).setIfExists({ lastEnsureAt: Date.now() });
}

/**
 * Terminate `profile`'s tracked proxy daemon if it is ours, clearing our run-state tracking
 * and the persisted activity mark. Quiet (no logging, no exit code) -- the shared core of
 * `agent stop` and the de-authenticate teardown. `graceMs > 0` waits that long and escalates
 * to SIGKILL if the daemon is still alive (use it when the caller must be sure it stopped,
 * e.g. de-auth); `0` sends a single SIGTERM without waiting. Returns the tracked pid, whether
 * we signalled it, and whether it is confirmed stopped afterwards.
 */
export async function stopTrackedProxy(
  graceMs = 0,
  profile: Profile = null,
): Promise<{ trackedPid?: number; signalled: boolean; stopped: boolean }> {
  const state = CopilotEnvRunState.forProfile(profile);
  // A named profile's `port` is its stable reservation (the baked agent wiring points at
  // it), so stopping the daemon must NOT release it -- only the default's port tracking
  // reverts to the configured/built-in default on stop.
  const clearPort = profile === null ? { port: null } : {};
  const trackedPid = state.read().pid;
  if (trackedPid === undefined) {
    // Nothing tracked. Still clear any stale activity marks so a fresh start is not seen
    // as recently active. The activity-file removal is safe unconditionally (rmSync
    // creates nothing), and setIfExists keeps the state write from fabricating a phantom
    // profile home for a typo'd `agent stop --profile <name>`.
    state.setIfExists({ lastEnsureAt: null });
    clearPersistedInferenceActivity(profile);
    return { signalled: false, stopped: true };
  }
  // Classify the tracked pid before signalling it -- the OS may have recycled a stale pid onto
  // an unrelated process. Signal on "yes" (confirmed ours) AND "unknown" (a restricted/sandboxed
  // token that can't read the pid's identity, e.g. Windows Constrained Language Mode): the
  // tracked pid is almost certainly still our daemon, and treating "unknown" as "already gone"
  // would leave a live daemon running while reporting it stopped. Only a confident "no" skips the
  // signal. On Windows there are no POSIX signals: SIGTERM maps to TerminateProcess (a hard kill;
  // SQLite WAL recovery makes that safe). Killing the daemon also tears down its idle watchdog.
  const cls = await classifyDaemonPid(trackedPid);
  const signalled = cls === "yes" || cls === "unknown";
  if (signalled) {
    await terminatePid(trackedPid, graceMs);
  }
  // "stopped" = the tracked daemon is no longer alive as our process. A confident "no" (already
  // gone / replaced) counts as stopped. With graceMs 0 (no wait) a just-SIGTERMed process can
  // still be alive for a tick, so a caller needing certainty passes graceMs > 0 (waited + SIGKILL)
  // before this check.
  const stopped = !signalled || !pidAlive(trackedPid);
  // Preserve the pid/port tracking ONLY when we actually waited (graceMs > 0) and the daemon is
  // confirmed still alive -- a genuinely stuck daemon a follow-up `agent stop` must be able to
  // target. Otherwise clear it (the graceMs 0 path can't confirm death, so it stays optimistic,
  // exactly as `agent stop` always has). Activity marks are cleared either way.
  const keepTracking = graceMs > 0 && !stopped;
  state.set(
    keepTracking ? { lastEnsureAt: null } : { pid: null, ...clearPort, lastEnsureAt: null },
  );
  clearPersistedInferenceActivity(profile);
  return { trackedPid, signalled, stopped };
}
