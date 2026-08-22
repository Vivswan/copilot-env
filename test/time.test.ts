import { dayKeyIn, formatDuration, localDayKey } from "../src/utils/time.ts";
import { expect, test, TZ_PINNABLE } from "./helpers/testing.ts";
test("formatDuration renders compact durations and omits zero components", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(-5000)).toBe("0s"); // negatives clamp
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(90_000)).toBe("1m30s");
  expect(formatDuration(3_600_000)).toBe("1h");
  expect(formatDuration(3_660_000)).toBe("1h1m");
  expect(formatDuration(5_430_000)).toBe("1h30m30s");
  expect(formatDuration(499)).toBe("0s"); // rounds to whole seconds
  expect(formatDuration(1_500)).toBe("2s"); // round-half-up
});

test("localDayKey slices the calendar day in the zone it is NAMED, on every platform", () => {
  const at = (iso: string): number => Date.parse(iso);
  // The same instant lands on three different calendar days depending on the zone --
  // this is the slicing every usage source buckets by.
  expect(localDayKey(at("2026-06-02T01:00:00Z"), "UTC")).toBe("2026-06-02");
  expect(localDayKey(at("2026-06-02T01:00:00Z"), "America/New_York")).toBe("2026-06-01"); // UTC-4
  expect(localDayKey(at("2026-06-02T11:00:00Z"), "Pacific/Kiritimati")).toBe("2026-06-03"); // UTC+14
  // Single-digit months/days are zero-padded, and a half-hour zone still resolves a day.
  expect(localDayKey(at("2026-01-05T00:00:00Z"), "UTC")).toBe("2026-01-05");
  expect(localDayKey(at("2026-01-04T19:00:00Z"), "Asia/Kolkata")).toBe("2026-01-05"); // UTC+5:30
});

test("the named-zone path agrees with the default path for the system's own zone", () => {
  // localDayKey has two halves: Date's accessors for the default (the hot path, and the
  // one that follows the process TZ) and an Intl formatter for a named zone. If they
  // could disagree, every named-zone assertion above would be pinning something the
  // production default never does. Whatever zone this machine runs in, they must match.
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (
    const iso of [
      "2026-06-02T01:00:00Z",
      "2026-01-05T00:00:00Z",
      "2026-12-31T23:59:59Z",
      "2026-03-08T09:30:00Z", // inside the US DST spring-forward window
      "2026-11-01T05:30:00Z", // inside the US DST fall-back repeated hour
    ]
  ) {
    const ms = Date.parse(iso);
    expect(localDayKey(ms, systemZone)).toBe(localDayKey(ms));
  }
});

test("dayKeyIn rejects an unknown zone up front, before any row is bucketed", () => {
  // The failure mode this prevents: resolved lazily, a bad zone raises RangeError once per
  // ROW, inside each reader's per-file catch -- which would log "could not read <file>" and
  // hand back a report whose per-day split had silently vanished.
  expect(() => dayKeyIn("Not/AZone")).toThrow();
  expect(() => dayKeyIn("")).toThrow();
  // A resolved zone is reusable and stable (the per-zone memo hands back one function).
  expect(dayKeyIn("UTC")).toBe(dayKeyIn("UTC"));
  expect(dayKeyIn()).toBe(dayKeyIn(undefined));
});

test.skipIf(!TZ_PINNABLE)(
  "the DEFAULT zone honors the process TZ (the reason the day math is JS, not SQLite)",
  () => {
    // The ONE test that genuinely needs a process-level TZ, and so the only reason
    // TZ_PINNABLE still exists: it pins the property that justifies deriving the day key
    // in JS instead of with SQLite's `localtime` (whose libc zone is cached at first use).
    // Day SLICING itself is covered by the named-zone test above, on every platform.
    // TZ assignments are ignored after a `delete process.env.TZ` (verified), so
    // save/restore by explicit zone name and never delete.
    const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      process.env.TZ = "UTC";
      expect(localDayKey(Date.parse("2026-06-02T01:00:00Z"))).toBe("2026-06-02");
      process.env.TZ = "America/New_York";
      expect(localDayKey(Date.parse("2026-06-02T01:00:00Z"))).toBe("2026-06-01");
    } finally {
      process.env.TZ = savedTz;
    }
  },
);
