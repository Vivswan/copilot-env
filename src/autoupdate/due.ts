// Pure scheduling helper for the autoupdate preflight (no I/O; `nowMs` injected so
// it's directly unit-testable). The command gate (a live `agent start` launch only,
// never a probe or a dry run) lives in src/commands/start.ts.
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";

/** A `lastCheckMs` in the future (corrupt state or a backward clock change) counts as due, so a
 *  bad timestamp cannot wedge autoupdate off indefinitely. */
export function isDue(lastCheckMs: number, nowMs: number): boolean {
  if (lastCheckMs > nowMs) return true;
  return nowMs - lastCheckMs >= MILLISECONDS_PER_DAY;
}
