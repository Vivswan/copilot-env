// The one pid-liveness judgment, so no two consumers (copilot_api/process.ts, the health probes,
// the file lock) can disagree about a pid. It lives in utils because the daemon shims' import
// closure must not pull in copilot_api/process.ts, which reaches the daemon spawn and proxy-float
// graph.

/** Only ESRCH is a death. A refused signal is an existing pid (EPERM: a sandboxed token, such as
 *  Codex's packaged app spawning us, cannot signal it), and a probe that could not run at all
 *  proves nothing, so every consumer whose "dead" licenses a destructive act (a tracking clear, a
 *  kill, a lock takeover) reads both as alive. */
export type PidLiveness = "alive" | "dead";

export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}

/** True means NOT provably dead. */
export function pidAlive(pid: number): boolean {
  return pidLiveness(pid) !== "dead";
}
