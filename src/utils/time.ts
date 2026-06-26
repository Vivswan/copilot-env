// Shared time constants for cooldowns, cutoffs, and tests.

export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

/**
 * Format a millisecond duration as a compact, human string: "1h", "30m", "1m30s", "45s", "0s".
 * Negative inputs clamp to "0s"; zero components are omitted (3600000 -> "1h", not "1h0m0s").
 * Shared by `agent start` (idle-window banner) and `agent health` (idle watchdog report) --
 * whole-second granularity suits both, which surface minutes/hours, not sub-second precision.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total === 0) return "0s";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 ? `${seconds}s` : "",
  ].filter((p) => p !== "");
  return parts.join("");
}

/**
 * Block the current thread for `ms` (Atomics.wait on a throwaway SharedArrayBuffer).
 * Used by the synchronous retry/backoff paths (config rename retry, the Direct
 * probe retry) that can't await. A non-positive `ms` is a no-op.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Throw if `days` is set but not a non-negative whole number -- the shared post-parse guard
 * for the cooldown knobs: the config-driven `update-cooldown` (agent update) and the
 * `agent shell --clis --cooldown` flag. (cli.ts validates the raw flag string at
 * Commander-coercion time; this guards the already-parsed number.) `flag` names it in the message.
 */
export function assertNonNegativeDays(days: number | null, flag = "--cooldown"): void {
  if (days !== null && (!Number.isInteger(days) || days < 0)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${days}')`);
  }
}
