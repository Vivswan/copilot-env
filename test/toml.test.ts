// The TOML reader's one decision about the parser's behaviour (one leading BOM is dropped, a
// table is any object but a datetime) holds only while every parse site in src/ goes through
// src/utils/toml.ts. A site importing `parse` from smol-toml itself reads the library's current
// behaviour instead, which is what a dependency bump then changes under it.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";
import { tsFilesUnder } from "./helpers/tree.ts";

test("smol-toml's parse is imported by src/utils/toml.ts and nowhere else under src/", () => {
  const importers = tsFilesUnder(join(ROOT, "src"))
    .filter((file) =>
      /import\s+(?:\*\s+as\s+\w+|\{[^}]*\bparse\b[^}]*\})\s*from\s*"smol-toml"/.test(
        readFileSync(file, "utf8"),
      )
    )
    .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
    .sort();
  expect(importers).toEqual(["src/utils/toml.ts"]);
});
