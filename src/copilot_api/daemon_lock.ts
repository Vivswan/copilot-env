// The daemon's liveness is its `daemon.lock` (src/utils/file_lock.ts): the OS lock it holds for
// life on the sidecar, with the marker naming its pid, so no unlock code has to run at death.
//   SIGKILL, a crash                -> the OS releases the lock; the marker stays, naming a pid
//                                      nobody holds the lock under: read as dead
//   a daemon from an older release  -> holds none, so consumers fall back to the pid table
//   a home without OS locks         -> the marker layer: the pid is judged, and one the CLI cannot
//                                      signal (EPERM, a sandboxed token) reads alive, so the CLI
//                                      clears a dead predecessor's leftover before the spawn
//                                      (clearDeadDaemonLock)
//   importing this module           -> acquires nothing; daemon_lock_preload.ts does
import { join } from "node:path";
import {
  type LockJudge,
  probeFileLock,
  removeLeftoverLock,
  tryAcquireFileLock,
} from "../utils/file_lock.ts";
import { sleepSync } from "../utils/time.ts";

/** An on-disk contract: a rename would orphan every running daemon's lock. */
const DAEMON_LOCK_FILENAME = "daemon.lock";

export function daemonLockPath(home: string): string {
  return join(home, DAEMON_LOCK_FILENAME);
}

// staleMs governs only a second acquire from the SAME process (another process's hold is never
// judged by age, see file_lock.ts): 0 lets it refresh the marker rather than read its own hold as
// a contender.
const ACQUIRE_STALE_MS = 0;
const ACQUIRE_RETRY_MS = 100;
const ACQUIRE_WAIT_MS = 5_000;

/** No release exists on purpose: the lock the OS drops at death IS the liveness signal, which is
 *  why this uses the tryAcquireFileLock primitive rather than scoped withFileLock
 *  (test/utils/file_lock.test.ts pins this module as the primitive's one production consumer).
 *  The knobs are for tests. */
export function acquireDaemonLockForLife(
  home: string,
  opts: { waitMs?: number; retryMs?: number } = {},
): boolean {
  const lockPath = daemonLockPath(home);
  const deadline = Date.now() + (opts.waitMs ?? ACQUIRE_WAIT_MS);
  // A lock still held after the budget is a second daemon in this home, or on the marker layer a
  // leftover the daemon cannot judge, which is the CLI's to clear before the spawn
  // (clearDeadDaemonLock). The retries cover a predecessor that is still exiting.
  for (;;) {
    if (tryAcquireFileLock(lockPath, ACQUIRE_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(opts.retryMs ?? ACQUIRE_RETRY_MS);
  }
}

/** The CLI's half of the takeover: a marker a dead daemon left is removed so the next daemon's
 *  acquire finds the way clear even where, on the marker layer, that daemon could not judge the
 *  pid. launchDaemon (src/copilot_api/process.ts) runs it before every spawn. */
export function clearDeadDaemonLock(home: string): boolean {
  return removeLeftoverLock(daemonLockPath(home));
}

/** The pid a `daemon.lock` names while nobody holds its OS lock, where the OS lock is the judge:
 *  a daemon that wrote the marker before this release's lock took the sidecar still runs behind
 *  a lock that reads dead (src/migrations/5.0.1.ts stops it once). Null under a held lock, on the
 *  marker layer, and with no marker. */
export function daemonPidWithoutOsLock(home: string): number | null {
  const probe = probeFileLock(daemonLockPath(home));
  return probe.kind === "free" && probe.judge === "os-lock" ? probe.markerPid : null;
}

type DaemonLockVerdict = "alive" | "dead" | "unproven";

/**
 * Shared by every liveness site (proxyStatus, the stop paths, the launch cleanup) so the judgment
 * cannot drift.
 *   marker names pid, lock held  -> "alive"
 *   marker names pid, lock free  -> "dead": the daemon that wrote it is gone, whatever the pid
 *                                   table says of the number
 *   anything else                -> "unproven": the caller falls back to the pid table
 */
export function daemonLockVerdict(home: string, pid: number): DaemonLockVerdict {
  const probe = probeFileLock(daemonLockPath(home));
  if (probe.kind === "held" && probe.markerPid === pid) return "alive";
  if (probe.kind === "free" && probe.markerPid === pid) return "dead";
  return "unproven";
}

/** `unreadable` and `held` with a null pid are "failed to look", never "nobody there": a caller
 *  about to signal processes fails closed on both. `judge` says what `held` rests on: under the OS
 *  lock a holder is a live process whatever its pid reads as; on the marker layer a held pid may
 *  be recycled. */
type DaemonLockHold =
  | { readonly kind: "held"; readonly pid: number | null; readonly judge: LockJudge }
  | { readonly kind: "free" }
  | { readonly kind: "unreadable" };

export function daemonLockHold(home: string): DaemonLockHold {
  const probe = probeFileLock(daemonLockPath(home));
  switch (probe.kind) {
    case "held":
      return { kind: "held", pid: probe.markerPid, judge: probe.judge };
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
