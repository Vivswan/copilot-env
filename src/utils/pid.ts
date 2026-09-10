// The ONE pid-liveness primitive. Both the daemon lifecycle (copilot_api/process.ts,
// which re-exports it) and the file-lock staleness judgment (utils/file_lock.ts) key
// off this decision, so they can never disagree about whether the same pid is alive.
// It lives in utils because file_lock cannot import copilot_api/process.ts (that
// would drag execa/ps-list into the lock's import graph).

/** What one null-signal probe proved about a pid. Three-state on purpose: a probe that
 *  could not run is NOT a death, and the consumers whose "dead" reading licenses a
 *  destructive act (a lock steal, a tracking clear, a sweep or kill decision) must
 *  never read it as one. */
export type PidLiveness = "alive" | "dead" | "unproven";

/**
 * Judge `pid` via a null signal. "Failed to look" is never "nobody there" (the same
 * posture as the scan verdicts in copilot_api/process.ts).
 */
export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH: the OS itself says no such process.
    if (code === "ESRCH") return "dead";
    // EPERM is answered only for a pid that EXISTS: this (restricted/sandboxed) token
    // can't signal it, e.g. Codex's packaged app spawning our probe.
    if (code === "EPERM") return "alive";
    // Could not judge at all: Deno's NotCapable (code: undefined) under a permission set
    // without --allow-run (the daemon's own), or any error this table does not recognize.
    return "unproven";
  }
}

/**
 * pidLiveness flattened to a boolean -- the house accepted-flatten, with the safe
 * direction built in: TRUE means NOT PROVABLY DEAD ("alive" or "unproven"), so an
 * unprovable look can never read as a death. That is the value of this wrapper over a
 * pass-through: every boolean consumer's false reading (a lock steal's stale judgment,
 * a died-in-grace verdict, a tracking clear, a sweep's died-since-scan filter, a health
 * display) licenses or reports a death, and a probe this permission set cannot run (the
 * daemon's own, without --allow-run) must never mint one.
 */
export function pidAlive(pid: number): boolean {
  return pidLiveness(pid) !== "dead";
}
