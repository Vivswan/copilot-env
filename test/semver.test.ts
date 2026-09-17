import { isUpToDate, stripV, versionLessThan } from "../src/utils/semver.ts";
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
