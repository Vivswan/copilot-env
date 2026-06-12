// Pure scheduling helper for the autoupdate preflight (no I/O; `nowMs` injected so
// it's directly unit-testable).
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";

/** The only subcommand that triggers an autoupdate check. */
export const PREFLIGHT_COMMAND = "start";

/**
 * True when at least one day has elapsed since the last completed check. A
 * `lastCheckMs` in the future (corrupt state or a backward clock change) counts
 * as due, so a bad timestamp can't wedge autoupdate off indefinitely.
 */
export function isDue(lastCheckMs: number, nowMs: number): boolean {
  if (lastCheckMs > nowMs) return true;
  return nowMs - lastCheckMs >= MILLISECONDS_PER_DAY;
}

/**
 * True when the preflight should run for this first arg. Autoupdate is limited to
 * `agent start` -- a deliberate, less-frequent action -- so day-to-day commands
 * (env/health/cost/...) never trigger a self-update, and `agent env` (whose stdout
 * the shell wrapper evals) is never in scope.
 */
export function shouldRunPreflight(arg0: string | undefined): boolean {
  return arg0 === PREFLIGHT_COMMAND;
}
