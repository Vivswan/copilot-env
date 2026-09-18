// The filesystem a dry run writes into: an in-memory layer over the disk, keyed by canonical path
// (every symlink on the disk resolved, so an alias and its target are one entry). A read answers
// from the layer first and the disk second, so a reader in the same run sees what an earlier write
// planned, and a listing merges the disk's names with the layer's creates minus its deletes. For
// the sequences the writers issue, an error the planned state alone determines is mirrored with the
// platform's own node:fs code and syscall name, so a caller's catch logic reads the same whichever
// mode runs. Not simulated: permissions and disk space (EACCES, ENOSPC), and a rename onto an
// existing destination (no writer issues one); a dry run reports what the real run would attempt.
//
// Tombstones and the disk. A planned delete leaves a `gone` entry; a directory the run made where
// the disk had none (or a tombstone) is `fresh`, and nothing the disk holds below it is visible:
//
//   rm -rf ~/.codex; mkdir ~/.codex           -> ~/.codex lists nothing the disk has under it
//   chmod ~/.codex 0700 (disk dir, no rm)     -> mode recorded, the disk's children still list
//   write ~/.codex/a; rm ~/.codex/a           -> `gone`; the report drops it (absent before and after)
//
// A link the run plans (the installer's `current`) is a `link` entry: a lookup through it restarts
// at its target, an lstat sees the link, and a disk link a rename moves stays a link. A disk file
// the layer carries (a chmod, a rename, a copy) is held by path, never decoded: a binary moves as
// bytes, and only a text read decodes it.
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { RenameRefusedError } from "./fs_disk.ts";

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

/** Planned text or bytes, or the disk file the entry carries by path. */
export type FileContent = { text: string } | { bytes: Uint8Array } | { disk: string };

export type OverlayEntry =
  | { kind: "file"; content: FileContent; mode: number; mtimeMs: number }
  | { kind: "dir"; mode: number; mtimeMs: number; fresh: boolean }
  | { kind: "link"; target: string; mtimeMs: number }
  | { kind: "gone" };

export interface OverlayWrite {
  mode?: number;
  /** The write lands a fresh inode (a staged file renamed over the path), so the file takes a fresh
   *  inode's mode even when it exists. */
  replace?: boolean;
  secretKeys?: Iterable<string>;
  /** The whole file holds secrets (a settings bundle): the report prints its verdict alone. */
  secret?: boolean;
}

type Present = Exclude<OverlayEntry, { kind: "gone" }> | { kind: "disk"; stats: Stats };

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

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

/** The kernel's bound on a chain of links. */
const MAX_LINK_HOPS = 40;

/** An error shaped as node:fs throws it, so `(e as NodeJS.ErrnoException).code` reads the same. */
export function errno(code: string, syscall: string, path: string, dest?: string): Error {
  const target = dest === undefined ? `'${path}'` : `'${path}' -> '${dest}'`;
  const e: NodeJS.ErrnoException = new Error(`${code}: ${ERRNO_TEXT[code]}, ${syscall} ${target}`);
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}

/** node's rmSync refusal of a directory without `recursive`: a SystemError, not an errno. */
export function rmDirectoryRefused(path: string): Error {
  const e: NodeJS.ErrnoException = new Error(
    `Path is a directory: rm returned EISDIR (is a directory) ${path}`,
  );
  e.code = "ERR_FS_EISDIR";
  return e;
}

const WINDOWS = process.platform === "win32";

/** The mode a fresh entry lands with under Deno. A file's explicit mode is set by a chmod after the
 *  create, so it lands exactly; a directory's goes to the OS, which applies the umask, as it does
 *  to either default. */
function freshMode(mode: number | undefined, kind: "file" | "dir"): number {
  if (mode !== undefined && kind === "file") return platformMode(mode);
  return platformMode((mode ?? (kind === "file" ? 0o666 : 0o777)) & ~umask());
}

/** The mode the platform reports for `mode`. Windows keeps one bit, read-only: Deno's stat says
 *  0666 for anything writable and 0444 otherwise, for a directory too. */
function platformMode(mode: number): number {
  if (WINDOWS) return (mode & 0o222) === 0 ? 0o444 : 0o666;
  return mode & 0o777;
}

/** What a lookup under a regular file raises: ENOTDIR on POSIX; Windows reports the path as not
 *  found, except that node's own recursive mkdir says ENOTDIR. */
function underFile(syscall: string): string {
  return !WINDOWS || syscall === "mkdir" ? "ENOTDIR" : "ENOENT";
}

/** Windows has no umask (Deno refuses the call), and no bits for one to mask. */
function umask(): number {
  try {
    return process.umask();
  } catch {
    return 0;
  }
}

function isDir(seen: Present): boolean {
  return seen.kind === "dir" || (seen.kind === "disk" && seen.stats.isDirectory());
}

function isLink(seen: Present): boolean {
  return seen.kind === "link" || (seen.kind === "disk" && seen.stats.isSymbolicLink());
}

/** An absolute path as its root (`/`, `C:\`) and the components under it. resolve() has already
 *  normalized the separators, so only the platform's own splits: a backslash is a byte of a POSIX
 *  name. */
function split(abs: string): { root: string; parts: string[] } {
  const { root } = parse(abs);
  return { root, parts: abs.slice(root.length).split(sep).filter((part) => part !== "") };
}

function statsOf(entry: Exclude<OverlayEntry, { kind: "gone" }>): EntryStats {
  const kind = entry.kind;
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
    mode: kind === "file"
      ? S_IFREG | entry.mode
      : kind === "dir"
      ? S_IFDIR | entry.mode
      : S_IFLNK | 0o777,
    size: kind === "file" ? contentSize(entry.content) : kind === "link" ? entry.target.length : 0,
    mtimeMs: entry.mtimeMs,
  };
}

function contentSize(content: FileContent): number {
  if ("text" in content) return new TextEncoder().encode(content.text).length;
  if ("bytes" in content) return content.bytes.length;
  return statSync(content.disk).size;
}

export class Overlay {
  /** By canonical path. Insertion order is first-touch order, which is the order the report
   *  prints; a re-touch keeps its place. */
  readonly entries = new Map<string, OverlayEntry>();
  /** The path as the first write to each key spelled it: what the report prints, so a user sees
   *  the path the command named rather than where a link led. */
  private readonly names = new Map<string, string>();
  /** Per key, every attribute a write declared secret, kept across the run's later writes to the
   *  same path: a key once declared never prints, whether or not a later writer repeats it. */
  private readonly secrets = new Map<string, Set<string>>();
  /** The keys a write declared secret as a whole. */
  private readonly secretFiles = new Set<string>();
  /** Keys the run landed under its own scratch (a move or copy into it): the report never names
   *  them, since scratch goes before exit and was never the user's. */
  private readonly hidden = new Set<string>();

  nameOf(key: string): string {
    return this.names.get(key) ?? key;
  }

  /** Marks what stands at `path` (and below) as the run's own scratch, off the report. */
  hide(path: string): void {
    this.hidden.add(this.key(path, false));
  }

  isHidden(key: string): boolean {
    for (const root of this.hidden) if (key === root || isBelow(key, root)) return true;
    return false;
  }

  secretKeysOf(key: string): ReadonlySet<string> {
    return this.secrets.get(key) ?? new Set();
  }

  isSecretFile(key: string): boolean {
    return this.secretFiles.has(key);
  }

  /** The key `path` names, resolved one component at a time against the run's own state: a
   *  component the layer holds is taken as planned (a tombstoned or planned path is never a disk
   *  link to follow), a link (planned, or on the disk while the disk still speaks there) is followed
   *  one hop with the walk restarting at its target, so every hop meets the planned state, and the
   *  last component stays a link when `follow` is off (lstat, rm, rename, readlink, and a staged
   *  write act on the link itself). */
  private key(path: string, follow = true): string {
    let { root: cur, parts: pending } = split(resolve(path));
    let diskSpeaks = true;
    let hops = 0;
    while (pending.length > 0) {
      const part = pending.shift() as string;
      const next = join(cur, part);
      let target: string | null = null;
      const own = this.entries.get(next);
      if (own !== undefined) {
        if (own.kind !== "link" || (!follow && pending.length === 0)) {
          diskSpeaks = own.kind === "dir" && !own.fresh;
          cur = next;
          continue;
        }
        target = own.target;
      } else {
        cur = next;
        if (!diskSpeaks || (!follow && pending.length === 0)) continue;
        try {
          if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
        } catch {
          // Absent or under a file: the tail stays as spelled and view() judges it.
        }
        if (target === null) continue;
      }
      // The kernel's own bound on a chain of links (a link to itself included).
      if (++hops > MAX_LINK_HOPS) throw errno("ELOOP", follow ? "stat" : "lstat", path);
      const restart = split(resolve(dirname(next), target));
      cur = restart.root;
      pending = [...restart.parts, ...pending];
      diskSpeaks = true;
    }
    return cur;
  }

  /** The name a key prints under is the spelling of the first write that touched it. */
  private set(key: string, entry: OverlayEntry, spelled: string): void {
    if (!this.names.has(key)) this.names.set(key, spelled);
    this.entries.set(key, entry);
  }

  /** Whether the disk still speaks for `key`, judged by the nearest overlay ancestor. An overlay
   *  file above `key` is what node reports for a lookup under a regular file. */
  private diskBelow(key: string, syscall: string, path: string): boolean {
    for (let cur = dirname(key);; cur = dirname(cur)) {
      const above = this.entries.get(cur);
      if (above !== undefined) {
        if (above.kind === "file") throw errno(underFile(syscall), syscall, path);
        return above.kind === "dir" && !above.fresh;
      }
      if (dirname(cur) === cur) return true;
    }
  }

  /** What the run sees at `key`, or null for nothing. */
  private view(key: string, syscall: string, path: string, follow = true): Present | null {
    const own = this.entries.get(key);
    if (own !== undefined) return own.kind === "gone" ? null : own;
    if (!this.diskBelow(key, syscall, path)) return null;
    try {
      return { kind: "disk", stats: follow ? statSync(key) : lstatSync(key) };
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
  }

  private dropBelow(key: string): void {
    for (const recorded of [...this.entries.keys()]) {
      if (isBelow(recorded, key)) this.entries.delete(recorded);
    }
  }

  /** The file at `path` as the run sees it, for a read that decodes or copies its bytes. */
  private fileAt(path: string, syscall: string): FileContent {
    const key = this.key(path);
    const seen = this.view(key, syscall, path);
    if (seen === null) throw errno("ENOENT", syscall, path);
    if (seen.kind === "file") return seen.content;
    if (isDir(seen)) throw errno("EISDIR", syscall, path);
    return { disk: key };
  }

  readText(path: string): string {
    const content = this.fileAt(path, "open");
    if ("text" in content) return content.text;
    if ("bytes" in content) return new TextDecoder().decode(content.bytes);
    return readFileSync(content.disk, "utf8");
  }

  readBytes(path: string): Uint8Array {
    const content = this.fileAt(path, "open");
    if ("text" in content) return new TextEncoder().encode(content.text);
    // A copy, so a caller's edits never reach the planned bytes.
    if ("bytes" in content) return content.bytes.slice();
    return new Uint8Array(readFileSync(content.disk));
  }

  /** The parent a write lands under, judged as node judges it (absent is ENOENT, a file ENOTDIR). */
  private landingParent(key: string, syscall: string, path: string, dest?: string): void {
    const parent = this.view(dirname(key), syscall, path);
    if (parent === null) throw errno("ENOENT", syscall, path, dest);
    if (!isDir(parent)) throw errno(underFile(syscall), syscall, path, dest);
  }

  /** An explicit mode lands whether the file exists or not (Deno chmods after the write); without
   *  one an existing file keeps its mode and a fresh inode takes the default. A staged write
   *  (`replace`) lands at the path itself, so a link there is replaced, as the real rename does. */
  writeText(path: string, text: string, write: OverlayWrite = {}): void {
    this.land(path, { text }, write);
  }

  writeBytes(path: string, bytes: Uint8Array, write: OverlayWrite = {}): void {
    // The caller's buffer may be reused; the layer keeps its own copy.
    this.land(path, { bytes: bytes.slice() }, write);
  }

  /** The bytes of `from` as the run sees them, landed at `to` with the source's mode, as
   *  copyFileSync lands them: by path (never decoded), or by value when the source will not
   *  outlive the run (scratch). The source's secret declarations travel with them. */
  copyFile(from: string, to: string, byValue = false): void {
    const content = this.fileAt(from, "copyfile");
    const carried = byValue && "disk" in content
      ? { bytes: new Uint8Array(readFileSync(content.disk)) }
      : content;
    this.land(to, carried, { mode: this.stat(from).mode & 0o777 });
    this.carrySecrets(this.key(from), this.key(to));
  }

  private land(path: string, content: FileContent, write: OverlayWrite): void {
    const key = this.key(path, !write.replace);
    this.landingParent(key, "open", path);
    const seen = this.view(key, "open", path, !write.replace);
    // Windows opens a directory for writing with EINVAL, and refuses the staged rename over one
    // with the EPERM the real writer wraps as RenameRefusedError (the installer answers that class
    // with a direct write).
    if (seen !== null && isDir(seen)) {
      if (write.replace && WINDOWS) {
        throw new RenameRefusedError(path, errno("EPERM", "rename", path));
      }
      throw errno(!write.replace && WINDOWS ? "EINVAL" : "EISDIR", "open", path);
    }
    const mode = write.mode !== undefined || seen === null || write.replace || seen.kind === "link"
      ? freshMode(write.mode, "file")
      : seen.kind === "disk"
      ? seen.stats.mode & 0o777
      : seen.mode;
    if (write.secretKeys !== undefined) {
      const declared = this.secrets.get(key) ?? new Set<string>();
      for (const k of write.secretKeys) declared.add(k);
      this.secrets.set(key, declared);
    }
    if (write.secret) this.secretFiles.add(key);
    this.set(key, { kind: "file", content, mode, mtimeMs: Date.now() }, resolve(path));
  }

  stat(path: string, follow = true): EntryStats {
    const syscall = follow ? "stat" : "lstat";
    const seen = this.view(this.key(path, follow), syscall, path, follow);
    if (seen === null) throw errno("ENOENT", syscall, path);
    return seen.kind === "disk" ? seen.stats : statsOf(seen);
  }

  exists(path: string): boolean {
    try {
      return this.view(this.key(path), "access", path) !== null;
    } catch {
      return false;
    }
  }

  readdir(path: string): string[] {
    const key = this.key(path);
    const seen = this.view(key, "scandir", path);
    if (seen === null) throw errno("ENOENT", "scandir", path);
    if (!isDir(seen)) throw errno("ENOTDIR", "scandir", path);
    const names = new Set<string>(seen.kind === "dir" && seen.fresh ? [] : readdirSync(key));
    for (const [recorded, entry] of this.entries) {
      if (recorded === key || dirname(recorded) !== key) continue;
      if (entry.kind === "gone") names.delete(basename(recorded));
      else names.add(basename(recorded));
    }
    return [...names].sort();
  }

  /** Each name with its own kind (a link is the link), as `readdir` with file types lists them. */
  readdirEntries(path: string): DirEntry[] {
    return this.readdir(path).map((name) => {
      const stats = this.stat(join(path, name), false);
      return {
        name,
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink(),
      };
    });
  }

  /** The target text of the link at `path`, planned or on the disk; a non-link is EINVAL. */
  readlink(path: string): string {
    const key = this.key(path, false);
    const seen = this.view(key, "readlink", path, false);
    if (seen === null) throw errno("ENOENT", "readlink", path);
    if (seen.kind === "link") return seen.target;
    if (seen.kind === "disk" && seen.stats.isSymbolicLink()) return readlinkSync(key);
    throw errno("EINVAL", "readlink", path);
  }

  /** The canonical path, every link (planned or on the disk) resolved; absent is node's ENOENT. */
  realpath(path: string): string {
    const key = this.key(path);
    if (this.view(key, "lstat", path) === null) throw errno("ENOENT", "lstat", path);
    return key;
  }

  /** Always recursive (`mkdir -p`): an existing directory is a no-op, a regular file at the path or
   *  above it fails as node's recursive mkdir does. */
  mkdir(path: string, mode?: number): void {
    const asked = this.key(path);
    // A link on the way whose target is gone (a `~/.local` link whose target the run removed) is
    // what mkdir meets, and it refuses it as EEXIST rather than creating the target behind it.
    const spelled = split(resolve(path));
    for (let cur = spelled.root, i = 0; i < spelled.parts.length; i++) {
      cur = join(cur, spelled.parts[i] as string);
      const link = this.view(this.key(cur, false), "mkdir", path, false);
      if (link !== null && isLink(link) && this.view(this.key(cur), "mkdir", path) === null) {
        throw errno("EEXIST", "mkdir", path);
      }
    }
    const missing: [string, string][] = [];
    // The canonical and the spelled path climb together, so an ancestor made here is named as the
    // caller spelled it.
    for (let cur = asked, said = resolve(path);; cur = dirname(cur), said = dirname(said)) {
      const seen = this.view(cur, "mkdir", path);
      if (seen !== null) {
        if (!isDir(seen)) throw errno(cur === asked ? "EEXIST" : "ENOTDIR", "mkdir", path);
        break;
      }
      missing.unshift([cur, said]);
      if (dirname(cur) === cur) break;
    }
    for (const [dir, said] of missing) {
      this.set(dir, {
        kind: "dir",
        mode: freshMode(mode, "dir"),
        mtimeMs: Date.now(),
        fresh: true,
      }, said);
    }
  }

  /** node's rmSync: a directory needs `recursive` (ERR_FS_EISDIR), an absent path needs `force`.
   *  Returns whether anything was there. */
  rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): boolean {
    const key = this.key(path, false);
    let seen: Present | null;
    try {
      seen = this.view(key, "lstat", path, false);
    } catch (e) {
      // Windows reads a path under a file as absent, which `force` forgives.
      if (options.force && isEnoent(e)) return false;
      throw e;
    }
    if (seen === null) {
      if (options.force) return false;
      throw errno("ENOENT", "lstat", path);
    }
    if (isDir(seen) && !options.recursive) throw rmDirectoryRefused(path);
    this.dropBelow(key);
    this.set(key, { kind: "gone" }, resolve(path));
    return true;
  }

  /** node's rmdirSync: an empty directory goes (the run's own creations and removals under it
   *  count), a file is ENOTDIR, entries are ENOTEMPTY. A link is the entry itself: Windows removes a
   *  junction with rmdir, POSIX refuses a symlink as not a directory. */
  rmdir(path: string): void {
    const key = this.key(path, false);
    const seen = this.view(key, "rmdir", path, false);
    if (seen === null) throw errno("ENOENT", "rmdir", path);
    if (isLink(seen)) {
      if (!WINDOWS) throw errno("ENOTDIR", "rmdir", path);
    } else {
      if (!isDir(seen)) throw errno("ENOTDIR", "rmdir", path);
      if (this.readdir(path).length > 0) throw errno("ENOTEMPTY", "rmdir", path);
    }
    this.set(key, { kind: "gone" }, resolve(path));
  }

  /** A disk entry is carried into the layer with its mode changed: the diff must be able to tell a
   *  mode-only change from untouched content. */
  chmod(path: string, mode: number): void {
    const key = this.key(path);
    const seen = this.view(key, "chmod", path);
    if (seen === null) throw errno("ENOENT", "chmod", path);
    const entry = seen.kind === "disk" ? materialize(key, seen.stats, false) : seen;
    if (entry.kind === "link") return;
    this.set(key, { ...entry, mode: platformMode(mode) }, resolve(path));
  }

  /** node's symlinkSync: the parent must exist, the path must not. */
  symlink(target: string, path: string): void {
    const key = this.key(path, false);
    this.landingParent(key, "symlink", target, path);
    if (this.view(key, "symlink", path, false) !== null) {
      throw errno("EEXIST", "symlink", target, path);
    }
    this.set(key, { kind: "link", target, mtimeMs: Date.now() }, resolve(path));
  }

  /** A link built aside and renamed over `link`: a file or a link there is replaced, a directory
   *  is the rename's own refusal (EISDIR; EPERM on Windows), raw, as the disk side raises it. */
  atomicSymlink(target: string, link: string): void {
    const key = this.key(link, false);
    this.landingParent(key, "rename", link);
    const seen = this.view(key, "rename", link, false);
    if (seen !== null && isDir(seen)) {
      throw errno(WINDOWS ? "EPERM" : "EISDIR", "rename", link);
    }
    this.set(key, { kind: "link", target, mtimeMs: Date.now() }, resolve(link));
  }

  /** The source subtree moves into the layer under `to` (planned text, disk files by path, or by
   *  value when the source will not outlive the run, links as links) and `from` is tombstoned. A
   *  destination that exists is replaced without a refusal: every writer moves onto a path it has
   *  cleared or that was never there. */
  rename(from: string, to: string, byValue = false): void {
    const src = this.key(from, false);
    const dst = this.key(to, false);
    const source = this.view(src, "rename", from, false);
    if (source === null) throw errno("ENOENT", "rename", from, to);
    this.landingParent(dst, "rename", from, to);
    if (isBelow(dst, src)) throw errno("EINVAL", "rename", from, to);
    const moved = this.collect(src, source, byValue);
    this.dropBelow(src);
    this.set(src, { kind: "gone" }, resolve(from));
    this.dropBelow(dst);
    const spelled = resolve(to);
    for (const [rel, entry] of moved) {
      const key = rel === "" ? dst : join(dst, rel);
      this.set(key, entry, rel === "" ? spelled : join(spelled, rel));
      // What a path declared secret travels with its content, so the report at the new path
      // redacts the same values.
      this.carrySecrets(rel === "" ? src : join(src, rel), key);
    }
  }

  /** The secret declarations of `from` join `to`'s (a moved or copied file keeps its redaction). */
  private carrySecrets(from: string, to: string): void {
    const keys = this.secrets.get(from);
    if (keys !== undefined) {
      const declared = this.secrets.get(to) ?? new Set<string>();
      for (const k of keys) declared.add(k);
      this.secrets.set(to, declared);
    }
    if (this.secretFiles.has(from)) this.secretFiles.add(to);
  }

  /** Every entry of the subtree at `key`, keyed by path relative to it (the root is ""), as the run
   *  sees it. */
  /** Every entry of the subtree at `key`, keyed by path relative to it (the root is ""), as the run
   *  sees it; a disk file is carried by value when asked (the source will not outlive the run). */
  private collect(
    key: string,
    seen: Present,
    byValue: boolean,
    rel = "",
  ): [string, OverlayEntry][] {
    const entry = seen.kind === "disk" ? materialize(key, seen.stats, true) : { ...seen };
    if (entry.kind === "dir") entry.fresh = true;
    if (byValue && entry.kind === "file" && "disk" in entry.content) {
      entry.content = { bytes: new Uint8Array(readFileSync(entry.content.disk)) };
    }
    const out: [string, OverlayEntry][] = [[rel, entry]];
    if (entry.kind !== "dir") return out;
    for (const name of this.readdir(key)) {
      const child = join(key, name);
      const childSeen = this.view(child, "rename", child, false);
      if (childSeen === null) continue;
      out.push(...this.collect(child, childSeen, byValue, rel === "" ? name : join(rel, name)));
    }
    return out;
  }
}

/** A disk entry as the layer carries it: a file by path, so its bytes are never decoded here; a
 *  link by its target text. */
function materialize(
  key: string,
  stats: Stats,
  fresh: boolean,
): Exclude<OverlayEntry, { kind: "gone" }> {
  const mode = stats.mode & 0o777;
  if (stats.isSymbolicLink()) {
    return { kind: "link", target: readlinkSync(key), mtimeMs: stats.mtimeMs };
  }
  if (stats.isDirectory()) return { kind: "dir", mode, mtimeMs: stats.mtimeMs, fresh };
  return { kind: "file", content: { disk: key }, mode, mtimeMs: stats.mtimeMs };
}

/** Whether `path` is a strict descendant of `dir` (both resolved). */
export function isBelow(path: string, dir: string): boolean {
  for (let cur = dirname(path);; cur = dirname(cur)) {
    if (cur === dir) return true;
    if (dirname(cur) === cur) return false;
  }
}
