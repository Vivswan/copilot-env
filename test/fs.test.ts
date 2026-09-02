// readTextResult: the three-way text read (text / absent / unreadable) and its
// don't-care wrapper readTextOrNull. "Absent" and "unreadable" must never
// collapse into each other -- removal paths authorize destructive action on
// absent and hands-off treatment on unreadable (see removeClaudeProfile).
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNull, readTextResult } from "../src/utils/fs.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { removeDir, tmpDir } from "./helpers.ts";

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

test("readTextResult keeps text, absent, and unreadable apart", () => {
  dir = tmpDir("copilot-fs-");
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello");
  expect(readTextResult(file)).toEqual({ kind: "text", text: "hello" });

  // Nothing at the path, and a lookup under a non-directory parent (ENOENT /
  // ENOTDIR), both read "absent": nothing is there to protect.
  expect(readTextResult(join(dir, "missing.txt"))).toEqual({ kind: "absent" });
  expect(readTextResult(join(file, "child.txt"))).toEqual({ kind: "absent" });

  // A directory at the path EXISTS but cannot be read as text (a non-ENOENT
  // error on every platform): "unreadable", never "absent", with the cause kept.
  const asDir = join(dir, "settings.json");
  mkdirSync(asDir);
  const result = readTextResult(asDir);
  expect(result.kind).toBe("unreadable");
  if (result.kind === "unreadable") expect(result.error.length).toBeGreaterThan(0);
});

test("readTextOrNull collapses every non-text outcome to null", () => {
  dir = tmpDir("copilot-fs-");
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello");
  expect(readTextOrNull(file)).toBe("hello");
  expect(readTextOrNull(join(dir, "missing.txt"))).toBe(null);
  const asDir = join(dir, "as-dir");
  mkdirSync(asDir);
  expect(readTextOrNull(asDir)).toBe(null);
});

test.skipIf(process.platform === "win32")(
  "a dangling symlink is unreadable, never absent (the entry itself exists)",
  () => {
    // POSIX only: creating symlinks on Windows needs elevation/dev-mode.
    dir = tmpDir("copilot-fs-");
    const link = join(dir, "settings.json");
    symlinkSync(join(dir, "gone.json"), link);
    // readFileSync follows the link and reports ENOENT, but lstat shows an
    // entry AT the path: classifying it absent would authorize cleanup of
    // something that is still there.
    expect(readTextResult(link).kind).toBe("unreadable");
    expect(readTextOrNull(link)).toBe(null);
  },
);
