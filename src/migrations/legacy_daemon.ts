// The daemon a home's daemon.lock names, stopped by the lock alone. The migrations that move or
// retire a previous release's daemon cannot ask the process classifier whether it is ours: that
// daemon ran under deno, which this release's classifier reads as foreign, and the marker in OUR
// home is the claim. The pid is judged by the lock and its liveness, and re-proved at the SIGKILL
// boundary by the lock still naming it alive; a dry run names what it would stop and signals
// nothing. Sweeping the marker a dead holder left stays with the caller (clearDeadDaemonLock).
import { daemonLockHold, daemonLockPath, daemonLockVerdict } from "../copilot_api/daemon_lock.ts";
import {
  DAEMON_SIGKILL_GRACE_MS,
  type TerminateVerdict,
  terminatePid,
} from "../copilot_api/process.ts";
import * as fs from "../utils/fs_facade.ts";
import { pidAlive } from "../utils/pid.ts";
import { sleepSync } from "../utils/time.ts";

export type LockedDaemonOutcome =
  /** The lock is free (absent, or a marker a dead holder left). */
  | { kind: "none" }
  /** A dry run: the holder it would signal. */
  | { kind: "would-stop"; pid: number }
  /** Signalled and waited for; `stillRunning` when the lock still names the pid alive after the grace. */
  | { kind: "stopped"; pid: number; verdict: TerminateVerdict; stillRunning: boolean }
  /** Fail closed: a lock this process cannot read, or one held without a pid, is never "nobody". */
  | { kind: "unjudged"; reason: string };

export async function stopLockedDaemon(home: string): Promise<LockedDaemonOutcome> {
  const hold = daemonLockHold(home);
  if (hold.kind === "free") return { kind: "none" };
  if (hold.kind === "unreadable") {
    return { kind: "unjudged", reason: `${daemonLockPath(home)} cannot be read` };
  }
  if (hold.pid === null) {
    return { kind: "unjudged", reason: `${daemonLockPath(home)} is held but names no pid` };
  }
  const pid = hold.pid;
  if (fs.dryRunActive()) return { kind: "would-stop", pid };
  const verdict = await terminatePid(pid, DAEMON_SIGKILL_GRACE_MS, (candidate) =>
    Promise.resolve(daemonLockVerdict(home, candidate) === "alive" ? "yes" : "no"),
  );
  const deadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  return { kind: "stopped", pid, verdict, stillRunning: daemonLockVerdict(home, pid) === "alive" };
}
