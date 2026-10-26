// Runtime code reaches the filesystem through the one seam (src/utils/fs_facade.ts), never around
// it: the seam names every write outside copilot-env's own homes on stderr and answers every read
// from a dry run's planned state. So the ban is on REACHING node:fs or Bun at all, not on
// the call that mutates: a raw call is a write the seam never sees or a read behind the plan.
//
// Two rules, one per direction, because their exemptions differ; each ALLOWED set below carries its
// files' reasons. A file handle whose flags cannot be read counts as a write, and a read-exempt
// file still may not open one for writing: openWritable / openWriteFd are the seam's way. A file
// allowed a raw read handle or a raw fd write keeps every other read and write guarded.
//
// A child process running a filesystem command (`rm`, `mv`, `Remove-Item`, ...) is refused too; a
// command the rule cannot read (a variable) passes, since a spawn's command is often computed.
//
// A scanner over the parsed tree rather than a lint plugin: the per-file exemptions, the alias
// tracking, and the flag and argv reading are beyond what a GritQL pattern states. Run and pinned
// by test/utils/fs_write_lint.test.ts, which fails on any finding under src/. Each visitor sees a
// node once, in source order, so a use ahead of its declaration (hoisting) is not followed.
import type {
  Argument,
  ArrayExpressionElement,
  BindingPattern,
  BindingProperty,
  CallExpression,
  Expression,
  ImportDeclaration,
  MemberExpression,
  ModuleExportName,
  ObjectPattern,
  PropertyKey,
  VisitorObject,
} from "oxc-parser";
import { parseModule, visit } from "../helpers/syntax.ts";

/** The specifiers that bind node:fs; reaching a name from either, by any alias, is what both rules report. */
const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);

/** Repo-relative files that may write raw; each row says why. */
const ALLOWED = new Set([
  // the seam's disk side
  "src/utils/fs_disk.ts",
  // the marker a child process probes under a held lock, so it must be real
  "src/utils/dry_run.ts",
  // the lock protocol's per-acquisition marker, a transient the seam documents
  "src/utils/file_lock.ts",
  // patches the PROXY's own createWriteStream, no write of ours
  "src/scripts/log_mute_preload.ts",
]);

/** One-time fix-ups that narrate their own moves. */
const EXEMPT_PREFIX = "src/migrations/";

/** Raw reads outside the seam: the usage scanners' partial fd reads, on a hot path, over inputs no dry run touches. */
const READ_EXEMPT_PREFIX = "src/usage/";

/** Two read handles no run plans, opened raw: the updater hashing the release binary, the daemon's /dev/null stdin. */
const READ_HANDLE_ALLOWED = new Set(["src/install/checksums.ts", "src/copilot_api/process.ts"]);

/** The one `Bun.file` read: the import-free preload's load hook reading the proxy's own chunk text. */
const BUN_FILE_READ_ALLOWED = new Set(["src/scripts/client_headers_preload.ts"]);

/** The one-expression consumers that make `Bun.file(...)` a read; a stored handle stays a write and a read. */
const BUN_FILE_READ_METHODS = new Set(["text", "json", "arrayBuffer", "bytes", "stream", "exists"]);

/** The one file writing a descriptor rather than a path: the seam's own report line, to fd 2 through `writeSync`. */
const STDERR_WRITE_ALLOWED = new Set(["src/utils/report_write.ts"]);

/** The descriptor writes; in STDERR_WRITE_ALLOWED they are console output, not a mutation, so they pass. */
const FD_WRITE_NAMES = new Set(["write", "writeSync"]);

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

/** `Bun.write` mutates; `Bun.file` hands out a readable (via its writer, a writable) handle the seam never sees. */
const BUN_WRITE_NAMES = new Set(["write", "file"]);

/** `Bun.file` alone: the handle it hands out reads behind any dry run's plan. */
const BUN_READ_NAMES = new Set(["file"]);

/** The node:fs open calls: a read by name, a write when the flag says so. */
const FS_OPEN_NAMES = new Set(["open", "openSync"]);

function withoutOpens(names: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...names].filter((name) => !FS_OPEN_NAMES.has(name)));
}

function withoutFdWrites(names: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...names].filter((name) => !FD_WRITE_NAMES.has(name)));
}

/** The module whose spawns are read for a filesystem command; only the write rule tracks it. */
const CHILD_PROCESS_MODULE = "node:child_process";

/** The spawn entry points whose first argument names the command (`exec*` take a command line). */
const SPAWN_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);

/** The entry points whose first argument is a whole command line (commandLineMutates reads it). */
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

/** The write direction's name on a finding, exported for the lint's test. */
export const WRITES_RULE = "no-unreported-fs-writes";

/** The read direction's name on a finding, exported for the lint's test. */
export const READS_RULE = "no-raw-fs-reads";

/** One finding; `start` is the zero-based offset of the offending node in the source. */
export interface FsFinding {
  rule: typeof WRITES_RULE | typeof READS_RULE;
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
  return guarded(path) && !path.startsWith(READ_EXEMPT_PREFIX);
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

/** `Bun`, `globalThis.Bun`, and the local aliases a rule collected. */
function isBunNamespace(node: Expression, aliases: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return node.name === "Bun" || aliases.has(node.name);
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "globalThis" &&
    memberName(node) === "Bun"
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

/** The API names one direction of the seam covers, and the message for reaching one raw. `bunFileReads`
 *  lets `Bun.file(...).text()` and its kin pass; every other reach of `Bun.file` (a stored handle, `.write` or
 *  `.delete` on one) is reported. */
interface Direction {
  fs: ReadonlySet<string>;
  bun: ReadonlySet<string>;
  bunFileReads: boolean;
  message: string;
}

interface Scan {
  /** Every finding the scan appended, each stamped with `rule`; the caller sorts them into source order. */
  findings: FsFinding[];

  /** Stamped on every finding appended: WRITES_RULE for the mutation scan, READS_RULE for the read scan. */
  rule: FsFinding["rule"];

  /** The names this scan watches and the message it reports with. */
  direction: Direction;

  /** Local names bound to a whole node:fs module: `import * as fs`, `import fs`, the `promises` namespace, aliases. */
  fsNamespaces: Set<string>;

  /** Local names bound to the Bun global (`const b = Bun`, and aliases of those). */
  bunAliases: Set<string>;

  /** Start offsets of the `Bun.file` members a read call consumes in place (bunFileReads). */
  bunFileReadChains: Set<number>;

  /** Local names bound to node:fs `open`/`openSync`. */
  fsOpens: Set<string>;

  /** Local names bound to a child_process spawn entry point (SPAWN_NAMES). */
  spawns: Set<string>;

  /** Local names bound to an exec entry point (EXEC_NAMES). */
  execs: Set<string>;

  /** Local names bound to the whole child_process module. */
  childProcessNamespaces: Set<string>;
}

function newScan(rule: FsFinding["rule"], direction: Direction): Scan {
  return {
    findings: [],
    rule,
    direction,
    fsNamespaces: new Set(),
    bunAliases: new Set(),
    bunFileReadChains: new Set(),
    fsOpens: new Set(),
    spawns: new Set(),
    execs: new Set(),
    childProcessNamespaces: new Set(),
  };
}

function report(scan: Scan, at: { start: number }, message = scan.direction.message): void {
  scan.findings.push({ rule: scan.rule, start: at.start, message });
}

/** The child_process names a write scan tracks: each spawn and exec entry point under its local
 *  name, and the whole module under a namespace or default import. */
function collectChildProcessImport(scan: Scan, node: ImportDeclaration): void {
  for (const specifier of node.specifiers) {
    if (specifier.type !== "ImportSpecifier") {
      scan.childProcessNamespaces.add(specifier.local.name);
      continue;
    }
    if (specifier.importKind === "type") continue;
    const imported = nameOf(specifier.imported);
    if (imported === null) continue;
    if (SPAWN_NAMES.has(imported)) scan.spawns.add(specifier.local.name);
    if (EXEC_NAMES.has(imported)) scan.execs.add(specifier.local.name);
  }
}

/** A node:fs import: a guarded API name is reported where it is imported, an open is tracked
 *  under its local name, and `promises`, a default, or a namespace import binds the whole module. */
function collectFsImport(scan: Scan, node: ImportDeclaration): void {
  for (const specifier of node.specifiers) {
    if (specifier.type !== "ImportSpecifier") {
      scan.fsNamespaces.add(specifier.local.name);
      continue;
    }
    if (specifier.importKind === "type") continue; // erased: no runtime binding
    const imported = nameOf(specifier.imported);
    if (imported === null) continue;
    if (scan.direction.fs.has(imported)) report(scan, specifier);
    if (FS_OPEN_NAMES.has(imported)) scan.fsOpens.add(specifier.local.name);
    // `import { promises as fsp }`: a whole namespace.
    if (imported === "promises") scan.fsNamespaces.add(specifier.local.name);
  }
}

/** `const fsp = fs.promises;` / `const bun = Bun;` / `const o = fs.openSync;`: a namespace, an
 *  alias, or an open under another name. */
function collectAlias(scan: Scan, local: string, init: Expression): void {
  if (isFsNamespace(init, scan.fsNamespaces)) scan.fsNamespaces.add(local);
  if (isBunNamespace(init, scan.bunAliases)) scan.bunAliases.add(local);
  if (init.type !== "MemberExpression") return;
  const name = memberName(init);
  if (name !== null && FS_OPEN_NAMES.has(name) && isFsNamespace(init.object, scan.fsNamespaces)) {
    scan.fsOpens.add(local);
  }
}

/** One destructured property off a module namespace: a guarded name is reported at the property;
 *  under node:fs, `promises` and an open are tracked under the local name. */
function collectDestructuredName(
  scan: Scan,
  property: BindingProperty,
  names: ReadonlySet<string>,
  fromFs: boolean,
): void {
  const key = nameOf(property.key);
  if (key === null) return;
  if (names.has(key)) {
    report(scan, property);
    return;
  }
  if (!fromFs || property.value.type !== "Identifier") return;
  const local = property.value.name;
  if (key === "promises") scan.fsNamespaces.add(local);
  if (FS_OPEN_NAMES.has(key)) scan.fsOpens.add(local);
}

/** `const { rmSync } = fs;` / `const { promises: fsp } = fs;` / `const { write } = Bun;`. */
function collectDestructure(scan: Scan, pattern: ObjectPattern, init: Expression): void {
  const fromFs = isFsNamespace(init, scan.fsNamespaces);
  const fromBun = isBunNamespace(init, scan.bunAliases);
  if (!fromFs && !fromBun) return;
  const names = fromFs ? scan.direction.fs : scan.direction.bun;
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    collectDestructuredName(scan, property, names, fromFs);
  }
}

/** Every way of reaching a node:fs or Bun filesystem API by name: a named import, a member
 *  read off a module or global namespace (and any alias of either), a destructure, a re-export, a
 *  dynamic import of the whole module. */
function reachVisitor(scan: Scan): VisitorObject {
  const { direction } = scan;
  return {
    ImportDeclaration(node) {
      if (node.importKind === "type") return;
      const source = node.source.value;
      if (source === CHILD_PROCESS_MODULE && scan.rule === WRITES_RULE) {
        collectChildProcessImport(scan, node);
      }
      if (FS_MODULES.has(source)) collectFsImport(scan, node);
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
      if (isBunNamespace(node.object, scan.bunAliases) && direction.bun.has(name)) {
        if (name === "file" && scan.bunFileReadChains.has(node.start)) return;
        report(scan, node);
      }
    },
    // `Bun.file("x").text()`: the outer call is visited before its callee, so the member it
    // consumes is known when the handler above reaches it.
    CallExpression(node) {
      if (!direction.bunFileReads || node.callee.type !== "MemberExpression") return;
      const method = memberName(node.callee);
      const handle = node.callee.object;
      if (method === null || !BUN_FILE_READ_METHODS.has(method)) return;
      if (handle.type !== "CallExpression" || handle.callee.type !== "MemberExpression") return;
      if (memberName(handle.callee) !== "file") return;
      if (!isBunNamespace(handle.callee.object, scan.bunAliases)) return;
      scan.bunFileReadChains.add(handle.callee.start);
    },
    VariableDeclarator(node) {
      const { id, init } = node;
      if (init === null) return;
      if (id.type === "Identifier") collectAlias(scan, id.name, init);
      if (id.type === "ObjectPattern") collectDestructure(scan, id, init);
    },
  };
}

/** Whether a literal command line handed to exec names a mutating command. */
function execLineMutates(first: Argument): boolean {
  const line = literalText(first);
  return line !== null && commandLineMutates(line);
}

/** A call by a bare name: a tracked open with a write flag, or a tracked spawn or exec of a
 *  mutating command. */
function judgeNamedCall(
  scan: Scan,
  node: CallExpression,
  name: string,
  first: Argument,
  second: Argument | undefined,
): void {
  if (scan.fsOpens.has(name) && fsFlagWrites(second)) {
    report(scan, node, HANDLE_MESSAGE);
    return;
  }
  if (scan.spawns.has(name) && spawnMutates(first, second)) {
    report(scan, node, SPAWN_MESSAGE);
    return;
  }
  if (scan.execs.has(name) && execLineMutates(first)) report(scan, node, SPAWN_MESSAGE);
}

/** `Bun.spawn(...)` / `Bun.spawnSync(...)` of a literal argv naming a mutating command. */
function judgeBunSpawn(scan: Scan, node: CallExpression, name: string, first: Argument): void {
  if (name !== "spawn" && name !== "spawnSync") return;
  const argv = bunSpawnArgv(first);
  if (argv !== null && argvMutates(argv)) report(scan, node, SPAWN_MESSAGE);
}

/** A spawn or exec through the child_process module's namespace, of a mutating command. */
function judgeChildProcessCall(
  scan: Scan,
  node: CallExpression,
  name: string,
  first: Argument,
  second: Argument | undefined,
): void {
  if (SPAWN_NAMES.has(name) && spawnMutates(first, second)) {
    report(scan, node, SPAWN_MESSAGE);
    return;
  }
  if (EXEC_NAMES.has(name) && execLineMutates(first)) report(scan, node, SPAWN_MESSAGE);
}

/** A call on a member: a namespace open with a write flag, a Bun spawn, or a child_process
 *  module's spawn or exec. */
function judgeMemberCall(
  scan: Scan,
  node: CallExpression,
  callee: MemberExpression,
  first: Argument,
  second: Argument | undefined,
): void {
  const name = memberName(callee);
  if (name === null) return;
  if (isFsNamespace(callee.object, scan.fsNamespaces)) {
    if (FS_OPEN_NAMES.has(name) && fsFlagWrites(second)) report(scan, node, HANDLE_MESSAGE);
    return;
  }
  if (isBunNamespace(callee.object, scan.bunAliases)) {
    judgeBunSpawn(scan, node, name, first);
    return;
  }
  if (callee.object.type !== "Identifier") return;
  if (scan.childProcessNamespaces.has(callee.object.name)) {
    judgeChildProcessCall(scan, node, name, first, second);
  }
}

/** The write rule's own visitors: a write-capable open, and a child process running a
 *  filesystem command (node:child_process, Bun.spawn). */
function writeVisitor(scan: Scan): VisitorObject {
  return {
    CallExpression(node) {
      const { callee } = node;
      const [first, second] = node.arguments;
      if (first === undefined) return;
      if (callee.type === "Identifier") judgeNamedCall(scan, node, callee.name, first, second);
      if (callee.type === "MemberExpression") judgeMemberCall(scan, node, callee, first, second);
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
      fs: STDERR_WRITE_ALLOWED.has(path) ? withoutFdWrites(FS_WRITE_NAMES) : FS_WRITE_NAMES,
      bun: BUN_WRITE_NAMES,
      bunFileReads: BUN_FILE_READ_ALLOWED.has(path),
      message: WRITE_MESSAGE,
    });
    scans.push(scan);
    visitors.push(reachVisitor(scan), writeVisitor(scan));
  }
  if (readGuarded(path)) {
    const handles = READ_HANDLE_ALLOWED.has(path);
    const scan = newScan(READS_RULE, {
      fs: handles ? withoutOpens(FS_READ_NAMES) : FS_READ_NAMES,
      bun: BUN_READ_NAMES,
      bunFileReads: BUN_FILE_READ_ALLOWED.has(path),
      message: READ_MESSAGE,
    });
    scans.push(scan);
    visitors.push(reachVisitor(scan));
  }
  if (scans.length === 0) return [];
  visit(parseModule(path, source).program, merge(visitors));
  return scans.flatMap((scan) => scan.findings).sort((a, b) => a.start - b.start);
}
