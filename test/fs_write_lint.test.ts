import { fileURLToPath } from "node:url";
import fsWritePlugin from "./lint/no_unreported_fs_writes.ts";
import { expect, test } from "./helpers/testing.ts";

// The rule is what catches a NEW raw write silently bypassing the reporting seam, so its
// teeth and its scoping are pinned here rather than assumed from a quiet `deno lint`.

const GUARDED = "src/commands/example.ts";

const lint = (source: string, file = GUARDED): string[] =>
  Deno.lint.runPlugin(fsWritePlugin, file, source).map((d) => d.message);

const CASES: readonly (readonly [string, number])[] = [
  // Named imports of a write API, sync and promise spellings alike.
  ['import { writeFileSync } from "node:fs";', 1],
  ['import { rm } from "node:fs/promises";', 1],
  ['import { mkdirSync, readFileSync, rmSync } from "node:fs";', 2],
  ['import { createWriteStream } from "node:fs";', 1],
  ['import { FileWriteStream } from "node:fs";', 1],
  ['import { utimesSync } from "node:fs";', 1],
  // A whole module object reached any other way.
  ['import * as fs from "node:fs"; fs.rmSync("x", { force: true });', 1],
  ['import fs from "node:fs"; fs["renameSync"]("a", "b");', 1],
  ['import * as fs from "node:fs"; const { chmodSync } = fs;', 1],
  ['import { promises as fsp } from "node:fs"; await fsp.writeFile("x", "y");', 1],
  ['import * as fs from "node:fs"; await fs.promises.rm("x");', 1],
  ['import * as fs from "node:fs"; const { writeFile } = fs.promises;', 1],
  ['import * as fs from "node:fs"; const fsp = fs.promises; fsp.rm("x");', 1],
  ['import fs from "node:fs"; const { promises: fsp } = fs; fsp.rm("x");', 1],
  ['const fs = await import("node:fs");', 1],
  ['const fsp = await import("node:fs/promises");', 1],
  // Handing the module on under another module's name.
  ['export * from "node:fs";', 1],
  ['export { rmSync } from "node:fs";', 1],
  ['export { rm as remove } from "node:fs/promises";', 1],
  ['export { promises } from "node:fs";', 1],
  ['export { default as fs } from "node:fs";', 1],
  ['export { default as fsp } from "node:fs/promises";', 1],
  ['export { readFileSync, rmSync } from "node:fs";', 1],
  // A read-only re-export is as legal as a read-only import.
  ['export { readFileSync } from "node:fs";', 0],
  // The Deno namespace, spelled every way.
  ['Deno.writeTextFileSync("x", "y");', 1],
  ['await globalThis.Deno.remove("x");', 1],
  ["const { makeTempDirSync } = Deno;", 1],
  ['const deno = Deno; deno.removeSync("x");', 1],
  ['Deno.chownSync("x", 1, 1);', 1],
  // Reads, type imports and unrelated modules are left alone.
  ['import { existsSync, readFileSync, readdirSync } from "node:fs";', 0],
  ['import * as fs from "node:fs"; fs.readFileSync("x", "utf8");', 0],
  ['import type { WriteFileOptions } from "node:fs";', 0],
  ['import { type WriteStream, readFileSync } from "node:fs";', 0],
  ['Deno.readTextFileSync("x"); Deno.statSync("x");', 0],
  ['import { writeFileReported } from "../utils/report_write.ts";', 0],
  ['export { writeFileReported } from "../utils/report_write.ts";', 0],
  ['const store = new Map(); store.rm("x");', 0],
  // A handle opened for writing: node:fs by flag, Deno by option; a flag the rule cannot read is a
  // write too. A read-only open stays legal.
  ['import { openSync } from "node:fs"; openSync("x", "w");', 1],
  ['import { open } from "node:fs/promises"; await open("x", "a+");', 1],
  ['import * as fs from "node:fs"; fs.openSync("x", "r+");', 1],
  ['import { openSync } from "node:fs"; openSync("x", flags);', 1],
  ['import { openSync } from "node:fs"; openSync("x", "r"); openSync("y");', 0],
  ['await Deno.open("x", { write: true, create: true });', 1],
  ['Deno.openSync("x", { append: true });', 1],
  ['await Deno.open("x", opts);', 1],
  ['const flag = "write"; await Deno.open("x", { [flag]: true });', 1],
  ['import * as fs from "node:fs"; const { openSync } = fs; openSync("x", "w");', 1],
  [
    'await Deno.open("x", { read: true }); await Deno.open("y"); Deno.openSync("z", { write: false });',
    0,
  ],
  // A child process running a filesystem command: the command itself, a shell's command line, an
  // exec command line, or Deno.Command; a computed command passes (the rule cannot read it).
  ['import { spawnSync } from "node:child_process"; spawnSync("rm", ["-rf", "x"]);', 1],
  ['import { spawn } from "node:child_process"; spawn("/bin/mv", ["a", "b"]);', 1],
  ['import { spawnSync } from "node:child_process"; spawnSync("cmd.exe", ["/c", "del /q x"]);', 1],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("powershell", ["-Command", "Remove-Item x"]);',
    1,
  ],
  ['import { spawnSync } from "node:child_process"; spawnSync("sh", ["-c", "ls && rm x"]);', 1],
  ['import { execSync } from "node:child_process"; execSync("cp a b");', 1],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("cmd", ["/c", "echo ok & del x"]);',
    1,
  ],
  ['import * as cp from "node:child_process"; cp.spawnSync("rmdir", ["x"]);', 1],
  ['new Deno.Command("rm", { args: ["x"] }).outputSync();', 1],
  ['new Deno.Command("sh", { "args": ["-c", "rm x"] }).outputSync();', 1],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("gh", ["auth", "token"]); spawnSync("sh", ["-c", "ls"]); spawnSync(bin, ["rm"]);',
    0,
  ],
];

test("no-unreported-fs-writes: every way of reaching a write API, and nothing else", () => {
  for (const [source, count] of CASES) {
    expect(lint(source), source).toHaveLength(count);
  }
});

test("no-unreported-fs-writes: scoped to src/, minus the seam's disk side, the marker, the lock layer and migrations", () => {
  const raw = 'import { writeFileSync } from "node:fs";';
  // The absolute spellings deno lint passes, built the way the plugin builds its scope.
  const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  expect(lint(raw, abs("../src/commands/example.ts"))).toHaveLength(1);
  expect(lint(raw, abs("../src/utils/fs_disk.ts"))).toEqual([]);

  expect(lint(raw, "src/utils/fs_disk.ts")).toEqual([]);
  expect(lint(raw, "src/utils/dry_run.ts")).toEqual([]);
  expect(lint(raw, "src/utils/report_write.ts")).toHaveLength(1);
  expect(lint(raw, "src/utils/file_lock.ts")).toEqual([]);
  expect(lint(raw, "src/scripts/log_mute_preload.ts")).toEqual([]);
  expect(lint(raw, "src/migrations/4.0.0.ts")).toEqual([]);
  // Nested src paths and the windows-style separator are still in scope.
  expect(lint(raw, "src/scripts/inference_activity.ts")).toHaveLength(1);
  expect(lint(raw, "src\\install\\installer.ts")).toHaveLength(1);
  // Tests, repo scripts and the CI helpers own their own files.
  expect(lint(raw, "test/helpers.ts")).toEqual([]);
  expect(lint(raw, "scripts/compile.ts")).toEqual([]);
  expect(lint(raw, ".github/scripts/release-assets.ts")).toEqual([]);
});
