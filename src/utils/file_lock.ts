// Exclusion is the OS advisory lock (flock/LockFileEx via Deno.FsFile.tryLockSync), which a crashed
// holder releases automatically. The pid+ts marker in the lock file names the holder for the probes
// (probeFileLock, the daemon verdict in src/scripts/daemon_lock.ts) and is never judged by an
// acquirer that holds the OS lock: a marker under a free OS lock is a leftover (a crashed holder, or
// the delete Windows refused while a scanner had the file open), whatever its pid or age.
//
// The OS lock is held on a sidecar (`<lock>.oslock`), never on the marker file: on Windows an
// exclusive LockFileEx blocks reads from every other handle, which would blind exactly the readers
// whose contract the marker is. The sidecar is never unlinked: a deletable lock file can be locked
// as an orphan inode by a contender that opened it just before the holder released the path.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { isEnoentOrNotdir } from "./fs.ts";
import * as fs from "./fs_facade.ts";
import { dryRunActive } from "./fs_facade.ts";
import { sleepSync } from "./time.ts";

// --- the shared bounded-wait acquisition policy --------------------------------
//
// For every millisecond-scale SYNC read-modify-write. A real critical section is milliseconds, so a
// holder still there after the wait is hung or leaked; the outcome is then not-held, which a
// best-effort reader (the usage index) degrades on and withRequiredFileLockSync makes an error.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 15;

export interface FileLockOptions {
  /** One clock for the marker written and the age judgment, so an injected clock stays
   *  deterministic. */
  nowMs?: number;
  /** The OS lock operation on the open sidecar, replaceable so a test can make it fail the way a
   *  filesystem without locking does (ENOLCK), which no scratch directory can. */
  osLock?: (file: Deno.FsFile) => boolean;
}

function tryLockExclusive(file: Deno.FsFile): boolean {
  return file.tryLockSync(true);
}

function renderMarker(nowMs: number): string {
  return `${process.pid}\n${nowMs}\n`;
}

/** `busy` is a holder (another process, or this one); `unavailable` is the lock's own I/O failing
 *  (its directory, the sidecar, the marker write), which a not-held consumer must not read as a
 *  holder. */
type Acquire =
  | { readonly kind: "acquired" }
  | { readonly kind: "busy" }
  | { readonly kind: "unavailable"; readonly cause: unknown };

const ACQUIRED: Acquire = Object.freeze({ kind: "acquired" });
const BUSY: Acquire = Object.freeze({ kind: "busy" });

/** `#ts` is the clock of the marker this process wrote, so a leaked in-process hold is judged by
 *  age alone, with no parse of the file. */
class HeldFileLock implements Disposable {
  #ts: number;

  constructor(
    readonly path: string,
    readonly file: Deno.FsFile,
    ts: number,
  ) {
    this.#ts = ts;
  }

  isAged(staleMs: number, nowMs: number): boolean {
    return Number.isFinite(staleMs) && nowMs - this.#ts > staleMs;
  }

  /** On a failed write the previous clock stays remembered; the file itself may be torn. */
  refresh(nowMs: number): Acquire {
    const written = writeMarker(this.path, renderMarker(nowMs));
    if (written.kind === "acquired") this.#ts = nowMs;
    return written;
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

/** `unreadable` is a marker we cannot judge: a probe answers unknown, a release deletes nothing. */
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

function writeMarker(lockPath: string, text: string): Acquire {
  try {
    writeFileSync(lockPath, text);
    return ACQUIRED;
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
}

/** What a delete refused by an open handle surfaces (Windows: a scanner on the just-released
 *  marker); the disk writer's rename loop (fs_disk.ts) keys off the same codes. */
const OPEN_HANDLE_REFUSAL_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
const REMOVE_RETRIES = 5;
const REMOVE_RETRY_MS = 50;

/** A POSIX unlink of an open file always succeeds; Windows refuses it while a handle opened
 *  without delete sharing is on the file. `remove` is the test seam. */
export function removeMarkerWithRetry(
  path: string,
  remove: (p: string) => void = (p) => rmSync(p, { force: true }),
): void {
  for (let i = 0;; i++) {
    try {
      remove(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= REMOVE_RETRIES || code === undefined || !OPEN_HANDLE_REFUSAL_CODES.has(code)) {
        throw err;
      }
      sleepSync(REMOVE_RETRY_MS);
    }
  }
}

/** A primitive: production code scopes lock lifetimes through withFileLock/withFileLockSync, bar
 *  src/scripts/daemon_lock.ts, and this stays exported for the on-disk contract tests.
 *
 *  the OS lock is held elsewhere                 -> false
 *  our own hold, marker still fresh              -> false
 *  our own hold, marker aged past staleMs        -> refreshed, true
 *  the OS lock is free                           -> ours; whatever marker the path holds is overwritten */
export function tryAcquireFileLock(
  lockPath: string,
  staleMs: number,
  opts: FileLockOptions = {},
): boolean {
  return tryAcquire(lockPath, staleMs, opts).kind === "acquired";
}

function tryAcquire(lockPath: string, staleMs: number, opts: FileLockOptions): Acquire {
  const nowMs = opts.nowMs ?? Date.now();

  const ours = HELD_LOCKS.get(lockPath);
  if (ours !== undefined) {
    return ours.isAged(staleMs, nowMs) ? ours.refresh(nowMs) : BUSY;
  }

  // The lock's directory is the store's home, made through the seam so a home outside
  // copilot-env's own (its parents included) is named on stderr; the lock file itself stays raw
  // (a dry run takes no lock, see withFileLockSync).
  try {
    fs.mkdir(dirname(lockPath));
  } catch (cause) {
    return { kind: "unavailable", cause };
  }

  let file: Deno.FsFile;
  try {
    file = Deno.openSync(osLockPath(lockPath), { read: true, write: true, create: true });
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
  let kept = false;
  try {
    let locked: boolean;
    try {
      locked = (opts.osLock ?? tryLockExclusive)(file);
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    if (!locked) return BUSY;
    const written = writeMarker(lockPath, renderMarker(nowMs));
    if (written.kind !== "acquired") return written;
    HELD_LOCKS.set(lockPath, new HeldFileLock(lockPath, file, nowMs));
    kept = true;
    return ACQUIRED;
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

/** Lenient on purpose (ts ignored): a holder must still be able to delete its own marker even if
 *  the ts half got corrupted. */
function markerPid(raw: string): number | null {
  const pid = Number.parseInt(raw.split("\n")[0] ?? "", 10);
  return !Number.isNaN(pid) && pid > 0 ? pid : null;
}

/** The marker is deleted only while it is OURS: a release by a non-holder (a test's cleanup, a stray
 *  primitive call) must not blind the probes to the live holder's pid. The sidecar stays (the
 *  orphan-inode note in the header). A delete Windows refuses (a scanner's open handle) is retried
 *  and then given up: the leftover is harmless, since no acquirer judges it. A release of a
 *  SCOPE-held path is refused: it would strand SCOPE_HOLDS and let the scope's own exit release a
 *  lock a later acquirer holds. */
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
      removeMarkerWithRetry(lockPath);
    }
  } catch {
    // gone / unreadable / still refused -> nothing to release
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

/** The fn runs either way. On `held: false` a best-effort consumer skips (the usage index), and
 *  withRequiredFileLockSync has already thrown; `reason` keeps a lock whose own I/O failed apart
 *  from a holder, so nobody is told to stop a process that holds nothing. */
export type LockOutcome = HeldLock | NotHeldOutcome;

export type NotHeldOutcome =
  | { readonly held: false; readonly reason: "busy" }
  | { readonly held: false; readonly reason: "unavailable"; readonly cause: unknown };

const HELD_OUTCOME: HeldLock = Object.freeze({ held: true } as HeldLock);
const NOT_HELD_BUSY: NotHeldOutcome = Object.freeze({ held: false, reason: "busy" });

/** `waitMs` Infinity never gives up, so the fn always observes `held`. `onWait` fires ONCE: on the
 *  first failed attempt, or with `noticeAfterMs` on the first failed attempt after more than that
 *  much waiting. */
export interface LockPolicy extends FileLockOptions {
  /** Governs only a second acquire from THIS process (another process's marker is never judged):
   *  Infinity never refresh-acquires this process's own live hold, however old, for a lock a
   *  process holds a long time (`agent start` across the float and the cleanup). */
  readonly staleMs: number;
  readonly waitMs: number;
  readonly retryMs?: number;
  readonly onWait?: () => void;
  readonly noticeAfterMs?: number;
}

/** After the bounded wait the outcome is not-held. A caller that may not run without the lock goes
 *  through withRequiredFileLockSync, where that outcome is an error instead. */
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
  const attempt = tryAcquire(lockPath, policy.staleMs, policy);
  if (attempt.kind === "acquired") {
    return { done: HELD_OUTCOME, owned: !wasOurs };
  }
  const elapsed = Date.now() - startedMs;
  const noticeable = policy.noticeAfterMs === undefined || elapsed > policy.noticeAfterMs;
  if (policy.onWait && !state.noticed && noticeable) {
    state.noticed = true;
    policy.onWait();
  }
  if (elapsed >= policy.waitMs) {
    const done: NotHeldOutcome = attempt.kind === "busy"
      ? NOT_HELD_BUSY
      : { held: false, reason: "unavailable", cause: attempt.cause };
    return { done, owned: false };
  }
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
function rejectAsyncFn(fn: (arg: never) => unknown): void {
  if (fn.constructor?.name === "AsyncFunction") {
    throw new Error("withFileLockSync fn is async; use withFileLock instead");
  }
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

/** Released exactly once, by the last scope out, on every exit path. A dry run takes no lock: it
 *  writes nothing, so it excludes no one, and the marker file a lock leaves would itself be a
 *  write; `fn` then runs as the holder. */
export function withFileLockSync<T>(
  lockPath: string,
  policy: LockPolicy,
  fn: (outcome: LockOutcome) => SyncResult<T>,
): T {
  rejectAsyncFn(fn);
  if (dryRunActive()) {
    const result = fn(HELD_OUTCOME);
    assertNotThenable(result);
    return result;
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

/** A holder still there after the bounded wait. `fn` never ran, so nothing was written. */
export class LockBusyError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | null, waitedMs: number) {
    const holder = holderPid === null ? "another process" : `pid ${holderPid}`;
    super(
      `${lockPath} is still held by ${holder} after ${waitedMs} ms; ` +
        "wait for it to finish, or stop that process, then retry.",
    );
    this.name = "LockBusyError";
  }
}

/** For a read-modify-write that must never run unlocked (the JSON stores, the profile port
 *  reservation): `fn` sees the lock evidence only. A holder past the wait is a LockBusyError; a
 *  lock whose own I/O failed (its directory, the sidecar, the marker) rethrows that failure as
 *  itself, so nobody is told to stop a process that holds nothing. */
export function withRequiredFileLockSync<T>(
  lockPath: string,
  policy: LockPolicy,
  fn: (lock: HeldLock) => SyncResult<T>,
): T {
  rejectAsyncFn(fn);
  return withFileLockSync(lockPath, policy, (outcome) => {
    if (outcome.held) return fn(outcome);
    if (outcome.reason === "unavailable") throw outcome.cause;
    throw new LockBusyError(lockPath, holderPid(lockPath), policy.waitMs);
  });
}

function holderPid(lockPath: string): number | null {
  const observed = readMarker(lockPath);
  return observed.kind === "present" ? markerPid(observed.raw) : null;
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
