export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

/** `ms -> "YYYY-MM-DD"`, bound to one timezone. */
export type DayKey = (ms: number) => string;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Date's own accessors: this is the hot path (one call per aggregated usage row) and the half that
 *  follows the process `TZ`. */
const SYSTEM_DAY_KEY: DayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A named zone's rules are fixed for the life of the process, so caching by name is safe; the
 *  system zone follows `TZ`, which is why SYSTEM_DAY_KEY is not in here. */
const DAY_KEY_BY_ZONE = new Map<string, DayKey>();

/**
 * JS, never SQLite's `localtime`: the libc zone behind SQLite is cached at first use, while `Date`
 * honors `TZ`. Resolve once and pass the result down; resolved per row, an unknown zone throws
 * inside a reader's per-file catch and silently costs the report its per-day split.
 * test/time.test.ts pins the Intl and Date halves together.
 */
export function dayKeyIn(timeZone?: string): DayKey {
  if (timeZone === undefined) return SYSTEM_DAY_KEY;
  const cached = DAY_KEY_BY_ZONE.get(timeZone);
  if (cached !== undefined) return cached;
  // "en-US" pins a Gregorian, latin-digit calendar whatever the host locale, and the parts are read
  // by name so field order cannot leak into the key. An unknown zone throws RangeError right here,
  // up front.
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

export function localDayKey(ms: number, timeZone?: string): string {
  return dayKeyIn(timeZone)(ms);
}

/** Walks the calendar through Date's local accessors, so a DST day is not 24 hours here (a 30
 *  minute shift makes it 23.5 or 24.5): the cutoff is a real local midnight and agrees with the
 *  per-day split SYSTEM_DAY_KEY cuts. */
export function startOfLocalDay(ms: number, daysBack = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

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

/** For the synchronous retry loops (lock acquisition, the config store's load, a refused rename,
 *  the Direct probe) that cannot await. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The post-parse guard for the cooldown knobs; cli.ts validates the raw flag string at Commander
 *  coercion. */
export function assertNonNegativeDays(days: number | null, flag = "--cooldown"): void {
  if (days !== null && (!Number.isInteger(days) || days < 0)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${days}')`);
  }
}
