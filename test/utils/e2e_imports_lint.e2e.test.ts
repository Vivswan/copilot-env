import {
  everywhere,
  lintCases,
  lintFixtures,
  repositoryOverrides,
} from "../helpers/biome_plugin.ts";
import { expect, test } from "../helpers/testing.ts";

// A no-op rule passes `biome ci` exactly as quietly as a clean tree does, so the rule's teeth
// and the scope biome.json gives it (every test/ source but the *.e2e.test.ts files and the
// banned helpers themselves) are pinned here rather than assumed. The sources cover every import
// form of the helper modules that spawn or listen, the listener and process modules and Bun APIs
// reached directly, every route to env.ts's two home-sandbox entry points, and beside them the
// imports a unit file may make.

/** The rule under test: its grit file, checkout-relative. */
const PLUGIN = "biome/no_e2e_helper_imports.grit";

// One diagnostic per banned import, none for the imports a unit file may make.
const SOURCES: [source: string, diagnostics: number][] = [
  'import { runCli } from "../helpers/run.ts";',
  'import { startDaemon } from "../../helpers/daemon.ts";',
  'import * as mcp from "../helpers/mcp.ts";',
  'import "../helpers/fake_endpoint.ts";',
  'import { scenario } from "../helpers/fake_model_endpoint.ts";',
  'import { scratchHome } from "../helpers/scratch_home.ts";',
  'import { freePort } from "../helpers/net.ts";',
  'import { lintCases } from "../helpers/biome_plugin.ts";',
  'import { fakeCodexOnPath } from "../helpers/fake_codex.ts";',
  'import { runCurrentCost } from "../helpers/usage_goldens.ts";',
  // A test at the root of test/ reaches the helpers without climbing.
  'import { runCli } from "./helpers/run.ts";',
  // Every path the resolver takes to the same file: no extension, a .js spelling, a `./`
  // segment, a climb back in through test/.
  'import { runCli } from "../helpers/run";',
  'import { runCli } from "../helpers/run.js";',
  'import { runCli } from "../helpers/./run.ts";',
  'import { runCli } from "../../test/helpers/run.ts";',
  // A helper reaching a banned sibling: no helpers/ segment in the path.
  'export { runCli } from "./run.ts";',
  'import { startDaemon } from "./daemon.ts";',
  'import { runCli } from "../helpers/sub/../run.ts";',
  'const run = await import("../helpers/run.ts");',
  // A template literal with nothing to substitute is as static as the quoted form.
  "const run = await import(`../helpers/run.ts`);",
  'export * from "../helpers/run.ts";',
  'export * as run from "../helpers/run.ts";',
  'export { runCli } from "../helpers/run.ts";',
  // An inline `{ type X }` leaves a runtime import statement behind (verbatimModuleSyntax).
  'import { type RunResult } from "../helpers/run.ts";',
  // A process by hand, under either module name.
  'import { spawn } from "node:child_process";',
  'import "child_process";',
  // A listener or a process reached directly, by module or by Bun API, under every spelling the
  // child-spawn rule covers: a member read, a computed member, globalThis, a destructuring.
  'import { createServer } from "node:net";',
  'import "node:http";',
  'import * as https from "https";',
  'import { connect } from "node:http2";',
  'import { createSocket } from "node:dgram";',
  "Bun.serve({ fetch: () => new Response() });",
  "Bun.listen({ hostname: 'x', port: 0, socket: {} });",
  "Bun.connect({ hostname: 'x', port: 1, socket: {} });",
  'Bun.spawn(["x"]);',
  'Bun.spawnSync(["x"]);',
  "globalThis.Bun.serve({});",
  'Bun["listen"]({});',
  "const { serve } = Bun;",
  "const { spawn: run } = globalThis.Bun;",
  // The "bun" module reached as a value, under every import form: the module's `$` spawns too,
  // and an alias would make a name list leaky, so the module is the unit.
  'import { serve } from "bun";',
  'import { spawnSync as run } from "bun";',
  'import * as bun from "bun";',
  'import bun from "bun";',
  'import { $ } from "bun";',
  'import { type Serve, serve } from "bun";',
  'const b = await import("bun");',
  'export { serve } from "bun";',
  'export * from "bun";',
  // require, under any spelling: the identifier is the hit, so an alias is one too.
  'const { runCli } = require("../helpers/run.ts");',
  "const load = require;",
  // The home sandbox: the two entry points, by name, aliased, read off the namespace, or
  // destructured out of it.
  'import { isolateAgentHomes } from "../helpers/env.ts";',
  'import { agentHomeEnv as homeEnv } from "../helpers/env.ts";',
  'import * as env from "../helpers/env.ts"; env.isolateAgentHomes("x");',
  'import * as env from "../helpers/env.ts"; env["agentHomeEnv"]("x");',
  'import * as env from "../helpers/env.ts"; const { isolateAgentHomes: isolate } = env;',
  'import * as env from "../helpers/env.ts"; const { agentHomeEnv } = env;',
]
  .map((source): [string, number] => [source, 1])
  .concat([
    // Type imports are erased, so they reach nothing.
    ['import type { RunResult } from "../helpers/run.ts";', 0],
    ['import type { Serve } from "bun";', 0],
    ['import { type Serve, type Subprocess } from "bun";', 0],
    ['import { expect, test } from "bun:test";', 0],
    ['import type { AgentHomes } from "../helpers/env.ts";', 0],
    ['import { type AgentHomes, envSnapshot } from "../helpers/env.ts";', 0],
    // What a unit file does import: the runner, the env snapshot, the proxy-only home.
    ['import { expect, tempDir, test } from "../helpers/testing.ts";', 0],
    ['import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";', 0],
    ['import { readTree } from "../helpers/tree.ts";', 0],
    // A name that only resembles a banned one, and a member read of anything else.
    ['import { runner } from "../helpers/runner.ts";', 0],
    ['import { runner } from "./runner.ts";', 0],
    ['import { outputOf } from "./subprocess.ts";', 0],
    ['import * as env from "../helpers/env.ts"; env.isolateProxyHome("x");', 0],
    ["const home = homes.dir;", 0],
    // Bun's other members, a stubbed HTTP client, and a type reference to a Bun class.
    ['Bun.which("x"); const { env } = Bun;', 0],
    ['import { request } from "undici";', 0],
    ["type Out = Bun.Subprocess['stdout'];", 0],
  ]);

test("no-e2e-helper-imports: every import of a spawning or listening helper is rejected, and nothing a unit file needs", () => {
  const counts = lintCases(
    PLUGIN,
    SOURCES.map(([source]) => source),
  );
  expect(SOURCES.map(([source], i) => [source, counts[i]])).toEqual(SOURCES);
});

test("biome.json scopes the rule to every test/ source but the *.e2e.test.ts files, the banned helpers, and testing.ts", () => {
  // Under the repository's own overrides: a typo in a glob would turn the rule off for the files
  // it exists for, and `biome ci` would pass vacuously. A helper that re-exports a banned one is
  // the case the scope exists for: left unlinted, it would hand a unit test the spawn unseen.
  const raw = 'import { runCli } from "../helpers/run.ts";';
  const files = {
    "test/example.test.ts": raw,
    "test/commands/example.test.ts": raw,
    "test/commands/example.e2e.test.ts": raw,
    "test/commands/listener.e2e.test.ts": "Bun.serve({});",
    "test/helpers/unit_support.ts": 'export { runCli } from "./run.ts";',
    "test/helpers/plain.ts": 'import { tempDir } from "./testing.ts";',
    "test/helpers/run.ts": 'import { spawnSync } from "node:child_process";',
    // Exempt for one reason: it imports nothing banned, and the child-spawn rule's scope fixture
    // pins its finding count, which this rule would change.
    "test/helpers/testing.ts": 'Bun.spawn(["x"]);',
    "test/commands/bun_module.e2e.test.ts": 'import { serve } from "bun";',
    "test/helpers/mcp.ts": raw,
    "test/lint/example.ts": 'import { createServer } from "node:net";',
    "src/example.ts": raw,
    "scripts/example.ts": raw,
  };
  expect(lintFixtures(files, repositoryOverrides())).toEqual({
    "test/example.test.ts": 1,
    "test/commands/example.test.ts": 1,
    "test/commands/example.e2e.test.ts": 0,
    "test/commands/listener.e2e.test.ts": 0,
    "test/helpers/unit_support.ts": 1,
    "test/helpers/plain.ts": 0,
    "test/helpers/run.ts": 0,
    "test/helpers/testing.ts": 0,
    "test/commands/bun_module.e2e.test.ts": 0,
    "test/helpers/mcp.ts": 0,
    "test/lint/example.ts": 1,
    "src/example.ts": 0,
    "scripts/example.ts": 0,
  });
  // Control: the same files under the rule alone, so a scope that matched nothing is told apart
  // from a rule that matched nothing; plain.ts imports nothing banned and is 0 either way.
  expect(lintFixtures(files, everywhere(PLUGIN))).toEqual({
    "test/example.test.ts": 1,
    "test/commands/example.test.ts": 1,
    "test/commands/example.e2e.test.ts": 1,
    "test/commands/listener.e2e.test.ts": 1,
    "test/helpers/unit_support.ts": 1,
    "test/helpers/plain.ts": 0,
    "test/helpers/run.ts": 1,
    "test/helpers/testing.ts": 1,
    "test/commands/bun_module.e2e.test.ts": 1,
    "test/helpers/mcp.ts": 1,
    "test/lint/example.ts": 1,
    "src/example.ts": 1,
    "scripts/example.ts": 1,
  });
});
