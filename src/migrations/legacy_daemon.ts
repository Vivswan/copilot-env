// The daemon a home's daemon.lock names, stopped by the lock and the pid's command line. The
// migrations that move or retire a previous release's daemon cannot ask the process classifier
// whether it is ours: that daemon ran under deno, which this release's classifier reads as foreign.
// The marker in OUR home is the claim, and the command line is what keeps a reboot's reused pid
// (the marker outlives the daemon) from being signalled. Sweeping the marker a dead holder left
// stays with the caller (clearDeadDaemonLock).
import { daemonLockHold, daemonLockPath, daemonLockVerdict } from "../copilot_api/daemon_lock.ts";
import {
  DAEMON_SIGKILL_GRACE_MS,
  lookupCommandLine,
  type TerminateVerdict,
  terminatePid,
} from "../copilot_api/process.ts";
import * as fs from "../utils/fs_facade.ts";
import { killCommand } from "../utils/kill_command.ts";
import { pidAlive } from "../utils/pid.ts";
import { sleepSync } from "../utils/time.ts";

export type LockedDaemonOutcome =
  /** The lock is free (absent, or a marker a dead holder left). */
  | { kind: "none" }
  /** A dry run: the holder it would signal. */
  | { kind: "would-stop"; pid: number }
  /** Signalled and waited for; `stillRunning` when the lock still names the pid alive after the grace. */
  | { kind: "stopped"; pid: number; verdict: TerminateVerdict; stillRunning: boolean }
  /** A live holder whose command line is not the deno daemon's: a reused pid, never signalled. */
  | { kind: "foreign"; pid: number; command: string }
  /** Fail closed: a lock this process cannot read, or one held without a pid, is never "nobody". */
  | { kind: "unjudged"; reason: string };

/** The deno-era spawn: `<...>/deno run ... <...>copilot-api<...> start ...`, by its two names. */
function isDenoDaemonCommand(command: string): boolean {
  return /\bdeno\b/.test(command) && command.includes("copilot-api");
}

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

  const look = await lookupCommandLine(pid);
  if (look.kind === "unproven") {
    return { kind: "unjudged", reason: `the process table cannot be read to judge pid ${pid}` };
  }
  if (look.kind === "absent") {
    return { kind: "unjudged", reason: `pid ${pid} is alive but not in this user's process table` };
  }
  if (!isDenoDaemonCommand(look.command)) return { kind: "foreign", pid, command: look.command };

  if (fs.dryRunActive()) return { kind: "would-stop", pid };
  const verdict = await terminatePid(pid, DAEMON_SIGKILL_GRACE_MS, (candidate) =>
    Promise.resolve(daemonLockVerdict(home, candidate) === "alive" ? "yes" : "no"),
  );
  const deadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  return { kind: "stopped", pid, verdict, stillRunning: daemonLockVerdict(home, pid) === "alive" };
}

/** The warning for a `foreign` outcome: the holder is named with what it runs, and the two ways out
 *  with the host's own kill. The lock stays: a re-run sweeps it once the pid is free. */
export function foreignHolderWarning(
  home: string,
  outcome: { pid: number; command: string },
): string {
  return [
    `  ${daemonLockPath(home)} names pid ${outcome.pid}, which is not the previous release's proxy daemon (a reboot reused the pid); left as it is`,
    `    pid ${outcome.pid} runs: ${outcome.command}`,
    `    yours and stale: ${killCommand(outcome.pid)}, then re-run the migration`,
    "    not yours: nothing to do; the lock is swept once the pid is free",
  ].join("\n");
}
