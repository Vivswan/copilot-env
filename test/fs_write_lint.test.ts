import { fileURLToPath } from "node:url";
import fsWritePlugin from "./lint/no_unreported_fs_writes.ts";
import { expect, test } from "./helpers/testing.ts";

// The rule is what catches a NEW raw write silently bypassing the reporting seam, so its
// teeth and its scoping are pinned here rather than assumed from a quiet `deno lint`.

const GUARDED = "src/commands/example.ts";

const lint = (source: string, file = GUARDED): string[] =>
  Deno.lint.runPlugin(fsWritePlugin, file, source).map((d) => d.message);

test("no-unreported-fs-writes: every way of reaching a write API is rejected", () => {
  expect(lint('import { writeFileSync } from "node:fs";')).toHaveLength(1);
  expect(lint('import { rm } from "node:fs/promises";')).toHaveLength(1);
  // Two banned names in one import: one report each.
  expect(lint('import { mkdirSync, readFileSync, rmSync } from "node:fs";')).toHaveLength(2);
  expect(lint('import * as fs from "node:fs"; fs.rmSync("x", { force: true });')).toHaveLength(1);
  expect(lint('import fs from "node:fs"; fs["renameSync"]("a", "b");')).toHaveLength(1);
  expect(lint('import * as fs from "node:fs"; const { chmodSync } = fs;')).toHaveLength(1);
  expect(lint('import { createWriteStream } from "node:fs";')).toHaveLength(1);
  expect(lint('import { promises as fsp } from "node:fs"; await fsp.writeFile("x", "y");'))
    .toHaveLength(1);
  expect(lint('import * as fs from "node:fs"; await fs.promises.rm("x");')).toHaveLength(1);
  expect(lint('import * as fs from "node:fs"; const { writeFile } = fs.promises;')).toHaveLength(1);
  expect(lint('import * as fs from "node:fs"; const fsp = fs.promises; fsp.rm("x");'))
    .toHaveLength(1);
  expect(lint('import fs from "node:fs"; const { promises: fsp } = fs; fsp.rm("x");'))
    .toHaveLength(1);
  expect(lint('const deno = Deno; deno.removeSync("x");')).toHaveLength(1);
  expect(lint('Deno.writeTextFileSync("x", "y");')).toHaveLength(1);
  expect(lint('await globalThis.Deno.remove("x");')).toHaveLength(1);
  expect(lint("const { makeTempDirSync } = Deno;")).toHaveLength(1);
});

test("no-unreported-fs-writes: reads, type imports and unrelated modules are left alone", () => {
  expect(lint('import { existsSync, readFileSync, readdirSync } from "node:fs";')).toEqual([]);
  expect(lint('import * as fs from "node:fs"; fs.readFileSync("x", "utf8");')).toEqual([]);
  expect(lint('import type { WriteFileOptions } from "node:fs";')).toEqual([]);
  expect(lint('Deno.readTextFileSync("x"); Deno.statSync("x");')).toEqual([]);
  expect(lint('import { writeFileReported } from "../utils/report_write.ts";')).toEqual([]);
  // Same member name, not a filesystem namespace.
  expect(lint('const store = new Map(); store.rm("x");')).toEqual([]);
});

test("no-unreported-fs-writes: scoped to src/, minus the seam, the lock layer and migrations", () => {
  const raw = 'import { writeFileSync } from "node:fs";';
  // The absolute spellings deno lint passes, built the way the plugin builds its scope.
  const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  expect(lint(raw, abs("../src/commands/example.ts"))).toHaveLength(1);
  expect(lint(raw, abs("../src/utils/report_write.ts"))).toEqual([]);

  expect(lint(raw, "src/utils/report_write.ts")).toEqual([]);
  expect(lint(raw, "src/utils/file_lock.ts")).toEqual([]);
  expect(lint(raw, "src/scripts/log_mute_preload.ts")).toEqual([]);
  expect(lint(raw, "src/migrations/3.5.6.ts")).toEqual([]);
  // Nested src paths and the windows-style separator are still in scope.
  expect(lint(raw, "src/scripts/inference_activity.ts")).toHaveLength(1);
  expect(lint(raw, "src\\install\\installer.ts")).toHaveLength(1);
  // Tests, repo scripts and the CI helpers own their own files.
  expect(lint(raw, "test/helpers.ts")).toEqual([]);
  expect(lint(raw, "scripts/compile.ts")).toEqual([]);
  expect(lint(raw, ".github/scripts/release-assets.ts")).toEqual([]);
});
