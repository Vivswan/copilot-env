// The TOML reader's one decision about the parser's behaviour (one leading BOM is dropped, a
// table is any object but a datetime) holds only while every parse site in src/ goes through
// src/utils/toml.ts. A site importing `parse` from smol-toml itself reads the library's current
// behaviour instead, which is what a dependency bump then changes under it.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../helpers/run.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";

test("smol-toml is named by src/utils/toml.ts and nowhere else under src/", () => {
  // The specifier in any quote, bare or `npm:`-prefixed with a version: a named, default,
  // namespace, or dynamic import, or a re-export, all reach the parser without the owner. The
  // guard is against an omission, not a spelling built to evade it.
  const importers = tsFilesUnder(join(ROOT, "src"))
    .filter((file) => /(["'`])(?:npm:)?smol-toml(?:@[^"'`]*)?\1/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
    .sort();
  expect(importers).toEqual(["src/utils/toml.ts"]);
});
