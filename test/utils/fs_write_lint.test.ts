import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";
import { READS_RULE, scanFsReach, WRITES_RULE } from "../lint/no_unreported_fs_writes.ts";

// The scanner is what catches a NEW raw write or read silently bypassing the seam, so the tree
// is swept here, and the scanner's teeth and scoping are pinned against doctored sources rather
// than assumed from a quiet sweep.

const GUARDED = "src/commands/example.ts";

/** The findings for `source`, counted per rule. */
function lint(source: string, file = GUARDED): { writes: number; reads: number } {
  const findings = scanFsReach(file, source);
  return {
    writes: findings.filter((f) => f.rule === WRITES_RULE).length,
    reads: findings.filter((f) => f.rule === READS_RULE).length,
  };
}

test("no file under src/ reaches the filesystem around the seam", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(join(PROJECT_ROOT, "src"))) {
    const path = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const finding of scanFsReach(path, source)) {
      const line = source.slice(0, finding.start).split("\n").length;
      offenders.push(`${path}:${line} ${finding.rule}: ${finding.message}`);
    }
  }
  expect(offenders).toEqual([]);
});

const CASES: readonly (readonly [string, number, number])[] = [
  // Named imports of a write API, sync and promise spellings alike.
  ['import { writeFileSync } from "node:fs";', 1, 0],
  ['import { rm } from "node:fs/promises";', 1, 0],
  ['import { mkdirSync, readFileSync, rmSync } from "node:fs";', 2, 1],
  ['import { createWriteStream } from "node:fs";', 1, 0],
  ['import { FileWriteStream } from "node:fs";', 1, 0],
  ['import { utimesSync } from "node:fs";', 1, 0],
  // A whole module object reached any other way.
  ['import * as fs from "node:fs"; fs.rmSync("x", { force: true });', 1, 0],
  ['import fs from "node:fs"; fs["renameSync"]("a", "b");', 1, 0],
  ['import * as fs from "node:fs"; const { chmodSync } = fs;', 1, 0],
  ['import { promises as fsp } from "node:fs"; await fsp.writeFile("x", "y");', 1, 0],
  ['import * as fs from "node:fs"; await fs.promises.rm("x");', 1, 0],
  ['import * as fs from "node:fs"; const { writeFile } = fs.promises;', 1, 0],
  ['import * as fs from "node:fs"; const fsp = fs.promises; fsp.rm("x");', 1, 0],
  ['import fs from "node:fs"; const { promises: fsp } = fs; fsp.rm("x");', 1, 0],
  // A dynamic import is the whole module: both directions refuse it.
  ['const fs = await import("node:fs");', 1, 1],
  ['const fsp = await import("node:fs/promises");', 1, 1],
  // Handing the module on under another module's name.
  ['export * from "node:fs";', 1, 1],
  ['export { rmSync } from "node:fs";', 1, 0],
  ['export { rm as remove } from "node:fs/promises";', 1, 0],
  ['export { promises } from "node:fs";', 1, 1],
  ['export { default as fs } from "node:fs";', 1, 1],
  ['export { default as fsp } from "node:fs/promises";', 1, 1],
  ['export { readFileSync, rmSync } from "node:fs";', 1, 1],
  // Bun's own file APIs: a write, and a handle that reads (and writes through its writer).
  ['await Bun.write("x", "y");', 1, 0],
  ['const f = Bun.file("x"); await f.text();', 1, 1],
  ['const bun = Bun; await bun.write("x", "y");', 1, 0],
  ["const { write } = Bun;", 1, 0],
  ['globalThis.Bun.file("x");', 1, 1],
  // Reads, every way of reaching one.
  ['import { existsSync, readFileSync, readdirSync } from "node:fs";', 0, 3],
  ['import * as fs from "node:fs"; fs.readFileSync("x", "utf8");', 0, 1],
  ['import { type WriteStream, readFileSync } from "node:fs";', 0, 1],
  ['import fs from "node:fs"; const { statSync } = fs;', 0, 1],
  ['import { promises as fsp } from "node:fs"; await fsp.readdir("x");', 0, 1],
  ['export { readFileSync } from "node:fs";', 0, 1],
  // A file handle is the seam's to hand out: every open is a read; one whose flag says
  // write (or cannot be read) is a write too, so a read-exempt file still may not open for writing.
  ['import { openSync } from "node:fs"; openSync("x", "w");', 1, 1],
  ['import { open } from "node:fs/promises"; await open("x", "a+");', 1, 1],
  ['import { open } from "node:fs/promises"; await open("x", "r");', 0, 1],
  ['import * as fs from "node:fs"; fs.openSync("x", "r+");', 1, 1],
  ['import { openSync } from "node:fs"; openSync("x", flags);', 1, 1],
  ['import * as fs from "node:fs"; const { openSync } = fs; openSync("x", "w");', 1, 1],
  ['import * as fs from "node:fs"; const o = fs.openSync; o("x", "w");', 1, 1],
  // Type imports, the seam itself, and unrelated modules are left alone.
  ['import type { WriteFileOptions, Stats } from "node:fs";', 0, 0],
  ['import * as fs from "../utils/fs_facade.ts"; fs.writeText("x", "y"); fs.readText("x");', 0, 0],
  ['export { writeText } from "../utils/fs_facade.ts";', 0, 0],
  ['const store = new Map(); store.rm("x"); store.stat("x");', 0, 0],
  ['Bun.which("deno"); const { env } = Bun;', 0, 0],
  // A child process running a filesystem command: the command itself, a shell's command line, an
  // exec command line, or Bun.spawn; a computed command passes (the rule cannot read it).
  ['import { spawnSync } from "node:child_process"; spawnSync("rm", ["-rf", "x"]);', 1, 0],
  ['import { spawn } from "node:child_process"; spawn("/bin/mv", ["a", "b"]);', 1, 0],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("cmd.exe", ["/c", "del /q x"]);',
    1,
    0,
  ],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("powershell", ["-Command", "Remove-Item x"]);',
    1,
    0,
  ],
  ['import { spawnSync } from "node:child_process"; spawnSync("sh", ["-c", "ls && rm x"]);', 1, 0],
  ['import { execSync } from "node:child_process"; execSync("cp a b");', 1, 0],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("cmd", ["/c", "echo ok & del x"]);',
    1,
    0,
  ],
  ['import * as cp from "node:child_process"; cp.spawnSync("rmdir", ["x"]);', 1, 0],
  ['Bun.spawn(["rm", "-rf", "x"]);', 1, 0],
  ['Bun.spawnSync({ cmd: ["sh", "-c", "ls && rm x"] });', 1, 0],
  ['const bun = Bun; bun.spawn(["mv", "a", "b"]);', 1, 0],
  ['Bun.spawn(["gh", "auth", "token"]); Bun.spawn([bin, "rm"]);', 0, 0],
  // Parentheses around a receiver do not hide it.
  ['import * as fs from "node:fs"; (fs).rmSync("x"); (fs.openSync)("y", "w");', 2, 1],
  [
    'import { spawnSync } from "node:child_process"; spawnSync("gh", ["auth", "token"]); spawnSync("sh", ["-c", "ls"]); spawnSync(bin, ["rm"]);',
    0,
    0,
  ],
];

test("every way of reaching a write or a read API is refused by its rule, and nothing else is", () => {
  const rows = CASES.map(([source, writes, reads]) => ({ source, writes, reads }));
  expect(rows.map((row) => ({ source: row.source, ...lint(row.source) }))).toEqual(rows);
});

test("scoped to src/, minus each rule's own exemptions", () => {
  const write = 'import { writeFileSync } from "node:fs";';
  const read = 'import { readFileSync } from "node:fs";';
  // Both directions: the disk side, the marker, the lock layer, and migrations.
  for (const exempt of [
    "src/utils/fs_disk.ts",
    "src/utils/dry_run.ts",
    "src/utils/file_lock.ts",
    "src/scripts/log_mute_preload.ts",
    "src/migrations/4.0.0.ts",
  ]) {
    expect(lint(write + read, exempt), exempt).toEqual({ writes: 0, reads: 0 });
  }
  // Reads alone: the usage scanners and the preload that runs before the seam; a write-capable
  // open there is still a write.
  const writeOpen = 'import { openSync } from "node:fs"; openSync("x", "w");';
  for (const readsOnly of ["src/usage/index.ts", "src/scripts/node_compat_preload.ts"]) {
    expect(lint(write + read, readsOnly), readsOnly).toEqual({ writes: 1, reads: 0 });
    expect(lint(writeOpen, readsOnly), readsOnly).toEqual({ writes: 1, reads: 0 });
  }
  // A raw read handle alone: the two files that stream a file no run plans keep every other read
  // (and every write) guarded.
  const readOpen = 'import { openSync } from "node:fs"; openSync("x", "r");';
  for (const handle of ["src/install/checksums.ts", "src/copilot_api/process.ts"]) {
    expect(lint(readOpen, handle), handle).toEqual({ writes: 0, reads: 0 });
    expect(lint(write + read, handle), handle).toEqual({ writes: 1, reads: 1 });
    expect(lint(writeOpen, handle), handle).toEqual({ writes: 1, reads: 0 });
  }
  // The report writes its line to fd 2 raw; a path write there is still a write.
  const fdWrite = 'import { writeSync } from "node:fs"; writeSync(2, "x");';
  expect(lint(fdWrite, "src/utils/report_write.ts")).toEqual({ writes: 0, reads: 0 });
  expect(lint(fdWrite, "src/commands/example.ts")).toEqual({ writes: 1, reads: 0 });
  // The seam's overlay and report read the disk through fs_disk.ts, not around it.
  for (const seam of [
    "src/utils/fs_facade.ts",
    "src/utils/fs_overlay.ts",
    "src/utils/dry_run_report.ts",
    "src/utils/report_write.ts",
  ]) {
    expect(lint(write + read, seam), seam).toEqual({ writes: 1, reads: 1 });
  }
  // Nested src paths are in scope.
  expect(lint(write, "src/scripts/inference_activity.ts").writes).toBe(1);
  expect(lint(read, "src/install/installer.ts").reads).toBe(1);
  // Tests, repo scripts and the CI helpers own their own files.
  for (const outside of [
    "test/helpers/env.ts",
    "scripts/compile.ts",
    ".github/scripts/release-assets.ts",
  ]) {
    expect(lint(write + read, outside), outside).toEqual({ writes: 0, reads: 0 });
  }
});
