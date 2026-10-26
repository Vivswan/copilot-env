// The daemon's liveness is its `daemon.lock` marker (src/utils/file_lock.ts): the file names the
// daemon's pid, and a reader judges that pid, so no unlock code has to run at death.
//   SIGKILL, a crash                -> the marker stays, naming a dead pid: read as dead
//   a daemon from an older release  -> holds none, so consumers fall back to the pid table
//   a pid the daemon cannot judge   -> reads alive (EPERM, a sandboxed token), so the CLI clears a
//                                      dead predecessor's leftover before the spawn
//                                      (clearDeadDaemonLock)
//   importing this module           -> acquires nothing; daemon_lock_preload.ts does
import { join } from "node:path";
import { probeFileLock, removeLeftoverLock, tryAcquireFileLock } from "../utils/file_lock.ts";
import { sleepSync } from "../utils/time.ts";

/** An on-disk contract: a rename would orphan every running daemon's lock. */
const DAEMON_LOCK_FILENAME = "daemon.lock";

export function daemonLockPath(home: string): string {
  return join(home, DAEMON_LOCK_FILENAME);
}

// 0: a second acquire from the SAME process refreshes its own marker rather than reading it as a contender.
const ACQUIRE_STALE_MS = 0;

// The pause between tries while a predecessor is still exiting; a test may pass its own.
const ACQUIRE_RETRY_MS = 100;

// The whole budget before a marker still there is refused; a test may pass its own.
const ACQUIRE_WAIT_MS = 5_000;

/** No release exists on purpose: the marker left at death, naming a pid that is gone, IS the
 *  liveness signal, which is why this uses the tryAcquireFileLock primitive rather than scoped
 *  withFileLock (test/utils/file_lock.test.ts pins this module as the primitive's one production
 *  consumer). The knobs are for tests. staleMs governs only a re-acquire from the same process:
 *  another process's marker is judged by its pid's liveness, never by its age (file_lock.ts). */
export function acquireDaemonLockForLife(
  home: string,
  opts: { waitMs?: number; retryMs?: number } = {},
): boolean {
  const lockPath = daemonLockPath(home);
  const deadline = Date.now() + (opts.waitMs ?? ACQUIRE_WAIT_MS);
  // A marker still there after the budget is refused whatever its holder's fate: a dead
  // predecessor's leftover is the CLI's to clear before the spawn (clearDeadDaemonLock), and a
  // live holder is a second daemon in this home. The retries cover a CLI test acquiring over a
  // predecessor that is still exiting.
  for (;;) {
    if (tryAcquireFileLock(lockPath, ACQUIRE_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(opts.retryMs ?? ACQUIRE_RETRY_MS);
  }
}

/** The CLI's half of the takeover: a marker a dead daemon left is removed so the next daemon's
 *  acquire finds the way clear even where that daemon could not judge the pid. launchDaemon
 *  (src/copilot_api/process.ts) runs it before every spawn. */
export function clearDeadDaemonLock(home: string): boolean {
  return removeLeftoverLock(daemonLockPath(home));
}

type DaemonLockVerdict = "alive" | "dead" | "unproven";

/**
 * Shared by every liveness site (proxyStatus, the stop paths, the launch cleanup) so the judgment
 * cannot drift.
 *   marker names pid, pid alive  -> "alive"
 *   marker names pid, pid dead   -> "dead": the daemon that wrote it is gone
 *   anything else                -> "unproven": the caller falls back to the pid table
 */
export function daemonLockVerdict(home: string, pid: number): DaemonLockVerdict {
  const probe = probeFileLock(daemonLockPath(home));
  if (probe.kind === "held" && probe.markerPid === pid) return "alive";
  if (probe.kind === "free" && probe.markerPid === pid) return "dead";
  return "unproven";
}

/** `unreadable` and `held` with a null pid are "failed to look", never "nobody there": a caller
 *  about to signal processes fails closed on both. */
type DaemonLockHold =
  | { readonly kind: "held"; readonly pid: number | null }
  | { readonly kind: "free" }
  | { readonly kind: "unreadable" };

export function daemonLockHold(home: string): DaemonLockHold {
  const probe = probeFileLock(daemonLockPath(home));
  switch (probe.kind) {
    case "held":
      return { kind: "held", pid: probe.markerPid };
    case "free":
    case "absent":
      return { kind: "free" };
    case "unknown":
      return { kind: "unreadable" };
    default: {
      // Inline exhaustiveness: importing assertNever would widen the daemon shims'
      // materialized import closure, which test/install/installer_pinning.e2e.test.ts pins.
      const unhandled: never = probe;
      throw new Error(`unreachable: unhandled lock probe ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Collapses the unattributable kinds to null, which is safe only for a caller that then has nobody
 *  to signal; one that must not collapse them uses daemonLockHold. */
export function daemonLockHolderPid(home: string): number | null {
  const hold = daemonLockHold(home);
  return hold.kind === "held" ? hold.pid : null;
}
