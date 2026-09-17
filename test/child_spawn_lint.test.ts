import { fileURLToPath } from "node:url";
import childSpawnPlugin from "./lint/no_unmanaged_child_spawn.ts";
import { expect, test } from "./helpers/testing.ts";

// A no-op rule passes `deno lint` exactly as quietly as a clean tree does, so the rule's
// teeth and its file scoping are pinned here rather than assumed.

const GUARDED = "test/example.test.ts";

const lint = (source: string, file = GUARDED): string[] =>
  Deno.lint.runPlugin(childSpawnPlugin, file, source).map((d) => d.message);

// Every route to a child process, and the sanctioned helper beside them: one diagnostic per
// construction or import of the banned modules, none for anything else.
const SOURCES: [source: string, diagnostics: number][] = [
  // Every spelling of the constructor.
  ['new Deno.Command("x", { args: [] }).spawn();', 1],
  ['await new Deno.Command("x", {}).output();', 1],
  ['new Deno.Command("x", {}).outputSync();', 1],
  // A spawn-shaped rule would miss these: stored first, then spawned; the constructor reached
  // without writing `Deno.Command` literally.
  ['const cmd = new Deno.Command("x", {}); cmd.spawn();', 1],
  ['const C = Deno.Command; new C("x", {}).spawn();', 1],
  ['const C = Deno["Command"]; new C("x", {}).spawn();', 1],
  ['new globalThis.Deno.Command("x", {}).spawn();', 1],
  ["const { Command } = Deno;", 1],
  // The other route, node:child_process, banned wholesale: every import FORM, since enumerating
  // entry points would miss `import * as cp`.
  ['import { spawn } from "node:child_process";', 1],
  ['import * as cp from "node:child_process";', 1],
  ['import cp from "node:child_process";', 1],
  ['import "node:child_process";', 1],
  ['const cp = await import("node:child_process");', 1],
  // Even the synchronous entry points: run.ts is the suite's one process boundary, and
  // runSync is how a test reaches spawnSync.
  ['import { spawnSync } from "node:child_process";', 1],
  // Type imports are erased, so they reach no API.
  ['import type { spawnSync } from "node:child_process";', 0],
  ['import { spawn } from "./my_helper.ts";', 0],
  // The sanctioned helper and unrelated code are left alone.
  ['const c = spawnChild("x", { args: [] });', 0],
  ['new Foo.Command("x").spawn();', 0],
  ["const { execPath } = Deno;", 0],
  ["const v = Deno.execPath();", 0],
];

test("no-unmanaged-child-spawn: every route to a child process is rejected, and nothing else", () => {
  for (const [source, diagnostics] of SOURCES) {
    expect(lint(source), source).toHaveLength(diagnostics);
  }
});

test("no-unmanaged-child-spawn: scoped to the test tree, and never to the helper itself", () => {
  const raw = 'new Deno.Command("x", {}).spawn();';
  // deno lint passes absolute paths: if the plugin's absolute scoping matched nothing, the relative
  // cases below and `deno lint` itself would both pass vacuously. On Windows the URL pathname reads
  // "/C:/...", which only the CI matrix covers; here both forms agree.
  const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  expect(lint(raw, abs("./example.test.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/mcp.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/run.ts"))).toEqual([]); // owns the sanctioned construction
  expect(lint(raw, abs("./helpers/testing.ts"))).toEqual([]); // the module-load cache lookup

  expect(lint(raw, "test/helpers/run.ts")).toEqual([]);
  expect(lint(raw, "test/helpers/testing.ts")).toEqual([]);
  // Runtime code and standalone scripts own their own process lifecycles.
  expect(lint(raw, "src/copilot_api/process.ts")).toEqual([]);
  expect(lint(raw, "scripts/test_docker.ts")).toEqual([]);
  // Nested test paths and the windows-style separator are still in scope.
  expect(lint(raw, "test/helpers/mcp.ts")).toHaveLength(1);
  expect(lint(raw, "test\\daemon_spawn.test.ts")).toHaveLength(1);
});
