import { formatDuration, localDayKey } from "../src/utils/time.ts";
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

test.skipIf(!TZ_PINNABLE)(
  "localDayKey formats the LOCAL calendar day and follows the TZ env",
  () => {
    // Deno's Date honors a runtime TZ change (verified; SQLite's `localtime`
    // does NOT, which is why the day key lives in JS -- see localDayKey).
    // TZ assignments are ignored after a `delete process.env.TZ` (verified), so
    // save/restore by explicit zone name and never delete.
    const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      process.env.TZ = "UTC";
      expect(localDayKey(Date.parse("2026-06-02T01:00:00Z"))).toBe("2026-06-02");
      process.env.TZ = "America/New_York"; // UTC-4 in June
      expect(localDayKey(Date.parse("2026-06-02T01:00:00Z"))).toBe("2026-06-01");
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(localDayKey(Date.parse("2026-06-02T11:00:00Z"))).toBe("2026-06-03");
      // Single-digit months/days are zero-padded.
      process.env.TZ = "UTC";
      expect(localDayKey(Date.parse("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    } finally {
      process.env.TZ = savedTz;
    }
  },
);
