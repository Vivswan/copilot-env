// The repository's and the test tree's scope, and the AST readers shared by the lint plugins
// (no_unmanaged_child_spawn.ts, no_unmanaged_temp_dir.ts, no_unreported_fs_writes.ts).
import { fileURLToPath } from "node:url";

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The repository root, derived from THIS file (test/lint/). fileURLToPath, not URL.pathname:
 *  the latter yields "/C:/..." on Windows and would match nothing, silently disabling every
 *  rule. */
const REPO_ROOT = normalize(fileURLToPath(new URL("../../", import.meta.url)));

/** The test tree's own path, derived the same way, so the scope tracks the directory itself
 *  rather than any ancestor that happens to be named "test". */
const TEST_DIR = normalize(fileURLToPath(new URL("../", import.meta.url)));

/** `filename` relative to the repo root, or null when it is outside it. Both the absolute
 *  paths `deno lint` passes and the repo-relative ones runPlugin takes are read. */
export function repoPath(filename: string): string | null {
  const path = normalize(filename);
  if (path.startsWith(REPO_ROOT)) return path.slice(REPO_ROOT.length);
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return path;
  return null;
}

/** `filename` relative to the test tree, or null when it is outside it. */
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

const NO_ALIASES: ReadonlySet<string> = new Set();

/** Whether `node` is the `Deno` global: spelled bare, through globalThis, or by one of the
 *  local `aliases` a rule collected (`const deno = Deno`). */
export function isDenoNamespace(node: Deno.lint.Node, aliases = NO_ALIASES): boolean {
  if (node.type === "Identifier") return node.name === "Deno" || aliases.has(node.name);
  return node.type === "MemberExpression" &&
    node.object.type === "Identifier" && node.object.name === "globalThis" &&
    node.property.type === "Identifier" && node.property.name === "Deno";
}
