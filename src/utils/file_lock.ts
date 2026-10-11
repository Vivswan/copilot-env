// Exclusion is the exclusive creation of the lock file, whose text names the holder: pid, then the
// clock of the write. The file appears WITH its text (a fully written sibling is hard-linked into
// place; a refresh renames one over it), so no reader ever meets an empty marker and takes a
// creator mid-write for a leftover. A crashed holder (SIGKILL, a power loss) leaves its file behind, so the
// next acquirer judges the pid it names (src/utils/pid.ts): a dead pid, a malformed marker, or
// this process's own pid with no in-process hold is a leftover and is taken over; a live pid, or
// one this permission set cannot signal (the daemon's), is a holder. The same file is the whole
// protocol, so the CLI and the daemon (which loads this module through
// src/scripts/daemon_lock_preload.ts) agree without an OS lock, which Bun does not expose.
//
// Two limits, accepted: a recycled pid reads as a live holder, and two contenders that judge one
// leftover stale at the same instant race between the judgment and the unlink, so the loser can
// take the winner's fresh file (the published pid lockfiles accept the same race).
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { isEnoentOrNotdir, retryOpenHandleRefusal } from "./fs.ts";
import { renameWithRetry } from "./fs_disk.ts";
import * as fs from "./fs_facade.ts";
import { dryRunActive } from "./fs_facade.ts";
import { isRecord } from "./json.ts";
import { type PidLiveness, pidLiveness } from "./pid.ts";
import { sleepSync } from "./time.ts";

// --- the shared bounded-wait acquisition policy --------------------------------
//
// For every millisecond-scale SYNC read-modify-write. A real critical section is milliseconds, so a
// holder whose marker has not changed for the wait is hung or leaked; the outcome is then not-held,
// which a best-effort reader (the usage index) degrades on and withRequiredFileLockSync makes an
// error. The wait is measured from the last holder change, never from the call: queued behind live
// writers (each hold releases and a successor writes a new marker) a contender waits them out.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 15;

interface FileLockOptions {
  /** One clock for the marker written and the age judgment, so an injected clock stays
   *  deterministic. */
  nowMs?: number;
  /** The liveness judgment of another process's pid, replaceable so a test can play a live or a
   *  dying holder without spawning one. */
  liveness?: (pid: number) => PidLiveness;
}

function renderMarker(nowMs: number): string {
  return `${process.pid}\n${nowMs}\n`;
}

/** `busy` is a holder (another process, or this one); `unavailable` is the lock's own I/O failing
 *  (its directory, the create, the marker read), which a not-held consumer must not read as a
 *  holder. */
type Acquire =
  | { readonly kind: "acquired" }
  | { readonly kind: "busy" }
  | { readonly kind: "unavailable"; readonly cause: unknown };

const ACQUIRED: Acquire = Object.freeze({ kind: "acquired" });
const BUSY: Acquire = Object.freeze({ kind: "busy" });

/** `#ts` is the clock of the marker this process wrote, so a leaked in-process hold is judged by
 *  age alone, with no parse of the file. */
class HeldFileLock {
  #ts: number;

  constructor(
    readonly path: string,
    ts: number,
  ) {
    this.#ts = ts;
  }

  isAged(staleMs: number, nowMs: number): boolean {
    return Number.isFinite(staleMs) && nowMs - this.#ts > staleMs;
  }

  /** On a failed write the previous clock stays remembered. The new text lands by rename (the
   *  disk writer's retrying one, for a marker a scanner holds open on Windows), so a reader never
   *  sees the marker between a truncate and a write. */
  refresh(nowMs: number): Acquire {
    try {
      const staged = stageMarker(this.path, renderMarker(nowMs));
      try {
        renameWithRetry(staged, this.path);
      } catch (cause) {
        discardStaged(staged);
        throw cause;
      }
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    this.#ts = nowMs;
    return ACQUIRED;
  }
}

/** The one record of what this process holds: a marker naming our pid that is not here is a
 *  leftover (a release Windows refused, a crash under a recycled pid). */
const HELD_LOCKS = new Map<string, HeldFileLock>();

/** `unreadable` is a marker we cannot judge: a probe answers unknown, a release deletes nothing. */
type MarkerRead =
  | { kind: "absent" }
  | { kind: "unreadable"; cause: unknown }
  | { kind: "present"; raw: string };

function readMarker(lockPath: string): MarkerRead {
  try {
    return { kind: "present", raw: readFileSync(lockPath, "utf8") };
  } catch (cause) {
    return isEnoentOrNotdir(cause) ? { kind: "absent" } : { kind: "unreadable", cause };
  }
}

/** Staging names count up per process: a sibling a refused delete left behind (an open handle on
 *  Windows) may still alias the marker through its hard link, and reopening that name would
 *  truncate the live marker. The exclusive open is the backstop for a name that exists anyway. */
let stagingSerial = 0;

/** The marker's bytes, written to a sibling only this process names, so they can reach the lock
 *  path in one atomic step (a link for the create, a rename for a refresh). The sibling is removed
 *  where the OS allows, a failed write's included; a refused removal leaves a harmless alias that
 *  the per-process serial keeps from reuse. */
function stageMarker(lockPath: string, text: string): string {
  for (;;) {
    const staged = `${lockPath}.${process.pid}.${(stagingSerial++).toString(36)}.staging`;
    try {
      writeFileSync(staged, text, { flag: "wx" });
      return staged;
    } catch (cause) {
      if (isRecord(cause) && cause.code === "EEXIST") continue;
      discardStaged(staged);
      throw cause;
    }
  }
}

/** A sibling left behind is named by its pid and harms nothing, so a refusal to delete it (an
 *  open handle on Windows) never undoes the step it followed. */
function discardStaged(staged: string): void {
  try {
    rmSync(staged, { force: true });
  } catch {}
}

/** `exists` is the one refusal the create itself can answer; anything else is the lock's I/O, a
 *  filesystem without hard links included: a lock that cannot be taken without a window in which
 *  a contender reads an empty marker is not taken at all. */
function createMarker(lockPath: string, text: string): "created" | "exists" | { cause: unknown } {
  let staged: string;
  try {
    staged = stageMarker(lockPath, text);
  } catch (cause) {
    return { cause };
  }
  try {
    linkSync(staged, lockPath);
    return "created";
  } catch (cause) {
    return isRecord(cause) && cause.code === "EEXIST" ? "exists" : { cause };
  } finally {
    discardStaged(staged);
  }
}

/** `remove` is the test seam. */
export function removeMarkerWithRetry(
  path: string,
  remove: (p: string) => void = (p) => rmSync(p, { force: true }),
): void {
  retryOpenHandleRefusal(() => remove(path));
}

/** Whether the marker at the path is a holder's or a leftover. Our own pid outside HELD_LOCKS is a
 *  leftover: nothing in this process holds a lock the record does not know. */
function markerHolds(
  lockPath: string,
  raw: string,
  liveness: (pid: number) => PidLiveness,
): "held" | "leftover" {
  const pid = markerPid(raw);
  if (pid === null) return "leftover";
  if (pid === process.pid) return HELD_LOCKS.has(lockPath) ? "held" : "leftover";
  return liveness(pid) === "alive" ? "held" : "leftover";
}

/** A primitive: production code scopes lock lifetimes through withFileLock/withFileLockSync, bar
 *  src/copilot_api/daemon_lock.ts, and this stays exported for the on-disk contract tests.
 *
 *  the file names a live pid (or one we cannot
 *  signal)                                       -> false
 *  our own hold, marker still fresh              -> false
 *  our own hold, marker aged past staleMs        -> refreshed, true
 *  no file, or a leftover (dead pid, malformed,
 *  our pid with no hold)                         -> ours; the leftover is taken over */
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

  const text = renderMarker(nowMs);
  const created = createMarker(lockPath, text);
  if (created === "created") return record(lockPath, nowMs);
  if (created !== "exists") return { kind: "unavailable", cause: created.cause };

  const observed = readMarker(lockPath);
  if (observed.kind === "unreadable") return { kind: "unavailable", cause: observed.cause };
  // Released between the create and the read: the next attempt lands.
  if (observed.kind === "absent") return BUSY;
  if (markerHolds(lockPath, observed.raw, opts.liveness ?? pidLiveness) === "held") return BUSY;

  // The takeover: the leftover goes, then the create runs again; a contender that won the same
  // takeover is a holder now.
  try {
    removeMarkerWithRetry(lockPath);
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
  const retaken = createMarker(lockPath, text);
  if (retaken === "created") return record(lockPath, nowMs);
  return retaken === "exists" ? BUSY : { kind: "unavailable", cause: retaken.cause };
}

function record(lockPath: string, nowMs: number): Acquire {
  HELD_LOCKS.set(lockPath, new HeldFileLock(lockPath, nowMs));
  return ACQUIRED;
}

/** `markerPid` is the holder's (`held`) or the LAST holder's (`free`), so a consumer can tie the
 *  verdict to a specific pid; `absent` means no marker file is there NOW, which a completed
 *  release also leaves behind. */
type FileLockProbe =
  | { readonly kind: "held"; readonly markerPid: number | null }
  | { readonly kind: "free"; readonly markerPid: number | null }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

const PROBE_ABSENT: FileLockProbe = Object.freeze({ kind: "absent" });
const PROBE_UNKNOWN: FileLockProbe = Object.freeze({ kind: "unknown" });

/** Non-mutating: the marker is read and its pid judged. `unknown` is a marker this process cannot
 *  read, so a caller about to act on "nobody there" fails closed. */
export function probeFileLock(
  lockPath: string,
  liveness: (pid: number) => PidLiveness = pidLiveness,
): FileLockProbe {
  const observed = readMarker(lockPath);
  if (observed.kind === "unreadable") return PROBE_UNKNOWN;
  if (observed.kind === "absent") return PROBE_ABSENT;
  const pid = markerPid(observed.raw);
  return markerHolds(lockPath, observed.raw, liveness) === "held"
    ? Object.freeze({ kind: "held", markerPid: pid })
    : Object.freeze({ kind: "free", markerPid: pid });
}

/** A leftover (probeFileLock's `free`) is unlinked and true comes back; a holder, an absent file,
 *  and a marker this process cannot read are left alone. For a process that can signal to clear
 *  the way for one that cannot: the daemon's own acquire (src/copilot_api/daemon_lock.ts) runs
 *  under a permission set that reads every pid as alive, so the CLI clears a dead daemon's
 *  leftover before the spawn. */
export function removeLeftoverLock(lockPath: string): boolean {
  if (probeFileLock(lockPath).kind !== "free") return false;
  removeMarkerWithRetry(lockPath);
  return true;
}

/** Lenient on purpose (ts ignored): a holder must still be able to delete its own marker even if
 *  the ts half got corrupted. */
function markerPid(raw: string): number | null {
  const pid = Number.parseInt(raw.split("\n")[0] ?? "", 10);
  return !Number.isNaN(pid) && pid > 0 ? pid : null;
}

/** The marker is deleted only while it is OURS: a release by a non-holder (a test's cleanup, a stray
 *  primitive call) must not blind the probes to the live holder's pid. A delete Windows refuses (a
 *  scanner's open handle) is retried and then given up: the leftover names our pid and the next
 *  acquirer takes it over. A release of a SCOPE-held path is refused: it would strand SCOPE_HOLDS
 *  and let the scope's own exit release a lock a later acquirer holds. */
export function releaseFileLock(lockPath: string): void {
  if (SCOPE_HOLDS.has(lockPath)) {
    throw new Error(
      "releaseFileLock called on a scope-held lock; the withFileLock/withFileLockSync scope owns the release",
    );
  }
  try {
    const observed = readMarker(lockPath);
    if (observed.kind === "present" && markerPid(observed.raw) === process.pid) {
      removeMarkerWithRetry(lockPath);
    }
  } catch {
    // gone / unreadable / still refused -> nothing to release
  } finally {
    HELD_LOCKS.delete(lockPath);
  }
}

// --- the scoped lock API --------------------------------------------------------
//
// Production takes a lock through these: wait, critical section, and release live in one scope, so
// no call site can leak a lock across an early return or a throw. src/copilot_api/daemon_lock.ts is the
// one exception, holding the primitive's lock until the process dies.

declare const heldLockBrand: unique symbol;

/** Only the held branch of withFileLock/withFileLockSync mints one, so an API that demands lock
 *  evidence cannot be called without a lock scope. */
interface HeldLock {
  readonly held: true;
  readonly [heldLockBrand]: true;
}

/** The fn runs either way. On `held: false` a best-effort consumer skips (the usage index), and
 *  withRequiredFileLockSync has already thrown; `reason` keeps a lock whose own I/O failed apart
 *  from a holder, so nobody is told to stop a process that holds nothing. */
export type LockOutcome = HeldLock | NotHeldOutcome;

type NotHeldOutcome =
  | { readonly held: false; readonly reason: "busy" }
  | { readonly held: false; readonly reason: "unavailable"; readonly cause: unknown };

const HELD_OUTCOME: HeldLock = Object.freeze({ held: true } as HeldLock);
const NOT_HELD_BUSY: NotHeldOutcome = Object.freeze({ held: false, reason: "busy" });

/** `waitMs` bounds the wait on ONE unchanged holder: the budget restarts whenever the marker read
 *  after a failed attempt differs from the last one (a release, a successor, a refresh), and
 *  Infinity never gives up, so the fn always observes `held`. `onWait` fires ONCE: on the first
 *  failed attempt, or with `noticeAfterMs` on the first failed attempt after more than that much
 *  waiting since the call. */
export interface LockPolicy extends FileLockOptions {
  /** Governs only a second acquire from THIS process (another process's marker is judged by its
   *  pid's liveness, never its age): Infinity never refresh-acquires this process's own live hold,
   *  however old, for a lock a process holds a long time (`agent start` across the float and the
   *  cleanup). */
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

/** One wait's clocks: the notice runs from the call; the give-up runs from the last change of the
 *  marker observed after a failed attempt (`observed` is its text, null while absent). */
interface WaitState {
  readonly startedMs: number;
  noticed: boolean;
  observed: string | null;
  observedSinceMs: number;
}

function startWait(): WaitState {
  const now = Date.now();
  return { startedMs: now, noticed: false, observed: null, observedSinceMs: now };
}

/** Shared by the sync and async loops so the notice and give-up judgments cannot drift. `owned` is
 *  whether THIS attempt took the lock: a refresh of a lock this process already held joins the
 *  holding scopes instead. */
function acquireStep(
  lockPath: string,
  policy: LockPolicy,
  state: WaitState,
): { done: LockOutcome; owned: boolean } | { sleepMs: number } {
  const wasOurs = HELD_LOCKS.has(lockPath);
  const attempt = tryAcquire(lockPath, policy.staleMs, policy);
  if (attempt.kind === "acquired") {
    return { done: HELD_OUTCOME, owned: !wasOurs };
  }
  const now = Date.now();
  const marker = readMarker(lockPath);
  // An unreadable marker (Windows: a scanner's momentary exclusive handle) is no observation:
  // neither the refusal nor the read after it is holder progress.
  if (marker.kind !== "unreadable") {
    const observed = marker.kind === "present" ? marker.raw : null;
    if (observed !== state.observed) {
      state.observed = observed;
      state.observedSinceMs = now;
    }
  }
  const elapsed = now - state.startedMs;
  const noticeable = policy.noticeAfterMs === undefined || elapsed > policy.noticeAfterMs;
  if (policy.onWait && !state.noticed && noticeable) {
    state.noticed = true;
    policy.onWait();
  }
  if (now - state.observedSinceMs >= policy.waitMs) {
    const done: NotHeldOutcome =
      attempt.kind === "busy"
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
  const then =
    (typeof result === "object" || typeof result === "function") &&
    result !== null &&
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
  const state = startWait();
  let outcome: LockOutcome;
  let holding: boolean;
  for (;;) {
    const step = acquireStep(lockPath, policy, state);
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
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | null,
    waitedMs: number,
  ) {
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
 *  lock whose own I/O failed (its directory, the create, the marker read) rethrows that failure as
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
  const state = startWait();
  let outcome: LockOutcome;
  let holding: boolean;
  for (;;) {
    const step = acquireStep(lockPath, policy, state);
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
