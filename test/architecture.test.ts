// The layering lint over architecture.json: the declaration must equal the import graph under
// src/ in BOTH directions, so a forbidden import and a stale allowance both fail, and a file no
// layer owns is never dropped silently.

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ImportGraph, lintArchitecture, readArchitecture } from "./lint/architecture.ts";
import { ROOT, runSync } from "./helpers/run.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";

const arch = readArchitecture(ROOT);

interface DenoDependency {
  /** The import text as written. */
  specifier: string;
  code?: { specifier?: string };
  type?: { specifier?: string };
}

interface DenoInfo {
  modules: { specifier: string; error?: string; dependencies?: DenoDependency[] }[];
}

/**
 * The import graph under src/ as deno resolves it (`deno info --json`): one synthetic entry
 * imports every source file by file URL, so a file nothing imports is a module of the graph too.
 * Exact for static, type-only, re-export, and string-literal dynamic imports, with no parser of
 * our own. Deno's own spelling of each file URL is learned from the entry's resolved
 * dependencies, so no path is re-derived here (Windows spells the drive its own way).
 */
function importGraph(): ImportGraph {
  const files = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `src/${entry.replaceAll("\\", "/")}`);
  const hrefs = new Map(files.map((file) => [pathToFileURL(join(ROOT, file)).href, file]));
  const dir = tempDir("arch-graph-");
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      [...hrefs.keys()].map((href) => `import ${JSON.stringify(href)};`).join("\n"),
    );
    const result = runSync(
      Deno.execPath(),
      // As a URL: a bare Windows path (`c:\...`) is not read as a file by every deno.
      ["info", "--json", "--config", join(ROOT, "deno.json"), pathToFileURL(entry).href],
      { cwd: ROOT },
    );
    if (result.exitCode !== 0) throw new Error(`deno info failed: ${result.stderr}`);
    const { modules } = JSON.parse(result.stdout) as DenoInfo;
    for (const mod of modules) {
      if (mod.error !== undefined) throw new Error(`${mod.specifier}: ${mod.error}`);
    }
    // Deno's spelling of each source file's URL -> its repo path, read off the entry's edges.
    const resolved = new Map<string, string>();
    for (const mod of modules) {
      for (const dep of mod.dependencies ?? []) {
        const file = hrefs.get(dep.specifier);
        if (file !== undefined && dep.code?.specifier !== undefined) {
          resolved.set(dep.code.specifier, file);
        }
      }
    }
    if (resolved.size !== files.length) {
      throw new Error(
        `deno info resolved ${resolved.size} of ${files.length} source files (${modules.length} modules; ` +
          `first: ${JSON.stringify(modules[0]).slice(0, 600)})`,
      );
    }
    const graph = new Map<string, string[]>();
    for (const mod of modules) {
      const file = resolved.get(mod.specifier);
      if (file === undefined) continue;
      const targets = new Set<string>();
      for (const dep of mod.dependencies ?? []) {
        for (const spec of [dep.code?.specifier, dep.type?.specifier]) {
          const target = spec === undefined ? undefined : resolved.get(spec);
          if (target !== undefined) targets.add(target);
        }
      }
      graph.set(file, [...targets].sort());
    }
    if (graph.size !== files.length) {
      throw new Error(`the graph lists ${graph.size} of ${files.length} source files as modules`);
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

// Each row breaks the declaration one way; the lint must name the break and nothing else.
test("a forbidden import, a stale allowance, and a file no layer owns are each named exactly", () => {
  type Architecture = ReturnType<typeof readArchitecture>;
  const cliImports = graph().get("src/cli.ts") ?? [];
  const proxyFloatImporters = [...graph()]
    .filter(([, targets]) => targets.includes("src/proxy_float.ts"))
    .map(([file]) => file);
  // Both derivations must find something, or a row below would pin an empty message.
  expect(cliImports.some((to) => to.startsWith("src/commands/"))).toBe(true);
  expect(proxyFloatImporters).not.toEqual([]);
  const rows: { name: string; edit: (arch: Architecture) => Architecture; problems: string[] }[] = [
    {
      // `cli -> commands` is the edge src/cli.ts draws to every command file.
      name: "an undeclared edge fails as a forbidden import naming both files",
      edit: (arch) => ({
        ...arch,
        edges: { ...arch.edges, cli: (arch.edges.cli ?? []).filter((to) => to !== "commands") },
      }),
      problems: [
        `forbidden import cli -> commands: ${
          cliImports.filter((to) => to.startsWith("src/commands/"))
            .map((to) => `src/cli.ts -> ${to}`).join(", ")
        }; move it or declare the edge`,
      ],
    },
    {
      // Nothing under src/ imports src/cli.ts.
      name: "a declared edge no file draws fails as a stale allowance",
      edit: (arch) => ({
        ...arch,
        edges: { ...arch.edges, utils: [...(arch.edges.utils ?? []), "cli"] },
      }),
      problems: [
        "stale allowance utils -> cli: no file draws it; remove it from architecture.json",
      ],
    },
    {
      name: "a src file outside every layer is reported, as a source and as a target",
      edit: (arch) => {
        const { proxy_float: _dropped, ...layers } = arch.layers;
        const edges = Object.fromEntries(
          Object.entries(arch.edges)
            .filter(([from]) => from !== "proxy_float")
            .map(([from, targets]) => [from, targets.filter((to) => to !== "proxy_float")]),
        );
        return { ...arch, layers, edges };
      },
      problems: [
        "src/proxy_float.ts belongs to no layer in architecture.json",
        ...proxyFloatImporters.map((file) =>
          `src/proxy_float.ts (imported by ${file}) belongs to no layer in architecture.json`
        ),
      ],
    },
  ];
  for (const row of rows) {
    const problems = lintArchitecture(row.edit(arch), graph()).sort();
    expect({ name: row.name, problems }).toEqual({ name: row.name, problems: row.problems.sort() });
  }
});
