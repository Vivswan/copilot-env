// The lock around the autoupdate preflight, so two shells racing at the same
// moment do not both download and apply one release. A parameterization of the shared advisory
// file lock (utils/file_lock.ts, which also carries the no-flock rationale).
//
//   best-effort, a once-a-day personal self-update -> not a distributed mutex
//   the 30-minute stale window dwarfs any update  -> a second scope in THIS process never
//                                                     refresh-acquires a live update's lock
import type { LockOutcome } from "../utils/file_lock.ts";
import { withFileLock } from "../utils/file_lock.ts";
import { autoupdateLockFile } from "./state.ts";

/** One acquisition attempt, never a retry; 30 minutes stale, chosen to dwarf any real update (the
 *  invariant above). Tests lock a hermetic path under the same policy. */
export const UPDATE_LOCK_POLICY = { staleMs: 30 * 60 * 1000, waitMs: 0 } as const;

/** Always THE update lock: no caller can aim it elsewhere.
 *
 *    the OS lock is free  -> taken over whatever marker is left, and `fn` sees `held: true`
 *    a holder is live     -> another update is running, and `fn` sees `held: false`
 *    we took it           -> released exactly once, and never another holder's lock */
export function withUpdateLock<T>(
  nowMs: number,
  fn: (outcome: LockOutcome) => T | Promise<T>,
): Promise<T> {
  return withFileLock(autoupdateLockFile(), { ...UPDATE_LOCK_POLICY, nowMs }, fn);
}
