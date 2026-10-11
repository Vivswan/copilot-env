// The one way the daemon stops itself, so neither the idle watchdog nor the SIGTERM `agent stop`
// sends can skip the drain.
//   the server handle      -> from the Bun.serve wrap in inference_activity.ts, the only place in
//                             the process that sees it
//   importing this module  -> installs nothing; daemon_runtime_preload.ts arms the handler
import { deadline } from "@std/async";

/** Structural on purpose: the handle is recorded by shape rather than by matching Bun's full
 *  Server type. `stop()` without the force flag stops listening and resolves once the in-flight
 *  requests have finished. */
interface DrainableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** A SIGTERM listener replaces the runtime's default terminate-on-signal, so without a deadline a
 *  wedged drain would leave `agent stop` (one SIGTERM, no SIGKILL) unable to stop the daemon. Every
 *  escalating teardown (start --force, uninstall, de-auth, profile <name> del) SIGKILLs after a 2000ms
 *  grace, so this must sit under that. */
export const DRAIN_DEADLINE_MS = 1_500;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type Signal = (typeof SIGNALS)[number];
type SignalListener = (signal: string) => void;

let daemonServer: DrainableServer | null = null;

// The in-flight shutdown IS the "already shutting down" state: a second SIGTERM, or the watchdog
// tripping mid-drain, joins this promise instead of starting a rival drain.
let shuttingDown: Promise<void> | null = null;

/** Listeners for the two signals registered after installTerminationHandler, held back until the
 *  drain is over: copilot-api's own `process.once("SIGTERM", ...)` exits as soon as its cleanups
 *  settle, which in the same emit as our listener would sever the responses the drain protects. */
const deferredListeners: Array<{ signal: Signal; listener: SignalListener }> = [];

/** The most recent server wins; the daemon opens only one. The shape check is there because the
 *  serve wrap passes through whatever the runtime returned. */
export function recordDaemonServer(candidate: unknown): void {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as DrainableServer).stop === "function"
  ) {
    daemonServer = candidate as DrainableServer;
  }
}

export function resetDaemonShutdownForTests(): void {
  daemonServer = null;
  shuttingDown = null;
  deferredListeners.length = 0;
}

/** The held-back listeners run in registration order with the exit after them: one that exits
 *  itself (copilot-api's) ends the process with its cleanups done, and the exit's own hooks run
 *  whichever way. */
function exitAfterDeferredListeners(code: number): never {
  for (const { signal, listener } of deferredListeners.splice(0)) {
    try {
      listener(signal);
    } catch {
      // a failing late listener must not keep the daemon alive
    }
  }
  process.exit(code);
}

/** Never resolves: the process is gone by then. */
export function shutdownDaemon(code = 0): Promise<void> {
  if (shuttingDown !== null) return shuttingDown;
  const server = daemonServer;
  const drained =
    server === null
      ? Promise.resolve()
      : deadline(
          Promise.resolve().then(() => server.stop()),
          DRAIN_DEADLINE_MS,
        );
  const exit = (): never => exitAfterDeferredListeners(code);
  shuttingDown = drained.then(exit, exit);
  return shuttingDown;
}

const REGISTRARS = ["on", "once", "addListener", "prependListener", "prependOnceListener"] as const;

/** POSIX only: on Windows node's `process.kill(pid, "SIGTERM")` is TerminateProcess, which no
 *  in-process handler can intercept. The Windows daemon keeps the hard kill; SQLite WAL recovery is
 *  what makes that safe. SIGINT is the foreground run's Ctrl-C, drained the same way. */
export function installTerminationHandler(): void {
  if (process.platform === "win32") return;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      void shutdownDaemon(0);
    });
  }
  // From here on, every registration for these two signals is deferred past the drain; anything
  // else reaches the runtime untouched.
  for (const method of REGISTRARS) {
    const register = process[method].bind(process) as (
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => typeof process;
    const deferring = (event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (typeof event === "string" && (SIGNALS as readonly string[]).includes(event)) {
        deferredListeners.push({ signal: event as Signal, listener });
        return process;
      }
      return register(event, listener);
    };
    process[method] = deferring as unknown as typeof process.on;
  }
}
