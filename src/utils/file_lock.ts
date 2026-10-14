// Exclusion is the OS advisory lock (src/utils/os_lock.ts) on a permanent `<lock>.oslock` sidecar,
// released by the holder's death; the marker at `<lock>` (`pid\nts\n`) is the readable face for
// the probes and the daemon verdict. The layer is the MACHINE's: the marker layer (exclusive
// create, the holder's pid judged by src/utils/pid.ts, with its known limits: a recycled or
// unsignallable pid reads as a holder, judge-then-unlink races) runs only where the libc or
// kernel32 will not load, decided once per process and so the same for every process of this
// binary here; a lock call the filesystem refuses is the lock's own failure, never a fallback. The
// one mixed pair, a deno-era daemon holding the OS lock beside this binary without dlopen, reads
// busy by the deno marker's live pid. The lock sits on the sidecar, never the marker (a Windows
// range blinds other readers), and the sidecar is never unlinked (an orphan inode could be held).
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { isEnoentOrNotdir, retryOpenHandleRefusal } from "./fs.ts";
import { renameWithRetry } from "./fs_disk.ts";
import * as fs from "./fs_facade.ts";
import { dryRunActive } from "./fs_facade.ts";
import { isRecord } from "./json.ts";
import { type OsLock, type OsLockHandle, osLock } from "./os_lock.ts";
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
  /** The OS lock, replaceable so a test can play a machine whose libc will not load, or a
   *  filesystem that refuses the lock call, which no scratch directory can. */
  osLock?: OsLock;
  /** The liveness judgment of another process's pid on the marker layer, replaceable so a test
   *  can play a live or a dying holder without spawning one. Never consulted under the OS lock. */
  liveness?: (pid: number) => PidLiveness;
  /** The grace the marker layer gives a marker with no pid yet (a creator between its exclusive
   *  create and its text) before it is a leftover. */
  retryMs?: number;
}

/** Which mechanism answered: `os-lock` is the sidecar's advisory lock, `pid` the marker's pid
 *  judged alive or dead. */
export type LockJudge = "os-lock" | "pid";

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

/** The OS lock a hold keeps open for its life, with the seam that took it so the same one lets go. */
interface OsHold {
  readonly lock: OsLock;
  readonly handle: OsLockHandle;
}

/** `#ts` is the clock of the marker this process wrote, so a leaked in-process hold is judged by
 *  age alone, with no parse of the file. `os` is null for a hold the marker layer took. */
class HeldFileLock {
  #ts: number;

  constructor(
    readonly path: string,
    ts: number,
    readonly os: OsHold | null,
  ) {
    this.#ts = ts;
  }

  get judge(): LockJudge {
    return this.os === null ? "pid" : "os-lock";
  }

  isAged(staleMs: number, nowMs: number): boolean {
    return Number.isFinite(staleMs) && nowMs - this.#ts > staleMs;
  }

  /** On a failed write the previous clock stays remembered. The new text lands by rename (the
   *  disk writer's retrying one, for a marker a scanner holds open on Windows), so a reader never
   *  sees the marker between a truncate and a write. */
  refresh(nowMs: number): Acquire {
    try {
      writeMarker(this.path, renderMarker(nowMs));
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    this.#ts = nowMs;
    return ACQUIRED;
  }

  /** Does NOT delete the marker file (releaseFileLock's marker-verified job) and never the sidecar. */
  drop(): void {
    this.os?.lock.release(this.os.handle);
  }
}

/** The one record of what this process holds: the OS lock is per open handle, so the handle lives
 *  here for the lock's lifetime, and a marker naming our pid that is not here is a leftover (a
 *  release Windows refused, a crash under a recycled pid). */
const HELD_LOCKS = new Map<string, HeldFileLock>();

function osLockPath(lockPath: string): string {
  return `${lockPath}.oslock`;
}

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

function sameMarker(a: MarkerRead, b: MarkerRead): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "present" || b.kind !== "present" || a.raw === b.raw;
}

/** Staging names count up per process: a sibling a refused delete left behind (an open handle on
 *  Windows) must not be reopened under a live acquisition, and the exclusive open is the backstop
 *  for a name that exists anyway. */
let stagingSerial = 0;

/** The marker's bytes, written to a sibling only this process names, so they reach the lock path
 *  in one rename. The sibling is removed where the OS allows, a failed write's included; a refused
 *  removal leaves a harmless file that the per-process serial keeps from reuse. */
function stageMarker(lockPath: string, text: string): string {
  for (;;) {
    const staged = `${lockPath}.${process.pid}.${(stagingSerial++).toString(36)}.staging`;
    try {
      writeFileSync(staged, text, { flag: "wx" });
      return staged;
    } catch (cause) {
      if (isRecord(cause) && cause.code === "EEXIST") continue;
      removeQuietly(staged);
      throw cause;
    }
  }
}

/** A staging sibling left behind is named by its pid and harms nothing, and an empty marker guard
 *  left by a failed create is the next acquirer's leftover, so a refusal to delete either (an open
 *  handle on Windows) never undoes the step it followed. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

/** The text lands whole, by rename, over whatever the path holds. */
function writeMarker(lockPath: string, text: string): void {
  const staged = stageMarker(lockPath, text);
  try {
    renameWithRetry(staged, lockPath);
  } catch (cause) {
    removeQuietly(staged);
    throw cause;
  }
}

/** The marker layer's create: the exclusive open is the guard, and the text then lands by rename,
 *  so a reader meets the marker empty for the instant between (which the layer's readers give one
 *  retry) and never torn. `exists` is the one refusal the create itself can answer; anything else
 *  is the lock's I/O. */
function createMarker(lockPath: string, text: string): "created" | "exists" | { cause: unknown } {
  try {
    closeSync(openSync(lockPath, "wx"));
  } catch (cause) {
    return isRecord(cause) && cause.code === "EEXIST" ? "exists" : { cause };
  }
  try {
    writeMarker(lockPath, text);
    return "created";
  } catch (cause) {
    removeQuietly(lockPath);
    return { cause };
  }
}

/** `remove` is the test seam. */
export function removeMarkerWithRetry(
  path: string,
  remove: (p: string) => void = (p) => rmSync(p, { force: true }),
): void {
  retryOpenHandleRefusal(() => remove(path));
}

/** The marker layer's judgment of a marker at the path. Our own pid outside HELD_LOCKS is a
 *  leftover: nothing in this process holds a lock the record does not know. `unjudged` is a marker
 *  with no pid in it: a creator between its exclusive create and its text, or garbage. */
function markerHolds(
  lockPath: string,
  raw: string,
  liveness: (pid: number) => PidLiveness,
): "held" | "leftover" | "unjudged" {
  const pid = markerPid(raw);
  if (pid === null) return "unjudged";
  if (pid === process.pid) return HELD_LOCKS.has(lockPath) ? "held" : "leftover";
  return liveness(pid) === "alive" ? "held" : "leftover";
}

/** A primitive: production code scopes lock lifetimes through withFileLock/withFileLockSync, bar
 *  src/copilot_api/daemon_lock.ts, and this stays exported for the on-disk contract tests.
 *
 *  the OS lock is held elsewhere             -> false
 *  our own hold, fresh / aged past staleMs   -> false / refreshed, true
 *  the OS lock is free                       -> ours; whatever marker the path holds is written over
 *  no libc here (the marker layer)           -> a live pid's marker is false; no file or a leftover
 *                                               (dead pid, malformed, our pid with no hold) is ours */
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
  // copilot-env's own (its parents included) is named on stderr; the lock files themselves stay
  // raw (a dry run takes no lock, see withFileLockSync).
  try {
    fs.mkdir(dirname(lockPath));
  } catch (cause) {
    return { kind: "unavailable", cause };
  }

  const lock = opts.osLock ?? osLock;
  let os: ReturnType<OsLock["tryExclusive"]>;
  try {
    os = lock.tryExclusive(osLockPath(lockPath));
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
  if (os.kind === "busy") return BUSY;
  if (os.kind === "unsupported") return acquireByMarker(lockPath, nowMs, opts);
  try {
    writeMarker(lockPath, renderMarker(nowMs));
  } catch (cause) {
    lock.release(os.handle);
    return { kind: "unavailable", cause };
  }
  HELD_LOCKS.set(lockPath, new HeldFileLock(lockPath, nowMs, { lock, handle: os.handle }));
  return ACQUIRED;
}

/** The marker layer: the create is the exclusion, and an existing marker is judged by its pid. */
function acquireByMarker(lockPath: string, nowMs: number, opts: FileLockOptions): Acquire {
  const text = renderMarker(nowMs);
  const created = createMarker(lockPath, text);
  if (created === "created") return recordMarkerHold(lockPath, nowMs);
  if (created !== "exists") return { kind: "unavailable", cause: created.cause };

  const observed = readMarker(lockPath);
  if (observed.kind === "unreadable") return { kind: "unavailable", cause: observed.cause };
  // Released between the create and the read: the next attempt lands.
  if (observed.kind === "absent") return BUSY;
  const liveness = opts.liveness ?? pidLiveness;
  let holds = markerHolds(lockPath, observed.raw, liveness);
  if (holds === "unjudged") {
    // One grace for a creator still writing its text; a marker that changed meanwhile is a
    // holder's progress, one that did not is a leftover.
    sleepSync(opts.retryMs ?? LOCK_RETRY_MS);
    const reread = readMarker(lockPath);
    if (reread.kind !== "present" || reread.raw !== observed.raw) return BUSY;
    holds = markerHolds(lockPath, reread.raw, liveness);
    if (holds === "unjudged") holds = "leftover";
  }
  if (holds === "held") return BUSY;

  // The takeover: the leftover goes, then the create runs again; a contender that won the same
  // takeover is a holder now.
  try {
    removeMarkerWithRetry(lockPath);
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
  const retaken = createMarker(lockPath, text);
  if (retaken === "created") return recordMarkerHold(lockPath, nowMs);
  return retaken === "exists" ? BUSY : { kind: "unavailable", cause: retaken.cause };
}

function recordMarkerHold(lockPath: string, nowMs: number): Acquire {
  HELD_LOCKS.set(lockPath, new HeldFileLock(lockPath, nowMs, null));
  return ACQUIRED;
}

/** `markerPid` is the holder's (`held`) or the LAST holder's (`free`), so a consumer can tie the
 *  verdict to a specific pid; `absent` means no marker file is there NOW, which a completed
 *  release also leaves behind. `judge` says which layer answered. */
export type FileLockProbe =
  | { readonly kind: "held"; readonly markerPid: number | null; readonly judge: LockJudge }
  | { readonly kind: "free"; readonly markerPid: number | null; readonly judge: LockJudge }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

const PROBE_ABSENT: FileLockProbe = Object.freeze({ kind: "absent" });
const PROBE_UNKNOWN: FileLockProbe = Object.freeze({ kind: "unknown" });

function probeHeld(markerPid: number | null, judge: LockJudge): FileLockProbe {
  return Object.freeze({ kind: "held", markerPid, judge });
}

function probeFree(markerPid: number | null, judge: LockJudge): FileLockProbe {
  return Object.freeze({ kind: "free", markerPid, judge });
}

/** Non-mutating: the sidecar is try-locked SHARED and released at once, and the marker is only
 *  read. `unknown` is a marker this process cannot read or one that changed under the probe, so a
 *  caller about to act on "nobody there" fails closed. */
export function probeFileLock(lockPath: string, opts: FileLockOptions = {}): FileLockProbe {
  const observed = readMarker(lockPath);
  if (observed.kind === "unreadable") return PROBE_UNKNOWN;
  const pid = observed.kind === "present" ? markerPid(observed.raw) : null;
  // The OS may report a second same-process attempt either way (flock on NFS is per process),
  // so our own lock answers from the record.
  const ours = HELD_LOCKS.get(lockPath);
  if (ours !== undefined) return probeHeld(pid, ours.judge);
  const lock = opts.osLock ?? osLock;
  let os: ReturnType<OsLock["tryShared"]>;
  try {
    os = lock.tryShared(osLockPath(lockPath));
  } catch {
    return PROBE_UNKNOWN;
  }
  if (os.kind === "locked") lock.release(os.handle);
  if (os.kind === "unsupported") return probeByMarker(lockPath, observed, opts);
  // The marker must read the same BEFORE and AFTER the lock observation, or a holder change
  // mid-probe would pair the previous holder's pid with the successor's lock state. The residual
  // window (a successor between its lock and its marker write) is a sub-millisecond misread the
  // next probe corrects.
  if (!sameMarker(observed, readMarker(lockPath))) return PROBE_UNKNOWN;
  if (os.kind === "busy") return probeHeld(pid, "os-lock");
  return observed.kind === "present" ? probeFree(pid, "os-lock") : PROBE_ABSENT;
}

/** The marker layer's probe: a marker with no pid is `unknown` here (a creator mid-write and
 *  garbage look alike, and a probe takes no grace); the acquirer's retry tells them apart. */
function probeByMarker(
  lockPath: string,
  observed: MarkerRead,
  opts: FileLockOptions,
): FileLockProbe {
  if (observed.kind !== "present") return PROBE_ABSENT;
  const pid = markerPid(observed.raw);
  switch (markerHolds(lockPath, observed.raw, opts.liveness ?? pidLiveness)) {
    case "held":
      return probeHeld(pid, "pid");
    case "leftover":
      return probeFree(pid, "pid");
    case "unjudged":
      return PROBE_UNKNOWN;
  }
}

/** A leftover (probeFileLock's `free`) is unlinked and true comes back; a holder, an absent file,
 *  and a marker this process cannot judge are left alone. Under the OS lock the next acquirer
 *  would write over it anyway, so the unlink is tidiness for a home whose last daemon is gone; on
 *  the marker layer it is the takeover the next acquirer cannot make where it cannot signal the
 *  holder's pid (EPERM reads as alive), which is why the CLI clears a dead daemon's leftover
 *  before the spawn (src/copilot_api/daemon_lock.ts). */
export function removeLeftoverLock(lockPath: string, opts: FileLockOptions = {}): boolean {
  if (probeFileLock(lockPath, opts).kind !== "free") return false;
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
 *  primitive call) must not blind the probes to the live holder's pid. The marker goes BEFORE the
 *  OS lock, so no contender can have written its own marker under the path we delete. The sidecar
 *  stays (the orphan-inode note in the header). A delete Windows refuses (a scanner's open handle)
 *  is retried and then given up: the leftover names our pid and the next acquirer writes over it.
 *  A release of a SCOPE-held path is refused: it would strand SCOPE_HOLDS and let the scope's own
 *  exit release a lock a later acquirer holds. */
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
    HELD_LOCKS.delete(lockPath);
    ours?.drop();
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
 *  Infinity never gives up, so the fn always observes `held`. `onWait` fires ONCE, with the probe
 *  of the holder it waits on: on the first failed attempt, or with `noticeAfterMs` on the first
 *  failed attempt after more than that much waiting since the call. */
export interface LockPolicy extends FileLockOptions {
  /** Governs only a second acquire from THIS process (another process's hold is never judged by
   *  age): Infinity never refresh-acquires this process's own live hold, however old, for a lock a
   *  process holds a long time (`agent start` across the float and the cleanup). */
  readonly staleMs: number;
  readonly waitMs: number;
  readonly onWait?: (holder: FileLockProbe) => void;
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
    policy.onWait(probeFileLock(lockPath, policy));
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
