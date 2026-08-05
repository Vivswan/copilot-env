// Pure scheduling helper for the autoupdate preflight (no I/O; `nowMs` injected so
// it's directly unit-testable). The subcommand gate ("only on `agent start`") lives
// in the launchers themselves -- bin/agent and bin/agent.ps1 -- which run the
// preflight before cli.ts loads; test/autoupdate.test.ts pins those lines.
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";

/**
 * True when at least one day has elapsed since the last completed check. A
 * `lastCheckMs` in the future (corrupt state or a backward clock change) counts
 * as due, so a bad timestamp can't wedge autoupdate off indefinitely.
 */
export function isDue(lastCheckMs: number, nowMs: number): boolean {
  if (lastCheckMs > nowMs) return true;
  return nowMs - lastCheckMs >= MILLISECONDS_PER_DAY;
}
