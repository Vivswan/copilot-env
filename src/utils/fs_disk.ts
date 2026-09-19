// The disk side of the fs seam (fs_facade.ts): the one file in src/ that touches the filesystem,
// reads included. Every write outside copilot-env's own homes is named on stderr through the ledger
// in report_write.ts, and a write that failed is named only for what a before/after look PROVES
// changed. test/lint/no_unreported_fs_writes.ts refuses a raw node:fs or Deno filesystem call
// anywhere else, bar the lock protocol's internals (file_lock.ts), the dry-run marker (dry_run.ts),
// the preloads that run before the seam or patch the proxy's own stream (src/scripts/), the usage
// scanners' partial reads (src/usage/), the two read handles no run plans (install/checksums.ts,
// copilot_api/process.ts), and src/migrations/.
//
// What does not print:
//
//   inside a home registered via hideWritesUnder -> silent; the root itself still prints
//   scratch this process creates and removes     -> silent
//   a recipe's transient side (a temp file)      -> silent
//   a write that failed                          -> only what a before/after look PROVES changed
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isEnoentOrNotdir } from "./fs.ts";
import {
  forgetReported,
  kindOf,
  reportWrite,
  trackScratch,
  underScratch,
  untrackScratch,
} from "./report_write.ts";
import { sleepSync } from "./time.ts";

declare const scratchBrand: unique symbol;

/** The only thing removeScratchDir accepts, so a permanent directory can never be removed silently
 *  through the scratch path. */
export type ScratchDir = string & { readonly [scratchBrand]: true };

/** The subset of node's Stats the CLI reads; a real Stats satisfies it. */
export interface EntryStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  mtimeMs: number;
}

/** The subset of node's Dirent the CLI reads; a real Dirent satisfies it. */
export interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

// --- the reads -------------------------------------------------------------------------------------

export {
  existsSync as exists,
  lstatSync as lstat,
  readdirSync as readdir,
  readlinkSync as readlink,
  statSync as stat,
} from "node:fs";

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function readdirEntries(path: string): DirEntry[] {
  return readdirSync(path, { withFileTypes: true });
}

/** The canonical path as the OS spells it (`realpathSync.native`): on Windows a junction and an
 *  8.3 short name resolve, which the JS walk leaves alone. */
export function realpath(path: string): string {
  return realpathSync.native(path);
}

// --- the before/after look -----------------------------------------------------------------------

/** A look that FAILED (permissions, a transient error) never reads as absent, or a report would be
 *  fabricated from it; a dangling symlink IS present. A deep look fingerprints the whole tree keyed
 *  by full relative path, so moving an entry between levels changes it even when no directory
 *  metadata does. */
export type Look =
  | { kind: "present"; fingerprint: string }
  | { kind: "absent" }
  | { kind: "unknown" };

export function look(path: string, deep = false): Look {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (e) {
    return isEnoentOrNotdir(e) ? { kind: "absent" } : { kind: "unknown" };
  }
  const own = entryFingerprint(stat);
  if (!deep || !stat.isDirectory()) return { kind: "present", fingerprint: own };
  const lines = [own];
  return fingerprintTree(path, "", lines)
    ? { kind: "present", fingerprint: lines.join("\n") }
    : { kind: "unknown" };
}

function entryFingerprint(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/** False when a level cannot be listed or an entry vanishes mid-walk: a tree that cannot be judged.
 */
function fingerprintTree(dir: string, rel: string, lines: string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return false;
  }
  for (const name of names) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    let stat: Stats;
    try {
      stat = lstatSync(join(dir, name));
    } catch {
      return false;
    }
    lines.push(`${childRel}=${entryFingerprint(stat)}`);
    if (stat.isDirectory() && !fingerprintTree(join(dir, name), childRel, lines)) return false;
  }
  return true;
}

function reportTransition(path: string, was: Look, detail?: string, deep = false): void {
  const now = look(path, deep);
  if (was.kind === "unknown" || now.kind === "unknown") return;
  if (now.kind === "absent") {
    if (was.kind === "absent") return;
    reportWrite("deleted", path, detail);
  } else if (was.kind === "absent") {
    reportWrite("created", path, detail);
  } else if (was.fingerprint !== now.fingerprint) {
    reportWrite("rewritten", path, detail);
  }
}

/** A transient whose removal fails is a file the user now keeps, so it is named (the one moment a
 *  transient is reported), but only as the transition `was` proves: a recipe that never wrote it
 *  says nothing. */
function dropTransient(path: string, was: Look, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    reportTransition(path, was, "left behind", recursive);
  }
}

// --- the errors node raises, spelled as it spells them -------------------------------------------

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  EISDIR: "illegal operation on a directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EINVAL: "invalid argument",
  EPERM: "operation not permitted",
  ELOOP: "too many symbolic links encountered",
};

/** An error shaped as node:fs throws it, so `(e as NodeJS.ErrnoException).code` reads the same. */
export function errno(code: string, syscall: string, path: string, dest?: string): Error {
  const target = dest === undefined ? `'${path}'` : `'${path}' -> '${dest}'`;
  const e: NodeJS.ErrnoException = new Error(`${code}: ${ERRNO_TEXT[code]}, ${syscall} ${target}`);
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

/** node's rmSync refusal of a directory without `recursive`: a SystemError, not an errno. */
export function rmDirectoryRefused(path: string): Error {
  const e: NodeJS.ErrnoException = new Error(
    `Path is a directory: rm returned EISDIR (is a directory) ${path}`,
  );
  e.code = "ERR_FS_EISDIR";
  return e;
}

/**
 * The directories `mkdirSync(path, { recursive: true })` would create, outermost first: the walk up
 * from `path` stops at the first entry that exists. The look is lstat's, so a symlink is an entry:
 * one that resolves to a directory is that directory for mkdir, and one to a file or to nothing is
 * the entry mkdir trips on. An existing entry that is NOT a directory (a regular file where a home
 * should be, a dangling link at `~/.local`) is the error mkdir would raise, thrown here with
 * mkdir's own code and message, so the walk fails exactly where the create would: EEXIST for the
 * path itself or for a dangling link above it, ENOTDIR for a file above it. A stat that failed for
 * another reason (EACCES) reads as present: the create itself then says what is wrong.
 */
export function missingDirectories(path: string): string[] {
  const missing: string[] = [];
  for (let cur = path;; cur = dirname(cur)) {
    const entry = lookEntry(cur);
    if (entry === "unreadable") return missing;
    if (entry !== "absent") {
      if (entry !== "dangling" && entry.isDirectory()) return missing;
      throw errno(cur === path || entry === "dangling" ? "EEXIST" : "ENOTDIR", "mkdir", path);
    }
    missing.unshift(cur);
    if (dirname(cur) === cur) return missing;
  }
}

/** What mkdir meets at `path`: the entry as it resolves (a symlink followed), a dangling link, or
 *  nothing. `unreadable` is a look that failed for a reason other than absence. */
function lookEntry(path: string): Stats | "dangling" | "absent" | "unreadable" {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (e) {
    return isEnoentOrNotdir(e) ? "absent" : "unreadable";
  }
  if (!entry.isSymbolicLink()) return entry;
  try {
    return statSync(path);
  } catch (e) {
    return isEnoentOrNotdir(e) ? "dangling" : "unreadable";
  }
}

/** Whether the entry at `path` itself (a link never followed) is a directory. */
function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The refusal a caller that plans a removal ahead of its apply raises at plan time, so a dry run
 *  refuses where the real run does instead of previewing a delete the apply would refuse. A
 *  symlink is the link, not what it points at. */
export function assertNotDirectory(path: string): void {
  if (isDirectoryEntry(path)) {
    throw new Error(`${path} is a directory; only a file can be removed here`);
  }
}

// --- the writes ------------------------------------------------------------------------------------

export interface WriteOptions {
  /** Set on the file whether it is fresh or exists (Deno chmods after the write). */
  mode?: number;
  /** Staged beside the target and renamed over it (the default); `false` writes in place, through
   *  a link, for a file another process holds open or a path that may be a user's own symlink. */
  atomic?: boolean;
  /** Rides on the stderr write line. */
  detail?: string;
  /** Dotted keys of this file whose values a dry run prints as `<redacted>`. */
  secretKeys?: Iterable<string>;
  /** The whole file holds secrets (a settings bundle): a dry run prints its verdict alone. */
  secret?: boolean;
}

export function writeText(path: string, text: string, options: WriteOptions = {}): void {
  if (options.atomic === false) writeInPlace(path, text, options);
  else writeStaged(path, text, options);
}

export function writeBytes(path: string, bytes: Uint8Array, options: WriteOptions = {}): void {
  if (options.atomic === false) writeInPlace(path, bytes, options);
  else writeStaged(path, bytes, options);
}

function writeInPlace(path: string, data: string | Uint8Array, options: WriteOptions): void {
  const was = look(path);
  try {
    writeFileSync(path, data, { mode: options.mode });
  } catch (err) {
    reportTransition(path, was, "write failed");
    throw err;
  }
  reportWrite(kindOf(was), path, options.detail);
}

/** A same-directory temp file (`<name>.tmp.<pid>`: one writer per process at a time, so the pid
 *  alone keeps writers apart) written, fsynced, and renamed over the target, so a reader never
 *  sees a torn file. `mode` restricts the temp file from creation, so the rename publishes an
 *  already-restricted inode. */
function writeStaged(path: string, data: string | Uint8Array, options: WriteOptions): void {
  mkdir(dirname(path));
  const was = look(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
  // A stale temp from a crashed run under this pid goes first: `mode` applies only to a fresh
  // inode, so writing into it would publish its old permissions. Through the seam, because with pid
  // reuse the path could be a file the user made.
  rm(tmp, { force: true, detail: "stale temp file" });
  const tmpWas = look(tmp);
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = openSync(tmp, "w", options.mode);
    try {
      for (let written = 0; written < bytes.length;) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The open applied the umask; an explicit mode lands exactly, as Deno's own write does.
    if (options.mode !== undefined) chmodSync(tmp, options.mode);
  } catch (err) {
    dropTransient(tmp, tmpWas);
    throw err;
  }
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    dropTransient(tmp, tmpWas);
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RENAME_REFUSED_CODES.has(code)) {
      throw new RenameRefusedError(path, err);
    }
    throw err;
  }
  reportWrite(kindOf(was), path, options.detail);
}

export function copyFile(from: string, to: string, detail?: string): void {
  const was = look(to);
  try {
    copyFileSync(from, to);
  } catch (err) {
    reportTransition(to, was, "copy failed");
    throw err;
  }
  reportWrite(kindOf(was), to, detail);
}

/** Names every directory actually created, outermost first; `detail` rides on the directory asked
 *  for. An ancestor that exists as a regular file is mkdir's ENOTDIR. */
export function mkdir(path: string, mode?: number, detail?: string): void {
  const missing = missingDirectories(path);
  try {
    mkdirSync(path, { recursive: true, mode });
  } catch (err) {
    for (const made of missing) reportTransition(made, { kind: "absent" });
    throw err;
  }
  for (const made of missing) reportWrite("created", made, made === path ? detail : undefined);
}

/** A mode change is a rewrite of the entry, deduped away when this process already announced the
 *  path. */
export function chmod(path: string, mode: number): void {
  chmodSync(path, mode);
  reportWrite("rewritten", path);
}

export interface RemoveOptions {
  recursive?: boolean;
  /** An absent path is no error, as in node. */
  force?: boolean;
  detail?: string;
}

/** node's rmSync, named: a directory needs `recursive` (ERR_FS_EISDIR), an absent path needs
 *  `force` (ENOENT), and a lookup under a file is its ENOTDIR whatever `force` says. Returns
 *  whether anything was there. A removal that fails partway is named for what it provably changed. */
export function rm(path: string, options: RemoveOptions = {}): boolean {
  const recursive = options.recursive ?? false;
  // node's own refusals first; a look that failed for another reason (EACCES) is left to the
  // removal itself.
  let entry: Stats | null = null;
  try {
    entry = lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (options.force) return false;
      throw errno("ENOENT", "lstat", path);
    }
    if (code === "ENOTDIR") throw e;
  }
  if (entry !== null && entry.isDirectory() && !recursive) throw rmDirectoryRefused(path);
  const was = look(path, recursive);
  try {
    rmSync(path, { recursive, force: true });
  } catch (err) {
    reportTransition(path, was, "partly removed", recursive);
    throw err;
  }
  reportWrite("deleted", path, options.detail);
  return true;
}

/** node's rmdirSync, named: an empty directory (or a Windows junction) goes; entries (ENOTEMPTY),
 *  a file (ENOTDIR, on Windows too), and an absent path (ENOENT) are its own refusals. */
export function rmdir(path: string): void {
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** A move OUT of a scratch dir is the creation of `to` (the source never existed for the user); a
 *  move INTO one is the deletion of `from`. */
export function rename(from: string, to: string): void {
  const was = look(to, true);
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const source = look(from, true);
    try {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      // A partial copy is a change.
      reportTransition(to, was, "copy failed", true);
      throw err;
    }
    try {
      rmSync(from, { recursive: true, force: true });
    } catch (err) {
      // The copy landed but the source would not (fully) go: no move happened.
      reportWrite(kindOf(was), to);
      reportTransition(from, source, "partly removed", true);
      throw err;
    }
  }
  if (underScratch(from)) {
    reportWrite(kindOf(was), to);
    return;
  }
  if (underScratch(to)) {
    reportWrite("deleted", from);
    return;
  }
  forgetReported(from);
  reportWrite("moved", to, `from ${from}`);
}

/** node's symlinkSync: an entry at the path is its EEXIST (atomicSymlink is the replacing shape). */
export function symlink(target: string, path: string, type?: "junction"): void {
  symlinkSync(target, path, type);
  reportWrite("linked", path, `to ${target}`);
}

/** The replacement link is built aside and renamed over `link`, so a concurrent reader never sees a
 *  missing link. */
export function atomicSymlink(target: string, link: string): void {
  const staged = join(dirname(link), `.${basename(link)}-next-${process.pid}`);
  // A stale staging entry from a crashed run under this pid goes first, through the seam: with
  // pid reuse the path could be a file the user made, so its removal is named.
  rm(staged, { force: true, detail: "stale staging file" });
  const was = look(staged);
  symlinkSync(target, staged);
  try {
    renameSync(staged, link);
  } catch (err) {
    dropTransient(staged, was);
    throw err;
  }
  reportWrite("linked", link, `to ${target}`);
}

/**
 * A file opened for writing (created or truncated at the open, which is the mutation reported):
 * the one way runtime code streams bytes to a path (a release download, the daemon's log).
 */
export async function openWritable(path: string): Promise<Deno.FsFile> {
  const was = look(path);
  const file = await Deno.open(path, { write: true, create: true, truncate: true });
  reportWrite(kindOf(was), path);
  return file;
}

/** openWritable as a node fd, for a child's stdio. */
export function openWriteFd(path: string): number {
  const was = look(path);
  const fd = openSync(path, "w");
  reportWrite(kindOf(was), path);
  return fd;
}

/** Nothing written under it is reported, because removeScratchDir takes it all away before exit. */
export function scratchDir(prefix: string): ScratchDir {
  const dir = mkdtempSync(prefix) as ScratchDir;
  trackScratch(dir);
  return dir;
}

/** A removal that fails names the root it left behind, the one scratch fact the user then keeps. */
export function removeScratchDir(dir: ScratchDir): void {
  untrackScratch(dir);
  // Minted by us from nothing: whatever a failed removal leaves is a creation.
  dropTransient(dir, { kind: "absent" }, true);
}

// --- the rename over a live file -------------------------------------------------------------------

/** What a rename refused by an open handle on the destination surfaces (Windows: the daemon,
 *  antivirus, the search indexer). */
const RENAME_REFUSED_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/** The live file is untouched; the staged copy is dropped where removal succeeded, and a leftover
 *  is reported. The one failure a caller may answer with a direct write (the installer's launcher
 *  shims); every other failure propagates as itself. */
export class RenameRefusedError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`rename over ${path} refused (the file is held open)`, { cause });
    this.name = "RenameRefusedError";
  }
}

/** A POSIX rename over an open destination always succeeds; Windows transiently refuses it while
 *  another process holds the file open. */
export function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  rename: (f: string, t: string) => void = renameSync,
): void {
  for (let i = 0; i <= attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || code === undefined || !RENAME_REFUSED_CODES.has(code)) {
        throw err;
      }
      sleepSync(50);
    }
  }
}
