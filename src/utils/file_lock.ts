// Exclusion is the OS advisory lock (flock/LockFileEx via Deno.FsFile.tryLockSync), which a crashed
// holder releases automatically. The pid+ts marker in the lock file is the on-disk contract a
// release predating the OS lock judges liveness by (and may rename-steal by age), so it is still
// written and honored.
//
// The OS lock is held on a sidecar (`<lock>.oslock`), never on the marker file: on Windows an
// exclusive LockFileEx blocks reads from every other handle, which would blind exactly the readers
// whose contract the marker is. The sidecar is never unlinked: a deletable lock file can be locked
// as an orphan inode by a contender that opened it just before the holder released the path.
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { isEnoentOrNotdir, readTextOrNull } from "./fs.ts";
import { isRecord } from "./json.ts";
import { pidAlive } from "./pid.ts";
import { mkdirReported } from "./report_write.ts";
import { sleepSync } from "./time.ts";

// --- the shared bounded-wait acquisition policy --------------------------------
//
// For every millisecond-scale SYNC read-modify-write: after the bounded wait the caller proceeds
// WITHOUT the lock rather than deadlock a command. A real critical section is milliseconds, so a
// live holder is never seen stale; the backstops only ever reclaim a crashed or leaked lock.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 15;

/** Only for a lock we do NOT hold: our own marker is the `#raw` HeldFileLock remembers, never a
 *  fresh disk read, because a rename-steal can put a successor's marker at the path. */
function readLockRaw(lockPath: string): string | null {
  return readTextOrNull(lockPath);
}

interface LockMarker {
  pid: number;
  ts: number;
}

export interface FileLockOptions {
  /** One clock for the marker written and the age judgment, so an injected clock stays
   *  deterministic. */
  nowMs?: number;
  /** The autoupdate lock's on-disk contract: a not-yet-updated reader parses only the JSON form,
   *  and must still recognize a live holder during the upgrade window instead of stealing the lock
   *  as malformed. */
  jsonMarker?: boolean;
}

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

function markerStale(raw: string, staleMs: number, nowMs: number): boolean {
  const marker = parseMarker(raw);
  if (marker === null) return true;
  if (!pidAlive(marker.pid)) return true;
  return Number.isFinite(staleMs) && nowMs - marker.ts > staleMs;
}

function renderMarker(nowMs: number, jsonMarker: boolean): string {
  return jsonMarker
    ? JSON.stringify({ pid: process.pid, ts: nowMs })
    : `${process.pid}\n${nowMs}\n`;
}

/** `#raw` is what we WROTE, not a claim about what is on disk: another release can rename-steal the
 *  path, which is precisely what releaseFileLock checks for. */
class HeldFileLock implements Disposable {
  #raw: string;

  constructor(
    readonly path: string,
    readonly file: Deno.FsFile,
    raw: string,
  ) {
    this.#raw = raw;
  }

  isStale(staleMs: number, nowMs: number): boolean {
    return markerStale(this.#raw, staleMs, nowMs);
  }

  /** False = the write threw, so the previous marker stays remembered; the file itself may be torn.
   */
  refresh(marker: string): boolean {
    if (!writeMarker(this.path, marker)) return false;
    this.#raw = marker;
    return true;
  }

  /** Does NOT delete the marker file (releaseFileLock's marker-verified job) and never the sidecar.
   */
  [Symbol.dispose](): void {
    dropHandle(this.file);
  }
}

/** The OS lock is per open handle, so the handle must stay open for the lock's lifetime. */
const HELD_LOCKS = new Map<string, HeldFileLock>();

function osLockPath(lockPath: string): string {
  return `${lockPath}.oslock`;
}

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

/** `unreadable` is a marker we cannot judge, and therefore one we never steal. */
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

function writeMarker(lockPath: string, text: string): boolean {
  try {
    writeFileSync(lockPath, text);
    return true;
  } catch {
    return false;
  }
}

/** A primitive: production code scopes lock lifetimes through withFileLock/withFileLockSync, bar
 *  src/scripts/daemon_lock.ts, and this stays exported for the on-disk contract tests.
 *
 *  fresh marker the OS lock cannot see (a pre-OS-lock release, a test plant) -> back off
 *  our own hold, marker still fresh                                         -> false
 *  our own hold, marker aged past staleMs                                   -> refreshed, true */
export function tryAcquireFileLock(
  lockPath: string,
  staleMs: number,
  opts: FileLockOptions = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const jsonMarker = opts.jsonMarker ?? false;

  const ours = HELD_LOCKS.get(lockPath);
  if (ours !== undefined) {
    if (!ours.isStale(staleMs, nowMs)) return false;
    return ours.refresh(renderMarker(nowMs, jsonMarker));
  }

  try {
    mkdirReported(dirname(lockPath));
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
    HELD_LOCKS.set(lockPath, new HeldFileLock(lockPath, file, marker));
    kept = true;
    return true;
  } finally {
    if (!kept) dropHandle(file);
  }
}

/** `markerPid` is the holder's (`held`) or the LAST holder's (`free`), so a consumer can tie the
 *  verdict to a specific pid; `absent` means no marker file is there NOW, which a completed
 *  release also leaves behind. */
export type FileLockProbe =
  | { readonly kind: "held"; readonly markerPid: number | null }
  | { readonly kind: "free"; readonly markerPid: number | null }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

const PROBE_ABSENT: FileLockProbe = Object.freeze({ kind: "absent" });
const PROBE_UNKNOWN: FileLockProbe = Object.freeze({ kind: "unknown" });

/** Non-mutating: the sidecar is try-locked SHARED and unlocked at once, and the marker is only
 *  read. */
export function probeFileLock(lockPath: string): FileLockProbe {
  const observed = readMarker(lockPath);
  if (observed.kind === "unreadable") return PROBE_UNKNOWN;
  const pid = observed.kind === "present" ? markerPid(observed.raw) : null;
  // The OS may report a second same-process attempt either way, so our own lock answers from the
  // record.
  if (HELD_LOCKS.has(lockPath)) return Object.freeze({ kind: "held", markerPid: pid });
  const lockState = observeOsLock(lockPath);
  if (lockState === "unknown") return PROBE_UNKNOWN;
  // The marker must read the same BEFORE and AFTER the lock observation, or a holder change
  // mid-probe would pair the previous holder's pid with the successor's lock state. The residual
  // window (a successor between its lock and its marker write) is a sub-millisecond misread the
  // next probe corrects.
  const reread = readMarker(lockPath);
  if (reread.kind !== observed.kind) return PROBE_UNKNOWN;
  if (observed.kind === "present" && reread.kind === "present" && reread.raw !== observed.raw) {
    return PROBE_UNKNOWN;
  }
  if (lockState === "held") return Object.freeze({ kind: "held", markerPid: pid });
  return observed.kind === "present"
    ? Object.freeze({ kind: "free", markerPid: pid })
    : PROBE_ABSENT;
}

/** The SHARED try-lock lets any number of concurrent probes coexist without reading one another as
 *  a holder; only a real holder's EXCLUSIVE lock reports `held`. A prober's momentary shared hold
 *  can still fail an exclusive acquirer's single attempt, which is why acquirers contending with
 *  probes retry. */
function observeOsLock(lockPath: string): "held" | "free" | "unknown" {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(osLockPath(lockPath), { read: true, write: true });
  } catch (e) {
    return isEnoentOrNotdir(e) ? "free" : "unknown";
  }
  try {
    return file.tryLockSync(false) ? "free" : "held";
  } catch {
    return "unknown";
  } finally {
    dropHandle(file);
  }
}

/** The marker-only protocol's identity-verified steal: a FRESH holder that replaced the marker
 *  between the caller's read and the rename is restored via linkSync (which fails rather than
 *  clobber a third process's lock). The sidecar acquire path no longer needs it; it stays as the
 *  takeover contract old-release processes execute against our markers, pinned by
 *  test/file_lock.test.ts. */
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

/** Lenient on purpose (ts ignored): a holder must still be able to delete its own marker even if
 *  the ts half got corrupted. */
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

/** The marker is deleted only while still OURS, never a successor's that a rename-steal put at the
 *  path; the sidecar stays (the orphan-inode note in the header). A release of a SCOPE-held path is
 *  refused: it would strand SCOPE_HOLDS and let the scope's own exit release a lock a later
 *  acquirer holds. */
export function releaseFileLock(lockPath: string): void {
  if (SCOPE_HOLDS.has(lockPath)) {
    throw new Error(
      "releaseFileLock called on a scope-held lock; the withFileLock/withFileLockSync scope owns the release",
    );
  }
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

// --- the scoped lock API --------------------------------------------------------
//
// Production takes a lock through these: wait, critical section, and release live in one scope, so
// no call site can leak a lock across an early return or a throw. src/scripts/daemon_lock.ts is the
// one exception, holding the primitive's lock until the process dies.

declare const heldLockBrand: unique symbol;

/** Only the held branch of withFileLock/withFileLockSync mints one, so an API that demands lock
 *  evidence cannot be called without a lock scope. A domain that needs to name WHICH lock
 *  re-brands it (HeldUpdateLock, src/autoupdate/lock.ts). */
export interface HeldLock {
  readonly held: true;
  readonly [heldLockBrand]: true;
}

/** The fn runs either way; on `held: false` it skips, or proceeds unlocked where the lock is
 *  best-effort. */
export type LockOutcome = HeldLock | { readonly held: false };

const HELD_OUTCOME: HeldLock = Object.freeze({ held: true } as HeldLock);
const NOT_HELD_OUTCOME: LockOutcome = Object.freeze({ held: false });

/** `waitMs` Infinity never gives up, so the fn always observes `held`. `onWait` fires ONCE: on the
 *  first failed attempt, or with `noticeAfterMs` on the first failed attempt after more than that
 *  much waiting. */
export interface LockPolicy extends FileLockOptions {
  /** Infinity reclaims ONLY a dead holder and never age-steals a live one, for a lock a live
   *  process may hold a long time (`agent start` blocking on interactive auth). */
  readonly staleMs: number;
  readonly waitMs: number;
  readonly retryMs?: number;
  readonly onWait?: () => void;
  readonly noticeAfterMs?: number;
}

/** After the bounded wait the caller proceeds WITHOUT the lock, best-effort. */
export const BOUNDED_LOCK_POLICY: LockPolicy = Object.freeze({
  staleMs: LOCK_STALE_MS,
  waitMs: LOCK_WAIT_MS,
  retryMs: LOCK_RETRY_MS,
});

/** Shared by the sync and async loops so the notice and give-up judgments cannot drift. `owned` is
 *  whether THIS attempt took the lock: a refresh of a lock this process already held joins the
 *  holding scopes instead. */
function acquireStep(
  lockPath: string,
  policy: LockPolicy,
  startedMs: number,
  state: { noticed: boolean },
): { done: LockOutcome; owned: boolean } | { sleepMs: number } {
  const wasOurs = HELD_LOCKS.has(lockPath);
  if (tryAcquireFileLock(lockPath, policy.staleMs, policy)) {
    return { done: HELD_OUTCOME, owned: !wasOurs };
  }
  const elapsed = Date.now() - startedMs;
  const noticeable = policy.noticeAfterMs === undefined || elapsed > policy.noticeAfterMs;
  if (policy.onWait && !state.noticed && noticeable) {
    state.noticed = true;
    policy.onWait();
  }
  if (elapsed >= policy.waitMs) return { done: NOT_HELD_OUTCOME, owned: false };
  return { sleepMs: policy.retryMs ?? LOCK_RETRY_MS };
}

/** Concurrent async scopes in one process can interleave: a second scope may refresh-acquire the
 *  first's aged marker and outlive it, so the physical release belongs to the LAST settling scope.
 *  A lock held by a primitive caller (no entry here) is never released by a scope that only
 *  refreshed it. */
const SCOPE_HOLDS = new Map<string, number>();

/** False = a primitive caller holds the lock; leave it be. */
function enterHeldScope(lockPath: string, owned: boolean): boolean {
  if (owned) {
    SCOPE_HOLDS.set(lockPath, 1);
    return true;
  }
  const current = SCOPE_HOLDS.get(lockPath);
  if (current === undefined) return false;
  SCOPE_HOLDS.set(lockPath, current + 1);
  return true;
}

function exitHeldScope(lockPath: string): void {
  const current = SCOPE_HOLDS.get(lockPath) ?? 0;
  if (current > 1) {
    SCOPE_HOLDS.set(lockPath, current - 1);
    return;
  }
  SCOPE_HOLDS.delete(lockPath);
  releaseFileLock(lockPath);
}

/** Rejected BEFORE it runs: by the time the returned promise could be inspected, the body up to the
 *  first await has executed and the continuation would outlive the release. */
function isAsyncFn(fn: (outcome: LockOutcome) => unknown): boolean {
  return fn.constructor?.name === "AsyncFunction";
}

/** The compile-time face of the same rule: a PromiseLike return can only satisfy `never`. */
type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

/** A non-async fn can still return a thenable; the lock releases without awaiting it, so the throw
 *  is how the caller learns, loudly, that its body ran async. */
function assertNotThenable(result: unknown): void {
  const then = (typeof result === "object" || typeof result === "function") && result !== null &&
      "then" in result
    ? (result as { then: unknown }).then
    : undefined;
  if (typeof then === "function") {
    throw new Error("withFileLockSync fn returned a promise; use withFileLock instead");
  }
}

/** Released exactly once, by the last scope out, on every exit path. */
export function withFileLockSync<T>(
  lockPath: string,
  policy: LockPolicy,
  fn: (outcome: LockOutcome) => SyncResult<T>,
): T {
  if (isAsyncFn(fn)) {
    throw new Error("withFileLockSync fn is async; use withFileLock instead");
  }
  const startedMs = Date.now();
  const state = { noticed: false };
  let outcome: LockOutcome;
  let holding: boolean;
  for (;;) {
    const step = acquireStep(lockPath, policy, startedMs, state);
    if ("done" in step) {
      outcome = step.done;
      holding = outcome.held && enterHeldScope(lockPath, step.owned);
      break;
    }
    sleepSync(step.sleepMs);
  }
  try {
    const result = fn(outcome);
    assertNotThenable(result);
    return result;
  } finally {
    if (holding) exitHeldScope(lockPath);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  policy: LockPolicy,
  fn: (outcome: LockOutcome) => T | Promise<T>,
): Promise<T> {
  const startedMs = Date.now();
  const state = { noticed: false };
  let outcome: LockOutcome;
  let holding: boolean;
  for (;;) {
    const step = acquireStep(lockPath, policy, startedMs, state);
    if ("done" in step) {
      outcome = step.done;
      holding = outcome.held && enterHeldScope(lockPath, step.owned);
      break;
    }
    await sleepAsync(step.sleepMs);
  }
  try {
    return await fn(outcome);
  } finally {
    if (holding) exitHeldScope(lockPath);
  }
}
