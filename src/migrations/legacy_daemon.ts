// The daemon a previous release left running, proved from what it left behind before anything is
// signalled or removed: `prove` is the only builder of a ProvenLock (the author gone) or a
// ProvenDaemon (the author alive, re-read on the live table before a SIGKILL), so a bare pid
// reaches no signal and no delete. The evidence: `<home>/daemon.lock` (`pid\nts\n`), the OS lock
// on its `.oslock` sidecar (src/utils/file_lock.ts: held or unreadable is never a leftover), and
// the process table (`deno ... <entry>/copilot-api... start ... --port N`, started before the
// marker was written). This release's own daemon is proved in one case only: a marker it holds
// under a free OS lock (a build between the bun move and the lock's return), which
// src/migrations/5.0.1.ts stops; every other `ours` is left alone.
import { poll } from "@std/async";
import {
  daemonLockHold,
  daemonLockPath,
  daemonPidWithoutOsLock,
} from "../copilot_api/daemon_lock.ts";
import { allDaemonHomes, resolveRootHome } from "../copilot_api/paths.ts";
import { proxyPortFree } from "../copilot_api/port.ts";
import {
  DAEMON_SIGKILL_GRACE_MS,
  isDaemonCommandLine,
  isDaemonProcess,
  listUserProcessRows,
  lookupProcess,
  type ProcessLook,
  type ProcessRow,
  processIsZombie,
  processLookCommand,
  processStartMs,
  stopPidCommand,
  wholeNumber,
} from "../copilot_api/process.ts";
import { agentStopCommand } from "../copilot_api/profile.ts";
import * as fs from "../utils/fs_facade.ts";
import { type OsLock, osLock } from "../utils/os_lock.ts";
import { pidAlive } from "../utils/pid.ts";

/** The file lock's sidecar beside a daemon.lock (`<lock>.oslock`, src/utils/file_lock.ts), named
 *  here for the lock pair a proof removes. */
export function denoLockSidecarPath(home: string): string {
  return `${daemonLockPath(home)}.oslock`;
}

// The deno release's daemon signature, as its own sweep matched it: the runtime from the process
// table's executable name, then only invocation-shaped tokens (flags, paths, `run`, a quoted
// Windows path) up to an entry whose path segment starts with `copilot-api`, then `start`.
const DENO_RUNTIME_RE = /^deno(?:\.exe)?$/i;
const MIDDLE_TOKEN = `run|deno|-[^\\s"]*|"[^"]*"|(?:[^\\s"\\\\/-][^\\s"\\\\/]*)?[\\\\/][^\\s"]*`;
const ENTRY_TOKEN = '(?:"[^"]*[\\\\/]copilot-api[^"]*"|[^\\s"]*[\\\\/]copilot-api[^\\s"]*)';
const DENO_DAEMON_RE = new RegExp(
  `^\\s*(?:(?:${MIDDLE_TOKEN})\\s+)*${ENTRY_TOKEN}\\s+start(?:\\s|$)`,
  "i",
);
const ARGV_PORT_RE = /(?:^|\s)--port[= ](\d{1,5})(?=\s|$)/;

/** A deno by the table's executable name alone, whatever its argv says or fails to say. */
export function isDenoRuntimeRow(row: ProcessRow): boolean {
  return DENO_RUNTIME_RE.test(row.ucomm);
}

/** The shape, the port included: a daemon the step cannot verify by its port is not one it stops.
 *  Exported for the migration test's argv rows. */
export function isDenoDaemonRow(row: ProcessRow): boolean {
  return (
    DENO_RUNTIME_RE.test(row.ucomm) &&
    DENO_DAEMON_RE.test(row.command) &&
    argvPort(row.command) !== null
  );
}

export function argvPort(command: string): number | null {
  const match = ARGV_PORT_RE.exec(command);
  return match === null ? null : wholeNumber(match[1] as string);
}

function isOwnDaemonRow(row: ProcessRow): boolean {
  return process.platform === "win32" ? isDaemonCommandLine(row.command) : isDaemonProcess(row);
}

/** The reads a proof is built from; a test replaces one to stage a table this host cannot produce. */
export interface HolderReads {
  lookup: (pid: number) => Promise<ProcessLook>;
  start: (pid: number) => Promise<number | null>;
  zombie: (pid: number) => Promise<boolean | null>;
  portFree: (port: number) => Promise<boolean>;
  rows: () => Promise<ProcessRow[] | "unproven">;
}

export const REAL_HOLDER_READS: HolderReads = {
  lookup: lookupProcess,
  start: processStartMs,
  zombie: processIsZombie,
  portFree: proxyPortFree,
  rows: listUserProcessRows,
};

/** The start time reads at second resolution while a daemon writes its marker within a second
 *  of starting, so only a start this far past the marker proves another process. */
const START_AFTER_MARKER_SLACK_MS = 2_000;

/** Windows keeps a listening socket answering for a moment after its owner exits, so the port is
 *  re-read in steps up to this long before it reads as held by something else. */
const PORT_RELEASE_WAIT_MS = 2_500;
const PORT_RELEASE_STEP_MS = 100;

/** The author is gone; what now answers to the marker's pid holds nothing of the lock's. */
export type LeftoverReason = "dead" | "malformed" | "zombie" | "recycled" | "stranger";

/** Whose daemon a proof names: the deno release's, or this release's holding its marker without
 *  the OS lock. The identity reads differ; the stop is the same. */
export type DaemonShape = "deno" | "ours";

/** The construction token: never exported, so no subclass outside this module can call `super`
 *  without a cast (a cast is the one way past every type). */
const PROOF: unique symbol = Symbol("legacy_daemon.prove");

// The builders: module-private closures the static blocks below fill in, so `prove` is the one
// place a ProvenLock or a ProvenDaemon comes from while both constructors stay closed.
let buildLeftover!: (
  home: string,
  pid: number | null,
  command: string,
  reason: LeftoverReason,
  reads: HolderReads,
) => ProvenLock;
let buildDaemon!: (
  shape: DaemonShape,
  home: string,
  pid: number,
  command: string,
  startMs: number,
  port: number,
  reads: HolderReads,
) => ProvenDaemon;

/**
 * A `home`'s daemon.lock proved against the live process table: the author gone (this class, a
 * leftover) or alive (ProvenDaemon). Built only by `prove`, so every destructive step below takes
 * one. The protected `reads` makes the type nominal and the token keeps a subclass elsewhere from
 * minting one.
 *
 * The guarantee's scope: the proof types refuse the accidental path, a bare pid or a hand-built
 * object reaching a destructive step through ordinary code; deliberate fabrication through
 * prototypes, Object.create, casts, or any is out of scope and is the cast class the review records.
 */
export class ProvenLock {
  protected constructor(
    token: typeof PROOF,
    readonly home: string,
    readonly pid: number | null,
    readonly command: string,
    readonly reason: LeftoverReason | null,
    protected readonly reads: HolderReads,
  ) {
    // The boundary assertion behind the type: a `super` call that forged the token with a cast
    // fails here rather than minting a proof.
    if (token !== PROOF) throw new Error("a ProvenLock is built by prove() alone");
  }

  static {
    buildLeftover = (home, pid, command, reason, reads) =>
      new ProvenLock(PROOF, home, pid, command, reason, reads);
  }

  isDaemon(): this is ProvenDaemon {
    return this instanceof ProvenDaemon;
  }
}

/** The lock's author, alive: the one state the signal path accepts. */
export class ProvenDaemon extends ProvenLock {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the brand a ProvenLock with properties assigned onto it lacks, so `ProvenLock & {...}` is not a ProvenDaemon to the compiler
  private readonly provenDaemon = true;
  declare readonly pid: number;

  private constructor(
    readonly shape: DaemonShape,
    home: string,
    pid: number,
    command: string,
    readonly startMs: number,
    readonly port: number,
    reads: HolderReads,
  ) {
    super(PROOF, home, pid, command, null, reads);
  }

  static {
    buildDaemon = (shape, home, pid, command, startMs, port, reads) =>
      new ProvenDaemon(shape, home, pid, command, startMs, port, reads);
  }

  private isSameShape(row: ProcessRow): boolean {
    return this.shape === "deno" ? isDenoDaemonRow(row) : isOwnDaemonRow(row);
  }

  /** Whether `prove` on the live table builds this daemon again: same home, pid, and start time.
   *  The SIGKILL boundary. */
  async reprovesAsSame(): Promise<boolean> {
    const again = await prove(this.home, this.reads);
    return (
      again instanceof ProvenDaemon &&
      again.shape === this.shape &&
      again.pid === this.pid &&
      Math.abs(again.startMs - this.startMs) <= START_AFTER_MARKER_SLACK_MS
    );
  }

  /** The daemon's identity against the table now, the lock apart (a daemon drops it while
   *  shutting down and may hang after): the shape and the start time. "unknown" is a table or
   *  clock that will not read, or one that says gone of a pid the signal probe says is alive. */
  async identityNow(): Promise<"same" | "other" | "unknown"> {
    const look = await this.reads.lookup(this.pid);
    if (look.kind === "gone") return pidAlive(this.pid) ? "unknown" : "other";
    if (look.kind === "unreadable") return "unknown";
    if (!this.isSameShape(look.row)) return "other";
    const startMs = await this.reads.start(this.pid);
    if (startMs === null) return "unknown";
    return Math.abs(startMs - this.startMs) > START_AFTER_MARKER_SLACK_MS ? "other" : "same";
  }

  portComesFree(): Promise<boolean> {
    return settles(
      () => this.reads.portFree(this.port),
      PORT_RELEASE_STEP_MS,
      PORT_RELEASE_WAIT_MS,
    );
  }
}

/** What `prove` says of a home's lock. Only the ProvenLock arms license a signal or a delete. */
export type LockVerdict =
  | ProvenLock
  /** No marker file: nothing to judge. */
  | { readonly kind: "none" }
  /** A marker this process cannot read: never "nobody". */
  | { readonly kind: "unreadable" }
  /** This release's own daemon (a re-run after the user started one). */
  | { readonly kind: "ours"; readonly pid: number }
  /** Alive, not a deno, and no sidecar: not this step's lock to judge. */
  | { readonly kind: "bystander"; readonly pid: number; readonly command: string }
  /** A pid this step must not place: fail closed, the user judges it. */
  | {
      readonly kind: "unjudged";
      /** Null when the marker names no pid to look at, or when the pid it names is not the
       *  lock's holder (a live process holds the OS lock). */
      readonly pid: number | null;
      readonly command: string;
      readonly reason: string;
    };

/** The OS lock on `home`'s sidecar, observed on the sidecar itself (a shared try-lock, released
 *  at once), never through a marker's say-so: `held` is a live process whatever the table calls
 *  it; `unreadable` (a sidecar this process cannot open or lock, or a machine whose libc will not
 *  load, where no holder could be seen) proves nothing either way. No sidecar is nobody's hold. */
function osLockState(home: string): "held" | "free" | "unreadable" {
  let shared: ReturnType<OsLock["tryShared"]>;
  try {
    shared = osLock.tryShared(denoLockSidecarPath(home));
  } catch {
    return "unreadable";
  }
  switch (shared.kind) {
    case "locked":
      osLock.release(shared.handle);
      return "free";
    case "absent":
      return "free";
    case "busy":
      return "held";
    case "unsupported":
      return "unreadable";
  }
}

/** Whether `pid` holds the OS lock of a daemon home other than `home`: then it is that home's
 *  live daemon wearing a number a dead daemon's marker here still names. `unknown` is a home
 *  whose lock cannot be read, so the question has no answer and nothing destructive follows. */
function holdsAnotherHomesLock(pid: number, home: string): "yes" | "no" | "unknown" {
  const rootHome = resolveRootHome();
  let answer: "no" | "unknown" = "no";
  for (const other of [rootHome, ...allDaemonHomes(rootHome)]) {
    if (other === home) continue;
    const hold = daemonLockHold(other);
    if (hold.kind === "unreadable") answer = "unknown";
    if (hold.kind === "held" && hold.judge === "os-lock" && hold.pid === pid) return "yes";
  }
  return answer;
}

/**
 * Reads the marker, the sidecar, the OS lock, and the table, and proves one of: the author alive
 * (a ProvenDaemon), the author gone (a ProvenLock leftover), or a verdict that licenses nothing.
 * An evidence input that is malformed or impossible fails closed as "unjudged" with the reason: it
 * never reads as proof, nor as absence.
 */
export async function prove(
  home: string,
  reads: HolderReads = REAL_HOLDER_READS,
): Promise<LockVerdict> {
  const marker = readMarker(home);
  if (marker.kind !== "text") return { kind: marker.kind };
  const { pid, writtenMs } = marker;
  // The author is gone only if nothing holds the OS lock: a held sidecar is a live process's
  // (removing it would orphan its lock), and one this process cannot open may be, so neither is
  // ever a leftover, whatever the marker says.
  const osLock = osLockState(home);
  const leftover = (reason: LeftoverReason, command = ""): LockVerdict => {
    if (osLock === "free") return buildLeftover(home, pid, command, reason, reads);
    return {
      kind: "unjudged",
      pid: null,
      command,
      reason:
        osLock === "held"
          ? "its sidecar is locked by a live process"
          : "its sidecar cannot be opened, so its lock may be held",
    };
  };
  if (pid === null) {
    // The sidecar's own lock first: a held or unreadable one is the verdict whatever the table
    // shows. Then a marker naming no pid beside the deno release's sidecar may be that daemon's,
    // truncated: a leftover only once the table shows no deno at all.
    if (osLock !== "free" || !fs.exists(denoLockSidecarPath(home))) return leftover("malformed");
    const rows = await reads.rows();
    if (rows === "unproven") {
      return {
        kind: "unjudged",
        pid,
        command: "",
        reason:
          "its lock marker names no pid, and the process table could not be scanned for a deno",
      };
    }
    if (rows.some((row) => DENO_RUNTIME_RE.test(row.ucomm))) {
      return {
        kind: "unjudged",
        pid,
        command: "",
        reason: "its lock marker names no pid while a deno runs",
      };
    }
    return leftover("malformed");
  }
  if (!pidAlive(pid)) return leftover("dead");
  const look = await reads.lookup(pid);
  if (look.kind !== "row") {
    return { kind: "unjudged", pid, command: "", reason: "the process table did not show it" };
  }
  const { command } = look.row;
  if (isOwnDaemonRow(look.row)) {
    // Stopped only when provably this home's: its marker under a free OS lock here, and no OS
    // lock of another home held by it (the cross-home pid reuse). Anything less is left alone.
    if (daemonPidWithoutOsLock(home) !== pid) return { kind: "ours", pid };
    if (holdsAnotherHomesLock(pid, home) !== "no") return { kind: "ours", pid };
    const port = argvPort(command);
    const startMs = port === null ? null : await reads.start(pid);
    if (port === null || startMs === null) return { kind: "ours", pid };
    return buildDaemon("ours", home, pid, command, startMs, port, reads);
  }
  if ((await reads.zombie(pid)) === true) return leftover("zombie", command);
  const sidecar = fs.exists(denoLockSidecarPath(home));
  if (!DENO_RUNTIME_RE.test(look.row.ucomm)) {
    // A recycled pid's leftover only when no other home's OS lock is held by this pid (its own
    // sidecar's state is the leftover rule above).
    return sidecar && holdsAnotherHomesLock(pid, home) === "no"
      ? leftover("recycled", command)
      : { kind: "bystander", pid, command };
  }
  const unjudged = (reason: string): LockVerdict => ({ kind: "unjudged", pid, command, reason });
  if (!DENO_DAEMON_RE.test(command)) return unjudged("its argv is not the shape this step stops");
  const port = argvPort(command);
  if (port === null) return unjudged("its argv names no --port");
  if (writtenMs === null) return unjudged("its lock marker carries no timestamp");
  if (writtenMs > Date.now()) return unjudged("its lock marker is stamped in the future");
  if (!sidecar) return unjudged("its lock has no .oslock sidecar, so it is not the deno release's");
  const startMs = await reads.start(pid);
  if (startMs === null) return unjudged("its start time could not be read");
  if (startMs > writtenMs + START_AFTER_MARKER_SLACK_MS) return leftover("stranger", command);
  return buildDaemon("deno", home, pid, command, startMs, port, reads);
}

type MarkerRead =
  | { kind: "text"; pid: number | null; writtenMs: number | null }
  | { kind: "none" }
  | { kind: "unreadable" };

/** The marker's two lines (`pid\nts\n`, the deno release's format too). */
function readMarker(home: string): MarkerRead {
  const read = fs.readTextResult(daemonLockPath(home));
  if (read.kind === "absent") return { kind: "none" };
  if (read.kind !== "text") return { kind: "unreadable" };
  // A marker line is a whole decimal number and nothing else: `12345junk` is malformed, never
  // 12345 (parseInt would read it so, and a forged or torn marker would pass as the author's).
  const [first = "", second = ""] = read.text.split("\n");
  const pid = wholeNumber(first);
  return {
    kind: "text",
    pid: pid === null || pid <= 0 ? null : pid,
    writtenMs: wholeNumber(second),
  };
}

/** What the escalation sent. */
type StopVerdict =
  /** Gone inside the SIGTERM grace. */
  | "term"
  /** SIGKILL sent: the pid re-proved as the same daemon at that boundary. */
  | "kill"
  /** No SIGKILL: at that boundary the pid could not be re-proved as the daemon, so nothing more
   *  was sent to it. */
  | "spared";

export type DenoStopOutcome =
  /** A dry run: nothing signalled. */
  | { readonly kind: "would-stop" }
  /** The daemon is gone (the pid dead, or alive as a different process) and its port answers nobody. */
  | { readonly kind: "stopped"; readonly verdict: StopVerdict }
  /** The pid is alive after the SIGKILL grace: the same daemon (`identity` "same"), or one this
   *  host can no longer read and so must not name as the daemon (`identity` "unread"). */
  | {
      readonly kind: "still-running";
      readonly verdict: StopVerdict;
      readonly identity: "same" | "unread";
    }
  /** The daemon is gone, yet its port still answers past the release wait: something else
   *  listens there. */
  | { readonly kind: "port-still-busy"; readonly port: number };

/**
 * SIGTERM, the grace, then SIGKILL only if `prove` on the live table builds the same daemon again
 * (same home, pid, and start time); a pid that no longer proves gets nothing more. Then the
 * daemon's end (the pid dead, or alive as another process, which is spared) and its port.
 */
export async function stopProvenDaemon(daemon: ProvenDaemon): Promise<DenoStopOutcome> {
  if (fs.dryRunActive()) return { kind: "would-stop" };
  const { pid } = daemon;
  signal(pid, "SIGTERM");
  await waitForExit(pid);
  let verdict: StopVerdict = "term";
  if (pidAlive(pid)) {
    const same = await daemon.reprovesAsSame();
    verdict = same ? "kill" : "spared";
    if (same) {
      signal(pid, "SIGKILL");
      await waitForExit(pid);
    }
  }
  if (pidAlive(pid)) {
    const identity = await daemon.identityNow();
    if (identity === "same") return { kind: "still-running", verdict, identity: "same" };
    if (identity === "unknown") return { kind: "still-running", verdict, identity: "unread" };
  }
  if (!(await daemon.portComesFree())) return { kind: "port-still-busy", port: daemon.port };
  return { kind: "stopped", verdict };
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, name);
  } catch {
    /* already gone */
  }
}

/** Awaited, never a blocking sleep: a daemon that is this process's child (the tests' fixtures)
 *  is reaped on the event loop, and a blocked loop would read it alive for the whole grace. */
async function waitForExit(pid: number): Promise<void> {
  await settles(() => Promise.resolve(!pidAlive(pid)), 50, DAEMON_SIGKILL_GRACE_MS);
}

/** poll's abort at the cap is the answer "no", not an error. */
async function settles(
  ask: () => Promise<boolean>,
  stepMs: number,
  capMs: number,
): Promise<boolean> {
  try {
    await poll(ask, (done) => done, { interval: stepMs, signal: AbortSignal.timeout(capMs) });
    return true;
  } catch (error) {
    if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
      return false;
    }
    throw error;
  }
}

/** Removes the proven lock's marker and its sidecar, through the write seam (a dry run stages
 *  both). The proof is the licence: a daemon stopped, or a leftover of a gone author. */
export function removeLockPair(lock: ProvenLock): void {
  fs.rm(daemonLockPath(lock.home), { force: true });
  fs.rm(denoLockSidecarPath(lock.home), { force: true });
}

// --- the 4.0.9 steps' stop --------------------------------------------------------------------

export type LockedDaemonOutcome =
  /** No daemon to stop: no marker, or a leftover of a gone author, which went with its sidecar. */
  | { kind: "none" }
  /** A dry run: the holder it would signal. */
  | { kind: "would-stop"; pid: number }
  /** Signalled and waited for; `stillRunning` when the daemon may still run after the grace. */
  | { kind: "stopped"; pid: number; verdict: StopVerdict; stillRunning: boolean }
  /** Fail closed: a lock this process cannot prove is never "nobody". */
  | { kind: "unjudged"; reason: string };

/** The 4.0.9 layout and rename steps' stop of a daemon at `home`: the same proof as the 5.0.1
 *  step's (their daemons ran under deno too), so a lock it cannot prove is left with the reason,
 *  never signalled. A stopped daemon's lock pair goes with it. This release's own daemon, OS lock
 *  or not, is the user's to stop. */
export async function stopLockedDaemon(home: string): Promise<LockedDaemonOutcome> {
  const verdict = await prove(home);
  if (verdict instanceof ProvenLock && !(verdict.isDaemon() && verdict.shape === "ours")) {
    if (!verdict.isDaemon()) {
      removeLockPair(verdict);
      return { kind: "none" };
    }
    const outcome = await stopProvenDaemon(verdict);
    const { pid } = verdict;
    switch (outcome.kind) {
      case "would-stop":
        removeLockPair(verdict);
        return { kind: "would-stop", pid };
      case "stopped":
        removeLockPair(verdict);
        return { kind: "stopped", pid, verdict: outcome.verdict, stillRunning: false };
      case "still-running":
        return { kind: "stopped", pid, verdict: outcome.verdict, stillRunning: true };
      case "port-still-busy":
        return { kind: "stopped", pid, verdict: "term", stillRunning: true };
    }
  }
  const lock = daemonLockPath(home);
  const ours = (pid: number): LockedDaemonOutcome => ({
    kind: "unjudged",
    reason: `${lock} is held by this release's daemon (pid ${pid}); stop it: ${agentStopCommand(null)}`,
  });
  if (verdict instanceof ProvenLock) return ours(verdict.pid);
  switch (verdict.kind) {
    case "none":
      return { kind: "none" };
    case "unreadable":
      return { kind: "unjudged", reason: `${lock} cannot be read` };
    case "ours":
      return ours(verdict.pid);
    case "bystander":
      return {
        kind: "unjudged",
        reason: `${lock} names pid ${verdict.pid}, which is not the deno-era daemon; look: ${processLookCommand(verdict.pid)}`,
      };
    case "unjudged":
      return {
        kind: "unjudged",
        reason:
          verdict.pid === null
            ? `${lock}: ${verdict.reason}`
            : `${lock} names pid ${verdict.pid}, but ${verdict.reason}; look: ${processLookCommand(verdict.pid)}, stop it by hand: ${stopPidCommand(verdict.pid)}`,
      };
  }
}
