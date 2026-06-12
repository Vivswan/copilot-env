// Shared time constants for cooldowns, cutoffs, and tests.

export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

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
 * Throw if `days` is set but not a non-negative whole number — the shared
 * post-coercion `--cooldown` guard for `agent update` and `agent shell --clis`.
 * (cli.ts validates the raw string at Commander-coercion time; this guards the
 * already-parsed number.) `flag` names the option in the message.
 */
export function assertNonNegativeDays(days: number | null, flag = "--cooldown"): void {
  if (days !== null && (!Number.isInteger(days) || days < 0)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${days}')`);
  }
}
