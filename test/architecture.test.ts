// The layering lint over architecture.json: the declaration must equal the import graph under
// src/ in BOTH directions, so a forbidden import and a stale allowance both fail, and a file no
// layer owns is never dropped silently.

import { readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImportGraph, lintArchitecture, readArchitecture } from "./lint/architecture.ts";
import { importSpecifier, ROOT, runSync } from "./helpers/run.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";

const arch = readArchitecture(ROOT);

interface DenoInfo {
  modules: {
    specifier: string;
    error?: string;
    dependencies?: { code?: { specifier?: string }; type?: { specifier?: string } }[];
  }[];
}

/** A file URL deno resolved -> its repo-relative posix path, or null outside src/. */
function sourcePath(specifier: string | undefined): string | null {
  if (specifier === undefined || !specifier.startsWith("file:")) return null;
  const rel = relative(ROOT, fileURLToPath(specifier)).replaceAll("\\", "/");
  return rel.startsWith("src/") ? rel : null;
}

/**
 * The import graph under src/ as deno resolves it (`deno info --json`): one synthetic entry
 * imports every source file, so a file nothing imports is a module of the graph too. Exact for
 * static, type-only, re-export, and string-literal dynamic imports, with no parser of our own.
 */
function importGraph(): ImportGraph {
  const files = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(ROOT, "src", entry));
  const dir = tempDir("arch-graph-");
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, files.map((file) => `import ${importSpecifier(file)};`).join("\n"));
    const result = runSync(
      Deno.execPath(),
      ["info", "--json", "--config", join(ROOT, "deno.json"), entry],
      { cwd: ROOT },
    );
    if (result.exitCode !== 0) throw new Error(`deno info failed: ${result.stderr}`);
    const graph = new Map<string, string[]>();
    for (const mod of (JSON.parse(result.stdout) as DenoInfo).modules) {
      if (mod.error !== undefined) throw new Error(`${mod.specifier}: ${mod.error}`);
      const file = sourcePath(mod.specifier);
      if (file === null) continue;
      const targets = new Set<string>();
      for (const dep of mod.dependencies ?? []) {
        for (const target of [sourcePath(dep.code?.specifier), sourcePath(dep.type?.specifier)]) {
          if (target !== null) targets.add(target);
        }
      }
      graph.set(file, [...targets].sort());
    }
    return graph;
  } finally {
    removeDir(dir);
  }
}

let graphMemo: ImportGraph | undefined;
function graph(): ImportGraph {
  graphMemo ??= importGraph();
  return graphMemo;
}

test("the imports under src/ match architecture.json exactly", () => {
  expect(lintArchitecture(arch, graph())).toEqual([]);
});

test("an undeclared edge fails as a forbidden import naming both files", () => {
  // `cli -> commands` is the edge src/cli.ts draws to every command file.
  const withoutEdge = {
    ...arch,
    edges: { ...arch.edges, cli: (arch.edges.cli ?? []).filter((to) => to !== "commands") },
  };
  const problems = lintArchitecture(withoutEdge, graph());
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(
    /^forbidden import cli -> commands: src\/cli\.ts -> src\/commands\/[a-z_]+\.ts, .*; move it or declare the edge$/,
  );
});

test("a declared edge no file draws fails as a stale allowance", () => {
  // Nothing under src/ imports src/cli.ts.
  const withStale = {
    ...arch,
    edges: { ...arch.edges, utils: [...(arch.edges.utils ?? []), "cli"] },
  };
  expect(lintArchitecture(withStale, graph())).toEqual([
    "stale allowance utils -> cli: no file draws it; remove it from architecture.json",
  ]);
});

test("a src file outside every layer is reported, as a source and as a target", () => {
  const { proxy_float: _dropped, ...layers } = arch.layers;
  const edges = Object.fromEntries(
    Object.entries(arch.edges)
      .filter(([from]) => from !== "proxy_float")
      .map(([from, targets]) => [from, targets.filter((to) => to !== "proxy_float")]),
  );
  const problems = lintArchitecture({ ...arch, layers, edges }, graph());
  expect(problems).toContain("src/proxy_float.ts belongs to no layer in architecture.json");
  expect(problems).toContain(
    "src/proxy_float.ts (imported by src/copilot_api/launch.ts) belongs to no layer in architecture.json",
  );
});
