// The filesystem a dry run writes into: a memfs Volume holding what the run planned, unioned here
// with the disk underneath and keyed by canonical path (every link resolved, so an alias and its
// target are one entry). A read answers from the volume where the run planned and from the disk
// elsewhere; a listing merges the disk's names with the volume's minus the run's tombstones. For
// the sequences the writers issue, an error the planned state alone determines is mirrored with the
// platform's own node:fs code and syscall name, so a caller's catch logic reads the same whichever
// mode runs. Not simulated: permissions and disk space (EACCES, ENOSPC), and a rename onto an
// existing destination (no writer issues one); a dry run reports what the real run would attempt.
//
// The union is ours, never memfs's: memfs knows nothing of the disk, so the walk that resolves a
// path against planned links and disk links, the tombstones, the fresh-directory shadowing, the
// modes, and the per-platform errno table live here, and every volume call takes a canonical key.
// What the volume owns is what the run planned at those keys: bytes, links, directories, listings.
// Modes stay out of it: memfs enforces permission bits (a 0444 file refuses a write, a directory
// without execute bits refuses traversal, which is every Windows directory once folded), and the
// run simulates no permission failure, so the volume keeps memfs's defaults and each entry's
// reported mode is recorded here.
//
//   rm -rf ~/.codex; mkdir ~/.codex           -> ~/.codex lists nothing the disk has under it
//   chmod ~/.codex 0700 (disk dir, no rm)     -> mode recorded, the disk's children still list
//   write ~/.codex/a; rm ~/.codex/a           -> a tombstone; the report drops it (absent both sides)
//
// A disk entry the run carries (a chmod, a rename, a copy) is loaded into the volume by value; its
// bytes are never decoded here, and the report prints its verdict alone. A directory the volume
// holds only as a planned entry's ancestor is the disk's own: no row, and the disk speaks below it.
import type { Volume } from "memfs";
import type { Stats } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import * as disk from "./fs_disk.ts";
import {
  type DirEntry,
  type EntryStats,
  errno,
  RenameRefusedError,
  rmDirectoryRefused,
} from "./fs_disk.ts";

export type { DirEntry, EntryStats };

/** What the run holds at a key, for the report: a planned file (its text when the run wrote it as
 *  text, else its bytes alone), a directory (fresh: the disk below it is hidden), a link, or a
 *  tombstone. */
export type OverlayEntry =
  | { kind: "file"; text: string | null; bytes: () => Uint8Array; mode: number }
  | { kind: "dir"; mode: number; fresh: boolean }
  | { kind: "link"; target: string }
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

/** What a lookup meets: the run's own entry (the volume's stats) or the disk's. */
type Seen = { kind: "own"; stats: EntryStats } | { kind: "disk"; stats: Stats };

/** The kernel's bound on a chain of links. */
const MAX_LINK_HOPS = 40;

const WINDOWS = process.platform === "win32";

const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/** A fresh overlay on a fresh volume. memfs is loaded here, not at import: its module builds a
 *  default volume that asks the process for its uid, a cost and a permission only a dry run pays. */
export async function openOverlay(): Promise<Overlay> {
  const { Volume } = await import("memfs");
  return new Overlay(new Volume());
}

/** The volume is posix-rooted, and on win32 memfs strips a drive letter it is handed: a key maps
 *  under `/` with its separators turned (`C:\a` -> `/C:/a`, `\\srv\share\a` -> `/srv/share/a`), so
 *  the volume never sees a root of its own to rewrite. */
function volPath(key: string): string {
  if (!WINDOWS) return key;
  const { root } = parse(key);
  const rest = key.slice(root.length);
  return `/${root.replaceAll("\\", "/").replace(/^\/+/, "")}${rest.replaceAll("\\", "/")}`;
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}

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

/** An absolute path as its root (`/`, `C:\`) and the components under it. resolve() has already
 *  normalized the separators, so only the platform's own splits: a backslash is a byte of a POSIX
 *  name. */
function split(abs: string): { root: string; parts: string[] } {
  const { root } = parse(abs);
  return {
    root: foldKey(root),
    parts: abs.slice(root.length).split(sep).filter((part) => part !== ""),
  };
}

/** A key as the run's tables hold it. Windows names an entry whatever the case of its path, so a
 *  key there is folded to lower case (the root too) and every spelling of a path is one entry; the
 *  spelling the run used lives in `names` for the report, an entry's own name in `spellings` for
 *  the listings. */
function foldKey(key: string): string {
  return WINDOWS ? key.toLowerCase() : key;
}

export class Overlay {
  /** The report's rows, by canonical key in first-touch order: every key the run planned (the
   *  volume holds it) or tombstoned. A re-touch keeps its place; a key a tree removal dropped and
   *  a later write re-created takes the later place. */
  private readonly rows = new Set<string>();
  /** Planned deletions: a read sees nothing there, whatever the disk holds. */
  private readonly gone = new Set<string>();
  /** Directories the run made (or moved) where the disk did not speak: nothing the disk holds
   *  below one is visible. */
  private readonly fresh = new Set<string>();
  /** Files the run wrote as text, so the report may decode them; a byte write or a carried disk
   *  file is never decoded. */
  private readonly texts = new Set<string>();
  /** The mode each planned file or directory reports (a link reports 0777, as node's lstat does). */
  private readonly modes = new Map<string, number>();
  /** The path as the first write to each key spelled it: what the report prints, so a user sees
   *  the path the command named rather than where a link led. */
  private readonly names = new Map<string, string>();
  /** Windows only: each planned key's own name in its true case, what a listing and a moved
   *  tree's rows print. Two owners: the disk's spelling for an entry the disk holds (absorbed, or
   *  written over), and the mutation's own walk for one the run creates (`walked`: the component
   *  that produced the key, so a link's target names the entry, never the alias). A lookup never
   *  names anything; a case-only rename and a move set it outright. */
  private readonly spellings = new Map<string, string>();
  /** Windows only: the component each key was last walked through, the spelling `set()` takes
   *  for a key the run creates. Scratch: every walk overwrites it. */
  private readonly walked = new Map<string, string>();
  /** Per key, every attribute a write declared secret, kept across the run's later writes to the
   *  same path: a key once declared never prints, whether or not a later writer repeats it. */
  private readonly secrets = new Map<string, Set<string>>();
  /** The keys a write declared secret as a whole. */
  private readonly secretFiles = new Set<string>();
  /** Keys the run landed under its own scratch (a move or copy into it): the report never names
   *  them, since scratch goes before exit and was never the user's. */
  private readonly hidden = new Set<string>();

  constructor(private readonly vol: Volume) {}

  // --- the report's view -------------------------------------------------------------------------

  /** Every row with what the run holds there, in first-touch order. */
  *entries(): IterableIterator<[string, OverlayEntry]> {
    for (const key of this.rows) yield [key, this.entryAt(key)];
  }

  private entryAt(key: string): OverlayEntry {
    if (this.gone.has(key)) return { kind: "gone" };
    const path = volPath(key);
    const stats = this.vol.lstatSync(path);
    if (stats.isSymbolicLink()) {
      return { kind: "link", target: String(this.vol.readlinkSync(path)) };
    }
    const mode = this.modeOf(key);
    if (stats.isDirectory()) return { kind: "dir", mode, fresh: this.fresh.has(key) };
    return {
      kind: "file",
      text: this.texts.has(key) ? DECODER.decode(this.volBytes(path)) : null,
      bytes: () => this.volBytes(path),
      mode,
    };
  }

  private modeOf(key: string): number {
    const mode = this.modes.get(key);
    if (mode === undefined) throw new Error(`${key}: a planned entry with no mode`);
    return mode;
  }

  /** The volume's stats for a planned entry, with the mode the run recorded for it. */
  private ownStats(key: string): EntryStats {
    const stats = this.vol.lstatSync(volPath(key));
    const link = stats.isSymbolicLink();
    return {
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => link,
      mode: (stats.mode & ~0o777) | (link ? 0o777 : this.modeOf(key)),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  /** Whether the run planned or tombstoned `key` itself. */
  touched(key: string): boolean {
    return this.rows.has(foldKey(key));
  }

  nameOf(key: string): string {
    return this.names.get(key) ?? key;
  }

  /** The entry's own name as a listing prints it. */
  private basenameOf(key: string): string {
    return WINDOWS ? this.spellings.get(key) ?? basename(key) : basename(key);
  }

  /** The disk's own spelling of a non-link entry it holds at `key` (realpath restores the case a
   *  folded key lost); a key the run already planned keeps the name the run gave it. */
  private diskSpelling(key: string): void {
    if (!WINDOWS || this.rows.has(key)) return;
    try {
      this.spellings.set(key, basename(disk.realpath(key)));
    } catch {
      // Gone from the disk since it was seen: nothing to spell it by.
    }
  }

  /** Whether the volume holds an entry at `path` (a link counts, unfollowed). */
  private volHas(path: string): boolean {
    try {
      this.vol.lstatSync(path);
      return true;
    } catch (e) {
      if (isEnoent(e)) return false;
      throw e;
    }
  }

  /** Marks what stands at `path` (and below) as the run's own scratch, off the report. */
  hide(path: string): void {
    this.hidden.add(this.key(path, "lstat", false));
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

  // --- the volume, by canonical key ------------------------------------------------------------

  /** A copy, so a caller's edits never reach the planned bytes. */
  private volBytes(path: string): Uint8Array {
    return new Uint8Array(this.vol.readFileSync(path) as Uint8Array);
  }

  private volNames(path: string): string[] {
    return (this.vol.readdirSync(path) as (string | Uint8Array)[]).map((name) => String(name));
  }

  /** The ancestors a volume entry needs: a directory the disk holds is made in the volume as its
   *  stand-in (no row, and the disk still speaks below it). */
  private scaffold(dir: string): void {
    this.vol.mkdirSync(volPath(dir), { recursive: true });
  }

  /** Takes the volume's entry at `key` away, whole. memfs's rm follows a link, so a link (and a
   *  file) goes through unlink. */
  private unplan(key: string): void {
    const path = volPath(key);
    let stats: EntryStats;
    try {
      stats = this.vol.lstatSync(path);
    } catch (e) {
      if (isEnoent(e)) return;
      throw e;
    }
    if (stats.isDirectory()) this.vol.rmSync(path, { recursive: true, force: true });
    else this.vol.unlinkSync(path);
  }

  /** The disk entry at `key` loaded into the volume as it stands (a link by its target text, a
   *  file by its bytes, a directory with its mode), and with `deep` every disk child below a
   *  directory that the run has not planned or tombstoned. */
  private absorb(key: string, stats: Stats, deep: boolean): void {
    const path = volPath(key);
    this.scaffold(dirname(key));
    if (!stats.isSymbolicLink()) this.diskSpelling(key);
    // An entry an earlier absorb loaded (a case-only rename of its parent) is loaded once.
    const held = this.volHas(path);
    if (stats.isSymbolicLink()) {
      if (!held) this.vol.symlinkSync(disk.readlink(key), path);
      return;
    }
    if (stats.isDirectory()) {
      if (!held) this.vol.mkdirSync(path);
      this.modes.set(key, stats.mode & 0o777);
      if (deep) this.absorbChildren(key);
      return;
    }
    if (!held) this.vol.writeFileSync(path, disk.readBytes(key));
    this.modes.set(key, stats.mode & 0o777);
  }

  /** Every disk child of `key` the run has not planned or tombstoned; a planned directory the
   *  disk still speaks below (a chmod'd one) carries its own disk children the same way. */
  private absorbChildren(key: string): void {
    for (const name of disk.readdir(key)) {
      const child = foldKey(join(key, name));
      if (this.gone.has(child)) continue;
      // The disk's spelling of an entry the run left alone; a planned one keeps the run's.
      if (WINDOWS && !this.rows.has(child)) this.spellings.set(child, name);
      if (this.rows.has(child)) {
        if (this.vol.lstatSync(volPath(child)).isDirectory() && !this.fresh.has(child)) {
          this.absorbChildren(child);
        }
        continue;
      }
      this.absorb(child, disk.lstat(child), true);
    }
  }

  // --- the union's bookkeeping -----------------------------------------------------------------

  /** The name a key prints under is the spelling of the first write that touched it. */
  private set(key: string, spelled: string): void {
    if (!this.names.has(key)) this.names.set(key, spelled);
    if (WINDOWS && !this.spellings.has(key)) {
      this.spellings.set(key, this.walked.get(key) ?? basename(spelled));
    }
    this.gone.delete(key);
    this.rows.add(key);
  }

  /** `key` is planned gone: its row stays (or joins), and nothing of the run's below it survives. */
  private markGone(key: string, spelled: string): void {
    if (!this.names.has(key)) this.names.set(key, spelled);
    this.fresh.delete(key);
    this.texts.delete(key);
    this.modes.delete(key);
    this.spellings.delete(key);
    this.rows.add(key);
    this.gone.add(key);
  }

  private tombstone(key: string, spelled: string): void {
    this.dropBelow(key);
    this.unplan(key);
    this.markGone(key, spelled);
  }

  /** Nothing of the run's below `key` survives: its rows, and the modes of the disk entries a move
   *  or chmod absorbed there without a row of their own. */
  private dropBelow(key: string): void {
    for (const recorded of [...this.rows]) {
      if (!isBelow(recorded, key)) continue;
      this.rows.delete(recorded);
      this.gone.delete(recorded);
      this.fresh.delete(recorded);
      this.texts.delete(recorded);
    }
    for (const table of [this.modes, this.spellings]) {
      for (const recorded of [...table.keys()]) {
        if (isBelow(recorded, key)) table.delete(recorded);
      }
    }
  }

  /** The key `path` names, resolved one component at a time against the run's own state: a
   *  component the run planned is taken as planned (a tombstoned or planned path is never a disk
   *  link to follow), a link (planned, or on the disk while the disk still speaks there) is followed
   *  one hop with the walk restarting at its target, so every hop meets the planned state, and the
   *  last component stays a link when `follow` is off (lstat, rm, rename, readlink, and a staged
   *  write act on the link itself). */
  private key(path: string, syscall: string, follow = true): string {
    let { root: cur, parts: pending } = split(resolve(path));
    let diskSpeaks = true;
    let hops = 0;
    while (pending.length > 0) {
      const part = pending.shift() as string;
      const next = foldKey(join(cur, part));
      if (WINDOWS) this.walked.set(next, part);
      let target: string | null = null;
      if (this.gone.has(next)) {
        diskSpeaks = false;
        cur = next;
        continue;
      }
      if (this.rows.has(next)) {
        const own = this.vol.lstatSync(volPath(next));
        if (!own.isSymbolicLink() || (!follow && pending.length === 0)) {
          diskSpeaks = own.isDirectory() && !this.fresh.has(next);
          cur = next;
          continue;
        }
        target = String(this.vol.readlinkSync(volPath(next)));
      } else {
        cur = next;
        if (!diskSpeaks || (!follow && pending.length === 0)) continue;
        try {
          if (disk.lstat(next).isSymbolicLink()) target = disk.readlink(next);
        } catch {
          // Absent or under a file: the tail stays as spelled and view() judges it.
        }
        if (target === null) continue;
      }
      // The kernel's own bound on a chain of links (a link to itself included).
      if (++hops > MAX_LINK_HOPS) throw errno("ELOOP", syscall, path);
      const restart = split(resolve(dirname(next), target));
      cur = restart.root;
      pending = [...restart.parts, ...pending];
      diskSpeaks = true;
    }
    return cur;
  }

  /** Whether the disk still speaks for `key`, judged by the nearest ancestor the run planned or
   *  tombstoned. A planned file above `key` is what node reports for a lookup under a regular
   *  file. */
  private diskBelow(key: string, syscall: string, path: string): boolean {
    for (let cur = dirname(key);; cur = dirname(cur)) {
      if (this.gone.has(cur)) return false;
      if (this.rows.has(cur)) {
        const above = this.vol.lstatSync(volPath(cur));
        if (above.isFile()) throw errno(underFile(syscall), syscall, path);
        return above.isDirectory() && !this.fresh.has(cur);
      }
      if (dirname(cur) === cur) return true;
    }
  }

  /** What the run sees at `key`, or null for nothing. */
  private view(key: string, syscall: string, path: string, follow = true): Seen | null {
    if (this.gone.has(key)) return null;
    if (this.rows.has(key)) return { kind: "own", stats: this.ownStats(key) };
    if (!this.diskBelow(key, syscall, path)) return null;
    try {
      return { kind: "disk", stats: follow ? disk.stat(key) : disk.lstat(key) };
    } catch (e) {
      if (isEnoent(e)) return null;
      // A lookup under a regular file on the disk: the syscall's own refusal, the platform's code.
      if ((e as NodeJS.ErrnoException).code === "ENOTDIR") {
        throw errno(underFile(syscall), syscall, path);
      }
      throw e;
    }
  }

  /** The file at `path` as the run sees it, for a read that decodes or copies its bytes. */
  private fileAt(path: string, syscall: string): { key: string; seen: Seen } {
    const key = this.key(path, syscall);
    const seen = this.view(key, syscall, path);
    if (seen === null) throw errno("ENOENT", syscall, path);
    if (seen.stats.isDirectory()) throw errno("EISDIR", syscall, path);
    return { key, seen };
  }

  /** The parent a write lands under, judged as node judges it (absent is ENOENT, a file ENOTDIR). */
  private landingParent(key: string, syscall: string, path: string, dest?: string): void {
    const parent = this.view(dirname(key), syscall, path);
    if (parent === null) throw errno("ENOENT", syscall, path, dest);
    if (!parent.stats.isDirectory()) throw errno(underFile(syscall), syscall, path, dest);
  }

  // --- reads -------------------------------------------------------------------------------------

  readText(path: string): string {
    const { key, seen } = this.fileAt(path, "open");
    return seen.kind === "own" ? DECODER.decode(this.volBytes(volPath(key))) : disk.readText(key);
  }

  readBytes(path: string): Uint8Array {
    const { key, seen } = this.fileAt(path, "open");
    return seen.kind === "own" ? this.volBytes(volPath(key)) : disk.readBytes(key);
  }

  stat(path: string, follow = true): EntryStats {
    const syscall = follow ? "stat" : "lstat";
    const seen = this.view(this.key(path, syscall, follow), syscall, path, follow);
    if (seen === null) throw errno("ENOENT", syscall, path);
    return seen.stats;
  }

  exists(path: string): boolean {
    try {
      return this.view(this.key(path, "access"), "access", path) !== null;
    } catch {
      return false;
    }
  }

  /** The disk's names (none under a fresh directory), plus the volume's, minus the tombstones. */
  readdir(path: string): string[] {
    const key = this.key(path, "scandir");
    const seen = this.view(key, "scandir", path);
    if (seen === null) throw errno("ENOENT", "scandir", path);
    if (!seen.stats.isDirectory()) throw errno("ENOTDIR", "scandir", path);
    // By folded name, so Windows lists one entry per spelling: the disk's for an entry the run
    // left alone (a scaffold stand-in included), the entry's own for one the run planned.
    const listed = new Map<string, string>();
    if (!this.fresh.has(key)) {
      for (const name of disk.readdir(key)) listed.set(foldKey(name), name);
    }
    if (this.vol.existsSync(volPath(key))) {
      for (const name of this.volNames(volPath(key))) {
        const child = join(key, name);
        if (this.rows.has(child) || !listed.has(name)) listed.set(name, this.basenameOf(child));
      }
    }
    for (const recorded of this.gone) {
      if (dirname(recorded) === key) listed.delete(basename(recorded));
    }
    return [...listed.values()].sort();
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
    const key = this.key(path, "readlink", false);
    const seen = this.view(key, "readlink", path, false);
    if (seen === null) throw errno("ENOENT", "readlink", path);
    if (!seen.stats.isSymbolicLink()) throw errno("EINVAL", "readlink", path);
    return seen.kind === "own" ? String(this.vol.readlinkSync(volPath(key))) : disk.readlink(key);
  }

  /** The canonical path, every link (planned or on the disk) resolved; absent is node's ENOENT.
   *  On Windows the key is folded, so the part the disk holds takes the OS's own spelling
   *  (`realpathSync.native`: case and 8.3 names) and the planned tail follows it as keyed. */
  realpath(path: string): string {
    const key = this.key(path, "lstat");
    if (this.view(key, "lstat", path) === null) throw errno("ENOENT", "lstat", path);
    if (!WINDOWS) return key;
    const tail: string[] = [];
    for (let cur = key;; cur = dirname(cur)) {
      try {
        return join(disk.realpath(cur), ...tail);
      } catch {
        // Not on the disk (planned, or under a fresh directory): its parent may be.
      }
      if (dirname(cur) === cur) return key;
      tail.unshift(basename(cur));
    }
  }

  // --- writes ------------------------------------------------------------------------------------

  /** An explicit mode lands whether the file exists or not (Deno chmods after the write); without
   *  one an existing file keeps its mode and a fresh inode takes the default. A staged write
   *  (`replace`) lands at the path itself, so a link there is replaced, as the real rename does. */
  writeText(path: string, text: string, write: OverlayWrite = {}): void {
    this.land(path, new TextEncoder().encode(text), true, write);
  }

  writeBytes(path: string, bytes: Uint8Array, write: OverlayWrite = {}): void {
    // The caller's buffer may be reused; the volume keeps its own copy.
    this.land(path, bytes.slice(), false, write);
  }

  /** The bytes of `from` as the run sees them, landed at `to` with the source's mode, as
   *  copyFileSync lands them. The source's text-ness and secret declarations travel with them. */
  copyFile(from: string, to: string): void {
    const { key: src, seen } = this.fileAt(from, "copyfile");
    const bytes = seen.kind === "own" ? this.volBytes(volPath(src)) : disk.readBytes(src);
    this.land(to, bytes, seen.kind === "own" && this.texts.has(src), {
      mode: seen.stats.mode & 0o777,
    });
    this.carrySecrets(src, this.key(to, "copyfile"));
  }

  private land(path: string, bytes: Uint8Array, text: boolean, write: OverlayWrite): void {
    const syscall = write.replace ? "rename" : "open";
    const key = this.key(path, syscall, !write.replace);
    this.landingParent(key, "open", path);
    const seen = this.view(key, "open", path, !write.replace);
    // Windows opens a directory for writing with EINVAL, and refuses the staged rename over one
    // with the EPERM the real writer wraps as RenameRefusedError (the installer answers that class
    // with a direct write).
    if (seen !== null && seen.stats.isDirectory()) {
      if (write.replace) {
        const staged = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
        if (WINDOWS) throw new RenameRefusedError(path, errno("EPERM", "rename", staged, path));
        throw errno("EISDIR", "rename", staged, path);
      }
      throw errno(WINDOWS ? "EINVAL" : "EISDIR", "open", path);
    }
    const mode =
      write.mode !== undefined || seen === null || write.replace || seen.stats.isSymbolicLink()
        ? freshMode(write.mode, "file")
        : seen.stats.mode & 0o777;
    const target = volPath(key);
    this.scaffold(dirname(key));
    // A staged write over a planned link replaces the link itself.
    if (seen?.kind === "own" && seen.stats.isSymbolicLink()) this.vol.unlinkSync(target);
    this.vol.writeFileSync(target, bytes);
    // A write over a disk file keeps the disk's name, as Windows does.
    if (seen?.kind === "disk" && !seen.stats.isSymbolicLink()) this.diskSpelling(key);
    this.modes.set(key, mode);
    if (text) this.texts.add(key);
    else this.texts.delete(key);
    if (write.secretKeys !== undefined) {
      const declared = this.secrets.get(key) ?? new Set<string>();
      for (const k of write.secretKeys) declared.add(k);
      this.secrets.set(key, declared);
    }
    if (write.secret) this.secretFiles.add(key);
    this.set(key, resolve(path));
  }

  /** Always recursive (`mkdir -p`): an existing directory is a no-op, a regular file at the path or
   *  above it fails as node's recursive mkdir does. */
  mkdir(path: string, mode?: number): void {
    const asked = this.key(path, "mkdir");
    // A link on the way whose target is gone (a `~/.local` link whose target the run removed) is
    // what mkdir meets, and it refuses it as EEXIST rather than creating the target behind it.
    const spelled = split(resolve(path));
    for (let cur = spelled.root, i = 0; i < spelled.parts.length; i++) {
      cur = join(cur, spelled.parts[i] as string);
      const link = this.view(this.key(cur, "mkdir", false), "mkdir", path, false);
      if (
        link !== null && link.stats.isSymbolicLink() &&
        this.view(this.key(cur, "mkdir"), "mkdir", path) === null
      ) {
        throw errno("EEXIST", "mkdir", path);
      }
    }
    const missing: [string, string][] = [];
    // The canonical and the spelled path climb together, so an ancestor made here is named as the
    // caller spelled it.
    for (let cur = asked, said = resolve(path);; cur = dirname(cur), said = dirname(said)) {
      const seen = this.view(cur, "mkdir", path);
      if (seen !== null) {
        if (!seen.stats.isDirectory()) {
          throw errno(cur === asked ? "EEXIST" : "ENOTDIR", "mkdir", path);
        }
        break;
      }
      missing.unshift([cur, said]);
      if (dirname(cur) === cur) break;
    }
    for (const [dir, said] of missing) {
      this.scaffold(dirname(dir));
      this.vol.mkdirSync(volPath(dir));
      this.modes.set(dir, freshMode(mode, "dir"));
      this.fresh.add(dir);
      this.set(dir, said);
    }
  }

  /** node's rmSync: a directory needs `recursive` (ERR_FS_EISDIR), an absent path needs `force`.
   *  Returns whether anything was there. */
  rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): boolean {
    const key = this.key(path, "lstat", false);
    let seen: Seen | null;
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
    if (seen.stats.isDirectory() && !options.recursive) throw rmDirectoryRefused(path);
    this.tombstone(key, resolve(path));
    return true;
  }

  /** node's rmdirSync: an empty directory goes (the run's own creations and removals under it
   *  count), a file is ENOTDIR, entries are ENOTEMPTY. A link is the entry itself: Windows removes a
   *  junction with rmdir, POSIX refuses a symlink as not a directory. */
  rmdir(path: string): void {
    const key = this.key(path, "rmdir", false);
    const seen = this.view(key, "rmdir", path, false);
    if (seen === null) throw errno("ENOENT", "rmdir", path);
    if (seen.stats.isSymbolicLink()) {
      if (!WINDOWS) throw errno("ENOTDIR", "rmdir", path);
    } else {
      if (!seen.stats.isDirectory()) throw errno(underFile("rmdir"), "rmdir", path);
      if (this.readdir(path).length > 0) throw errno("ENOTEMPTY", "rmdir", path);
    }
    this.tombstone(key, resolve(path));
  }

  /** A disk entry is carried into the volume with its mode changed: the diff must be able to tell a
   *  mode-only change from untouched content. */
  chmod(path: string, mode: number): void {
    const key = this.key(path, "chmod");
    const seen = this.view(key, "chmod", path);
    if (seen === null) throw errno("ENOENT", "chmod", path);
    if (seen.kind === "disk") this.absorb(key, seen.stats, false);
    this.modes.set(key, platformMode(mode));
    this.set(key, resolve(path));
  }

  /** node's symlinkSync: the parent must exist, the path must not. */
  symlink(target: string, path: string): void {
    const key = this.key(path, "symlink", false);
    this.landingParent(key, "symlink", target, path);
    if (this.view(key, "symlink", path, false) !== null) {
      throw errno("EEXIST", "symlink", target, path);
    }
    this.scaffold(dirname(key));
    this.vol.symlinkSync(target, volPath(key));
    this.set(key, resolve(path));
  }

  /** A link built aside and renamed over `link`: a file or a link there is replaced, a directory
   *  is the rename's own refusal (EISDIR; EPERM on Windows), raw, as the disk side raises it. */
  atomicSymlink(target: string, link: string): void {
    // A stale staging entry from a crashed run under this pid goes first, with its own row, as the
    // disk side removes it before building the link beside the target.
    const staged = join(dirname(link), `.${basename(link)}-next-${process.pid}`);
    this.rm(staged, { force: true });
    const key = this.key(link, "rename", false);
    this.landingParent(key, "rename", link);
    const seen = this.view(key, "rename", link, false);
    if (seen !== null && seen.stats.isDirectory()) {
      throw errno(WINDOWS ? "EPERM" : "EISDIR", "rename", link);
    }
    if (seen?.kind === "own") {
      this.vol.unlinkSync(volPath(key));
      this.texts.delete(key);
      this.modes.delete(key);
    }
    this.scaffold(dirname(key));
    this.vol.symlinkSync(target, volPath(key));
    this.set(key, resolve(link));
  }

  /** The source subtree moves in the volume under `to` (a disk source, and the disk children a
   *  planned directory still lists, are loaded first) and `from` is tombstoned. A destination that
   *  exists is replaced without a refusal: every writer moves onto a path it has cleared or that
   *  was never there. */
  rename(from: string, to: string): void {
    const src = this.key(from, "rename", false);
    const dst = this.key(to, "rename", false);
    const source = this.view(src, "rename", from, false);
    if (source === null) throw errno("ENOENT", "rename", from, to);
    this.landingParent(dst, "rename", from, to);
    if (isBelow(dst, src)) throw errno("EINVAL", "rename", from, to);
    if (src === dst) {
      // One key: a case-only rename on Windows (or a path renamed onto itself), which the disk
      // performs as a no-op that takes the new spelling.
      if (source.kind === "disk") this.absorb(src, source.stats, true);
      if (WINDOWS) this.spellings.set(src, basename(resolve(to)));
      this.set(src, resolve(to));
      return;
    }
    if (source.kind === "disk") this.absorb(src, source.stats, true);
    else if (source.stats.isDirectory() && !this.fresh.has(src)) this.absorbChildren(src);
    const moved = this.subtree(src);
    this.dropBelow(src);
    this.markGone(src, resolve(from));
    this.dropBelow(dst);
    this.unplan(dst);
    this.scaffold(dirname(dst));
    // memfs's rename follows a link at the source; a link moves as its target text.
    if (source.stats.isSymbolicLink()) {
      const target = String(this.vol.readlinkSync(volPath(src)));
      this.vol.unlinkSync(volPath(src));
      this.vol.symlinkSync(target, volPath(dst));
    } else {
      this.vol.renameSync(volPath(src), volPath(dst));
    }
    const spelled = resolve(to);
    for (const entry of moved) {
      const was = entry.rel === "" ? src : join(src, entry.rel);
      const key = entry.rel === "" ? dst : join(dst, entry.rel);
      this.set(key, entry.rel === "" ? spelled : join(spelled, entry.name));
      if (WINDOWS && entry.rel !== "") this.spellings.set(key, basename(entry.name));
      // The destination's own flags go with what stood there: the moved entry's are the truth.
      if (entry.dir) this.fresh.add(key);
      else this.fresh.delete(key);
      if (entry.text) this.texts.add(key);
      else this.texts.delete(key);
      if (entry.mode === undefined) this.modes.delete(key);
      else this.modes.set(key, entry.mode);
      // What a path declared secret travels with its content, so the report at the new path
      // redacts the same values.
      this.carrySecrets(was, key);
    }
  }

  /** Every volume entry at and below `key`: its key relative to `key` (`rel`; the root is ""), the
   *  same path in the entries' own names (`name`), and its flags, in the order the report lists a
   *  moved tree: each directory before its children, children sorted. */
  private subtree(
    key: string,
    rel = "",
    name = "",
  ): { rel: string; name: string; dir: boolean; text: boolean; mode: number | undefined }[] {
    const path = volPath(key);
    const dir = this.vol.lstatSync(path).isDirectory();
    const out = [{ rel, name, dir, text: this.texts.has(key), mode: this.modes.get(key) }];
    if (!dir) return out;
    for (const child of this.volNames(path).sort()) {
      const childKey = join(key, child);
      const childName = this.basenameOf(childKey);
      out.push(
        ...this.subtree(childKey, rel === "" ? child : join(rel, child), join(name, childName)),
      );
    }
    return out;
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
}

/** Whether `path` is a strict descendant of `dir` (both resolved). */
export function isBelow(path: string, dir: string): boolean {
  for (let cur = dirname(path);; cur = dirname(cur)) {
    if (cur === dir) return true;
    if (dirname(cur) === cur) return false;
  }
}
