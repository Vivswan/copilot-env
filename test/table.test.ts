import { formatTable } from "../src/utils/table.ts";
import { expect, test } from "./helpers/testing.ts";

test("formatTable pads columns and aligns per column", () => {
  const lines = formatTable(
    [
      ["a", "10"],
      ["longer", "5"],
    ],
    { header: ["name", "count"], aligns: ["left", "right"] },
  );
  expect(lines).toEqual([
    "  name    count",
    "  ------  -----",
    "  a          10",
    "  longer      5",
  ]);
});

test("formatTable renders footer rows below a second separator", () => {
  const lines = formatTable([["row", "1"]], {
    header: ["h", "n"],
    footer: [["sum", "1"]],
  });
  expect(lines).toEqual(["  h    n", "  ---  -", "  row  1", "  ---  -", "  sum  1"]);
});

test("formatTable trims every line, including separators", () => {
  // A zero-width final column: no line may carry trailing whitespace.
  const lines = formatTable([["x", ""]], { header: ["h", ""], footer: [["f", ""]] });
  for (const line of lines) {
    expect(line).toBe(line.trimEnd());
  }
});

test("formatTable handles ragged rows and an empty body", () => {
  expect(formatTable([["only"], ["two", "cells"]])).toEqual(["  only", "  two   cells"]);
  expect(formatTable([], { footer: [["f"]] })).toEqual(["  -", "  f"]);
  expect(formatTable([])).toEqual([]);
});

test("formatTable honors a custom indent", () => {
  expect(formatTable([["a"]], { indent: "" })).toEqual(["a"]);
});
