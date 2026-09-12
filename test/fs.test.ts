// readTextResult keeps "absent" and "unreadable" apart: a caller that authorizes destructive
// action on absent must never see a permission error collapsed into it. readTextOrNull is the
// don't-care wrapper that folds both to null.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNull, readTextResult } from "../src/utils/fs.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

test("readTextResult keeps text, absent, and unreadable apart", () => {
  dir = tempDir("copilot-fs-");
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello");
  expect(readTextResult(file)).toEqual({ kind: "text", text: "hello" });

  // A lookup under a non-directory parent (ENOTDIR) reads absent like ENOENT: nothing is there
  // to protect.
  expect(readTextResult(join(dir, "missing.txt"))).toEqual({ kind: "absent" });
  expect(readTextResult(join(file, "child.txt"))).toEqual({ kind: "absent" });

  // Reading a directory fails with a non-ENOENT error on every platform, so it must read
  // unreadable.
  const asDir = join(dir, "settings.json");
  mkdirSync(asDir);
  const result = readTextResult(asDir);
  expect(result.kind).toBe("unreadable");
  if (result.kind === "unreadable") expect(result.error.length).toBeGreaterThan(0);
});

test("readTextOrNull collapses every non-text outcome to null", () => {
  dir = tempDir("copilot-fs-");
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
    dir = tempDir("copilot-fs-");
    const link = join(dir, "settings.json");
    symlinkSync(join(dir, "gone.json"), link);
    // readFileSync follows the link and reports ENOENT, but an entry exists AT the path:
    // classifying it absent would authorize cleanup of something still there.
    expect(readTextResult(link).kind).toBe("unreadable");
    expect(readTextOrNull(link)).toBe(null);
  },
);
