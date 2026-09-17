import { fileURLToPath } from "node:url";
import tempDirPlugin from "./lint/no_unmanaged_temp_dir.ts";
import { expect, test } from "./helpers/testing.ts";

// A no-op rule passes `deno lint` exactly as quietly as a clean tree does, so the rule's
// teeth and its file scoping are pinned here rather than assumed.

const GUARDED = "test/example.test.ts";

/** Every API that yields a temp path, listed here on its own so that dropping one from the
 *  rule fails this test instead of shrinking it. */
const TEMP_PATH_APIS = [
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "makeTempDir",
  "makeTempDirSync",
  "makeTempFile",
  "makeTempFileSync",
  "tmpdir",
];

const lint = (source: string, file = GUARDED): string[] =>
  Deno.lint.runPlugin(tempDirPlugin, file, source).map((d) => d.message);

// Every route to a temp path draws one diagnostic per banned name it reaches; type imports and
// unrelated names draw none.
const SOURCES: [source: string, diagnostics: number][] = [
  // Every banned name, as a value import; the module does not matter, so the guard cannot
  // be sidestepped by importing from "fs" or "node:fs/promises" instead of "node:fs".
  ...TEMP_PATH_APIS.flatMap((name): [string, number][] => [
    [`import { ${name} } from "node:fs";`, 1],
    [`import { ${name} } from "fs";`, 1],
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
  // Deno's own, in every form.
  ['await Deno.makeTempDir({ prefix: "x-" });', 1],
  ["Deno.makeTempDirSync();", 1],
  ["Deno.makeTempFileSync();", 1],
  ["globalThis.Deno.makeTempFile();", 1],
  // The forms a call-shaped rule would have missed: stored first, then called.
  ["const make = Deno.makeTempDir; await make();", 1],
  ["const { makeTempDir } = Deno;", 1],
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
  ["Deno.removeSync(dir, { recursive: true });", 0],
];

test("no-unmanaged-temp-dir: every route to a temp path is rejected, and nothing else", () => {
  for (const [source, diagnostics] of SOURCES) {
    expect(lint(source), source).toHaveLength(diagnostics);
  }
});

test("no-unmanaged-temp-dir: scoped to the test tree, and never to the owning helper", () => {
  const raw = 'import { mkdtempSync } from "node:fs";';
  // The REAL absolute spellings deno lint passes, built the way the plugin builds its own
  // scope: the relative cases below would all still pass if the absolute form matched nothing.
  const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  expect(lint(raw, abs("./example.test.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/mcp.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/testing.ts"))).toEqual([]); // owns the temp root

  expect(lint(raw, "test/helpers/testing.ts")).toEqual([]);
  // Runtime code and standalone scripts own their own temp paths.
  expect(lint(raw, "src/install/download.ts")).toEqual([]);
  expect(lint(raw, "scripts/usage_goldens.ts")).toEqual([]);
  // Nested test paths and the windows-style separator are still in scope.
  expect(lint(raw, "test/helpers/mcp.ts")).toHaveLength(1);
  expect(lint(raw, "test\\usage.test.ts")).toHaveLength(1);
});
