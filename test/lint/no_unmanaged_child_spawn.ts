// Deno lint plugin: a test may not build its own child process.
//
// The per-test deadline (test/helpers/testing.ts) abandons a timed-out body instead of
// cancelling it, so a child it spawned runs on alongside the tests that follow.
// test/helpers/run.ts is the suite's one process boundary: `spawnChild` there registers
// every child for abort teardown.
//
// So the ban is on REACHING a child-process API at all -- the `Deno.Command` constructor
// under any spelling, and any value import of `node:child_process`. Matching an unwrapped
// spawn shape instead would miss a command stored in a variable first, and enumerating
// entry points would miss `import * as cp`. Type imports are erased, so they stay legal.
//
// Registered in deno.json, unit-tested in test/child_spawn_lint.test.ts.
import { fileURLToPath } from "node:url";

/** The helper that owns the one sanctioned construction, relative to the test tree. */
const HELPER = "helpers/run.ts";

/** The module the ban covers wholesale; run.ts takes its `spawnSync` from here. */
const CHILD_PROCESS_MODULE = "node:child_process";

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The test tree's own path, derived from THIS file (test/lint/) so the scope tracks the
 *  directory itself rather than any ancestor that happens to be named "test".
 *  fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and would match
 *  nothing, silently disabling the rule across the whole tree. */
const TEST_DIR = normalize(fileURLToPath(new URL("../", import.meta.url)));

/** `filename` relative to the test tree, or null when it is outside it. Both the absolute
 *  paths `deno lint` passes and the repo-relative ones runPlugin takes are read. */
function testTreePath(filename: string): string | null {
  const path = normalize(filename);
  if (path.startsWith(TEST_DIR)) return path.slice(TEST_DIR.length);
  if (path.startsWith("test/")) return path.slice("test/".length);
  return null;
}

const MESSAGE =
  "build child processes with spawnChild (test/helpers/run.ts), which registers the child " +
  "for abort teardown -- one made here outlives a timed-out test and runs on alongside the " +
  "tests that follow";

/** Whether `node` is the `Deno` global, spelled bare or through globalThis. */
function isDenoNamespace(node: Deno.lint.Node): boolean {
  if (node.type === "Identifier") return node.name === "Deno";
  return node.type === "MemberExpression" &&
    node.object.type === "Identifier" && node.object.name === "globalThis" &&
    node.property.type === "Identifier" && node.property.name === "Deno";
}

/** The member name a MemberExpression reads, for both `a.b` and `a["b"]`. */
function memberName(node: Deno.lint.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (
    node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

const plugin: Deno.lint.Plugin = {
  name: "copilot-env-test",
  rules: {
    "no-unmanaged-child-spawn": {
      create(context) {
        const relative = testTreePath(context.filename);
        if (relative === null || relative === HELPER) return {};
        return {
          // `Deno.Command`, `Deno["Command"]`, `globalThis.Deno.Command`.
          "MemberExpression"(node) {
            if (isDenoNamespace(node.object) && memberName(node) === "Command") {
              context.report({ node, message: MESSAGE });
            }
          },
          // `const { Command } = Deno`.
          "VariableDeclarator"(node) {
            if (node.init === null || !isDenoNamespace(node.init)) return;
            if (node.id.type !== "ObjectPattern") return;
            for (const property of node.id.properties) {
              if (
                property.type === "Property" && property.key.type === "Identifier" &&
                property.key.name === "Command"
              ) {
                context.report({ node: property, message: MESSAGE });
              }
            }
          },
          // Any VALUE import of the module, named / namespace / default / side-effect alike.
          "ImportDeclaration"(node) {
            if (node.source.value !== CHILD_PROCESS_MODULE || node.importKind === "type") return;
            context.report({ node, message: MESSAGE });
          },
          // `await import("node:child_process")`.
          "ImportExpression"(node) {
            if (
              node.source.type === "Literal" && node.source.value === CHILD_PROCESS_MODULE
            ) {
              context.report({ node, message: MESSAGE });
            }
          },
        };
      },
    },
  },
};

export default plugin;
