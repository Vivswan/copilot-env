export const SECONDS_PER_DAY = 24 * 60 * 60;
export const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/** `ms -> "YYYY-MM-DD"`, bound to one timezone. */
export type DayKey = (ms: number) => string;

const pad = (n: number): string => String(n).padStart(2, "0");

/** The two day computations in one zone: the key a usage row is bucketed under and the midnight
 *  a calendar window starts at. They share one zone so the cutoff can never fall mid-bucket. */
interface ZoneClock {
  dayKey: DayKey;
  /** The first instant of the calendar day `daysBack` days before the one holding `ms`. */
  startOfDay: (ms: number, daysBack: number) => number;
}

/** Date's own accessors: this is the hot path (one call per aggregated usage row) and the half that
 *  follows the process `TZ`. A DST day is not 24 hours here (a 30 minute shift makes it 23.5 or
 *  24.5): the cutoff is a real local midnight. */
const SYSTEM_CLOCK: ZoneClock = {
  dayKey: (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  startOfDay: (ms, daysBack) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
  },
};

/** A named zone's rules are fixed for the life of the process, so caching by name is safe; the
 *  system zone follows `TZ`, which is why SYSTEM_CLOCK is not in here. */
const CLOCK_BY_ZONE = new Map<string, ZoneClock>();

const WALL_CLOCK_FIELDS = ["year", "month", "day", "hour", "minute", "second"] as const;
type WallClock = Record<typeof WALL_CLOCK_FIELDS[number], number>;

/** One Intl formatter per zone, read by named part so field order cannot leak into the key. */
function intlClock(timeZone: string): ZoneClock {
  // "en-US" pins a Gregorian, latin-digit calendar whatever the host locale; h23 keeps midnight
  // "00", never "24". An unknown zone throws RangeError right here, up front.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallClock = (ms: number): WallClock => {
    const parts = formatter.formatToParts(new Date(ms));
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((p) => p.type === type)?.value);
    return Object.fromEntries(WALL_CLOCK_FIELDS.map((f) => [f, read(f)])) as WallClock;
  };
  /** The zone's wall-clock reading of `ms`, as the UTC instant with the same digits. */
  const wallUtc = (ms: number): number => {
    const w = wallClock(ms);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  };
  /** To the second the formatter resolves. */
  const offsetAt = (ms: number): number => wallUtc(ms) - Math.floor(ms / 1000) * 1000;
  const dayKey: DayKey = (ms) => {
    const w = wallClock(ms);
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  };
  return {
    dayKey,
    startOfDay: (ms, daysBack) => {
      const w = wallClock(ms);
      const midnight = Date.UTC(w.year, w.month - 1, w.day - daysBack);
      // Each offset in force within a day of the target midnight places it at one instant, and
      // Date takes the earliest that reads at or past it: the first of a repeated midnight, or
      // where the clock landed when a change skipped it (an hour, or Samoa's whole day). No zone
      // holds an offset for under an hour, so hourly samples see every offset.
      const offsets = new Set<number>();
      for (let t = -MILLISECONDS_PER_DAY; t <= MILLISECONDS_PER_DAY; t += MILLISECONDS_PER_HOUR) {
        offsets.add(offsetAt(midnight + t));
      }
      const readings = [...offsets]
        .map((offset) => midnight - offset)
        .filter((instant) => wallUtc(instant) >= midnight);
      return Math.min(...readings);
    },
  };
}

function clockIn(timeZone?: string): ZoneClock {
  if (timeZone === undefined) return SYSTEM_CLOCK;
  const cached = CLOCK_BY_ZONE.get(timeZone);
  if (cached !== undefined) return cached;
  const clock = intlClock(timeZone);
  CLOCK_BY_ZONE.set(timeZone, clock);
  return clock;
}

/**
 * JS, never SQLite's `localtime`: the libc zone behind SQLite is cached at first use, while `Date`
 * honors `TZ`. Resolve once and pass the result down; resolved per row, an unknown zone throws
 * inside a reader's per-file catch and silently costs the report its per-day split.
 * test/time.test.ts pins the Intl and Date halves together.
 */
export function dayKeyIn(timeZone?: string): DayKey {
  return clockIn(timeZone).dayKey;
}

export function localDayKey(ms: number, timeZone?: string): string {
  return dayKeyIn(timeZone)(ms);
}

/** Local midnight `daysBack` days before the day holding `ms`, in the named zone or the process
 *  zone, so a calendar cutoff agrees with the per-day split dayKeyIn cuts in the same zone. */
export function startOfLocalDay(ms: number, daysBack = 0, timeZone?: string): number {
  return clockIn(timeZone).startOfDay(ms, daysBack);
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
