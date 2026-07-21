// `agent stop`: terminates the tracked local proxy daemon(s).
import { existsSync } from "node:fs";
import { consola } from "consola";
import { CopilotApiPaths, profileHomeNames } from "../copilot_api/paths.ts";
import { classifyDaemonPid, pidAlive, terminatePid } from "../copilot_api/process.ts";
import { assertProfileName, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { clearPersistedInferenceActivity } from "../scripts/inference_activity.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

export interface StopArgs {
  /** `--profile <name>`: stop that named profile's daemon instead of the default. */
  profile?: string;
  /** `--all`: stop the default daemon AND every named profile's daemon. */
  all?: boolean;
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
    // creates nothing), but the STATE write runs for a NAMED profile only when its state
    // already exists on disk: the store's atomic write mkdirs its parent, so an
    // unconditional write here would FABRICATE a phantom profile home for a typo'd
    // `agent stop --profile <name>` (which profile --list / stop --all / the proxy float
    // would then all see).
    if (profile === null || existsSync(new CopilotApiPaths(profile).stateFile)) {
      state.set({ lastEnsureAt: null });
    }
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

/** Stop one daemon and report the outcome. Returns true when something was stopped. */
async function stopOne(profile: Profile): Promise<boolean> {
  const { trackedPid, signalled } = await stopTrackedProxy(0, profile);
  const what = profile === null ? "proxy" : `${profileLabel(profile)} proxy`;
  if (trackedPid === undefined) {
    consola.info(`The ${what} is not running on this host (nothing to stop).`);
    return false;
  }
  if (!signalled) {
    consola.info(`The ${what} (PID ${trackedPid}) was already stopped; cleared stale tracking.`);
    return false;
  }
  consola.info(`Stopped the ${what} (PID ${trackedPid})`);
  return true;
}

/** `stop`: terminate the proxy daemon(s) tracked on this host. */
export async function runStop(args: StopArgs = {}): Promise<void> {
  if (args.all && args.profile !== undefined) {
    throw new Error("--all stops every daemon; it does not combine with --profile");
  }
  const profiles: Profile[] = args.all ? [null, ...profileHomeNames()] : [args.profile ?? null];
  if (args.profile !== undefined) assertProfileName(args.profile);
  let stoppedAny = false;
  for (const profile of profiles) {
    if (await stopOne(profile)) stoppedAny = true;
  }
  if (!stoppedAny) {
    // Not a crash -- just nothing to do. Friendly note, no stack trace, but a
    // non-zero exit so scripts can still tell "stopped" from "nothing running".
    process.exitCode = 1;
    return;
  }
  consola.info(`   Bun env: ${PROJECT_ROOT}`);
}
