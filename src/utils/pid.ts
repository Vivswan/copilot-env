// The one pid-liveness judgment: copilot_api/process.ts and utils/file_lock.ts both key off it, so
// they can never disagree about a pid. It lives in utils because file_lock must not import
// copilot_api/process.ts, which pulls in the daemon spawn and proxy-float graph.

/** Three states on purpose: a probe that could not run is not a death, and every consumer whose
 *  "dead" licenses a destructive act (a lock steal, a tracking clear, a kill) must never read it as
 *  one. */
export type PidLiveness = "alive" | "dead" | "unproven";

export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM is answered only for a pid that exists: a sandboxed token (Codex's packaged app
    // spawning us) cannot signal it.
    if (code === "EPERM") return "alive";
    // Deno's NotCapable (code undefined) under a permission set without --allow-run, the daemon's
    // own.
    return "unproven";
  }
}

/** True means NOT provably dead: every boolean consumer's false licenses or reports a death, and a
 *  probe this permission set cannot run (the daemon's own, without --allow-run) must never mint
 *  one. */
export function pidAlive(pid: number): boolean {
  return pidLiveness(pid) !== "dead";
}
