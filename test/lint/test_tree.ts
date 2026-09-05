// The test tree's scope and the AST readers shared by the lint plugins that guard it
// (no_unmanaged_child_spawn.ts, no_unmanaged_temp_dir.ts).
import { fileURLToPath } from "node:url";

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The test tree's own path, derived from THIS file (test/lint/) so the scope tracks the
 *  directory itself rather than any ancestor that happens to be named "test".
 *  fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and would match
 *  nothing, silently disabling every rule across the whole tree. */
const TEST_DIR = normalize(fileURLToPath(new URL("../", import.meta.url)));

/** `filename` relative to the test tree, or null when it is outside it. Both the absolute
 *  paths `deno lint` passes and the repo-relative ones runPlugin takes are read. */
export function testTreePath(filename: string): string | null {
  const path = normalize(filename);
  if (path.startsWith(TEST_DIR)) return path.slice(TEST_DIR.length);
  if (path.startsWith("test/")) return path.slice("test/".length);
  return null;
}

/** The member name a MemberExpression reads, for both `a.b` and `a["b"]`. */
export function memberName(node: Deno.lint.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (
    node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}
