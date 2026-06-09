// Create-exclusive lock guarding the autoupdate preflight, so two shells racing
// at the same moment don't both download + apply the same release. No flock
// (NFS-unfriendly, per usage.ts). A lock is stale when older than 30 minutes or
// owned by a dead pid; a stale lock is stolen. The lock content is written to a
// temp file and hard-linked into place, so the lock is NEVER observed half-written
// (linkSync is atomic and fails EEXIST when the lock is already held).
//
// This is a BEST-EFFORT advisory lock for a once-a-day personal self-update, not a
// distributed mutex. Its correctness rests on one invariant: STALE_LOCK_MS must far
// exceed the real work duration (a tarball download + `bun install` of a few pinned
// deps — seconds to a couple of minutes), so a LIVE holder is never seen as stale.
// Steal therefore only ever reaps a crashed/dead holder; a live lock is never stolen,
// which is what keeps the release path from racing a successor.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive } from "../copilot_api/process.ts";
import { autoupdateLockFile } from "./paths.ts";

// 30 minutes — chosen to dwarf any real update (see the invariant above).
const STALE_LOCK_MS = 30 * 60 * 1000;

interface LockInfo {
  pid: number;
  ts: number;
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockInfo).pid === "number" &&
      typeof (parsed as LockInfo).ts === "number"
    ) {
      return parsed as LockInfo;
    }
  } catch {
    // unreadable / malformed => treat as no usable lock
  }
  return null;
}

/**
 * Atomically create the lock with its content already in place. Writes to a unique
 * temp file, then hard-links it to `path` — link fails EEXIST if the lock exists,
 * and a successful link exposes the fully-written file in one step (no empty
 * window for a racer to misread as stale).
 */
function tryCreate(path: string, nowMs: number): boolean {
  const tmp = `${path}.tmp.${process.pid}.${nowMs}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: nowMs }));
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the hard link keeps the inode; the temp name is disposable
    }
  }
}

/** Acquire the lock, stealing a stale one. Returns false if a fresh lock is held. */
export function acquireLock(nowMs: number, path: string = autoupdateLockFile()): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (tryCreate(path, nowMs)) return true;

  const info = readLock(path);
  const stale = info === null || nowMs - info.ts > STALE_LOCK_MS || !pidAlive(info.pid);
  if (!stale) return false;

  // Steal atomically: only one racer can rename the stale lock out of the way
  // (the rest get ENOENT). The winner then re-creates exclusively; if a third
  // process slipped in first, tryCreate returns false. So at most one holder.
  const claimed = `${path}.steal.${process.pid}.${nowMs}`;
  try {
    renameSync(path, claimed);
  } catch {
    // someone else already moved/removed it — just attempt a fresh create
    return tryCreate(path, nowMs);
  }
  try {
    rmSync(claimed, { force: true });
  } catch {
    // ignore
  }
  return tryCreate(path, nowMs);
}

/** Release the lock, but only if WE own it (never delete a successor's lock). */
export function releaseLock(path: string = autoupdateLockFile()): void {
  const info = readLock(path);
  if (info === null || info.pid !== process.pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}
