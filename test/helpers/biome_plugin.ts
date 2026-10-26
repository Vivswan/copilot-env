// A GritQL rule under biome/ is a lint plugin, and a plugin with no teeth passes `biome ci` as
// quietly as a clean tree does, so each rule's fixture test lints hand-written offenders through
// the real biome binary: a scratch project under the temp root, one file per case, linted in ONE
// biome run (a spawn per case would cost seconds per rule).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, runSync } from "./run.ts";
import { tempDir } from "./testing.ts";

/** biome.local.jsonc's `overrides` entry, as this repository writes it: a path scope and the plugins it
 *  turns on there. */
export interface PluginOverride {
  includes: string[];
  plugins: string[];
}

/** biome.local.jsonc's plugin paths are config-relative; the scratch config is elsewhere, so each
 *  becomes absolute. Forward slashes: biome reads the config as JSON on every platform. */
function absolutePlugin(plugin: string): string {
  return join(ROOT, plugin).replaceAll("\\", "/");
}

/** The plugin diagnostics biome reports per file of a scratch project.
 *    files      -> repo-relative path (so an override's globs apply as they do in the tree) ->
 *                  source text
 *    overrides  -> the scopes to lint under: the repository's own, or one entry that turns a
 *                  single plugin on everywhere
 *  Every file of `files` is a key of the result, with 0 where biome reported nothing, so a case
 *  biome never saw (a glob that excluded it) reads as 0 and the caller's expectation decides. */
export function lintFixtures(
  files: Record<string, string>,
  overrides: PluginOverride[],
): Record<string, number> {
  const project = tempDir("copilot-biome-fixture-");
  for (const [path, source] of Object.entries(files)) {
    const target = join(project, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  writeFileSync(
    join(project, "biome.json"),
    JSON.stringify({
      formatter: { enabled: false },
      linter: { enabled: true, rules: { recommended: false } },
      files: { includes: ["**"] },
      overrides: overrides.map((entry) => ({
        includes: entry.includes,
        plugins: entry.plugins.map(absolutePlugin),
      })),
    }),
  );
  // The package's JS launcher under the running bun, never the .bin shim: the shim is a .cmd on
  // Windows, which needs a shell and splits a checkout path with spaces.
  const launcher = join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");
  const result = runSync(
    process.execPath,
    [launcher, "lint", "--max-diagnostics=10000", "--reporter=json", "."],
    { cwd: project },
  );
  // Exit 1 is biome's "the lint found errors", which is the point; anything else is a broken run.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`biome lint exited ${result.exitCode}: ${result.stderr}${result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    diagnostics: { category?: string; location?: { path?: string } }[];
  };
  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(files).map((path) => [path, 0]),
  );
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.category !== "plugin") continue;
    const path = diagnostic.location?.path?.replaceAll("\\", "/");
    if (path === undefined || !(path in counts)) {
      throw new Error(`a plugin diagnostic landed on an unknown file: ${JSON.stringify(path)}`);
    }
    counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}

/** One plugin over every file, for a rule's own case table. */
export function everywhere(plugin: string): PluginOverride[] {
  return [{ includes: ["**"], plugins: [plugin] }];
}

/** The repository's own scopes, read from biome.local.jsonc (the layer the managed biome.json
 *  extends), so a scope test lints under exactly what `biome ci` applies. */
export function repositoryOverrides(): PluginOverride[] {
  const config = Bun.JSONC.parse(readFileSync(join(ROOT, "biome.local.jsonc"), "utf8")) as {
    overrides?: Partial<PluginOverride>[];
  };
  return (config.overrides ?? []).filter(
    (entry): entry is PluginOverride => entry.plugins !== undefined,
  );
}

/** Per-case counts for one rule: `cases[i]` is linted as its own file and its count returned in
 *  order. */
export function lintCases(plugin: string, cases: readonly string[]): number[] {
  const files = Object.fromEntries(
    cases.map((source, index) => [`case_${String(index).padStart(3, "0")}.ts`, source]),
  );
  const counts = lintFixtures(files, everywhere(plugin));
  return Object.keys(files).map((path) => counts[path] ?? 0);
}
