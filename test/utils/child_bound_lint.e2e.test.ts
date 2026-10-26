import {
  everywhere,
  lintCases,
  lintFixtures,
  repositoryOverrides,
} from "../helpers/biome_plugin.ts";
import { expect, test } from "../helpers/testing.ts";

// A no-op rule passes `biome ci` exactly as quietly as a clean tree does, so the rule's teeth and
// the scope biome.local.jsonc gives it are pinned here rather than assumed.

/** The rule under test: its grit file, checkout-relative. */
const PLUGIN = "biome/no_unbounded_child_spawn.grit";

// Unbounded entry points beside bounded calls and the sanctioned excuse: one diagnostic per unbounded call, none else.
const SOURCES: [source: string, diagnostics: number][] = [
  // Each entry point, bare and as a member, with no options or options that carry no bound.
  'spawnSync("ps", ["-U"]);',
  'spawnSync("ps", ["-U"], { encoding: "utf8" });',
  'execFile("ps", ["-U"], (error, stdout) => {});',
  'execFile("ps", ["-U"], { maxBuffer: 1 }, (error, stdout) => {});',
  'execFileSync("ps", ["-U"], { encoding: "utf8" });',
  'spawn(s.file, s.args, { stdio: "pipe" });',
  'cp.spawnSync("ps", ["-U"], { encoding: "utf8" });',
  // The one-argument forms, which have no options at all.
  'execFileSync("whoami");',
  'spawnSync("ps");',
  'cp.execFileSync("whoami");',
  // A bound the rule cannot see is no bound: options held in a variable, a spread that may or may
  // not carry one, a `timeout` nested under another key or inside the callback.
  "spawnSync(command, args, options);",
  'spawnSync(command, args, { stdio: "inherit", ...options });',
  'spawnSync("ps", ["-U"], { env: { timeout: "1" } });',
  'execFile("ps", ["-U"], (error) => { const retry = { timeout: 1 }; });',
  // A `timeout` that is no bound by construction: `undefined` or 0, a conditional with
  // `undefined` behind any arm, an optional chain, a call, arithmetic.
  'spawnSync("ps", ["-U"], { timeout: undefined, killSignal: "SIGKILL" });',
  'spawnSync("ps", ["-U"], { timeout: 0, killSignal: "SIGKILL" });',
  'spawnSync("npm", ["view"], { timeout: capture ? 30_000 : undefined, killSignal: "SIGKILL" });',
  'spawnSync("ps", ["-U"], { timeout: slow ? 5000 : capture ? 5000 : undefined });',
  'spawnSync("ps", ["-U"], { timeout: opts?.timeout });',
  'spawnSync("ps", ["-U"], { timeout: bound() });',
  'spawnSync("ps", ["-U"], { timeout: 5 * 1000 });',
  // An alias would hide the call from the name list, so the import is the diagnostic: one for the
  // import, none for the call through it.
  'import { spawnSync as probe } from "node:child_process";\nprobe("ps", ["-U"], { encoding: "utf8" });',
  'import { type SpawnSyncReturns, execFile as run } from "child_process";',
  // A suppression naming another rule leaves the diagnostic in place.
  '// biome-ignore lint/style/useConst: unrelated\nspawnSync("ps", ["-U"]);',
]
  .map((source): [string, number] => [source, 1])
  .concat([
    // An options literal whose `timeout` is a number literal, a named constant, a member, or the
    // shorthand is bounded, wherever the overload puts it.
    ['spawnSync("ps", ["-U"], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });', 0],
    ['spawnSync("ps", ["-U"], { timeout: PROCESS_SCAN_TIMEOUT_MS, killSignal: "SIGKILL" });', 0],
    ['spawnSync("ps", ["-U"], { timeout });', 0],
    ['spawnSync("ps", { timeout: 5000, killSignal: "SIGKILL" });', 0],
    ['execFile("ps", ["-U"], { timeout: 5, killSignal: "SIGKILL" }, (error, stdout) => {});', 0],
    ['execFile("ps", { timeout: 5000, killSignal: "SIGKILL" }, (error, stdout) => {});', 0],
    ['spawn(s.file, s.args, { stdio: "pipe", timeout: s.timeout });', 0],
    // The excuse a child that runs for the user carries at its call site.
    [
      '// biome-ignore lint/plugin/no_unbounded_child_spawn: the daemon runs for the user\nspawnSync("ps", ["-U"]);',
      0,
    ],
    // The names under their own names, an alias of a name from another module, and the erased
    // type-only forms.
    ['import { type SpawnSyncReturns, spawnSync } from "node:child_process";', 0],
    ['import { spawnSync as probe } from "./fake_spawn.ts";', 0],
    ['import type { spawnSync as Probe } from "node:child_process";', 0],
    ['import { type spawnSync as Probe } from "node:child_process";', 0],
    // A one-argument `spawn` is as often a callback as a child, and Bun.spawn takes its options
    // inside its one argument; other callables are not spawns.
    ["function run(spawn) { return spawn(env); }", 0],
    ["spawn();", 0],
    ['Bun.spawn(["x"]);', 0],
    ['spawnChild("x", { args: [] });', 0],
  ]);

test("no-unbounded-child-spawn: every unbounded child_process call is rejected, and nothing else", () => {
  const counts = lintCases(
    PLUGIN,
    SOURCES.map(([source]) => source),
  );
  expect(SOURCES.map(([source], i) => [source, counts[i]])).toEqual(SOURCES);
});

test("biome.local.jsonc scopes the rule to src/, where every subtree is covered", () => {
  // Under the repository's own overrides: a typo in the glob would turn the rule off for the files
  // it exists for, and `biome ci` would pass vacuously.
  const raw = 'spawnSync("ps", ["-U"], { encoding: "utf8" });';
  const files = {
    "src/utils/example.ts": raw,
    "src/commands/example.ts": raw,
    "src/scripts/example.ts": raw,
    // Tests and standalone scripts build their children elsewhere (run.ts, their own lifecycles).
    "test/example.e2e.test.ts": raw,
    "scripts/example.ts": raw,
  };
  expect(lintFixtures(files, repositoryOverrides())).toEqual({
    "src/utils/example.ts": 1,
    "src/commands/example.ts": 1,
    "src/scripts/example.ts": 1,
    "test/example.e2e.test.ts": 0,
    "scripts/example.ts": 0,
  });
  // Control: the same files under the rule alone, so a scope that matched nothing is told apart
  // from a rule that matched nothing.
  expect(Object.values(lintFixtures(files, everywhere(PLUGIN)))).toEqual([1, 1, 1, 1, 1]);
});
