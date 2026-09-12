// The create-exclusive lock around the autoupdate preflight, so two shells racing at the same
// moment do not both download and apply one release. A parameterization of the shared advisory
// file lock (utils/file_lock.ts, which also carries the no-flock rationale).
//
//   best-effort, a once-a-day personal self-update -> not a distributed mutex
//   STALE_LOCK_MS dwarfs any real update           -> a LIVE holder is never seen as stale, so
//                                                     steal only ever reaps a dead one
//   marker is JSON `{pid,ts}` (`jsonMarker`)       -> an external contract with every installed
//                                                     release; change it and a not-yet-updated
//                                                     reader misjudges a live new lock as
//                                                     malformed and steals it mid-update
import { withFileLock } from "../utils/file_lock.ts";
import { autoupdateLockFile } from "./paths.ts";

// 30 minutes, chosen to dwarf any real update (the invariant above).
const STALE_LOCK_MS = 30 * 60 * 1000;

declare const updateLockBrand: unique symbol;

/** Evidence that the UPDATE lock specifically is held: minted only by withUpdateLock's
 *  held branch (a generic file-lock scope cannot produce one), and the evidence
 *  applyUpdate demands. */
export interface HeldUpdateLock {
  readonly held: true;
  readonly [updateLockBrand]: true;
}

export type UpdateLockOutcome = HeldUpdateLock | { readonly held: false };

const HELD_UPDATE_LOCK: HeldUpdateLock = Object.freeze({ held: true } as HeldUpdateLock);
const UPDATE_LOCK_NOT_HELD: UpdateLockOutcome = Object.freeze({ held: false });

/** Always THE update lock: HeldUpdateLock is evidence about that one path, so no caller can aim
 *  this elsewhere and mint one anyway. One acquisition attempt, never a retry.
 *
 *    the lock is stale  -> stolen, and `fn` sees `held: true`
 *    a holder is fresh  -> another update is running, and `fn` sees `held: false`
 *    we took it         -> released exactly once, and never another holder's lock */
export function withUpdateLock<T>(
  nowMs: number,
  fn: (outcome: UpdateLockOutcome) => T | Promise<T>,
): Promise<T> {
  return updateLockScope(autoupdateLockFile(), nowMs, fn);
}

/** TEST-ONLY seam: withUpdateLock against a hermetic temp path, so suites never touch the
 *  install root's real lock. Production code calls withUpdateLock; the file-lock lint pin
 *  (test/file_lock.test.ts) keeps this name out of src/. */
export function withUpdateLockForTests<T>(
  lockPath: string,
  nowMs: number,
  fn: (outcome: UpdateLockOutcome) => T | Promise<T>,
): Promise<T> {
  return updateLockScope(lockPath, nowMs, fn);
}

function updateLockScope<T>(
  lockPath: string,
  nowMs: number,
  fn: (outcome: UpdateLockOutcome) => T | Promise<T>,
): Promise<T> {
  return withFileLock(
    lockPath,
    { staleMs: STALE_LOCK_MS, waitMs: 0, nowMs, jsonMarker: true },
    (outcome) => fn(outcome.held ? HELD_UPDATE_LOCK : UPDATE_LOCK_NOT_HELD),
  );
}
