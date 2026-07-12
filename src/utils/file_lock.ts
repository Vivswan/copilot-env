// Shared best-effort cross-process advisory file lock, used by both the JSON-store update()
// serialization (src/copilot_api/config.ts) and the `agent start` critical-section lock
// (src/commands/start.ts). It is NOT a hard mutex: perfect cross-process mutual exclusion needs
// OS advisory locks (flock/fcntl) that the portable Node/bun fs API doesn't expose, so it builds
// on atomic filesystem primitives -- linkSync to PUBLISH the lock (never observed half-written)
// and an identity-verified renameSync to STEAL a stale one -- and accepts a residual race that
// requires a CRASHED holder AND several precisely-timed racers: while one process reclaims a
// dead lock, a second may briefly displace a third's just-created lock during the restore
// window. In the COMMON path (no crash) it is exact. The consequence differs by caller: for the
// store lock it is at worst a single lost update; for the start lock, in that astronomically
// unlikely window two `agent start` could overlap and one reap the other's daemon -- which is
// self-healing (the reaped start fails and the resolver retries). This residual is fundamental
// to portable file locks (no crash-reclaiming file mutex is fully correct without OS locking);
// closing it entirely would need native advisory locks or a broker.
//
// `tryAcquireFileLock` makes ONE attempt (create, or reclaim a stale lock); callers own the
// wait loop so each can choose its own cadence and bound (a sync bounded spin for the store, an
// async unbounded wait for start). A lock is stale when its holder pid is DEAD, or -- only when
// `staleMs` is finite -- older than staleMs. Pass `Infinity` to reclaim ONLY a dead holder and
// never age-steal a live one (right for a lock a live process may legitimately hold for a long
// time, e.g. `agent start` blocking on interactive auth).
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Alive check via a null signal. EPERM means the pid exists but this token can't signal it --
 *  still alive; only ESRCH (thrown as a non-EPERM error) means dead. */
function pidAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the lock file's raw marker (`${pid}\n${ts}\n`), or null if absent/unreadable. */
function readLockRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/** Whether a raw lock marker is stale: malformed, its holder pid is dead, or (finite staleMs
 *  only) older than staleMs. */
function markerStale(raw: string, staleMs: number): boolean {
  const [pidStr, tsStr] = raw.split("\n");
  const pid = Number.parseInt(pidStr ?? "", 10);
  const ts = Number.parseInt(tsStr ?? "", 10);
  if (Number.isNaN(pid) || pid <= 0 || Number.isNaN(ts)) return true;
  if (!pidAliveLocal(pid)) return true;
  return Number.isFinite(staleMs) && Date.now() - ts > staleMs;
}

/** Create the lock file with its content already in place: write a unique temp file, then
 *  hard-link it to `lockPath` (linkSync is atomic; EEXIST if held; the linked file is never
 *  observed empty). Returns false if held or on any error. */
function tryCreateLock(lockPath: string): boolean {
  const tmp = `${lockPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${process.pid}\n${Date.now()}\n`);
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
 * One attempt to take the lock: create it, or if a stale lock is held (per markerStale/staleMs),
 * reclaim it. Returns whether the lock is now held by us. The steal is identity-verified: we
 * renameSync the lock aside and confirm the yanked marker MATCHES the stale one we observed; if a
 * FRESH holder replaced it between our read and the rename, we restore it via linkSync (which
 * fails rather than clobbering a lock a third process may have made) and do NOT steal.
 */
export function tryAcquireFileLock(lockPath: string, staleMs: number): boolean {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // if we can't even create the dir, tryCreateLock will fail and the caller proceeds unlocked
  }
  if (tryCreateLock(lockPath)) return true;
  const observed = readLockRaw(lockPath);
  if (observed !== null && markerStale(observed, staleMs)) {
    const claimed = `${lockPath}.steal.${process.pid}.${Date.now()}`;
    let yanked: string | null = null;
    try {
      renameSync(lockPath, claimed);
      yanked = readLockRaw(claimed);
    } catch {
      yanked = null; // someone else already moved/removed it
    }
    if (yanked !== null) {
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
    return tryCreateLock(lockPath);
  }
  return false;
}

/** Release the lock, but only if it is still OURS (pid marker matches) -- never delete a
 *  successor's. */
export function releaseFileLock(lockPath: string): void {
  try {
    const pid = Number.parseInt(readLockRaw(lockPath)?.split("\n")[0] ?? "", 10);
    if (pid === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // gone / unreadable -> nothing to release
  }
}
