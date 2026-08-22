// Shared cross-process advisory file lock (consumers range from the JSON-store update()
// serialization to the `agent start` critical section, the device-flow login mutex, and the
// autoupdate preflight). Mutual exclusion is carried by an OS advisory lock
// (flock/LockFileEx via Deno.FsFile.tryLockSync), which a crashed holder releases
// automatically. The pid+ts MARKER the lock file carries is retained as the lock's
// observable, cross-version on-disk contract: releases that predate the OS lock judge
// liveness/staleness by the marker alone (the JSON `{pid,ts}` form is the autoupdate lock's
// contract with already-shipped readers), and the marker is still how a lock left behind by a
// marker-only writer -- or leaked by a crashed pre-OS-lock holder -- is judged stale and taken
// over. During a mixed-version window an old release can still rename-steal a live lock it
// judges stale by age; among current-version processes exclusion is exact.
//
// The OS lock is held on a SIDECAR file (`<lock>.oslock`), never on the marker file itself:
// on Windows an exclusive LockFileEx blocks reads and writes from every OTHER handle, so
// locking the marker would make it unreadable to exactly the readers whose contract it is.
// The sidecar is created on demand and NEVER unlinked -- a lock file that can be deleted can
// be locked as an orphan inode by a contender that opened it just before the holder released
// the path, and a permanent sidecar makes that race unrepresentable.
//
// `tryAcquireFileLock` makes ONE attempt; callers own the wait loop so each can choose its
// own cadence and bound (the shared bounded SYNC spin below for the millisecond-scale
// read-modify-writes, an async unbounded wait for start, a single non-waiting attempt for
// the autoupdate preflight). A marker-judged lock is stale when its holder pid is DEAD, or
// -- only when `staleMs` is finite -- older than staleMs. Pass `Infinity` to reclaim ONLY a
// dead holder and never age-steal a live one (right for a lock a live process may
// legitimately hold for a long time, e.g. `agent start` blocking on interactive auth). A
// lock HELD by a live current-version process is protected by the OS lock outright, so the
// age horizon cannot steal it; the exception is this process's OWN held lock, whose aged
// marker is refreshed in place and reported as a (re-)acquire, preserving the historical
// age-steal outcome. Callers may inject `nowMs` (the clock used both for the marker written
// and the age judgment) so a caller with an injected clock, like the autoupdate preflight,
// stays deterministic under test.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isEnoentOrNotdir, readTextOrNull } from "./fs.ts";
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

/** Read the lock file's raw marker by path, or null if absent/unreadable. Only for a lock
 *  we do NOT hold (see the held-handle I/O rule in the header). */
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

/** Render the marker in the format `opts.jsonMarker` selects. */
function renderMarker(nowMs: number, jsonMarker: boolean): string {
  return jsonMarker
    ? JSON.stringify({ pid: process.pid, ts: nowMs })
    : `${process.pid}\n${nowMs}\n`;
}

/** A held OS lock: the open, exclusively-locked SIDECAR handle plus the marker we last wrote.
 *  Disposing releases the OS lock and closes the handle (it does NOT delete the marker file --
 *  that is releaseFileLock's marker-verified job, and the sidecar is never deleted at all). */
class HeldFileLock implements Disposable {
  constructor(
    readonly file: Deno.FsFile,
    public raw: string,
  ) {}

  [Symbol.dispose](): void {
    dropHandle(this.file);
  }
}

/** The locks THIS process currently holds, by lock path. The OS lock is per open handle, so
 *  the handle must stay open for the lock's lifetime; release finds it here. */
const HELD_LOCKS = new Map<string, HeldFileLock>();

/** The sidecar carrying the OS lock for `lockPath`. */
function osLockPath(lockPath: string): string {
  return `${lockPath}.oslock`;
}

/** Unlock and close a sidecar handle we are not keeping. */
function dropHandle(file: Deno.FsFile): void {
  try {
    file.unlockSync();
  } catch {
    // never locked, or already released by the close below
  }
  try {
    file.close();
  } catch {
    // already closed
  }
}

/** What a by-path read of the marker file found. `absent` is a free lock; `unreadable` is a
 *  marker we cannot judge, and therefore one we never steal. */
type MarkerRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "present"; raw: string };

function readMarker(lockPath: string): MarkerRead {
  try {
    return { kind: "present", raw: readFileSync(lockPath, "utf8") };
  } catch (e) {
    return isEnoentOrNotdir(e) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** Replace the marker file's content. False on any I/O error. */
function writeMarker(lockPath: string, text: string): boolean {
  try {
    writeFileSync(lockPath, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One attempt to take the lock: OS-lock the sidecar, then honor a non-stale marker left by a
 * writer the OS lock cannot see (a pre-OS-lock release, or a test-planted marker) by backing
 * off. Returns whether the lock is now held by us. Re-attempting a lock this process already
 * holds returns false while the marker is fresh, and refreshes the marker in place (returning
 * true) once it has aged past `staleMs` -- the same outcome the marker-only protocol produced.
 */
export function tryAcquireFileLock(
  lockPath: string,
  staleMs: number,
  opts: FileLockOptions = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const jsonMarker = opts.jsonMarker ?? false;

  const ours = HELD_LOCKS.get(lockPath);
  if (ours !== undefined) {
    if (!markerStale(ours.raw, staleMs, nowMs)) return false;
    const marker = renderMarker(nowMs, jsonMarker);
    if (!writeMarker(lockPath, marker)) return false;
    ours.raw = marker;
    return true;
  }

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // if we can't even create the dir, the open below fails and the caller proceeds unlocked
  }

  let file: Deno.FsFile;
  try {
    file = Deno.openSync(osLockPath(lockPath), { read: true, write: true, create: true });
  } catch {
    return false; // unreadable/uncreatable -> proceed as unlocked, best-effort
  }
  let kept = false;
  try {
    if (!file.tryLockSync(true)) return false; // a live current-version holder -> genuinely held
    const observed = readMarker(lockPath);
    if (observed.kind === "unreadable") return false;
    if (observed.kind === "present" && !markerStale(observed.raw, staleMs, nowMs)) return false;
    const marker = renderMarker(nowMs, jsonMarker);
    if (!writeMarker(lockPath, marker)) return false;
    HELD_LOCKS.set(lockPath, new HeldFileLock(file, marker));
    kept = true;
    return true;
  } finally {
    if (!kept) dropHandle(file);
  }
}

/**
 * The identity-verified steal of the marker-only protocol: renameSync the lock aside and
 * confirm the yanked marker MATCHES the stale one the caller observed; if a FRESH holder
 * replaced it between the caller's read and the rename, restore it via linkSync (which fails
 * rather than clobbering a lock a third process may have made) and do NOT steal. The
 * sidecar-lock acquire path above no longer needs this dance, but it remains the documented
 * takeover contract old-release processes still execute against our markers, so its restore
 * behavior stays pinned (and tested) here.
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

/** Release the lock: delete the marker file, but only while it is still OURS (pid marker
 *  matches) -- never a successor's, which an old-release rename-steal may have put at the
 *  path. The OS lock drops after, when the sidecar handle closes; the sidecar file itself
 *  stays (see the orphan-inode note in the header). */
export function releaseFileLock(lockPath: string): void {
  const ours = HELD_LOCKS.get(lockPath);
  try {
    const observed = readMarker(lockPath);
    if (observed.kind === "present" && markerPid(observed.raw) === process.pid) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // gone / unreadable -> nothing to release
  } finally {
    if (ours !== undefined) {
      HELD_LOCKS.delete(lockPath);
      ours[Symbol.dispose]();
    }
  }
}
