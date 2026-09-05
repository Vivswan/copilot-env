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

test("no-unmanaged-temp-dir: every route to a temp path is rejected", () => {
  // Every banned name, as a value import; the module does not matter, so the guard cannot
  // be sidestepped by importing from "fs" or "node:fs/promises" instead of "node:fs".
  for (const name of TEMP_PATH_APIS) {
    expect(lint(`import { ${name} } from "node:fs";`), name).toHaveLength(1);
    expect(lint(`import { ${name} } from "fs";`), name).toHaveLength(1);
  }
  expect(lint('import { existsSync, mkdtempSync, rmSync } from "node:fs";')).toHaveLength(1);
  // ... read off a namespace instead of imported by name.
  expect(lint('fs.mkdtempSync(join(os.tmpdir(), "x-"));')).toHaveLength(2);
  expect(lint('fs["mkdtempSync"]("x-");')).toHaveLength(1);
  expect(lint("const { mkdtempSync } = fs;")).toHaveLength(1);
  expect(lint('const { "mkdtempSync": make } = fs;')).toHaveLength(1);
  expect(lint("let make; ({ mkdtempSync: make } = fs);")).toHaveLength(1);
  expect(lint("function f({ tmpdir }: typeof os) { return tmpdir; }")).toHaveLength(1);
  // ... or handed on to another module under a new name.
  expect(lint('export { mkdtempSync as makeFixture } from "node:fs";')).toHaveLength(1);
  expect(lint('export * from "node:fs";')).toHaveLength(1);
  expect(lint('export * as os from "node:os";')).toHaveLength(1);
  // Deno's own, in every form.
  expect(lint('await Deno.makeTempDir({ prefix: "x-" });')).toHaveLength(1);
  expect(lint("Deno.makeTempDirSync();")).toHaveLength(1);
  expect(lint("Deno.makeTempFileSync();")).toHaveLength(1);
  expect(lint("globalThis.Deno.makeTempFile();")).toHaveLength(1);
  // The forms a call-shaped rule would have missed: stored first, then called.
  expect(lint("const make = Deno.makeTempDir; await make();")).toHaveLength(1);
  expect(lint("const { makeTempDir } = Deno;")).toHaveLength(1);
});

test("no-unmanaged-temp-dir: type imports and unrelated names are left alone", () => {
  expect(lint('import type { mkdtempSync } from "node:fs";')).toEqual([]);
  expect(lint('import { type mkdtempSync, rmSync } from "node:fs";')).toEqual([]);
  expect(lint('export type { mkdtempSync } from "node:fs";')).toEqual([]);
  expect(lint('export { rmSync } from "node:fs";')).toEqual([]);
  expect(lint('export * from "./helpers/testing.ts";')).toEqual([]);
  expect(lint("const { [key]: value } = fs;")).toEqual([]);
  expect(lint('const dir = tempDir("copilot-x-");')).toEqual([]);
  expect(lint('import { mkdirSync, rmSync } from "node:fs";')).toEqual([]);
  expect(lint('import { homedir } from "node:os";')).toEqual([]);
  expect(lint("Deno.removeSync(dir, { recursive: true });")).toEqual([]);
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
