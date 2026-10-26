import {
  everywhere,
  lintCases,
  lintFixtures,
  repositoryOverrides,
} from "../helpers/biome_plugin.ts";
import { expect, test } from "../helpers/testing.ts";

// A no-op rule passes `biome ci` exactly as quietly as a clean tree does, so the rule's teeth
// and the scope biome.json gives it are pinned here rather than assumed.

/** The rule under test: its grit file, checkout-relative. */
const PLUGIN = "biome/no_unmanaged_temp_dir.grit";

/** Every temp-path API, listed on its own so dropping one from the rule fails this test instead of shrinking it. */
const TEMP_PATH_APIS = [
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "tmpdir",
];

// Every route to a temp path draws one diagnostic per banned name it reaches; type imports and unrelated names none.
const SOURCES: [source: string, diagnostics: number][] = [
  // Every banned name, as a value import; the module does not matter, so the guard cannot be
  // sidestepped by importing from "fs" or "node:fs/promises" instead of "node:fs".
  ...TEMP_PATH_APIS.flatMap((name): [string, number][] => [
    [`import { ${name} } from "node:fs";`, 1],
    [`import { ${name} } from "fs";`, 1],
    [`import { ${name} as make } from "node:fs/promises";`, 1],
  ]),
  ['import { existsSync, mkdtempSync, rmSync } from "node:fs";', 1],
  // ... read off a namespace instead of imported by name.
  ['fs.mkdtempSync(join(os.tmpdir(), "x-"));', 2],
  ['fs["mkdtempSync"]("x-");', 1],
  ["const { mkdtempSync } = fs;", 1],
  ['const { "mkdtempSync": make } = fs;', 1],
  ["let make; ({ mkdtempSync: make } = fs);", 1],
  ["function f({ tmpdir }: typeof os) { return tmpdir; }", 1],
  // ... or handed on to another module under a new name.
  ['export { mkdtempSync as makeFixture } from "node:fs";', 1],
  ['export * from "node:fs";', 1],
  ['export * as os from "node:os";', 1],
  // The forms a call-shaped rule would have missed: stored first, then called.
  ["const make = fs.mkdtempSync; make();", 1],
  // Type imports and unrelated names are left alone.
  ['import type { mkdtempSync } from "node:fs";', 0],
  ['import { type mkdtempSync, rmSync } from "node:fs";', 0],
  ['export type { mkdtempSync } from "node:fs";', 0],
  ['export { rmSync } from "node:fs";', 0],
  ['export * from "./helpers/testing.ts";', 0],
  ["const { [key]: value } = fs;", 0],
  ['const dir = tempDir("copilot-x-");', 0],
  ['import { mkdirSync, rmSync } from "node:fs";', 0],
  ['import { homedir } from "node:os";', 0],
  ["rmSync(dir, { recursive: true });", 0],
];

test("no-unmanaged-temp-dir: every route to a temp path is rejected, and nothing else", () => {
  const counts = lintCases(
    PLUGIN,
    SOURCES.map(([source]) => source),
  );
  expect(SOURCES.map(([source], i) => [source, counts[i]])).toEqual(SOURCES);
});

test("biome.json scopes the rule to the test tree, minus the helper that owns the root", () => {
  const raw = 'import { mkdtempSync } from "node:fs";';
  const files = {
    "test/example.test.ts": raw,
    "test/helpers/mcp.ts": raw,
    "test/helpers/run.ts": raw,
    "test/helpers/testing.ts": raw, // owns the temp root
    // Runtime code and standalone scripts own their own temp paths.
    "src/install/download.ts": raw,
    "scripts/usage/goldens.ts": raw,
  };
  expect(lintFixtures(files, repositoryOverrides())).toEqual({
    "test/example.test.ts": 1,
    "test/helpers/mcp.ts": 1,
    "test/helpers/run.ts": 1,
    "test/helpers/testing.ts": 0,
    "src/install/download.ts": 0,
    "scripts/usage/goldens.ts": 0,
  });
  expect(Object.values(lintFixtures(files, everywhere(PLUGIN)))).toEqual([1, 1, 1, 1, 1, 1]);
});
