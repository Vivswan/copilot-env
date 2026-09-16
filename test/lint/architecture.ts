// One layering declaration (architecture.json at the repo root), two readers: the lint
// (test/architecture.test.ts) and the module map (scripts/docs_arch.ts, spliced into
// docs/architecture.md). The lint fails in both directions so the declaration cannot rot:
//   an import between layers with no declared edge  -> "forbidden import"
//   a declared edge no file draws                   -> "stale allowance"
//   a graph file no layer owns                      -> "belongs to no layer"
//
// The import graph itself comes from deno (`deno info --json`, test/architecture.test.ts), so an
// edge is exactly what deno resolves: static, type-only, re-export, side-effect, and
// string-literal dynamic imports alike. Imports inside one layer are not edges.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ARCHITECTURE_FILE = "architecture.json";

export interface Architecture {
  /** layer -> the repo-relative paths it owns; a trailing slash means a directory. */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  /** Paths (same grammar as a layer's) that are not SOURCES of the graph; an import into one is
   *  still an edge. */
  readonly exclude: readonly string[];
  /** from -> the layers it may import; a layer absent here imports nothing outside itself. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

/** Repo-relative posix source file -> the repo-relative files it imports (in-repo targets only). */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringListRecord(value: unknown): value is Record<string, string[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(isStringList);
}

/** The declaration under `root`, shape-checked: a typo in a layer name under `edges`, or two layers
 *  claiming one path, is an error here rather than a silent pass. */
export function readArchitecture(root: string): Architecture {
  const parsed: unknown = JSON.parse(readFileSync(join(root, ARCHITECTURE_FILE), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${ARCHITECTURE_FILE}: must be an object with layers, exclude, and edges`);
  }
  const { layers, exclude = [], edges = {} } = parsed as Record<string, unknown>;
  if (!isStringListRecord(layers) || Object.keys(layers).length === 0) {
    throw new Error(`${ARCHITECTURE_FILE}: layers must map each layer name to a list of paths`);
  }
  if (!isStringList(exclude)) {
    throw new Error(`${ARCHITECTURE_FILE}: exclude must be a list of paths`);
  }
  if (!isStringListRecord(edges)) {
    throw new Error(`${ARCHITECTURE_FILE}: edges must map each layer name to a list of layers`);
  }
  for (const [from, targets] of Object.entries(edges)) {
    for (const name of [from, ...targets]) {
      if (!Object.hasOwn(layers, name)) {
        throw new Error(`${ARCHITECTURE_FILE}: edges name "${name}", which is not a layer`);
      }
    }
  }
  const owned = Object.entries(layers).flatMap(([layer, paths]) =>
    paths.map((path) => ({ layer, path }))
  );
  for (const [i, a] of owned.entries()) {
    for (const b of owned.slice(i + 1)) {
      if (a.layer === b.layer) continue;
      const overlap = a.path === b.path ||
        (a.path.endsWith("/") && b.path.startsWith(a.path)) ||
        (b.path.endsWith("/") && a.path.startsWith(b.path));
      if (overlap) {
        throw new Error(
          `${ARCHITECTURE_FILE}: layers ${a.layer} and ${b.layer} overlap; a file has one owner`,
        );
      }
    }
  }
  return { layers, exclude, edges };
}

function owns(paths: readonly string[], file: string): boolean {
  return paths.some((owned) => owned.endsWith("/") ? file.startsWith(owned) : file === owned);
}

/** The layer owning a repo-relative path, or undefined. */
export function layerOf(arch: Architecture, file: string): string | undefined {
  return Object.entries(arch.layers).find(([, paths]) => owns(paths, file))?.[0];
}

/**
 * The lint verdict for `graph` against `arch`: empty means the declaration is exactly the import
 * graph. Every message names what to change and where.
 */
export function lintArchitecture(arch: Architecture, graph: ImportGraph): string[] {
  const problems: string[] = [];
  const files = [...graph.keys()].sort();
  for (const [layer, paths] of Object.entries(arch.layers)) {
    for (const path of paths) {
      if (!files.some((file) => owns([path], file))) {
        problems.push(`layer ${layer} names ${path}, which owns no file of the graph`);
      }
    }
  }
  const drawn = new Map<string, string[]>();
  for (const file of files) {
    if (owns(arch.exclude, file)) continue;
    const from = layerOf(arch, file);
    if (from === undefined) {
      problems.push(`${file} belongs to no layer in ${ARCHITECTURE_FILE}`);
      continue;
    }
    for (const target of graph.get(file) ?? []) {
      const to = layerOf(arch, target);
      if (to === undefined) {
        problems.push(
          `${target} (imported by ${file}) belongs to no layer in ${ARCHITECTURE_FILE}`,
        );
      } else if (to !== from) {
        const key = `${from} -> ${to}`;
        drawn.set(key, [...(drawn.get(key) ?? []), `${file} -> ${target}`]);
      }
    }
  }
  const declared = new Set(
    Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `${from} -> ${to}`)
    ),
  );
  for (const [key, sites] of [...drawn].sort()) {
    if (!declared.has(key)) {
      problems.push(`forbidden import ${key}: ${sites.join(", ")}; move it or declare the edge`);
    }
  }
  for (const key of [...declared].sort()) {
    if (!drawn.has(key)) {
      problems.push(
        `stale allowance ${key}: no file draws it; remove it from ${ARCHITECTURE_FILE}`,
      );
    }
  }
  return problems;
}

// --- the module map ------------------------------------------------------------

export const GENERATED_BEGIN =
  "<!-- BEGIN GENERATED: architecture-map (deno task docs:arch; derived from architecture.json) -->";
export const GENERATED_END = "<!-- END GENERATED: architecture-map -->";

/** The module map over the DECLARED edges: one node per layer, labelled with the paths it owns.
 *  Layer names are the node ids, so a name must be a mermaid identifier (letters, digits, `_`). */
export function renderArchitectureMap(arch: Architecture): string {
  for (const layer of Object.keys(arch.layers)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(layer)) {
      throw new Error(`layer "${layer}" is not a mermaid node id; use letters, digits, and _`);
    }
  }
  return [
    "graph TD",
    ...Object.entries(arch.layers).map(([name, paths]) => `  ${name}["${paths.join("<br>")}"]`),
    ...Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `  ${from} --> ${to}`)
    ),
  ].join("\n");
}

/** `page` with the body between the two markers replaced by a mermaid fence of `map` (blank
 *  lines around it, as `deno fmt` lays out a fence); exactly one marker pair, or a throw naming
 *  the counts, since a second pair would be spliced blind. */
export function spliceGeneratedRegion(page: string, map: string): string {
  const begins = page.split(GENERATED_BEGIN).length - 1;
  const ends = page.split(GENERATED_END).length - 1;
  if (begins !== 1 || ends !== 1) {
    throw new Error(
      `the page needs exactly one BEGIN and one END architecture-map marker, found ${begins} and ${ends}`,
    );
  }
  const start = page.indexOf(GENERATED_BEGIN) + GENERATED_BEGIN.length;
  const end = page.indexOf(GENERATED_END);
  if (end < start) throw new Error("the END architecture-map marker sits before the BEGIN marker");
  return `${page.slice(0, start)}\n\n\`\`\`mermaid\n${map}\n\`\`\`\n\n${page.slice(end)}`;
}
