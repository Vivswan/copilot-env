import {
  everywhere,
  lintCases,
  lintFixtures,
  repositoryOverrides,
} from "../helpers/biome_plugin.ts";
import { expect, test } from "../helpers/testing.ts";

// A no-op rule passes `biome ci` exactly as quietly as a clean tree does, so the rule's teeth
// and the scope biome.json gives it are pinned here rather than assumed.

const PLUGIN = "biome/no_unmanaged_child_spawn.grit";

// Every route to a child process, and the sanctioned helper beside them: one diagnostic per
// construction or import of the banned modules, none for anything else.
const SOURCES: [source: string, diagnostics: number][] = [
  // Every spelling of the spawn entry points.
  'Bun.spawn(["x"]);',
  'Bun.spawnSync(["x"]);',
  // A call-shaped rule would miss these: stored first, then called; the member reached without
  // writing `Bun.spawn` literally.
  'const s = Bun.spawn; s(["x"]);',
  'globalThis.Bun.spawn(["x"]);',
  'Bun["spawn"](["x"]);',
  'Bun["spawnSync"](["x"]);',
  "const { spawn } = Bun;",
  "const { spawnSync: run } = Bun;",
  'const { "spawn": run } = globalThis.Bun;',
  // The other route, node:child_process, banned wholesale: every import FORM, since enumerating
  // entry points would miss `import * as cp`.
  'import { spawn } from "node:child_process";',
  'import * as cp from "node:child_process";',
  'import cp from "node:child_process";',
  'import "node:child_process";',
  'const cp = await import("node:child_process");',
  'import { spawnSync } from "child_process";',
  // Even the synchronous entry points: run.ts is the suite's one process boundary, and runSync
  // is how a test reaches spawnSync.
  'import { spawnSync } from "node:child_process";',
  // An inline `{ type X }` leaves a runtime import statement behind (verbatimModuleSyntax).
  'import { type ChildProcess } from "node:child_process";',
]
  .map((source): [string, number] => [source, 1])
  .concat([
    // Type imports are erased, so they reach no API.
    ['import type { spawnSync } from "node:child_process";', 0],
    ['import type * as cp from "node:child_process";', 0],
    ['import { spawn } from "./my_helper.ts";', 0],
    // The sanctioned helper and unrelated code are left alone.
    ['const c = spawnChild("x", { args: [] });', 0],
    ['foo.spawn("x");', 0],
    ["const { which } = Bun;", 0],
    ["const { spawn } = other;", 0],
    ["const v = Bun.which('x');", 0],
  ]);

test("no-unmanaged-child-spawn: every route to a child process is rejected, and nothing else", () => {
  const counts = lintCases(
    PLUGIN,
    SOURCES.map(([source]) => source),
  );
  expect(SOURCES.map(([source], i) => [source, counts[i]])).toEqual(SOURCES);
});

test("biome.json scopes the rule to the test tree, minus the two files that own a spawn", () => {
  // Under the repository's own overrides: a typo in a glob would turn the rule off for the files
  // it exists for, and `biome ci` would pass vacuously.
  const raw = 'Bun.spawn(["x"]);';
  const files = {
    "test/example.test.ts": raw,
    "test/helpers/mcp.ts": raw,
    "test/helpers/run.ts": raw, // the process boundary
    "test/helpers/testing.ts": raw, // the deadline's own teardown
    // Runtime code and standalone scripts own their own process lifecycles.
    "src/copilot_api/process.ts": raw,
    "scripts/test_docker.ts": raw,
  };
  // The counts are every plugin's: in a unit file the e2e-boundary rule
  // (biome/no_e2e_helper_imports.grit) reports the same spawn, so test/example.test.ts reads 2;
  // mcp.ts is a banned helper that rule leaves alone, so it reads this rule's 1.
  expect(lintFixtures(files, repositoryOverrides())).toEqual({
    "test/example.test.ts": 2,
    "test/helpers/mcp.ts": 1,
    "test/helpers/run.ts": 0,
    "test/helpers/testing.ts": 0,
    "src/copilot_api/process.ts": 0,
    "scripts/test_docker.ts": 0,
  });
  // Control: the same files under the rule alone, so a scope that matched nothing is told apart
  // from a rule that matched nothing.
  expect(Object.values(lintFixtures(files, everywhere(PLUGIN)))).toEqual([1, 1, 1, 1, 1, 1]);
});
