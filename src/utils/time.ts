// Shared time constants for cooldowns, cutoffs, and tests.

export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

/** `ms -> "YYYY-MM-DD"`, bound to one timezone. */
export type DayKey = (ms: number) => string;

const pad = (n: number): string => String(n).padStart(2, "0");

/** The system zone's day key, on Date's own accessors: this is the hot path (one call per
 *  aggregated usage row) and the half that follows the process `TZ`. */
const SYSTEM_DAY_KEY: DayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** One bound day key per NAMED zone. A named zone's rules are fixed for the life of the
 *  process, so caching by name is safe -- which is why SYSTEM_DAY_KEY is not in here. */
const DAY_KEY_BY_ZONE = new Map<string, DayKey>();

/**
 * The day-key function for `timeZone` (an IANA name), or the system's own zone by default.
 * The one day-key derivation every usage source shares. Deliberately JS, never SQLite's
 * `localtime`: the libc zone behind SQLite is cached at first use, while `Date` honors `TZ`.
 *
 * Resolve ONCE and pass the result down; resolved per row, an unknown zone throws inside a
 * reader's per-file catch and silently costs the report its per-day split. Named zones go
 * through Intl and the default through `Date`; test/time.test.ts pins the two together.
 */
export function dayKeyIn(timeZone?: string): DayKey {
  if (timeZone === undefined) return SYSTEM_DAY_KEY;
  const cached = DAY_KEY_BY_ZONE.get(timeZone);
  if (cached !== undefined) return cached;
  // "en-US" pins a Gregorian, latin-digit calendar whatever the host locale is, and the parts
  // are read by NAME, so the locale's field ORDER cannot leak into the key. An unknown zone
  // throws RangeError right here, which is the whole point of resolving up front.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayKey: DayKey = (ms) => {
    const parts = formatter.formatToParts(new Date(ms));
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  DAY_KEY_BY_ZONE.set(timeZone, dayKey);
  return dayKey;
}

/** `ms` as a calendar day, `YYYY-MM-DD`, in `timeZone` or the system's own zone. The one-shot
 *  form of dayKeyIn, for a caller holding a single timestamp rather than a column of them. */
export function localDayKey(ms: number, timeZone?: string): string {
  return dayKeyIn(timeZone)(ms);
}

/**
 * The instant the SYSTEM zone's calendar day began, `daysBack` days before the day
 * holding `ms` (0 = that day's own midnight). Walks the calendar through Date's local
 * accessors, so a DST day is 23 or 25 hours long here, never 24: the cutoff is a real
 * local midnight, which is what makes a calendar-day window agree with the per-day
 * split SYSTEM_DAY_KEY cuts. System zone only, like the readers' default day key.
 */
export function startOfLocalDay(ms: number, daysBack = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

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
