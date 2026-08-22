import { fileURLToPath } from "node:url";
import childSpawnPlugin from "./lint/no_unmanaged_child_spawn.ts";
import { expect, test } from "./helpers/testing.ts";

// A no-op rule passes `deno lint` exactly as quietly as a clean tree does, so the rule's
// teeth and its file scoping are pinned here rather than assumed.

const GUARDED = "test/example.test.ts";

const lint = (source: string, file = GUARDED): string[] =>
  Deno.lint.runPlugin(childSpawnPlugin, file, source).map((d) => d.message);

test("no-unmanaged-child-spawn: every spelling of the constructor is rejected", () => {
  expect(lint('new Deno.Command("x", { args: [] }).spawn();')).toHaveLength(1);
  expect(lint('await new Deno.Command("x", {}).output();')).toHaveLength(1);
  expect(lint('new Deno.Command("x", {}).outputSync();')).toHaveLength(1);
  // The forms a spawn-shaped rule would have missed: stored first, then spawned.
  expect(lint('const cmd = new Deno.Command("x", {}); cmd.spawn();')).toHaveLength(1);
  // ... and the ways of naming the constructor without writing `Deno.Command` literally.
  expect(lint('const C = Deno.Command; new C("x", {}).spawn();')).toHaveLength(1);
  expect(lint('const C = Deno["Command"]; new C("x", {}).spawn();')).toHaveLength(1);
  expect(lint('new globalThis.Deno.Command("x", {}).spawn();')).toHaveLength(1);
  expect(lint("const { Command } = Deno;")).toHaveLength(1);
});

test("no-unmanaged-child-spawn: the other route, node:child_process, is banned wholesale", () => {
  // Every import FORM, since enumerating entry points would miss `import * as cp`.
  expect(lint('import { spawn } from "node:child_process";')).toHaveLength(1);
  expect(lint('import * as cp from "node:child_process";')).toHaveLength(1);
  expect(lint('import cp from "node:child_process";')).toHaveLength(1);
  expect(lint('import "node:child_process";')).toHaveLength(1);
  expect(lint('const cp = await import("node:child_process");')).toHaveLength(1);
  // Even the synchronous entry points: run.ts is the suite's one process boundary, and
  // runSync is how a test reaches spawnSync.
  expect(lint('import { spawnSync } from "node:child_process";')).toHaveLength(1);
  // Type imports are erased, so they reach no API.
  expect(lint('import type { spawnSync } from "node:child_process";')).toEqual([]);
  // Same identifier, unrelated module.
  expect(lint('import { spawn } from "./my_helper.ts";')).toEqual([]);
});

test("no-unmanaged-child-spawn: scoped to the test tree, and never to the helper itself", () => {
  const raw = 'new Deno.Command("x", {}).spawn();';
  // The REAL absolute spellings deno lint passes, built the way the plugin builds its own
  // scope: the relative cases below would all still pass if the absolute form matched
  // nothing, and so would `deno lint`. (The Windows-only half of that risk -- a URL pathname
  // reading "/C:/..." -- is what the CI matrix covers; here both forms agree.)
  const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  expect(lint(raw, abs("./example.test.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/mcp.ts"))).toHaveLength(1);
  expect(lint(raw, abs("./helpers/run.ts"))).toEqual([]); // owns the sanctioned construction

  expect(lint(raw, "test/helpers/run.ts")).toEqual([]);
  // Runtime code and standalone scripts own their own process lifecycles.
  expect(lint(raw, "src/copilot_api/process.ts")).toEqual([]);
  expect(lint(raw, "scripts/test_docker.ts")).toEqual([]);
  // Nested test paths and the windows-style separator are still in scope.
  expect(lint(raw, "test/helpers/mcp.ts")).toHaveLength(1);
  expect(lint(raw, "test\\daemon_spawn.test.ts")).toHaveLength(1);
});

test("no-unmanaged-child-spawn: the sanctioned helper and unrelated code are left alone", () => {
  expect(lint('const c = spawnChild("x", { args: [] });')).toEqual([]);
  expect(lint('new Foo.Command("x").spawn();')).toEqual([]);
  expect(lint("const { execPath } = Deno;")).toEqual([]);
  expect(lint("const v = Deno.execPath();")).toEqual([]);
});
