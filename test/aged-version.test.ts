import { describe, expect, test } from "bun:test";

import { pickAgedVersion } from "../src/utils/aged_version.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";

// --- pure-function units: `now` is injected, so these are clock-independent ---
const NOW = Date.parse("2026-06-05T00:00:00.000Z");
const iso = (daysAgo: number): string =>
  new Date(NOW - daysAgo * MILLISECONDS_PER_DAY).toISOString();

// A realistic `npm view <pkg> time --json` payload: the created/modified
// bookkeeping keys plus stable releases at various ages and one prerelease.
const TIME: Record<string, string> = {
  created: iso(800),
  modified: iso(1),
  "1.0.0": iso(800),
  "1.2.9": iso(30),
  "1.2.10": iso(20),
  "1.10.0": iso(10),
  "4.0.0-rc.1": iso(15),
};

describe("pickAgedVersion", () => {
  test("picks the newest stable release older than the cutoff", () => {
    expect(pickAgedVersion(TIME, 7 * MILLISECONDS_PER_DAY, NOW)).toBe("1.10.0");
  });

  test("excludes releases still inside the cooldown window", () => {
    // 1.10.0 is only 10d old; at 14d the newest qualifying release is 1.2.10 (20d).
    expect(pickAgedVersion(TIME, 14 * MILLISECONDS_PER_DAY, NOW)).toBe("1.2.10");
  });

  test("orders by numeric semver, not lexically (1.2.10 > 1.2.9)", () => {
    // At 25d, 1.2.10 (20d) is too new, so it falls back to 1.2.9 (30d).
    expect(pickAgedVersion(TIME, 25 * MILLISECONDS_PER_DAY, NOW)).toBe("1.2.9");
  });

  test("treats 1.10.0 as newer than 1.9.9 (numeric minor, not string)", () => {
    expect(
      pickAgedVersion({ "1.9.9": iso(40), "1.10.0": iso(40) }, 7 * MILLISECONDS_PER_DAY, NOW),
    ).toBe("1.10.0");
  });

  test("never selects a prerelease, even when it is newest and highest", () => {
    // 4.0.0-rc.1 (15d) is numerically the highest but must be skipped.
    expect(pickAgedVersion(TIME, 14 * MILLISECONDS_PER_DAY, NOW)).not.toBe("4.0.0-rc.1");
  });

  test("ignores the created/modified bookkeeping keys", () => {
    expect(
      pickAgedVersion({ created: iso(800), modified: iso(1) }, 7 * MILLISECONDS_PER_DAY, NOW),
    ).toBeNull();
  });

  test("returns null when no release is old enough", () => {
    expect(pickAgedVersion(TIME, 1000 * MILLISECONDS_PER_DAY, NOW)).toBeNull();
  });

  test("returns null for an empty map", () => {
    expect(pickAgedVersion({}, 7 * MILLISECONDS_PER_DAY, NOW)).toBeNull();
  });

  test("counts a release published exactly at the cutoff as old enough", () => {
    expect(pickAgedVersion({ "3.0.0": iso(7) }, 7 * MILLISECONDS_PER_DAY, NOW)).toBe("3.0.0");
  });

  test("supports sub-day minimum ages for bunfig-style cooldowns", () => {
    expect(
      pickAgedVersion({ "3.0.0": iso(0.5), "3.0.1": iso(0.1) }, 12 * 60 * 60 * 1000, NOW),
    ).toBe("3.0.0");
  });
});
