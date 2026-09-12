// The one way the daemon stops itself, so neither the idle watchdog nor the SIGTERM `agent stop`
// sends can skip the drain.
//   the server handle      -> from the Deno.serve wrap in inference_activity.ts, the only place in
//                             the process that sees it
//   importing this module  -> installs nothing; daemon_runtime_preload.ts arms the handler

/** Structural on purpose: the handle is recorded by shape rather than by matching Deno's full
 *  HttpServer type. */
export interface DrainableServer {
  shutdown(): Promise<void>;
}

/** A SIGTERM listener replaces deno's default terminate-on-signal, so without a deadline a wedged
 *  drain would leave `agent stop` (one SIGTERM, no SIGKILL) unable to stop the daemon. Every
 *  escalating teardown (start --force, uninstall, de-auth, profile --del) SIGKILLs after a 2000ms
 *  grace, so this must sit under that. */
export const DRAIN_DEADLINE_MS = 1_500;

let daemonServer: DrainableServer | null = null;

// The in-flight shutdown IS the "already shutting down" state: a second SIGTERM, or the watchdog
// tripping mid-drain, joins this promise instead of starting a rival drain.
let shuttingDown: Promise<void> | null = null;

/** The most recent server wins; the daemon opens only one. The shape check is there because the
 *  serve wrap passes through whatever the runtime returned. */
export function recordDaemonServer(candidate: unknown): void {
  if (
    typeof candidate === "object" && candidate !== null &&
    typeof (candidate as DrainableServer).shutdown === "function"
  ) {
    daemonServer = candidate as DrainableServer;
  }
}

export function resetDaemonShutdownForTests(): void {
  daemonServer = null;
  shuttingDown = null;
}

/** The timer is cleared on the fast path so it can never hold the process open past the drain. */
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

/** Never resolves: the process is gone by then. */
export function shutdownDaemon(code = 0): Promise<void> {
  if (shuttingDown !== null) return shuttingDown;
  const server = daemonServer;
  if (server === null) Deno.exit(code);
  shuttingDown = withDeadline(Promise.resolve(server.shutdown()), DRAIN_DEADLINE_MS).then(() =>
    Deno.exit(code)
  );
  return shuttingDown;
}

/** POSIX only: on Windows node's `process.kill(pid, "SIGTERM")` is TerminateProcess, which no
 *  in-process handler can intercept, and deno's signal listeners there accept only SIGINT/SIGBREAK.
 *  The Windows daemon keeps the hard kill; SQLite WAL recovery is what makes that safe. */
export function installTerminationHandler(): void {
  if (Deno.build.os === "windows") return;
  Deno.addSignalListener("SIGTERM", () => {
    void shutdownDaemon(0);
  });
}
