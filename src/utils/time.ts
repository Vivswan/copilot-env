export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

/** `ms -> "YYYY-MM-DD"`, bound to one timezone. */
export type DayKey = (ms: number) => string;

/** `ms` on the zone's wall clock. An unknown zone throws RangeError here. */
function wallClock(ms: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
}

/** Resolved per call, not once: the process zone follows `TZ`. */
function zoneOf(timeZone: string | undefined): string {
  return timeZone ?? Temporal.Now.timeZoneId();
}

/**
 * JS, never SQLite's `localtime`: the libc zone behind SQLite is cached at first use, while
 * Temporal honors `TZ`. Resolve once and pass the result down; resolved per row, an unknown zone
 * throws inside a reader's per-file catch and silently costs the report its per-day split.
 */
export function dayKeyIn(timeZone?: string): DayKey {
  if (timeZone !== undefined) wallClock(0, timeZone); // rejects an unknown zone now, not at the first row
  return (ms) => wallClock(ms, zoneOf(timeZone)).toPlainDate().toString();
}

export function localDayKey(ms: number, timeZone?: string): string {
  return dayKeyIn(timeZone)(ms);
}

/** The first instant of a calendar day, so a cutoff agrees with the per-day split dayKeyIn cuts in
 *  the same zone. A DST day is not 24 hours: the first of a repeated midnight, or where the clock
 *  landed when a change skipped it (Samoa's whole day, or a half-hour shift's 00:30). */
export function startOfLocalDay(ms: number, daysBack = 0, timeZone?: string): number {
  const zone = zoneOf(timeZone);
  return wallClock(ms, zone).toPlainDate().subtract({ days: daysBack }).toZonedDateTime(zone)
    .epochMilliseconds;
}

/** Once a day: the pacing of every background refresh (the autoupdate preflight, the Codex
 *  catalog, the discovery verdict). A `lastCheckMs` in the future (corrupt state or a backward
 *  clock change) counts as due, so a bad timestamp cannot wedge a refresh off indefinitely. */
export function isDue(lastCheckMs: number, nowMs: number): boolean {
  if (lastCheckMs > nowMs) return true;
  return nowMs - lastCheckMs >= MILLISECONDS_PER_DAY;
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

/** For retry loops inside synchronous callers, where an `await` is not available. */
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
