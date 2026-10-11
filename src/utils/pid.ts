// The one pid-liveness judgment, so no two consumers (copilot_api/process.ts, the health probes,
// the file lock) can disagree about a pid. It lives in utils because the daemon shims' import
// closure must not pull in copilot_api/process.ts, which reaches the daemon spawn and proxy-float
// graph.

/** Three states on purpose: a probe that could not run is not a death, and every consumer whose
 *  "dead" licenses a destructive act (a tracking clear, a kill, a lock takeover) must never read
 *  it as one. */
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
    // Anything else is a probe that did not run: the daemon's Deno sidecar refuses the null
    // signal under its permission set (NotCapable, code undefined).
    return "unproven";
  }
}

/** True means NOT provably dead: every boolean consumer's false licenses or reports a death, and a
 *  probe this permission set cannot run (the daemon's own, without --allow-run) must never mint
 *  one. */
export function pidAlive(pid: number): boolean {
  return pidLiveness(pid) !== "dead";
}
