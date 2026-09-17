// readTextResult keeps "absent" and "unreadable" apart: a caller that authorizes destructive
// action on absent must never see a permission error collapsed into it. readTextOrNull is the
// don't-care wrapper that folds both to null.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNull, readTextResult, type TextReadResult } from "../src/utils/fs.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

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

// POSIX only: creating symlinks on Windows needs elevation/dev-mode.
test.skipIf(process.platform === "win32")(
  "readTextResult: a dangling symlink is unreadable, never absent",
  () => {
    dir = tempDir("copilot-fs-");
    // readFileSync follows the link and reports ENOENT, but an entry exists AT the path:
    // classifying it absent would authorize cleanup of something still there.
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "gone.json"), dangling);
    const result = readTextResult(dangling);
    expect(result.kind).toBe("unreadable");
    if (result.kind === "unreadable") expect(result.error.length).toBeGreaterThan(0);
    expect(readTextOrNull(dangling)).toBeNull();
  },
);
