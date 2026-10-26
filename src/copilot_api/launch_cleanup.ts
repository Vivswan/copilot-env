// The tracked-pid / orphan cleanup: planCleanup decides (read-only; `start --dry-run` narrates the
// same plan) and cleanupExistingProxies acts under the held start lock (launch.ts), re-deriving
// every target's identity at its own signal boundary.
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { colorEnabled, paintFor } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { killCommand } from "../utils/kill_command.ts";
import { scannable } from "../utils/message.ts";
import { pidAlive } from "../utils/pid.ts";
import { daemonLockHold, daemonLockHolderPid, daemonLockVerdict } from "./daemon_lock.ts";
import { allDaemonHomes, CopilotApiPaths, profileHomeNames } from "./paths.ts";
import { daemonPolicy } from "./port.ts";
import {
  type classifyDaemonPid,
  classifyOwnedDaemonPid,
  DAEMON_SIGKILL_GRACE_MS,
  getOrphanPids,
  isCopilotApiPid,
  LAUNCH_SETTLE_MS,
  terminatePid,
} from "./process.ts";
import type { Profile } from "./profile.ts";
import { CopilotEnvRunState } from "./run_state.ts";

/** The set the orphan sweep must NEVER signal: another profile's healthy daemon is not an orphan.
 *  `except` drops ONE slot's RECORD, never the pid: another slot's claim on the same pid still counts. */
export function trackedDaemonPids(except?: Profile): Set<number> {
  const pids = new Set<number>();
  for (const profile of [null, ...profileHomeNames()]) {
    if (except !== undefined && profile === except) continue;
    const pid = CopilotEnvRunState.forProfile(profile).read().pid;
    if (pid !== undefined) pids.add(pid);
  }
  return pids;
}

/** A held daemon.lock is the STRONGER keep-signal beside run-state tracking: a pid marker the lock
 *  module judges by the pid's liveness, so it survives run-state loss (a recycled pid can defeat
 *  it, which is why every stop re-proves identity at its KILL boundary). `indeterminate` means the
 *  sweep cannot prove ANY pid unprotected, so it must not run. */
type LockSweepSpares =
  | { readonly kind: "pids"; readonly pids: Set<number> }
  | { readonly kind: "indeterminate"; readonly home: string };

export function lockProtectedDaemonPids(): LockSweepSpares {
  const pids = new Set<number>();
  for (const home of allDaemonHomes()) {
    const hold = daemonLockHold(home);
    switch (hold.kind) {
      case "held":
        if (hold.pid === null) return { kind: "indeterminate", home };
        pids.add(hold.pid);
        break;
      case "free":
        break;
      case "unreadable":
        return { kind: "indeterminate", home };
      default:
        return assertNever(hold);
    }
  }
  return { kind: "pids", pids };
}

/** The lock-holder exclusion is applied HERE, at the one list producer, so no caller can forget it.
 *  Both fail-closed cases empty the list and SAY so, so an operator never mistakes a broken process
 *  table for a clean machine. `listPids` is the test seam. */
export async function listUntrackedOrphans(
  myPid: number,
  myPpid: number,
  keepPids: Set<number>,
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
): Promise<number[]> {
  const spares = lockProtectedDaemonPids();
  if (spares.kind === "indeterminate") {
    consola.warn(
      `Skipping the orphan sweep: the daemon lock state under ${spares.home} cannot be established, so no process can be proven orphaned.`,
    );
    return [];
  }
  const scanned = await listPids(myPid, myPpid);
  if (scanned === "unproven") {
    consola.warn(
      "Skipping the orphan sweep: the process scan failed, so no process can be proven orphaned.",
    );
    return [];
  }
  return scanned.filter((p) => !keepPids.has(p) && !spares.pids.has(p));
}

const HOLDER_STOP_POLL_MS = 100;

/**
 * Whether THIS host can vouch that `holder` is OUR daemon in the LOCAL pid table. The lock alone
 * cannot: a daemon home can be shared across hosts, where another HOST's daemon holds it and its marker
 * pid may name any innocent local process. Nor can run state: it proves the pid was ours ONCE.
 *   tracked by another slot's record        -> refused (a stale-state pid-reuse collision)
 *   claimed, or unreadable, in another home -> refused ("failed to look" is never "not this pid")
 *   owner-filtered scan fails or says no    -> refused
 */
async function corroborateLockHolder(
  home: string,
  holder: number,
  trackedSpares: Set<number> = trackedDaemonPids(),
): Promise<boolean> {
  if (trackedSpares.has(holder)) return false;
  for (const other of allDaemonHomes()) {
    if (other === home) continue;
    const hold = daemonLockHold(other);
    switch (hold.kind) {
      case "held":
        if (hold.pid === null || hold.pid === holder) return false;
        break;
      case "free":
        break;
      case "unreadable":
        return false;
      default:
        return assertNever(hold);
    }
  }
  return await isCopilotApiPid(holder);
}

/**
 * SIGTERM, then wait out the grace RE-DERIVING every proof, and SIGKILL only if the pid STILL
 * corroborates AND still holds the lock right before the signal. Holding alone must never drive the
 * force-kill: on a shared home another host's daemon keeps the lock held. Any doubt at the deadline
 * skips the kill; the worst case is the preload's legible failure.
 */
async function stopLockHolder(home: string, holder: number): Promise<void> {
  try {
    process.kill(holder, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
  while (daemonLockHolderPid(home) === holder) {
    if (Date.now() >= deadline) {
      if ((await corroborateLockHolder(home, holder)) && daemonLockHolderPid(home) === holder) {
        try {
          process.kill(holder, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      return;
    }
    await sleep(HOLDER_STOP_POLL_MS);
  }
}

/** planCleanup is the SINGLE decision source: the live cleanup and `start --dry-run` both switch on
 *  it exhaustively, so a live action cannot ship without its dry-run line. */
export type CleanupAction =
  | { readonly kind: "stop-tracked"; readonly pid: number }
  | { readonly kind: "clear-tracking"; readonly pid: number }
  | { readonly kind: "stop-holder"; readonly pid: number }
  | { readonly kind: "leave-holder"; readonly pid: number }
  | { readonly kind: "stop-orphan"; readonly pid: number };

/**
 * READ-ONLY: no signals, no writes. Every judgment past the clear uses the POST-clear set: `profile`'s
 * own record is exempted as a RECORD, never as a pid, so another slot's claim still spares or refuses.
 * `home` is passed in because the callers own the path derivation.
 */
export async function planCleanup(
  home: string,
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
  classifyPid: typeof classifyDaemonPid = classifyOwnedDaemonPid,
): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];
  const tracked = state.read().pid;
  if (tracked !== undefined) {
    // "dead" is never signalled however alive the pid table says it is (pid reuse); "alive" DEFERS to
    // the corroborated holder stop below.
    if (daemonLockVerdict(home, tracked) === "unproven") {
      // "unknown" (the scan FAILED) skips the signal like "no", but is SAID: a silent skip reads as
      // "proven not ours", and the possibly-live daemon still holds its port.
      const cls = await classifyPid(tracked);
      switch (cls) {
        case "yes":
          actions.push({ kind: "stop-tracked", pid: tracked });
          break;
        case "unknown":
          warnUnprovenTrackedPid(tracked);
          break;
        case "no":
          break;
        default:
          assertNever(cls);
      }
    }
    // A durable state write, so an enumerated action the dry run must report.
    actions.push({ kind: "clear-tracking", pid: tracked });
  }
  const postClearTracked = trackedDaemonPids(profile);
  // Without the holder stop a live holder is unstoppable: the sweep spares every holder, so the new
  // daemon's preload fails lock acquisition on every retry and `agent stop` no-ops.
  const holder = daemonLockHolderPid(home);
  if (holder !== null && holder !== process.pid && holder !== process.ppid) {
    actions.push(
      (await corroborateLockHolder(home, holder, postClearTracked))
        ? { kind: "stop-holder", pid: holder }
        : { kind: "leave-holder", pid: holder },
    );
  }
  const orphans = await listUntrackedOrphans(process.pid, process.ppid, postClearTracked, listPids);
  for (const pid of orphans) {
    if (pidAlive(pid)) actions.push({ kind: "stop-orphan", pid });
  }
  return actions;
}

/** Emitted for a planned leave, and again when a planned holder stop finds its corroboration lapsed
 *  at the signal boundary. */
function warnLeaveHolder(pid: number): void {
  consola.warn(
    scannable({
      headline: `Leaving the daemon.lock holder (pid=${paintFor(colorEnabled()).cyan(String(pid))}) alone.`,
      evidence: [
        "that pid not identifiable as our daemon from this host",
        "a shared home's daemon on another host, or an unreadable process table",
        "the launch below blocked at its lock acquisition by the held lock",
      ],
      lead: "Fix:",
      actions: [
        [killCommand(pid), "on the host whose daemon holds the lock; the pid is that host's"],
      ],
    }),
  );
}

/** planCleanup also narrates `start --dry-run`, where NOTHING executes, so the wording claims no
 *  completed action; it advises stopping by raw pid because the live path's clear-tracking leaves
 *  `agent stop` no record to target. */
function warnUnprovenTrackedPid(pid: number): void {
  consola.warn(
    scannable({
      headline: `Skipping the tracked-pid stop (pid=${paintFor(colorEnabled()).cyan(String(pid))}).`,
      evidence: [
        "identity unproven by the process scan",
        "no signal sent by this stop (fail-closed)",
      ],
      lead: "Fix:",
      actions: [
        [killCommand(pid), "if it remains running, from a shell that can read the process table"],
      ],
    }),
  );
}

/** `stopped`: a daemon of this root home was signalled (a tracked pid, this home's lock holder, an
 *  orphan), so the tree it ran from is free: the start runs the floor gate once more
 *  (src/commands/start.ts), since the float refuses to swap under a running daemon. */
export interface CleanupOutcome {
  stopped: boolean;
}

/** The planned tracked-pid stop, its target re-derived at the signal boundary; true when signalled. */
async function stopTrackedPid(
  pid: number,
  classifyPid: typeof classifyDaemonPid,
): Promise<boolean> {
  // The SAME classifier rides into terminatePid's SIGKILL re-proof, so the escalation never judges
  // under a weaker (owner-blind) standard than the TERM.
  switch (await classifyPid(pid)) {
    case "yes":
      consola.info(`   Stopping tracked proxy (pid=${pid}) ...`);
      // Verdict unused: the clear-tracking action queued right behind unbinds the pid whichever
      // way the kill went, and terminatePid reports a refused escalation itself.
      await terminatePid(pid, DAEMON_SIGKILL_GRACE_MS, classifyPid);
      return true;
    case "unknown":
      warnUnprovenTrackedPid(pid);
      return false;
    case "no":
      return false;
  }
}

/** The planned stop of this home's daemon.lock holder; a lapsed corroboration draws the same leave
 *  the plan would have decided then. True when signalled. */
async function stopPlannedHolder(home: string, pid: number): Promise<boolean> {
  if (daemonLockHolderPid(home) !== pid) return false;
  if (!(await corroborateLockHolder(home, pid))) {
    warnLeaveHolder(pid);
    return false;
  }
  consola.info(`   Stopping this home's daemon.lock holder (pid=${pid}) ...`);
  await stopLockHolder(home, pid);
  return true;
}

/** Only pids in both the plan and a FRESH scan are signalled: the tracked and holder stops before
 *  this can take a grace, so a pid recycled since planning is never TERM'd off the stale snapshot.
 *  True when any was signalled. */
async function sweepPlannedOrphans(
  planned: readonly number[],
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven">,
): Promise<boolean> {
  const plannedSet = new Set(planned);
  const stillUntracked = async (): Promise<number[]> =>
    (await listUntrackedOrphans(process.pid, process.ppid, trackedDaemonPids(), listPids)).filter(
      (p) => plannedSet.has(p),
    );
  const confirmed = await stillUntracked();
  if (confirmed.length === 0) return false;

  for (const opid of confirmed) {
    if (!pidAlive(opid)) continue;
    consola.info(`   Stopping orphaned proxy (pid=${opid}) ...`);
    try {
      process.kill(opid, "SIGTERM");
    } catch {
      /* OSError */
    }
  }
  await sleep(DAEMON_SIGKILL_GRACE_MS);
  for (const opid of await stillUntracked()) {
    if (!pidAlive(opid)) continue;
    try {
      process.kill(opid, "SIGKILL");
    } catch {
      /* OSError */
    }
  }
  return true;
}

/**
 * The plan only authorizes: every signal re-derives its target's identity at its own boundary.
 * Race-free only under the start lock (withStartLock, held by the one caller in commands/start.ts).
 *
 *   tracking cleared before the sweeps -> a throw there leaves no port pointing at a dead daemon
 *   terminatePid's SIGKILL gate        -> signals on an UNREADABLE scan, so a pid recycled inside
 *                                         the grace still dies (the residual)
 */
export async function cleanupExistingProxies(
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
  classifyPid: typeof classifyDaemonPid = classifyOwnedDaemonPid,
): Promise<CleanupOutcome> {
  consola.start("Cleaning up existing proxy processes ...");
  let stopped = false;

  const home = new CopilotApiPaths(profile).home;
  const plan = await planCleanup(home, profile, state, listPids, classifyPid);

  const orphans: number[] = [];
  for (const action of plan) {
    switch (action.kind) {
      case "stop-tracked":
        if (await stopTrackedPid(action.pid, classifyPid)) stopped = true;
        break;
      case "clear-tracking":
        state.set(
          daemonPolicy(profile).releasesPortOnStop ? { pid: null, port: null } : { pid: null },
        );
        break;
      case "stop-holder":
        if (await stopPlannedHolder(home, action.pid)) stopped = true;
        break;
      case "leave-holder":
        warnLeaveHolder(action.pid);
        break;
      case "stop-orphan":
        orphans.push(action.pid);
        break;
      default:
        assertNever(action);
    }
  }

  if (orphans.length > 0) {
    if (await sweepPlannedOrphans(orphans, listPids)) stopped = true;
  }

  await sleep(LAUNCH_SETTLE_MS);
  return { stopped };
}
