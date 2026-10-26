import {
  everywhere,
  lintCases,
  lintFixtures,
  repositoryOverrides,
} from "../helpers/biome_plugin.ts";
import { expect, test } from "../helpers/testing.ts";

// The lint gate keeps the daemon preload shims import-free only if the rule has teeth and
// biome.local.jsonc points it at every shim, so both are pinned against doctored sources.

const PLUGIN = "biome/no_shim_imports.grit";

const SOURCES: [source: string, diagnostics: number][] = [
  ['import { x } from "./cli.ts";', 1],
  ['import "./side_effect.ts";', 1],
  ['import * as ns from "./cli.ts";', 1],
  ['export * from "./cli.ts";', 1],
  ['export * as cli from "./cli.ts";', 1],
  ['export { x } from "./cli.ts";', 1],
  ['const m = await import("./cli" + ".ts");', 1],
  // Aliasing require is still caught: the identifier is the match, not a call shape.
  ['const r = require; r("node:fs");', 1],
  // An inline `{ type X }` leaves a runtime statement behind (verbatimModuleSyntax).
  ['import { type T } from "./cli.ts";', 1],
  // Erased at runtime: type-only imports and plain sourceless exports stay legal.
  ['import type { T } from "./cli.ts"; export {};', 0],
  ['export type { T } from "./cli.ts";', 0],
  ["export function f(): number { return 1; }", 0],
  ['export const ENV_KEY = "COPILOT_ENV_X";', 0],
];

test("no-shim-imports: rejects every runtime-import shape, allows type-only", () => {
  const counts = lintCases(
    PLUGIN,
    SOURCES.map(([source]) => source),
  );
  expect(SOURCES.map(([source], i) => [source, counts[i]])).toEqual(SOURCES);
});

test("biome.local.jsonc points the rule at each import-free shim and nothing else", () => {
  // The shims that carry a cross-boundary env contract (test/copilot_api/daemon_env_keys.test.ts
  // pins each one's literal); a shim missing here is one a CLI import could reach unseen.
  const importing = 'import { x } from "./cli.ts";';
  const files = {
    "src/scripts/token_argv_preload.ts": importing,
    "src/scripts/pat_passthrough_preload.ts": importing,
    "src/scripts/client_headers_preload.ts": importing,
    "src/scripts/copilot_host_preload.ts": importing,
    // Other preloads import on purpose (the idle watchdog, the daemon lock), and the CLI imports
    // everywhere.
    "src/scripts/idle_watchdog_preload.ts": importing,
    "src/commands/profile.ts": importing,
    "test/helpers/env.ts": importing,
  };
  expect(lintFixtures(files, repositoryOverrides())).toEqual({
    "src/scripts/token_argv_preload.ts": 1,
    "src/scripts/pat_passthrough_preload.ts": 1,
    "src/scripts/client_headers_preload.ts": 1,
    "src/scripts/copilot_host_preload.ts": 1,
    "src/scripts/idle_watchdog_preload.ts": 0,
    "src/commands/profile.ts": 0,
    "test/helpers/env.ts": 0,
  });
  expect(Object.values(lintFixtures(files, everywhere(PLUGIN)))).toEqual([1, 1, 1, 1, 1, 1, 1]);
});
