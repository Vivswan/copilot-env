// Deno lint plugin: runtime code may not mutate the filesystem behind the user's back.
//
// Every file a command creates, rewrites, deletes, moves or links outside copilot-env's
// own homes is named on stderr by the one write-reporting seam (src/utils/report_write.ts;
// the seam is what decides that a write inside a home is silent bookkeeping). A raw
// node:fs (or Deno) write anywhere else in src/ is a mutation the seam never sees -- so
// the ban is on REACHING a
// write API at all: a named import of one from node:fs / node:fs/promises, a member read
// of one off a node:fs namespace or default import, a destructure of one, and the Deno
// namespace's own write calls. Read APIs stay legal everywhere.
//
// Scope: src/, minus the seam itself, the lock protocol's internals (file_lock.ts, whose
// per-acquisition marker file is a transient the seam documents), the daemon preload that
// patches the proxy's own createWriteStream (log_mute_preload.ts, no write of ours), and
// src/migrations/ (one-time fix-ups that narrate their own moves).
//
// Two more ways to mutate without naming a write API are refused too: a file handle opened
// for writing (`open`/`openSync` with a flag other than read, `Deno.open`/`Deno.openSync` with
// a write option; the seam's openWritableReported and openWriteFdReported are the way), and a
// child process running a filesystem command (`rm`, `mv`, `cp`, `del`, `Remove-Item`, ...:
// spawned directly, or as the first word of a shell's command line). A flag or command the
// rule cannot read (a variable) is refused for the open, where every legal spelling is a
// literal, and passed for the spawn, where the command is often computed.
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
  "FileWriteStream",
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

/** The node:fs open calls: a read API by name, a write when the flag says so. */
const FS_OPEN_NAMES = new Set(["open", "openSync"]);
const DENO_OPEN_NAMES = new Set(["open", "openSync"]);
/** Deno.open options that make the handle a write. */
const DENO_OPEN_WRITE_OPTIONS = new Set(["write", "append", "create", "createNew", "truncate"]);

const CHILD_PROCESS_MODULE = "node:child_process";
/** The spawn entry points whose first argument names the command (`exec*` take a command line). */
const SPAWN_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);
const EXEC_NAMES = new Set(["exec", "execSync"]);
/** A shell whose argument vector carries a command line of its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"]);
/** Commands that mutate the filesystem, POSIX, cmd.exe, and PowerShell (cmdlets and aliases). */
const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "ln",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "install",
  "tee",
  "truncate",
  "shred",
  "dd",
  "del",
  "erase",
  "rd",
  "md",
  "move",
  "copy",
  "xcopy",
  "robocopy",
  "mklink",
  "ren",
  "rename",
  "remove-item",
  "move-item",
  "copy-item",
  "new-item",
  "rename-item",
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
  "ri",
  "mi",
  "ci",
  "ni",
  "rni",
  "sc",
  "ac",
  "clc",
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
  "removeReported, ...) so a write outside copilot-env's own homes is named on stderr -- a " +
  "raw write here is one the seam never sees";

const HANDLE_MESSAGE = "open a file for writing through src/utils/report_write.ts " +
  "(openWritableReported, openWriteFdReported): a write handle opened here is a mutation the " +
  "seam never sees";

const SPAWN_MESSAGE = "a child process that mutates the filesystem (rm, mv, cp, del, ...) is a " +
  "write the seam never sees; do it through src/utils/report_write.ts";

/** The text of a string literal or an expression-free template literal, else null. */
function literalText(node: Deno.lint.Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.cooked ?? q.raw).join("");
  }
  return null;
}

/** A command's name as typed: the last path segment, without a Windows extension, lowercased. */
function commandName(text: string): string {
  const base = text.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/** Whether a shell command line runs a mutating command in any of its segments. */
function commandLineMutates(line: string): boolean {
  return line.split(/[;&|\n]+/).some((segment) => {
    const word = segment.trim().split(/\s+/)[0] ?? "";
    return MUTATING_COMMANDS.has(commandName(word));
  });
}

/** Whether a node:fs open flag opens for writing: anything but a plain read, or a flag the rule
 *  cannot read. */
function fsFlagWrites(flag: Deno.lint.Node | undefined): boolean {
  if (flag === undefined) return false;
  const text = literalText(flag);
  return text === null || /[wa+]/.test(text);
}

/** Whether a Deno.open options argument asks for a write: a write option not literally false, or
 *  options the rule cannot read. */
function denoOptionsWrite(options: Deno.lint.Node | undefined): boolean {
  if (options === undefined) return false;
  if (options.type !== "ObjectExpression") return true;
  return options.properties.some((property) => {
    if (property.type !== "Property" || property.computed) return true;
    const key = property.key.type === "Identifier"
      ? property.key.name
      : property.key.type === "Literal"
      ? String(property.key.value)
      : null;
    if (key === null || !DENO_OPEN_WRITE_OPTIONS.has(key)) return false;
    return !(property.value.type === "Literal" && property.value.value === false);
  });
}

/** Whether a spawn of `command` with `args` runs a mutating command: the command itself, or a
 *  shell handed a command line that does. */
function spawnMutates(command: Deno.lint.Node, args: Deno.lint.Node | undefined): boolean {
  const text = literalText(command);
  if (text === null) return false;
  const name = commandName(text);
  if (MUTATING_COMMANDS.has(name)) return true;
  if (!SHELLS.has(name) || args === undefined || args.type !== "ArrayExpression") return false;
  return args.elements.some((element) => {
    const line = element === null ? null : literalText(element);
    return line !== null && commandLineMutates(line);
  });
}

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
        /** Local names bound to node:fs `open`/`openSync`. */
        const fsOpens = new Set<string>();
        /** Local names bound to a child_process spawn entry point, by kind. */
        const spawns = new Set<string>();
        const execs = new Set<string>();
        /** Local names bound to the whole child_process module. */
        const childProcessNamespaces = new Set<string>();
        const isChildProcess = (node: Deno.lint.Node): boolean =>
          node.type === "Identifier" && childProcessNamespaces.has(node.name);
        return {
          "ImportDeclaration"(node) {
            if (node.importKind === "type") return;
            const source = String(node.source.value);
            if (source === CHILD_PROCESS_MODULE) {
              for (const specifier of node.specifiers) {
                if (specifier.type !== "ImportSpecifier") {
                  childProcessNamespaces.add(specifier.local.name);
                  continue;
                }
                if (specifier.importKind === "type") continue;
                const imported = specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : String(specifier.imported.value);
                if (SPAWN_NAMES.has(imported)) spawns.add(specifier.local.name);
                if (EXEC_NAMES.has(imported)) execs.add(specifier.local.name);
              }
              return;
            }
            if (!FS_MODULES.has(source)) return;
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportSpecifier") {
                if (specifier.importKind === "type") continue; // erased: no runtime binding
                const imported = specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : String(specifier.imported.value);
                if (FS_WRITE_NAMES.has(imported)) {
                  context.report({ node: specifier, message: MESSAGE });
                }
                if (FS_OPEN_NAMES.has(imported)) fsOpens.add(specifier.local.name);
                // `import { promises as fsp }`: a whole write-capable namespace.
                if (imported === "promises") fsNamespaces.add(specifier.local.name);
              } else {
                fsNamespaces.add(specifier.local.name);
              }
            }
          },
          // `open(path, "w")` / `fs.openSync(path, "a")` / `Deno.open(path, { write: true })`.
          "CallExpression"(node) {
            const callee = node.callee;
            const [first, second] = node.arguments;
            if (first === undefined) return;
            if (callee.type === "Identifier") {
              if (fsOpens.has(callee.name) && fsFlagWrites(second)) {
                context.report({ node, message: HANDLE_MESSAGE });
              } else if (spawns.has(callee.name) && spawnMutates(first, second)) {
                context.report({ node, message: SPAWN_MESSAGE });
              } else if (execs.has(callee.name)) {
                const line = literalText(first);
                if (line !== null && commandLineMutates(line)) {
                  context.report({ node, message: SPAWN_MESSAGE });
                }
              }
              return;
            }
            if (callee.type !== "MemberExpression") return;
            const name = memberName(callee);
            if (name === null) return;
            if (isFsNamespace(callee.object, fsNamespaces)) {
              if (FS_OPEN_NAMES.has(name) && fsFlagWrites(second)) {
                context.report({ node, message: HANDLE_MESSAGE });
              }
            } else if (isDenoNamespace(callee.object, denoAliases)) {
              if (DENO_OPEN_NAMES.has(name) && denoOptionsWrite(second)) {
                context.report({ node, message: HANDLE_MESSAGE });
              }
            } else if (isChildProcess(callee.object)) {
              if (SPAWN_NAMES.has(name) && spawnMutates(first, second)) {
                context.report({ node, message: SPAWN_MESSAGE });
              } else if (EXEC_NAMES.has(name)) {
                const line = literalText(first);
                if (line !== null && commandLineMutates(line)) {
                  context.report({ node, message: SPAWN_MESSAGE });
                }
              }
            }
          },
          // `new Deno.Command("rm", { args })`.
          "NewExpression"(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression" || memberName(callee) !== "Command") return;
            if (!isDenoNamespace(callee.object, denoAliases)) return;
            const [command, options] = node.arguments;
            if (command === undefined) return;
            const args = options?.type === "ObjectExpression"
              ? options.properties.find((property) =>
                property.type === "Property" && !property.computed &&
                ((property.key.type === "Identifier" && property.key.name === "args") ||
                  (property.key.type === "Literal" && property.key.value === "args"))
              )
              : undefined;
            const argsValue = args?.type === "Property" ? args.value : undefined;
            if (spawnMutates(command, argsValue)) {
              context.report({ node, message: SPAWN_MESSAGE });
            }
          },
          // `await import("node:fs")`: a whole module object the rule cannot follow.
          "ImportExpression"(node) {
            if (node.source.type === "Literal" && FS_MODULES.has(String(node.source.value))) {
              context.report({ node, message: MESSAGE });
            }
          },
          // `export * from "node:fs"` / `export { rmSync } from "node:fs"`: hands a write
          // API (or the whole module) to another module under a name the rule would not
          // see. A read-only re-export is as legal as a read-only import.
          "ExportAllDeclaration"(node) {
            if (FS_MODULES.has(String(node.source.value))) {
              context.report({ node, message: MESSAGE });
            }
          },
          "ExportNamedDeclaration"(node) {
            if (node.source === null || !FS_MODULES.has(String(node.source.value))) return;
            for (const specifier of node.specifiers) {
              // `local` is the name in the SOURCE module (`export { rm as remove }` -> rm).
              const name = specifier.local.type === "Identifier"
                ? specifier.local.name
                : String(specifier.local.value);
              // `default` and `promises` are the whole write-capable module under a name.
              if (FS_WRITE_NAMES.has(name) || name === "promises" || name === "default") {
                context.report({ node: specifier, message: MESSAGE });
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
              } else if (
                fromFs && FS_OPEN_NAMES.has(property.key.name) &&
                property.value.type === "Identifier"
              ) {
                fsOpens.add(property.value.name);
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
