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
import { memberName, testTreePath } from "./test_tree.ts";

/** The files that own a sanctioned construction, relative to the test tree: run.ts, the
 *  process boundary, and testing.ts, whose one child (the cache lookup) runs at module load,
 *  before any test body exists to be abandoned. */
const OWNERS: ReadonlySet<string> = new Set(["helpers/run.ts", "helpers/testing.ts"]);

/** The module the ban covers wholesale; run.ts takes its `spawnSync` from here. */
const CHILD_PROCESS_MODULE = "node:child_process";

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

const plugin: Deno.lint.Plugin = {
  name: "copilot-env-test",
  rules: {
    "no-unmanaged-child-spawn": {
      create(context) {
        const relative = testTreePath(context.filename);
        if (relative === null || OWNERS.has(relative)) return {};
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
