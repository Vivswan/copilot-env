// readTextResult keeps "absent" and "unreadable" apart: a caller that authorizes destructive
// action on absent must never see a permission error collapsed into it. readTextOrNull is the
// don't-care wrapper that folds both to null.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNull } from "../src/utils/fs.ts";
import { readTextResult, type TextReadResult } from "../src/utils/fs_facade.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

let dir = "";
test("readTextResult keeps text, absent, and unreadable apart; readTextOrNull collapses the last two", () => {
  dir = tempDir("copilot-fs-");
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello");
  const asDir = join(dir, "settings.json");
  mkdirSync(asDir);
  const rows: Array<{ path: string; kind: TextReadResult["kind"]; text: string | null }> = [
    { path: file, kind: "text", text: "hello" },
    // Nothing is there to protect: ENOENT, and ENOTDIR under a non-directory parent alike.
    { path: join(dir, "missing.txt"), kind: "absent", text: null },
    { path: join(file, "child.txt"), kind: "absent", text: null },
    // Reading a directory fails with a non-ENOENT error on every platform.
    { path: asDir, kind: "unreadable", text: null },
  ];
  for (const { path, kind, text } of rows) {
    const result = readTextResult(path);
    expect(result.kind, path).toBe(kind);
    if (result.kind === "text") expect(result.text).toBe(text);
    if (result.kind === "unreadable") expect(result.error.length).toBeGreaterThan(0);
    expect(readTextOrNull(path), path).toBe(text);
  }
});
