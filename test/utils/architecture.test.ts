// The layering lint over architecture.json: the declaration must equal the import graph under
// src/ in BOTH directions, so a forbidden import and a stale allowance both fail, and a file no
// layer owns is never dropped silently.

import { join, relative } from "node:path";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { moduleSpecifiers, parseModule, resolveRelative } from "../helpers/syntax.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";
import { type ImportGraph, lintArchitecture, readArchitecture } from "../lint/architecture.ts";

const arch = readArchitecture(PROJECT_ROOT);

/**
 * The import graph under src/ as the parser reads it (test/helpers/syntax.ts): every source file
 * is a module of the graph, imported or not, and an edge is every specifier a file names
 * statically (static, type-only, re-export, side-effect, and string-literal dynamic imports
 * alike) that resolves to another file under src/. A relative specifier naming no file throws
 * in the resolver: a graph that silently dropped it would read a broken import as a missing edge.
 */
function importGraph(): ImportGraph {
  const files = tsFilesUnder(join(PROJECT_ROOT, "src"));
  const repoPath = (file: string): string => relative(PROJECT_ROOT, file).replaceAll("\\", "/");
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of moduleSpecifiers(parseModule(file))) {
      const target = resolveRelative(file, specifier);
      if (target === null) continue;
      const path = repoPath(target);
      if (path.startsWith("src/")) targets.add(path);
    }
    graph.set(repoPath(file), [...targets].sort());
  }
  if (graph.size !== files.length) {
    throw new Error(`the graph lists ${graph.size} of ${files.length} source files as modules`);
  }
  return graph;
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
        `forbidden import cli -> commands: ${cliImports
          .filter((to) => to.startsWith("src/commands/"))
          .map((to) => `src/cli.ts -> ${to}`)
          .join(", ")}; move it or declare the edge`,
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
        ...proxyFloatImporters.map(
          (file) =>
            `src/proxy_float.ts (imported by ${file}) belongs to no layer in architecture.json`,
        ),
      ],
    },
  ];
  for (const row of rows) {
    const problems = lintArchitecture(row.edit(arch), graph()).sort();
    expect({ name: row.name, problems }).toEqual({ name: row.name, problems: row.problems.sort() });
  }
});
