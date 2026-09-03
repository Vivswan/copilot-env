// The daemon's hold-for-life liveness lock. The copilot-api daemon acquires an EXCLUSIVE
// advisory lock on `<home>/daemon.lock` at boot (via the `--preload` entry
// daemon_lock_preload.ts) and holds it until the process dies: lock held = alive,
// enforced by the OS, immune to pid reuse, and released at death with no unlock code
// running (SIGKILL included). The CLI side consults the same lock BEFORE the pid-table
// classification (daemonLockVerdict below); a daemon started by an older release holds
// no lock, which is why every consumer keeps pid classification as the fallback when
// the lock ties nothing to the pid in question.
//
// This module is import-safe -- importing it acquires nothing, so unit tests and the
// CLI-side consults can use it freely; only the preload entry acquires (the same split
// every other daemon shim has).
import { join } from "node:path";
import { probeFileLock, tryAcquireFileLock } from "../utils/file_lock.ts";
import { sleepSync } from "../utils/time.ts";

/** Basename of the per-home daemon liveness lock. An on-disk contract: the daemon and
 *  every consult derive the same path, and a rename would orphan running daemons' locks. */
export const DAEMON_LOCK_FILENAME = "daemon.lock";

/** The daemon liveness lock path for one daemon home. */
export function daemonLockPath(home: string): string {
  return join(home, DAEMON_LOCK_FILENAME);
}

// daemon.lock has NO marker-only writers (the filename is new with the OS-locked
// protocol), so a marker found under a FREE OS lock is always a dead holder's leftover:
// steal it at any age. staleMs 0 spells exactly that -- the only marker it honors is one
// written within the same millisecond, which the retry loop below absorbs. Accepted
// residual: a FUTURE-dated marker (clock rollback) whose dead holder's pid was recycled
// onto a live process never reads stale, so a launch in that window fails until the
// clock passes the marker's timestamp -- the same rollback exposure every marker lock in
// the tree has, and it self-heals with time.
const ACQUIRE_STALE_MS = 0;
const ACQUIRE_RETRY_MS = 100;
const ACQUIRE_WAIT_MS = 5_000;

/**
 * Acquire `home`'s daemon lock and hold it for the LIFE of this process. No release
 * exists on purpose: the OS dropping the lock at process death IS the liveness signal.
 * That is also why this uses the tryAcquireFileLock PRIMITIVE rather than the scoped
 * withFileLock API -- a scope pairs its acquisition with a release on exit, and a lock
 * whose lifetime is the process has no exit to release on (test/file_lock.test.ts pins
 * this module as the one production consumer of the primitive).
 *
 * Bounded retries absorb a CLI probe's transient hold (probeFileLock acquires for a
 * moment to observe); a holder still there after the budget is a genuinely live process
 * in this home, reported as `false`. The knobs are injectable for tests only.
 */
export function acquireDaemonLockForLife(
  home: string,
  opts: { waitMs?: number; retryMs?: number } = {},
): boolean {
  const lockPath = daemonLockPath(home);
  const deadline = Date.now() + (opts.waitMs ?? ACQUIRE_WAIT_MS);
  for (;;) {
    if (tryAcquireFileLock(lockPath, ACQUIRE_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(opts.retryMs ?? ACQUIRE_RETRY_MS);
  }
}

/** The lock's judgment of `pid` as `home`'s daemon: alive, dead, or unproven. */
export type DaemonLockVerdict = "alive" | "dead" | "unproven";

/**
 * THE lock-consult decision table, shared by every liveness site (proxyStatus, the stop
 * paths, the launch cleanup) so the judgment cannot drift:
 *   - lock HELD and its marker names `pid`  -> "alive" (the OS proves the holder lives)
 *   - lock ACQUIRABLE and its marker names `pid` -> "dead", whatever the pid table says
 *     (the holder died; a recycled pid can never resurrect the verdict)
 *   - anything else -> "unproven": no lock file (a pre-lock daemon holds none), a marker
 *     naming some other pid, or an unreadable probe. The caller falls back to pid-table
 *     classification, so a daemon started by an older release never reads as dead here.
 */
export function daemonLockVerdict(home: string, pid: number): DaemonLockVerdict {
  const probe = probeFileLock(daemonLockPath(home));
  if (probe.kind === "held" && probe.markerPid === pid) return "alive";
  if (probe.kind === "free" && probe.markerPid === pid) return "dead";
  return "unproven";
}

/** One home's daemon.lock hold, discriminating what a sweep/stop consumer must NOT
 *  conflate: `held` carries the marker-named holder pid, or null when the lock is
 *  provably held but the marker names nobody readable; `free` is a provably free (or
 *  never-written) lock; `unreadable` is a probe that could not judge at all. The two
 *  unattributable kinds (`unreadable`, `held` with a null pid) are "failed to look",
 *  never "nobody there" -- a caller about to signal processes fails closed on them. */
export type DaemonLockHold =
  | { readonly kind: "held"; readonly pid: number | null }
  | { readonly kind: "free" }
  | { readonly kind: "unreadable" };

/** Probe `home`'s daemon lock into the DaemonLockHold judgment above. */
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

/** The pid of the LIVE holder of `home`'s daemon lock, or null when no live holder can be
 *  NAMED (free, unreadable, or held anonymously -- daemonLockHold discriminates those for
 *  callers that must not collapse them). Null-safe for a stop path (nobody to signal),
 *  and derived from daemonLockHold so the two can never judge a probe differently. */
export function daemonLockHolderPid(home: string): number | null {
  const hold = daemonLockHold(home);
  return hold.kind === "held" ? hold.pid : null;
}
