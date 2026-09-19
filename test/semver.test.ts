import { isUpToDate, pickAgedVersion, stripV, versionLessThan } from "../src/utils/semver.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { expect, test } from "./helpers/testing.ts";

test("versionLessThan orders numeric cores segment by segment, pads ragged lengths, ranks prereleases below and ignores build metadata", () => {
  const rows: Array<[string, string, boolean]> = [
    // numeric, not lexical
    ["1.10.13", "1.10.30", true],
    ["1.10.30", "1.10.13", false],
    ["1.2.9", "1.2.10", true],
    ["1.9.9", "1.10.0", true],
    ["2.0.0", "1.99.99", false],
    // equal cores are not less-than; ragged lengths pad with 0
    ["1.2.3", "1.2.3", false],
    ["1.2", "1.2.0", false],
    ["1.2.0", "1.2", false],
    ["1.2", "1.2.1", true],
    // a prerelease ranks below its plain release; build metadata is ignored
    ["1.2.3-rc.1", "1.2.3", true],
    ["1.2.3", "1.2.3-rc.1", false],
    ["1.2.3+build", "1.2.3", false],
    ["1.2.3", "1.2.3+build", false],
  ];
  for (const [a, b, less] of rows) {
    expect(versionLessThan(a, b), `${a} < ${b}`).toBe(less);
  }
});

test("stripV drops exactly one leading v and leaves everything else as it came", () => {
  // Release tags carry the v; the installed version and the CLI's own reports do not.
  const rows: Array<[string, string]> = [
    ["v1.2.3", "1.2.3"],
    ["1.2.3", "1.2.3"],
    ["vv1.2.3", "v1.2.3"],
    ["1.2.3-rc.1+build", "1.2.3-rc.1+build"],
    ["not a version", "not a version"],
    ["", ""],
  ];
  for (const [input, stripped] of rows) {
    expect(stripV(input), JSON.stringify(input)).toBe(stripped);
  }
});

test("isUpToDate: current >= target, with a leading v stripped from either side", () => {
  expect(isUpToDate("1.2.3", "1.2.3")).toBe(true);
  expect(isUpToDate("v1.2.3", "v1.2.3")).toBe(true);
  expect(isUpToDate("v1.2.4", "1.2.3")).toBe(true);
  expect(isUpToDate("1.2.2", "v1.2.3")).toBe(false);
});

const NOW = Date.parse("2026-06-05T00:00:00.000Z");
const iso = (daysAgo: number): string =>
  new Date(NOW - daysAgo * MILLISECONDS_PER_DAY).toISOString();
const days = (n: number): number => n * MILLISECONDS_PER_DAY;

// The shape of `npm view <pkg> time --json`: created/modified bookkeeping keys ride alongside the versions.
const TIME: Record<string, string> = {
  created: iso(800),
  modified: iso(1),
  "1.0.0": iso(800),
  "1.2.9": iso(30),
  "1.2.10": iso(20),
  "1.10.0": iso(10),
  "4.0.0-rc.1": iso(15),
};

test("pickAgedVersion picks the newest stable release published at or before the cutoff", () => {
  const rows: {
    name: string;
    time: Record<string, string>;
    minAgeMs: number;
    pick: string | null;
  }[] = [
    { name: "newest stable older than the cutoff", time: TIME, minAgeMs: days(7), pick: "1.10.0" },
    // The 15-day-old 4.0.0-rc.1 is newer and higher, and still never chosen.
    {
      name: "cooldown excludes fresh releases and prereleases",
      time: TIME,
      minAgeMs: days(14),
      pick: "1.2.10",
    },
    {
      name: "numeric patch order: 1.2.10 above 1.2.9",
      time: TIME,
      minAgeMs: days(25),
      pick: "1.2.9",
    },
    {
      name: "numeric minor order: 1.10.0 above 1.9.9",
      time: { "1.9.9": iso(40), "1.10.0": iso(40) },
      minAgeMs: days(7),
      pick: "1.10.0",
    },
    {
      name: "bookkeeping keys alone yield nothing",
      time: { created: iso(800), modified: iso(1) },
      minAgeMs: days(7),
      pick: null,
    },
    { name: "nothing old enough", time: TIME, minAgeMs: days(1000), pick: null },
    { name: "empty map", time: {}, minAgeMs: days(7), pick: null },
    {
      name: "published exactly at the cutoff counts",
      time: { "3.0.0": iso(7) },
      minAgeMs: days(7),
      pick: "3.0.0",
    },
    {
      name: "sub-day minimum age",
      time: { "3.0.0": iso(0.5), "3.0.1": iso(0.1) },
      minAgeMs: 12 * 60 * 60 * 1000,
      pick: "3.0.0",
    },
  ];
  for (const { name, time, minAgeMs, pick } of rows) {
    expect(pickAgedVersion(time, minAgeMs, NOW), name).toBe(pick);
  }
});
