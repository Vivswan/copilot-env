// Deno lint plugin: a test may not make its own temp path.
//
// test/helpers/testing.ts owns the ONE temp root of each test module's isolate, removed when
// that isolate unloads, and `tempDir` there is the only way to a temp directory. A path made
// anywhere else sits directly in the OS tmpdir, where nothing removes it once the test that
// made it fails, times out, or forgets -- the suite once left tens of thousands behind, each
// fixture HOME holding its own deno cache.
//
// So the ban is on REACHING a temp-path API at all, under any spelling: node's mkdtemp
// family (plain, Sync, Disposable) and os.tmpdir, Deno's makeTempDir / makeTempFile (and
// their Sync forms) -- as a value import from any module, a member read off any object
// (`fs.mkdtempSync`, `Deno.makeTempDir`, `os.tmpdir`), or a destructuring. Matching the call
// would miss a function stored first; a user property that happens to share a name
// false-positives loudly, which beats a silent miss.
//
// Registered in deno.json, unit-tested in test/temp_dir_lint.test.ts.
import { memberName, testTreePath } from "./test_tree.ts";

/** The helper that owns the temp root and the one sanctioned mkdtemp, relative to the test
 *  tree. */
const HELPER = "helpers/testing.ts";

const TEMP_PATH_APIS: ReadonlySet<string> = new Set([
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "makeTempDir",
  "makeTempDirSync",
  "makeTempFile",
  "makeTempFileSync",
  "tmpdir",
]);

/** The built-in modules whose whole surface carries a temp-path API, so `export * from` one
 *  of them hands the API on too. */
const TEMP_PATH_MODULES: ReadonlySet<string> = new Set([
  "node:fs",
  "node:fs/promises",
  "node:os",
  "fs",
  "fs/promises",
  "os",
]);

const MESSAGE =
  "make temp directories with tempDir (test/helpers/testing.ts), which puts them under the " +
  "root that is removed when the test module ends -- one made here stays in the OS tmpdir " +
  "when its test fails or forgets it";

const plugin: Deno.lint.Plugin = {
  name: "copilot-env-fixtures",
  rules: {
    "no-unmanaged-temp-dir": {
      create(context) {
        const relative = testTreePath(context.filename);
        if (relative === null || relative === HELPER) return {};
        return {
          // `import { mkdtempSync } from "node:fs"`, whatever the module: the same names
          // arrive from "node:fs/promises", "node:os", or a bare "fs" alike. Type imports
          // are erased, so they reach no API.
          "ImportDeclaration"(node) {
            if (node.importKind === "type") return;
            for (const specifier of node.specifiers) {
              if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") {
                continue;
              }
              const imported = specifier.imported;
              const name = imported.type === "Identifier" ? imported.name : imported.value;
              if (typeof name === "string" && TEMP_PATH_APIS.has(name)) {
                context.report({ node: specifier, message: MESSAGE });
              }
            }
          },
          // `export * from "node:fs"`: the whole surface, temp APIs included, handed on.
          "ExportAllDeclaration"(node) {
            if (node.exportKind !== "type" && TEMP_PATH_MODULES.has(String(node.source.value))) {
              context.report({ node, message: MESSAGE });
            }
          },
          // `export { mkdtempSync as makeFixture } from "node:fs"`: a value re-export hands the
          // API to whichever module imports the alias.
          "ExportNamedDeclaration"(node) {
            if (node.source === null || node.exportKind === "type") return;
            for (const specifier of node.specifiers) {
              if (specifier.exportKind === "type") continue;
              const local = specifier.local;
              const name = local.type === "Identifier" ? local.name : local.value;
              if (typeof name === "string" && TEMP_PATH_APIS.has(name)) {
                context.report({ node: specifier, message: MESSAGE });
              }
            }
          },
          // `fs.mkdtempSync`, `Deno.makeTempDir`, `os.tmpdir`, `fs["mkdtempSync"]`.
          "MemberExpression"(node) {
            const name = memberName(node);
            if (name !== null && TEMP_PATH_APIS.has(name)) {
              context.report({ node, message: MESSAGE });
            }
          },
          // `const { mkdtempSync } = fs`, `({ makeTempDir } = Deno)`, `{ "tmpdir": t }` -- every
          // destructuring, wherever the pattern sits.
          "ObjectPattern"(node) {
            for (const property of node.properties) {
              if (property.type !== "Property") continue;
              const key = property.key;
              const name = key.type === "Identifier" && !property.computed
                ? key.name
                : key.type === "Literal" && typeof key.value === "string"
                ? key.value
                : null;
              if (name !== null && TEMP_PATH_APIS.has(name)) {
                context.report({ node: property, message: MESSAGE });
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
