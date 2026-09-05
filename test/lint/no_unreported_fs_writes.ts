// Deno lint plugin: runtime code may not mutate the filesystem behind the user's back.
//
// Every file a command creates, rewrites, deletes, moves or links is named on stderr by
// the one write-reporting seam (src/utils/report_write.ts). A raw node:fs (or Deno) write
// anywhere else in src/ is a mutation the seam never sees -- so the ban is on REACHING a
// write API at all: a named import of one from node:fs / node:fs/promises, a member read
// of one off a node:fs namespace or default import, a destructure of one, and the Deno
// namespace's own write calls. Read APIs stay legal everywhere.
//
// Scope: src/, minus the seam itself, the lock protocol's internals (file_lock.ts, whose
// per-acquisition marker file is a transient the seam documents), the daemon preload that
// patches the proxy's own createWriteStream (log_mute_preload.ts, no write of ours), and
// src/migrations/ (one-time fix-ups that narrate their own moves).
//
// Not caught: a file handle opened for writing (`open`/`openSync` with a write flag,
// `Deno.open`) -- those names are read APIs too, and the two write-through-handle sites
// (the sidecar download into scratch, the daemon log fd the launch pipeline has already
// blanked through the seam) are both accounted for. A new one would pass this rule.
// Registered in deno.json, unit-tested in test/fs_write_lint.test.ts.
import { fileURLToPath } from "node:url";

const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);

/** The seam, the lock protocol, and the preload that patches the PROXY's stream
 *  constructor, repo-relative. */
const ALLOWED = new Set([
  "src/utils/report_write.ts",
  "src/utils/file_lock.ts",
  "src/scripts/log_mute_preload.ts",
]);

const EXEMPT_PREFIX = "src/migrations/";

/** node:fs mutation entry points, sync and promise spellings alike. */
const FS_WRITE_NAMES = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "chmod",
  "chmodSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "write",
  "writeSync",
  "writev",
  "writevSync",
  "WriteStream",
  "SyncWriteStream",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "truncate",
  "truncateSync",
  "ftruncate",
  "ftruncateSync",
  "utimes",
  "utimesSync",
  "lutimes",
  "lutimesSync",
  "futimes",
  "futimesSync",
  "chown",
  "chownSync",
  "lchown",
  "lchownSync",
  "fchown",
  "fchownSync",
  "fchmod",
  "fchmodSync",
  "lchmod",
  "lchmodSync",
  "createWriteStream",
]);

/** The Deno namespace's mutation entry points. */
const DENO_WRITE_NAMES = new Set([
  "writeFile",
  "writeFileSync",
  "writeTextFile",
  "writeTextFileSync",
  "remove",
  "removeSync",
  "rename",
  "renameSync",
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "chmod",
  "chmodSync",
  "mkdir",
  "mkdirSync",
  "copyFile",
  "copyFileSync",
  "truncate",
  "truncateSync",
  "makeTempDir",
  "makeTempDirSync",
  "makeTempFile",
  "makeTempFileSync",
  "create",
  "createSync",
  "utime",
  "utimeSync",
  "chown",
  "chownSync",
]);

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The repository root, derived from THIS file (test/lint/). fileURLToPath, not
 *  URL.pathname: the latter yields "/C:/..." on Windows and would match nothing,
 *  silently disabling the rule. */
const REPO_ROOT = normalize(fileURLToPath(new URL("../../", import.meta.url)));

/** `filename` relative to the repo root, or null when it is outside it. Both the
 *  absolute paths `deno lint` passes and the repo-relative ones runPlugin takes. */
function repoPath(filename: string): string | null {
  const path = normalize(filename);
  if (path.startsWith(REPO_ROOT)) return path.slice(REPO_ROOT.length);
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return path;
  return null;
}

function guarded(filename: string): boolean {
  const relative = repoPath(filename);
  if (relative === null || !relative.startsWith("src/")) return false;
  if (relative.startsWith(EXEMPT_PREFIX) || ALLOWED.has(relative)) return false;
  return true;
}

const MESSAGE = "mutate the filesystem through src/utils/report_write.ts (writeFileReported, " +
  "removeReported, ...) so the write is named on stderr -- a raw write here is one the " +
  "user never sees";

/** Whether `node` names a node:fs module object: a namespace/default/`promises` import
 *  local, or `<local>.promises` off one. */
function isFsNamespace(node: Deno.lint.Node, locals: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return locals.has(node.name);
  return node.type === "MemberExpression" && memberName(node) === "promises" &&
    node.object.type === "Identifier" && locals.has(node.object.name);
}

/** Whether `node` is the `Deno` global: spelled bare, through globalThis, or by a local
 *  alias (`const deno = Deno`). */
function isDenoNamespace(node: Deno.lint.Node, aliases: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return node.name === "Deno" || aliases.has(node.name);
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
  name: "copilot-env-src",
  rules: {
    "no-unreported-fs-writes": {
      create(context) {
        if (!guarded(context.filename)) return {};
        /** Local names bound to a whole node:fs module (`import * as fs`, `import fs`,
         *  the `promises` namespace, and aliases of either). */
        const fsNamespaces = new Set<string>();
        /** Local aliases of the Deno global. */
        const denoAliases = new Set<string>();
        return {
          "ImportDeclaration"(node) {
            if (!FS_MODULES.has(String(node.source.value)) || node.importKind === "type") return;
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportSpecifier") {
                const imported = specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : String(specifier.imported.value);
                if (FS_WRITE_NAMES.has(imported)) {
                  context.report({ node: specifier, message: MESSAGE });
                }
                // `import { promises as fsp }`: a whole write-capable namespace.
                if (imported === "promises") fsNamespaces.add(specifier.local.name);
              } else {
                fsNamespaces.add(specifier.local.name);
              }
            }
          },
          "MemberExpression"(node) {
            const name = memberName(node);
            if (name === null) return;
            if (isFsNamespace(node.object, fsNamespaces)) {
              if (FS_WRITE_NAMES.has(name)) context.report({ node, message: MESSAGE });
              return;
            }
            if (isDenoNamespace(node.object, denoAliases) && DENO_WRITE_NAMES.has(name)) {
              context.report({ node, message: MESSAGE });
            }
          },
          // `const { rmSync } = fs;` / `const { remove } = Deno;` / `const fsp = fs.promises;`
          // / `const { promises: fsp } = fs;` / `const deno = Deno;`
          "VariableDeclarator"(node) {
            if (node.init === null) return;
            if (node.id.type === "Identifier") {
              if (isFsNamespace(node.init, fsNamespaces)) fsNamespaces.add(node.id.name);
              if (isDenoNamespace(node.init, denoAliases)) denoAliases.add(node.id.name);
              return;
            }
            if (node.id.type !== "ObjectPattern") return;
            const fromFs = isFsNamespace(node.init, fsNamespaces);
            const fromDeno = isDenoNamespace(node.init, denoAliases);
            if (!fromFs && !fromDeno) return;
            const names = fromFs ? FS_WRITE_NAMES : DENO_WRITE_NAMES;
            for (const property of node.id.properties) {
              if (property.type !== "Property" || property.key.type !== "Identifier") continue;
              if (names.has(property.key.name)) {
                context.report({ node: property, message: MESSAGE });
              } else if (
                fromFs && property.key.name === "promises" && property.value.type === "Identifier"
              ) {
                fsNamespaces.add(property.value.name);
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
