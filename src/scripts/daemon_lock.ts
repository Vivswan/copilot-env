// Lock held = alive, enforced by the OS, so no unlock code has to run at death.
//   a recycled pid                 -> holds no lock of its own
//   SIGKILL                        -> the OS releases it anyway
//   a daemon from an older release -> holds none, so consumers fall back to the pid table
//   importing this module          -> acquires nothing; daemon_lock_preload.ts does
import { join } from "node:path";
import { probeFileLock, tryAcquireFileLock } from "../utils/file_lock.ts";
import { sleepSync } from "../utils/time.ts";

/** An on-disk contract: a rename would orphan every running daemon's lock. */
export const DAEMON_LOCK_FILENAME = "daemon.lock";

export function daemonLockPath(home: string): string {
  return join(home, DAEMON_LOCK_FILENAME);
}

// daemon.lock has no marker-only writers, so a marker under a FREE OS lock is always a dead
// holder's leftover: staleMs 0 honors only a marker written this same millisecond by a still-live
// pid, which the retry loop below absorbs. Accepted residual: a future-dated marker (clock
// rollback) whose dead holder's pid was recycled onto a live process blocks launches until the
// clock passes it.
const ACQUIRE_STALE_MS = 0;
const ACQUIRE_RETRY_MS = 100;
const ACQUIRE_WAIT_MS = 5_000;

/** No release exists on purpose: the OS dropping the lock at death IS the liveness signal, which is
 *  why this uses the tryAcquireFileLock primitive rather than scoped withFileLock
 *  (test/file_lock.test.ts pins this module as the primitive's one production consumer). The knobs
 *  are for tests. */
export function acquireDaemonLockForLife(
  home: string,
  opts: { waitMs?: number; retryMs?: number } = {},
): boolean {
  const lockPath = daemonLockPath(home);
  const deadline = Date.now() + (opts.waitMs ?? ACQUIRE_WAIT_MS);
  // The retries absorb a CLI probe's transient hold (probeFileLock acquires for a moment to
  // observe); a holder still there after the budget is a live process in this home.
  for (;;) {
    if (tryAcquireFileLock(lockPath, ACQUIRE_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(opts.retryMs ?? ACQUIRE_RETRY_MS);
  }
}

export type DaemonLockVerdict = "alive" | "dead" | "unproven";

/**
 * Shared by every liveness site (proxyStatus, the stop paths, the launch cleanup) so the judgment
 * cannot drift.
 *   lock held, marker names pid        -> "alive": the OS proves the holder lives
 *   lock acquirable, marker names pid  -> "dead" whatever the pid table says; a recycled pid cannot
 *                                         resurrect it
 *   anything else                      -> "unproven": the caller falls back to the pid table
 */
export function daemonLockVerdict(home: string, pid: number): DaemonLockVerdict {
  const probe = probeFileLock(daemonLockPath(home));
  if (probe.kind === "held" && probe.markerPid === pid) return "alive";
  if (probe.kind === "free" && probe.markerPid === pid) return "dead";
  return "unproven";
}

/** `unreadable` and `held` with a null pid are "failed to look", never "nobody there": a caller
 *  about to signal processes fails closed on both. */
export type DaemonLockHold =
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
      // materialized import closure, which test/installer_pinning.test.ts pins.
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
