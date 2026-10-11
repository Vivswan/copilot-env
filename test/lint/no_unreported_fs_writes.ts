// Runtime code reaches the filesystem through the one seam, never around it.
//
// Every file a command creates, rewrites, deletes, moves or links outside copilot-env's own homes
// is named on stderr by the seam (src/utils/fs_facade.ts, whose disk side src/utils/fs_disk.ts
// decides that a write inside a home is silent bookkeeping), and every read the seam answers sees
// a dry run's planned state. A raw node:fs call anywhere else in src/ (or a Bun.write / Bun.file,
// or, in the daemon-side modules the sidecar still runs, a Deno call) is a write the seam never
// sees or a read that looks behind the plan -- so the ban is on REACHING the API at all: a named
// import from node:fs / node:fs/promises, a member read off a node:fs namespace or default import,
// a destructure of one, and the Bun and Deno namespaces' own calls. Two rules, one per direction,
// because their exemptions differ:
//
//   no-unreported-fs-writes  src/ minus fs_disk.ts (the disk side), dry_run.ts (the marker: a
//                            lock-held directory a child process probes, so it must be real),
//                            file_lock.ts (the lock protocol's per-acquisition marker file, a
//                            transient the seam documents), log_mute_preload.ts (patches the
//                            PROXY's own createWriteStream, no write of ours), and
//                            src/migrations/ (one-time fix-ups that narrate their own moves).
//   no-raw-fs-reads          the same, plus src/usage/ (read-only inputs no dry run touches, on
//                            the `agent cost` hot path with partial reads through a fd the seam has
//                            no primitive for) and node_compat_preload.ts (runs before the seam
//                            exists). Two files may open a read handle raw, and nothing else
//                            (checksums.ts streams the release binary it hashes, process.ts opens
//                            `/dev/null` for the daemon's stdin): no run plans either file.
//
// A file handle (`open`, `openSync`, `Deno.open`) is a read to the read rule whatever its flags,
// and a write to the write rule when its flag or options say so (or cannot be read): the seam's
// openWritable / openWriteFd are the way to a write handle, and a read-exempt file still may not
// open for writing.
//
// One more way to mutate without naming a write API is refused too: a child process running a
// filesystem command (`rm`, `mv`, `cp`, `del`, `Remove-Item`, ...: spawned directly, or as the
// first word of a shell's command line). A command the rule cannot read (a variable) passes, since
// a spawn's command is often computed.
//
// A scanner over the parsed tree rather than a lint plugin: the per-file exemption lists, the
// alias tracking, and the flag and argv reading are beyond what a GritQL pattern states. Run and
// pinned by test/utils/fs_write_lint.test.ts, which fails on any finding under src/.
//
// Each visitor sees a node once, in source order, so an import or alias is recorded before the
// uses that follow it; a use ahead of its declaration (hoisting) is not followed.
import type {
  Argument,
  ArrayExpressionElement,
  BindingPattern,
  Expression,
  ModuleExportName,
  PropertyKey,
  VisitorObject,
} from "oxc-parser";
import { parseModule, visit } from "../helpers/syntax.ts";

const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);

/** The seam's disk side, the dry-run marker, the lock protocol, and the preload that patches
 *  the PROXY's stream constructor, repo-relative. */
const ALLOWED = new Set([
  "src/utils/fs_disk.ts",
  "src/utils/dry_run.ts",
  "src/utils/file_lock.ts",
  "src/scripts/log_mute_preload.ts",
]);

const EXEMPT_PREFIX = "src/migrations/";

/** Raw reads the seam does not cover: the usage scanners (partial reads through a fd, on a hot
 *  path, over inputs no dry run touches) and the preload that runs before the seam exists. */
const READ_ALLOWED = new Set(["src/scripts/node_compat_preload.ts"]);
const READ_EXEMPT_PREFIX = "src/usage/";

/** The two read handles no run plans, opened raw where they are used (the release binary the
 *  updater hashes, the daemon's `/dev/null` stdin); every other read in these files still goes
 *  through the seam. */
const READ_HANDLE_ALLOWED = new Set(["src/install/checksums.ts", "src/copilot_api/process.ts"]);

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

/** node:fs lookup and read entry points, and every open (a handle is the seam's to hand out). */
const FS_READ_NAMES = new Set([
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "fstat",
  "fstatSync",
  "statfs",
  "statfsSync",
  "exists",
  "existsSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "opendir",
  "opendirSync",
  "open",
  "openSync",
  "openAsBlob",
  "read",
  "readSync",
  "readv",
  "readvSync",
  "createReadStream",
  "ReadStream",
  "glob",
  "globSync",
  "watch",
  "watchFile",
  "unwatchFile",
]);

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

/** The Deno namespace's lookup and read entry points, every open included. */
const DENO_READ_NAMES = new Set([
  "readTextFile",
  "readTextFileSync",
  "readFile",
  "readFileSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readDir",
  "readDirSync",
  "readLink",
  "readLinkSync",
  "realPath",
  "realPathSync",
  "open",
  "openSync",
  "watchFs",
]);

/** Bun's own file APIs: `Bun.write` mutates, `Bun.file` hands out a readable (and, through its
 *  writer, a writable) handle the seam never sees. */
const BUN_WRITE_NAMES = new Set(["write", "file"]);
const BUN_READ_NAMES = new Set(["file"]);

/** The node:fs open calls: a read by name, a write when the flag says so. */
const FS_OPEN_NAMES = new Set(["open", "openSync"]);
const DENO_OPEN_NAMES = new Set(["open", "openSync"]);
/** Deno.open options that make the handle a write. */
const DENO_OPEN_WRITE_OPTIONS = new Set(["write", "append", "create", "createNew", "truncate"]);

function withoutOpens(names: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...names].filter((name) => !FS_OPEN_NAMES.has(name)));
}

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

export const WRITES_RULE = "no-unreported-fs-writes";
export const READS_RULE = "no-raw-fs-reads";

export interface FsFinding {
  rule: typeof WRITES_RULE | typeof READS_RULE;
  /** Zero-based offset of the offending node in the source. */
  start: number;
  message: string;
}

/** `path` is repo-relative with forward slashes; the scope is src/ minus each rule's exemptions. */
function guarded(path: string): boolean {
  if (!path.startsWith("src/")) return false;
  if (path.startsWith(EXEMPT_PREFIX) || ALLOWED.has(path)) return false;
  return true;
}

function readGuarded(path: string): boolean {
  if (!guarded(path)) return false;
  return !path.startsWith(READ_EXEMPT_PREFIX) && !READ_ALLOWED.has(path);
}

const WRITE_MESSAGE =
  "mutate the filesystem through src/utils/fs_facade.ts (writeText, rm, ...) " +
  "so a write outside copilot-env's own homes is named on stderr -- a raw write here is one the " +
  "seam never sees";

const READ_MESSAGE =
  "read the filesystem through src/utils/fs_facade.ts (readText, stat, " +
  "readdir, exists, ...) so a dry run answers from its planned state -- a raw read " +
  "here looks behind the plan";

const HANDLE_MESSAGE =
  "open a file for writing through src/utils/fs_facade.ts (openWritable, " +
  "openWriteFd): a write handle opened here is a mutation the seam never sees";

const SPAWN_MESSAGE =
  "a child process that mutates the filesystem (rm, mv, cp, del, ...) is a " +
  "write the seam never sees; do it through src/utils/fs_facade.ts";

type Node =
  | Expression
  | Argument
  | ArrayExpressionElement
  | PropertyKey
  | BindingPattern
  | ModuleExportName;

/** The static text of a string literal or an expression-free template, else null. */
function literalText(node: Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return null;
}

/** An identifier's name, or a string literal's text, as a property key or import name reads. */
function nameOf(node: Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** `a.b` -> "b", `a["b"]` -> "b", `a[b]` -> null. */
function memberName(node: Expression): string | null {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : null;
}

function commandName(text: string): string {
  const base = text.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

function commandLineMutates(line: string): boolean {
  return line.split(/[;&|\n]+/).some((segment) => {
    const word = segment.trim().split(/\s+/)[0] ?? "";
    return MUTATING_COMMANDS.has(commandName(word));
  });
}

/** Whether a node:fs open flag opens for writing: anything but a plain read, or a flag the rule
 *  cannot read. */
function fsFlagWrites(flag: Argument | undefined): boolean {
  if (flag === undefined) return false;
  const text = literalText(flag);
  return text === null || /[wa+]/.test(text);
}

/** Whether a Deno.open options argument asks for a write: a write option not literally false, or
 *  options the rule cannot read. */
function denoOptionsWrite(options: Argument | undefined): boolean {
  if (options === undefined) return false;
  if (options.type !== "ObjectExpression") return true;
  return options.properties.some((property) => {
    if (property.type !== "Property" || property.computed) return true;
    const key = nameOf(property.key);
    if (key === null || !DENO_OPEN_WRITE_OPTIONS.has(key)) return false;
    return !(property.value.type === "Literal" && property.value.value === false);
  });
}

/** Whether a literal argument vector (`["rm", "-rf", x]`, or a shell with its command line)
 *  names a mutating command. */
function argvMutates(elements: readonly ArrayExpressionElement[]): boolean {
  const [command, ...args] = elements;
  const text = literalText(command);
  if (text === null) return false;
  const name = commandName(text);
  if (MUTATING_COMMANDS.has(name)) return true;
  if (!SHELLS.has(name)) return false;
  return args.some((element) => {
    const line = literalText(element);
    return line !== null && commandLineMutates(line);
  });
}

function spawnMutates(command: Node, args: Node | undefined): boolean {
  const text = literalText(command);
  if (text === null) return false;
  const name = commandName(text);
  if (MUTATING_COMMANDS.has(name)) return true;
  if (!SHELLS.has(name) || args === undefined || args === null || args.type !== "ArrayExpression") {
    return false;
  }
  return args.elements.some((element) => {
    const line = literalText(element);
    return line !== null && commandLineMutates(line);
  });
}

/** `Bun.spawn(["rm", ...])` / `Bun.spawn({ cmd: ["rm", ...] })`: the argv under either shape. */
function bunSpawnArgv(first: Argument): readonly ArrayExpressionElement[] | null {
  if (first.type === "ArrayExpression") return first.elements;
  if (first.type !== "ObjectExpression") return null;
  const cmd = first.properties.find(
    (property) =>
      property.type === "Property" && !property.computed && nameOf(property.key) === "cmd",
  );
  return cmd?.type === "Property" && cmd.value.type === "ArrayExpression"
    ? cmd.value.elements
    : null;
}

/** `Deno`, `Bun`, `globalThis.Deno`, and the local aliases a rule collected. */
function isGlobalNamespace(node: Expression, name: string, aliases: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return node.name === name || aliases.has(node.name);
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "globalThis" &&
    memberName(node) === name
  );
}

function isFsNamespace(node: Expression, locals: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return locals.has(node.name);
  return (
    node.type === "MemberExpression" &&
    memberName(node) === "promises" &&
    node.object.type === "Identifier" &&
    locals.has(node.object.name)
  );
}

/** The API names one direction of the seam covers, and the message for reaching one raw. */
interface Direction {
  fs: ReadonlySet<string>;
  deno: ReadonlySet<string>;
  bun: ReadonlySet<string>;
  message: string;
}

interface Scan {
  findings: FsFinding[];
  rule: FsFinding["rule"];
  direction: Direction;
  /** Local names bound to a whole node:fs module (`import * as fs`, `import fs`, the `promises`
   *  namespace, and aliases of either). */
  fsNamespaces: Set<string>;
  denoAliases: Set<string>;
  bunAliases: Set<string>;
  /** Local names bound to node:fs `open`/`openSync`, and to `Deno.open`/`Deno.openSync`. */
  fsOpens: Set<string>;
  denoOpens: Set<string>;
  /** Local names bound to a child_process spawn entry point, by kind, and to the whole module. */
  spawns: Set<string>;
  execs: Set<string>;
  childProcessNamespaces: Set<string>;
}

function newScan(rule: FsFinding["rule"], direction: Direction): Scan {
  return {
    findings: [],
    rule,
    direction,
    fsNamespaces: new Set(),
    denoAliases: new Set(),
    bunAliases: new Set(),
    fsOpens: new Set(),
    denoOpens: new Set(),
    spawns: new Set(),
    execs: new Set(),
    childProcessNamespaces: new Set(),
  };
}

function report(scan: Scan, at: { start: number }, message = scan.direction.message): void {
  scan.findings.push({ rule: scan.rule, start: at.start, message });
}

/** Every way of reaching a node:fs, Deno, or Bun filesystem API by name: a named import, a member
 *  read off a module or global namespace (and any alias of either), a destructure, a re-export, a
 *  dynamic import of the whole module. */
function reachVisitor(scan: Scan): VisitorObject {
  const { direction } = scan;
  return {
    ImportDeclaration(node) {
      if (node.importKind === "type") return;
      const source = node.source.value;
      if (source === CHILD_PROCESS_MODULE && scan.rule === WRITES_RULE) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            scan.childProcessNamespaces.add(specifier.local.name);
            continue;
          }
          if (specifier.importKind === "type") continue;
          const imported = nameOf(specifier.imported);
          if (imported !== null && SPAWN_NAMES.has(imported)) scan.spawns.add(specifier.local.name);
          if (imported !== null && EXEC_NAMES.has(imported)) scan.execs.add(specifier.local.name);
        }
        return;
      }
      if (!FS_MODULES.has(source)) return;
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          if (specifier.importKind === "type") continue; // erased: no runtime binding
          const imported = nameOf(specifier.imported);
          if (imported === null) continue;
          if (direction.fs.has(imported)) report(scan, specifier);
          if (FS_OPEN_NAMES.has(imported)) scan.fsOpens.add(specifier.local.name);
          // `import { promises as fsp }`: a whole namespace.
          if (imported === "promises") scan.fsNamespaces.add(specifier.local.name);
        } else {
          scan.fsNamespaces.add(specifier.local.name);
        }
      }
    },
    // `await import("node:fs")`: a whole module object the rule cannot follow.
    ImportExpression(node) {
      const source = literalText(node.source);
      if (source !== null && FS_MODULES.has(source)) report(scan, node);
    },
    // `export * from "node:fs"` / `export { rmSync } from "node:fs"`: hands an API (or the whole
    // module) to another module under a name the rule would not see.
    ExportAllDeclaration(node) {
      if (FS_MODULES.has(node.source.value)) report(scan, node);
    },
    ExportNamedDeclaration(node) {
      if (node.source === null || !FS_MODULES.has(node.source.value)) return;
      for (const specifier of node.specifiers) {
        // `local` is the name in the SOURCE module (`export { rm as remove }` -> rm).
        const name = nameOf(specifier.local);
        // `default` and `promises` are the whole module under a name.
        if (
          name !== null &&
          (direction.fs.has(name) || name === "promises" || name === "default")
        ) {
          report(scan, specifier);
        }
      }
    },
    MemberExpression(node) {
      const name = memberName(node);
      if (name === null) return;
      if (isFsNamespace(node.object, scan.fsNamespaces)) {
        if (direction.fs.has(name)) report(scan, node);
        return;
      }
      if (isGlobalNamespace(node.object, "Deno", scan.denoAliases) && direction.deno.has(name)) {
        report(scan, node);
      } else if (
        isGlobalNamespace(node.object, "Bun", scan.bunAliases) &&
        direction.bun.has(name)
      ) {
        report(scan, node);
      }
    },
    // `const { rmSync } = fs;` / `const { remove } = Deno;` / `const fsp = fs.promises;`
    // / `const { promises: fsp } = fs;` / `const deno = Deno;`
    VariableDeclarator(node) {
      const { id, init } = node;
      if (init === null) return;
      if (id.type === "Identifier") {
        const local = id.name;
        if (isFsNamespace(init, scan.fsNamespaces)) scan.fsNamespaces.add(local);
        if (isGlobalNamespace(init, "Deno", scan.denoAliases)) scan.denoAliases.add(local);
        if (isGlobalNamespace(init, "Bun", scan.bunAliases)) scan.bunAliases.add(local);
        // `const open = Deno.open;` / `const o = fs.openSync;`: an open under another name.
        if (init.type === "MemberExpression") {
          const name = memberName(init);
          if (name !== null && FS_OPEN_NAMES.has(name)) {
            if (isFsNamespace(init.object, scan.fsNamespaces)) scan.fsOpens.add(local);
            if (isGlobalNamespace(init.object, "Deno", scan.denoAliases)) scan.denoOpens.add(local);
          }
        }
        return;
      }
      if (id.type !== "ObjectPattern") return;
      const fromFs = isFsNamespace(init, scan.fsNamespaces);
      const fromDeno = isGlobalNamespace(init, "Deno", scan.denoAliases);
      const fromBun = isGlobalNamespace(init, "Bun", scan.bunAliases);
      if (!fromFs && !fromDeno && !fromBun) return;
      const names = fromFs ? direction.fs : fromDeno ? direction.deno : direction.bun;
      for (const property of id.properties) {
        if (property.type !== "Property") continue;
        const key = nameOf(property.key);
        const local = property.value.type === "Identifier" ? property.value.name : null;
        if (key === null) continue;
        if (names.has(key)) {
          report(scan, property);
        } else if (fromFs && key === "promises" && local !== null) {
          scan.fsNamespaces.add(local);
        } else if (fromFs && FS_OPEN_NAMES.has(key) && local !== null) {
          scan.fsOpens.add(local);
        } else if (fromDeno && DENO_OPEN_NAMES.has(key) && local !== null) {
          scan.denoOpens.add(local);
        }
      }
    },
  };
}

/** The write rule's own visitors: a write-capable open, and a child process running a
 *  filesystem command (node:child_process, Bun.spawn, Deno.Command). */
function writeVisitor(scan: Scan): VisitorObject {
  return {
    CallExpression(node) {
      const { callee } = node;
      const [first, second] = node.arguments;
      if (first === undefined) return;
      if (callee.type === "Identifier") {
        const { name } = callee;
        if (scan.fsOpens.has(name) && fsFlagWrites(second)) report(scan, node, HANDLE_MESSAGE);
        else if (scan.denoOpens.has(name) && denoOptionsWrite(second))
          report(scan, node, HANDLE_MESSAGE);
        else if (scan.spawns.has(name) && spawnMutates(first, second))
          report(scan, node, SPAWN_MESSAGE);
        else if (scan.execs.has(name)) {
          const line = literalText(first);
          if (line !== null && commandLineMutates(line)) report(scan, node, SPAWN_MESSAGE);
        }
        return;
      }
      if (callee.type !== "MemberExpression") return;
      const name = memberName(callee);
      if (name === null) return;
      if (isFsNamespace(callee.object, scan.fsNamespaces)) {
        if (FS_OPEN_NAMES.has(name) && fsFlagWrites(second)) report(scan, node, HANDLE_MESSAGE);
        return;
      }
      if (isGlobalNamespace(callee.object, "Deno", scan.denoAliases)) {
        if (DENO_OPEN_NAMES.has(name) && denoOptionsWrite(second))
          report(scan, node, HANDLE_MESSAGE);
        return;
      }
      if (isGlobalNamespace(callee.object, "Bun", scan.bunAliases)) {
        if (name !== "spawn" && name !== "spawnSync") return;
        const argv = bunSpawnArgv(first);
        if (argv !== null && argvMutates(argv)) report(scan, node, SPAWN_MESSAGE);
        return;
      }
      if (
        callee.object.type !== "Identifier" ||
        !scan.childProcessNamespaces.has(callee.object.name)
      ) {
        return;
      }
      if (SPAWN_NAMES.has(name) && spawnMutates(first, second)) report(scan, node, SPAWN_MESSAGE);
      else if (EXEC_NAMES.has(name)) {
        const line = literalText(first);
        if (line !== null && commandLineMutates(line)) report(scan, node, SPAWN_MESSAGE);
      }
    },
    // `new Deno.Command("rm", { args })`.
    NewExpression(node) {
      const { callee } = node;
      if (callee.type !== "MemberExpression" || memberName(callee) !== "Command") return;
      if (!isGlobalNamespace(callee.object, "Deno", scan.denoAliases)) return;
      const [command, options] = node.arguments;
      if (command === undefined) return;
      const args =
        options?.type === "ObjectExpression"
          ? options.properties.find(
              (property) =>
                property.type === "Property" &&
                !property.computed &&
                nameOf(property.key) === "args",
            )
          : undefined;
      if (spawnMutates(command, args?.type === "Property" ? args.value : undefined)) {
        report(scan, node, SPAWN_MESSAGE);
      }
    },
  };
}

/** Both rules' handlers for one node kind, in rule order. */
function merge(visitors: VisitorObject[]): VisitorObject {
  const merged: Record<string, ((node: never) => void)[]> = {};
  for (const visitor of visitors) {
    for (const [kind, handler] of Object.entries(visitor)) {
      const handlers = merged[kind] ?? [];
      handlers.push(handler as (node: never) => void);
      merged[kind] = handlers;
    }
  }
  return Object.fromEntries(
    Object.entries(merged).map(([kind, handlers]) => [
      kind,
      (node: never) => {
        for (const handler of handlers) handler(node);
      },
    ]),
  ) as VisitorObject;
}

/**
 * Both rules over one module. `path` is repo-relative with forward slashes (the scope reads it,
 * nothing is read from disk), so a doctored `source` pins the rule's teeth without a file.
 */
export function scanFsReach(path: string, source: string): FsFinding[] {
  const scans: Scan[] = [];
  const visitors: VisitorObject[] = [];
  if (guarded(path)) {
    const scan = newScan(WRITES_RULE, {
      fs: FS_WRITE_NAMES,
      deno: DENO_WRITE_NAMES,
      bun: BUN_WRITE_NAMES,
      message: WRITE_MESSAGE,
    });
    scans.push(scan);
    visitors.push(reachVisitor(scan), writeVisitor(scan));
  }
  if (readGuarded(path)) {
    const handles = READ_HANDLE_ALLOWED.has(path);
    const scan = newScan(READS_RULE, {
      fs: handles ? withoutOpens(FS_READ_NAMES) : FS_READ_NAMES,
      deno: handles ? withoutOpens(DENO_READ_NAMES) : DENO_READ_NAMES,
      bun: BUN_READ_NAMES,
      message: READ_MESSAGE,
    });
    scans.push(scan);
    visitors.push(reachVisitor(scan));
  }
  if (scans.length === 0) return [];
  visit(parseModule(path, source).program, merge(visitors));
  return scans.flatMap((scan) => scan.findings).sort((a, b) => a.start - b.start);
}
