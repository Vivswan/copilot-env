// The copilot-api daemon's ONE shutdown path, shared by the two things that stop it from
// the inside: the idle auto-stop watchdog (idle_watchdog.ts) and the SIGTERM that `agent
// stop` sends. Both drain the running server first, so an in-flight inference response is
// not cut off mid-stream, and both then exit the process -- there is no other way for the
// daemon to stop itself, so the drain can't be skipped by one caller and not the other.
//
// The server handle comes from the Deno.serve wrap in inference_activity.ts, which is the
// only place in the process that ever sees it (the daemon serves through srvx, which calls
// Deno.serve at serve time). With no handle recorded -- the proxy died before it served --
// shutdown is a plain exit.
//
// This module is import-safe: loading it installs nothing. daemon_runtime_preload.ts is the
// `--preload` entry that arms the signal handler.

/** The slice of Deno's HttpServer this path uses. Structural, so the handle is recorded by
 *  shape rather than by importing (and having to match) the full server type. */
export interface DrainableServer {
  shutdown(): Promise<void>;
}

/** How long the drain may run before we exit regardless. A SIGTERM listener REPLACES
 *  deno's default terminate-on-signal, so without a deadline a wedged drain would make
 *  `agent stop` (a single SIGTERM, no SIGKILL escalation) unable to stop the daemon.
 *  Every escalating teardown in the tree (start --force, uninstall, de-auth,
 *  profile --del) SIGKILLs after a 2000ms grace, so the deadline must sit under
 *  that or those paths sever the drain mid-flight. */
export const DRAIN_DEADLINE_MS = 1_500;

let daemonServer: DrainableServer | null = null;

// The in-flight shutdown IS the "already shutting down" state -- a second SIGTERM, or the
// watchdog tripping mid-drain, joins this promise instead of starting a rival drain.
let shuttingDown: Promise<void> | null = null;

/** Record the daemon's server so the shutdown path can drain it. Called by the serve
 *  wrap for every server the process opens; the most recent one wins, which for the
 *  daemon is its only one. A value without a `shutdown` method is ignored -- the wrap
 *  passes through whatever the runtime returned, and observation must never assume. */
export function recordDaemonServer(candidate: unknown): void {
  if (
    typeof candidate === "object" && candidate !== null &&
    typeof (candidate as DrainableServer).shutdown === "function"
  ) {
    daemonServer = candidate as DrainableServer;
  }
}

/** Forget the recorded server and any in-flight drain. Test-only: the daemon never
 *  un-serves, and its one shutdown ends the process. */
export function resetDaemonShutdownForTests(): void {
  daemonServer = null;
  shuttingDown = null;
}

/** Resolves when `promise` settles or `ms` elapses, whichever comes first. The timer is
 *  cleared on the fast path so it can never hold the process open past the drain. */
function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const settled = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(settled, settled);
  });
}

/** Drain the daemon's server (bounded by DRAIN_DEADLINE_MS) and exit with `code`.
 *  Never resolves: the process is gone by then. With nothing to drain -- the proxy died
 *  before it served -- the exit is immediate and synchronous. */
export function shutdownDaemon(code = 0): Promise<void> {
  if (shuttingDown !== null) return shuttingDown;
  const server = daemonServer;
  if (server === null) Deno.exit(code);
  shuttingDown = withDeadline(Promise.resolve(server.shutdown()), DRAIN_DEADLINE_MS).then(() =>
    Deno.exit(code)
  );
  return shuttingDown;
}

/**
 * Route SIGTERM through the shared shutdown path so `agent stop` drains rather than
 * severs. POSIX only, and not for lack of trying: Windows has no SIGTERM to deliver --
 * node's `process.kill(pid, "SIGTERM")` there is TerminateProcess, which no in-process
 * handler can intercept, and deno's own signal listeners accept only SIGINT/SIGBREAK.
 * The Windows daemon therefore keeps the hard-kill teardown it has always had (SQLite WAL
 * recovery is what makes that safe).
 */
export function installTerminationHandler(): void {
  if (Deno.build.os === "windows") return;
  Deno.addSignalListener("SIGTERM", () => {
    void shutdownDaemon(0);
  });
}
