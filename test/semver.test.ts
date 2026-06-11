import { expect, test } from "bun:test";

import { isUpToDate, stripV, versionLessThan } from "../src/utils/semver.ts";

// Lock the ordering contract before more callers route through versionLessThan
// (e.g. aged_version). These cases pin numeric-core ordering, the prerelease rule,
// build-metadata stripping, and ragged-length comparison.

test("versionLessThan compares numeric cores segment by segment (not lexically)", () => {
  expect(versionLessThan("1.10.13", "1.10.30")).toBe(true);
  expect(versionLessThan("1.10.30", "1.10.13")).toBe(false);
  expect(versionLessThan("1.2.9", "1.2.10")).toBe(true); // numeric, not string
  expect(versionLessThan("1.9.9", "1.10.0")).toBe(true);
  expect(versionLessThan("2.0.0", "1.99.99")).toBe(false);
});

test("versionLessThan: equal cores are not less-than; ragged lengths pad with 0", () => {
  expect(versionLessThan("1.2.3", "1.2.3")).toBe(false);
  expect(versionLessThan("1.2", "1.2.0")).toBe(false);
  expect(versionLessThan("1.2.0", "1.2")).toBe(false);
  expect(versionLessThan("1.2", "1.2.1")).toBe(true);
});

test("versionLessThan: a prerelease ranks below its plain release; build metadata is ignored", () => {
  expect(versionLessThan("1.2.3-rc.1", "1.2.3")).toBe(true);
  expect(versionLessThan("1.2.3", "1.2.3-rc.1")).toBe(false);
  expect(versionLessThan("1.2.3+build", "1.2.3")).toBe(false); // build meta stripped
  expect(versionLessThan("1.2.3", "1.2.3+build")).toBe(false);
});

test("stripV drops only a leading v", () => {
  expect(stripV("v1.2.3")).toBe("1.2.3");
  expect(stripV("1.2.3")).toBe("1.2.3");
});

test("isUpToDate: current >= target (tolerates leading v)", () => {
  expect(isUpToDate("1.2.3", "1.2.3")).toBe(true);
  expect(isUpToDate("v1.2.4", "1.2.3")).toBe(true);
  expect(isUpToDate("1.2.2", "v1.2.3")).toBe(false);
});
