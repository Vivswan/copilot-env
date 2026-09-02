// Create-exclusive lock guarding the autoupdate preflight, so two shells racing at the
// same moment don't both download + apply the same release. A thin parameterization of
// the shared advisory file lock (utils/file_lock.ts, which also carries the no-flock
// rationale): same linkSync publish, identity-verified steal with fresh-holder restore,
// and pid-guarded release, with autoupdate's own staleness horizon and injected clock.
//
// This is a BEST-EFFORT advisory lock for a once-a-day personal self-update, not a
// distributed mutex. Its correctness rests on one invariant: STALE_LOCK_MS must far
// exceed the real work duration (a tarball download + a frozen `deno install` of a few pinned
// deps -- seconds to a couple of minutes), so a LIVE holder is never seen as stale.
// Steal therefore only ever reaps a crashed/dead holder; a live lock is never stolen,
// which is what keeps the release path from racing a successor.
//
// Marker format: this lock's on-disk marker is JSON `{pid,ts}` (`jsonMarker`), NOT the
// shared native form, because the format is an external contract with every release
// already installed: a pre-unification `agent update` resolves the target release over
// the network BEFORE acquiring, so a not-yet-updated process can easily examine this
// lock while a new one holds it (and vice versa) during the in-place upgrade window.
// Both sides parse JSON `{pid,ts}`, so a live holder is always honored across versions;
// changing the written format would make old readers misjudge a live new lock as
// malformed and steal it mid-update.
import { withFileLock } from "../utils/file_lock.ts";
import { autoupdateLockFile } from "./paths.ts";

// 30 minutes -- chosen to dwarf any real update (see the invariant above).
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

/** Run `fn` scoped to ONE acquisition attempt of the update lock (stealing a stale one;
 *  a fresh holder means another update is running, and `fn` observes `held: false` to
 *  skip). Released exactly once, on every exit path, and only if WE own it (never a
 *  successor's lock). Always locks autoupdateLockFile(): HeldUpdateLock is evidence about
 *  THE update lock, so no caller may point this at another path and mint it anyway. */
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
