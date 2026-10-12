// TypeScript read as syntax, for the tests that scan source rather than run it: the import graph
// the layering lint checks, the exported names the architecture page claims, the env keys a shim
// spells, the filesystem APIs a module reaches. oxc-parser, because the TypeScript package the
// repository type-checks with (7.x) is the native compiler and ships no compiler API, and
// Bun.Transpiler drops type-only imports and type exports, which the graph and the page need.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type EcmaScriptModule,
  type Program,
  parseSync,
  Visitor,
  type VisitorObject,
} from "oxc-parser";

export interface ParsedModule {
  path: string;
  source: string;
  program: Program;
  module: EcmaScriptModule;
}

/** A syntax error here is a test failure naming the file: the scanners have no answer for a
 *  module the parser could not read. Parentheses are not kept as nodes, so `(fs).rmSync` reads
 *  as the member expression it is. */
export function parseModule(path: string, source = readFileSync(path, "utf8")): ParsedModule {
  const parsed = parseSync(path, source, { preserveParens: false });
  const error = parsed.errors[0];
  if (error !== undefined) throw new Error(`${path}: ${error.message}`);
  return { path, source, program: parsed.program, module: parsed.module };
}

/** One pass of the parser's visitor over `program`, in source order. */
export function visit(program: Program, handlers: VisitorObject): void {
  new Visitor(handlers).visit(program);
}

/**
 * Every module specifier `parsed` names statically: static imports (type-only included),
 * re-exports, and `import()` of a string literal. An `import()` of a computed value is not a
 * specifier and is skipped, as any graph reader must.
 */
export function moduleSpecifiers(parsed: ParsedModule): string[] {
  const out: string[] = [];
  for (const entry of parsed.module.staticImports) out.push(entry.moduleRequest.value);
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest !== null) out.push(entry.moduleRequest.value);
    }
  }
  visit(parsed.program, {
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        out.push(node.source.value);
      }
    },
  });
  return out;
}

/** A relative specifier resolved against the importing file the way bun resolves it (an
 *  extension may be elided), else null: a bare, `node:`, or `npm:` specifier names no file of the
 *  checkout. A relative specifier naming no file throws, as the import itself would. */
export function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  return Bun.resolveSync(specifier, dirname(from));
}

/**
 * The names `path` exports, values and types alike: a local declaration under its exported name,
 * `export { a as b }` as b, `export * as ns` as ns, and `export * from` carrying the target's
 * names (a star never re-exports a default). A star onto a module outside the checkout (a bare
 * specifier) carries nothing: the reader's claims name repository files.
 */
export function exportedNames(path: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(path)) return names;
  seen.add(path);
  const parsed = parseModule(path);
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const { exportName, importName, moduleRequest } = entry;
      if (exportName.kind === "Name" && exportName.name !== null) {
        names.add(exportName.name);
      } else if (exportName.kind === "Default") {
        names.add("default");
      } else if (importName.kind === "AllButDefault" && moduleRequest !== null) {
        const target = resolveRelative(path, moduleRequest.value);
        if (target === null) continue;
        for (const name of exportedNames(target, seen)) {
          if (name !== "default") names.add(name);
        }
      }
    }
  }
  return names;
}
