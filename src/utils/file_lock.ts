// Shared best-effort cross-process advisory file lock (consumers range from the JSON-store
// update() serialization to the `agent start` critical section, the device-flow login mutex,
// and the autoupdate preflight). It is NOT a hard mutex: perfect cross-process mutual exclusion
// needs OS advisory locks (flock/fcntl) that the portable Node/bun fs API doesn't expose, so it
// builds on atomic filesystem primitives -- linkSync to PUBLISH the lock (never observed
// half-written) and an identity-verified renameSync to STEAL a stale one -- and accepts a
// residual race that requires a CRASHED holder AND several precisely-timed racers: while one
// process reclaims a dead lock, a second may briefly displace a third's just-created lock during
// the restore window. In the COMMON path (no crash) it is exact. The consequence differs by
// caller: for the store lock it is at worst a single lost update; for the start lock, in that
// astronomically unlikely window two `agent start` could overlap and one reap the other's daemon
// -- which is self-healing (the reaped start fails and the resolver retries). This residual is
// fundamental to portable file locks (no crash-reclaiming file mutex is fully correct without OS
// locking); closing it entirely would need native advisory locks or a broker.
//
// `tryAcquireFileLock` makes ONE attempt (create, or reclaim a stale lock); callers own the wait
// loop so each can choose its own cadence and bound (the shared bounded SYNC spin below for the
// millisecond-scale read-modify-writes, an async unbounded wait for start, a single non-waiting
// attempt for the autoupdate preflight). A lock is stale when its holder pid is DEAD, or -- only
// when `staleMs` is finite -- older than staleMs. Pass `Infinity` to reclaim ONLY a dead holder
// and never age-steal a live one (right for a lock a live process may legitimately hold for a
// long time, e.g. `agent start` blocking on interactive auth). Callers may also inject `nowMs`
// (the clock used both for the marker written and the age judgment) so a caller with an injected
// clock, like the autoupdate preflight, stays deterministic under test. Two marker formats are
// WRITTEN (`jsonMarker` below) and both are always READ; which one a lock file uses is that
// lock's on-disk contract, never changed for an existing lock path.
import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readTextOrNull } from "./fs.ts";
import { isRecord } from "./json.ts";
import { pidAlive } from "./pid.ts";
import { sleepSync } from "./time.ts";

// --- the shared bounded-wait acquisition policy --------------------------------
//
// ONE stale/wait/retry contract for every millisecond-scale SYNC read-modify-write
// (the JSON store's update() serialization and the profile-port reservation): a
// lock whose holder pid is dead -- or older than LOCK_STALE_MS -- is reclaimed,
// and after a bounded LOCK_WAIT_MS wait the caller proceeds WITHOUT the lock
// rather than deadlock a command. Since a real critical section is milliseconds,
// a live holder is never seen stale and the wait effectively never expires -- the
// backstops only ever reclaim a crashed/leaked lock.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 15;

/** Acquire `lockPath` under the shared bounded SYNC wait above, returning whether
 *  the lock is now held (false = the caller proceeds unlocked, best-effort). */
export function acquireFileLockBounded(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryAcquireFileLock(lockPath, LOCK_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(LOCK_RETRY_MS);
  }
}

/** Read the lock file's raw marker, or null if absent/unreadable. */
function readLockRaw(lockPath: string): string | null {
  return readTextOrNull(lockPath);
}

interface LockMarker {
  pid: number;
  ts: number;
}

/** Per-lock knobs for `tryAcquireFileLock`. */
export interface FileLockOptions {
  /** The clock used both for the marker written and the age judgment (default Date.now()),
   *  injectable so a caller with an injected clock stays deterministic under test. */
  nowMs?: number;
  /** Write the marker as JSON `{pid,ts}` instead of the native `${pid}\n${ts}\n`. This is the
   *  autoupdate lock's on-disk contract: pre-unification releases both wrote and PARSED only
   *  that form, so keeping it means a not-yet-updated reader still recognizes a live holder
   *  during the in-place upgrade window instead of misjudging the lock malformed and stealing
   *  it. Readers here always accept BOTH formats regardless of this flag. */
  jsonMarker?: boolean;
}

/** Parse a lock marker: the native `${pid}\n${ts}\n` form, or the JSON `{pid,ts}` form written
 *  under `jsonMarker`. Null = malformed. */
function parseMarker(raw: string): LockMarker | null {
  const [pidStr, tsStr] = raw.split("\n");
  const pid = Number.parseInt(pidStr ?? "", 10);
  const ts = Number.parseInt(tsStr ?? "", 10);
  if (!Number.isNaN(pid) && pid > 0 && !Number.isNaN(ts)) return { pid, ts };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.ts === "number" &&
      Number.isFinite(parsed.ts)
    ) {
      return { pid: parsed.pid, ts: parsed.ts };
    }
  } catch {
    // not JSON either -> malformed
  }
  return null;
}

/** Whether a raw lock marker is stale: malformed, its holder pid is dead, or (finite staleMs
 *  only) older than staleMs as of `nowMs`. */
function markerStale(raw: string, staleMs: number, nowMs: number): boolean {
  const marker = parseMarker(raw);
  if (marker === null) return true;
  if (!pidAlive(marker.pid)) return true;
  return Number.isFinite(staleMs) && nowMs - marker.ts > staleMs;
}

/** Create the lock file with its content already in place: write a unique temp file, then
 *  hard-link it to `lockPath` (linkSync is atomic; EEXIST if held; the linked file is never
 *  observed empty). Returns false if held or on any error. */
function tryCreateLock(lockPath: string, nowMs: number, jsonMarker: boolean): boolean {
  const tmp = `${lockPath}.tmp.${process.pid}.${Date.now()}`;
  const marker = jsonMarker
    ? JSON.stringify({ pid: process.pid, ts: nowMs })
    : `${process.pid}\n${nowMs}\n`;
  try {
    writeFileSync(tmp, marker);
  } catch {
    return false;
  }
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch {
    return false; // EEXIST (held) or an unexpected error -> proceed as unlocked
  } finally {
    try {
      rmSync(tmp, { force: true }); // the hard link keeps the inode; the temp name is disposable
    } catch {
      // ignore
    }
  }
}

/**
 * One attempt to take the lock: create it, or if a stale lock is held (per markerStale/staleMs,
 * judged at `opts.nowMs`), reclaim it via the identity-verified steal below. Returns whether the
 * lock is now held by us.
 */
export function tryAcquireFileLock(
  lockPath: string,
  staleMs: number,
  opts: FileLockOptions = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const jsonMarker = opts.jsonMarker ?? false;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // if we can't even create the dir, tryCreateLock will fail and the caller proceeds unlocked
  }
  if (tryCreateLock(lockPath, nowMs, jsonMarker)) return true;
  const observed = readLockRaw(lockPath);
  if (observed === null) {
    // The lock vanished between the failed create and the read (a release or a completed
    // steal) -- retry the create once rather than reporting phantom contention. A PRESENT
    // but unreadable lock still blocks: a marker we cannot read is one we never steal.
    return tryCreateLock(lockPath, nowMs, jsonMarker);
  }
  if (markerStale(observed, staleMs, nowMs)) {
    reclaimStaleLock(lockPath, observed);
    return tryCreateLock(lockPath, nowMs, jsonMarker);
  }
  return false;
}

/**
 * The identity-verified steal: renameSync the lock aside and confirm the yanked marker MATCHES
 * the stale one the caller observed; if a FRESH holder replaced it between the caller's read and
 * the rename, restore it via linkSync (which fails rather than clobbering a lock a third process
 * may have made) and do NOT steal. Exported because the interleaving it guards against cannot be
 * produced on demand, so its restore contract is tested directly.
 */
export function reclaimStaleLock(lockPath: string, observed: string): void {
  const claimed = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  let yanked: string | null = null;
  try {
    renameSync(lockPath, claimed);
    yanked = readLockRaw(claimed);
  } catch {
    yanked = null; // someone else already moved/removed it
  }
  if (yanked === null) return;
  if (yanked === observed) {
    try {
      rmSync(claimed, { force: true }); // reclaimed exactly the stale lock we judged
    } catch {
      // ignore
    }
  } else {
    // Yanked a DIFFERENT (fresh) lock -> put it back without clobbering, don't steal.
    try {
      linkSync(claimed, lockPath);
    } catch {
      // lockPath re-occupied / fs error -> leave it; the yanked holder re-locks next attempt
    }
    try {
      rmSync(claimed, { force: true });
    } catch {
      // ignore
    }
  }
}

/** The holder pid of a raw marker, parsed LENIENTLY from either format (ts ignored). Release
 *  needs only the identity: a holder must still be able to delete its own marker even if the
 *  ts half got corrupted. Null when no pid can be read. */
function markerPid(raw: string): number | null {
  const pid = Number.parseInt(raw.split("\n")[0] ?? "", 10);
  if (!Number.isNaN(pid) && pid > 0) return pid;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed.pid;
    }
  } catch {
    // not JSON either -> no readable pid
  }
  return null;
}

/** Release the lock, but only if it is still OURS (pid marker matches) -- never delete a
 *  successor's. */
export function releaseFileLock(lockPath: string): void {
  try {
    const raw = readLockRaw(lockPath);
    if (raw !== null && markerPid(raw) === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // gone / unreadable -> nothing to release
  }
}
