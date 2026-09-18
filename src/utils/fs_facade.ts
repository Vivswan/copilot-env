// The one seam for every file the CLI reads or writes. A real run passes reads through to node:fs
// and writes to fs_disk.ts, which names each one on stderr; a dry run routes both to the overlay,
// so nothing touches the disk and every later read in the same run sees the planned state.
// Synchronous and node:fs-shaped, so a caller's error handling (`code === "ENOENT"`) is the same
// in both modes. Scratch this process minted (scratchDir) is real in every mode: a probe's
// throwaway config must exist for the spawned CLI to read it.
//
// The overlay is one per process and entered once per command (src/utils/dry_run.ts); a run's
// children learn of the dry run through the marker that module hands them, not through here.
//
// TRANSITION BRIDGE. Until the command layer enters withDryRun, `--dry-run` runs under the plan
// collector (collectDryRun, write_session.ts): the writes then record plan rows (fs_disk.ts), and
// the reads here answer from the plan's shadows first, so a writer already on the facade previews
// as one still on the wrappers. The bridge goes with write_session.ts.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as disk from "./fs_disk.ts";
import { type DirEntry, type EntryStats, errno, Overlay } from "./fs_overlay.ts";
import { underScratch } from "./report_write.ts";
import {
  dryRunActive as planCollecting,
  plannedMode,
  plannedState,
  readPlannedDir,
} from "./write_session.ts";

export type { DirEntry, EntryStats };
export type { RemoveOptions, ScratchDir, WriteOptions } from "./fs_disk.ts";
export { assertNotDirectory, RenameRefusedError } from "./fs_disk.ts";

let overlay: Overlay | null = null;

/** True inside withDryRun, and under the plan collector while the bridge stands. */
export function dryRunActive(): boolean {
  return overlay !== null || planCollecting();
}

/** Runs `body` with every call on this seam answered by a fresh overlay, and hands the overlay back
 *  with the outcome: a body that fails partway has planned what precedes the failure, as the real
 *  command would have landed it, so the changes travel with the error instead of being lost to a
 *  throw. The report of it is src/utils/dry_run.ts's. */
export async function underOverlay<T>(
  body: () => Promise<T>,
): Promise<
  | { status: "done"; result: T; overlay: Overlay }
  | { status: "failed"; error: unknown; overlay: Overlay }
> {
  if (overlay !== null) throw new Error("a dry run is already active");
  const run = new Overlay();
  overlay = run;
  try {
    return { status: "done", result: await body(), overlay: run };
  } catch (error) {
    return { status: "failed", error, overlay: run };
  } finally {
    overlay = null;
  }
}

/** The overlay a write to `path` lands in: none for scratch, which stays real in every mode. */
function overlayFor(path: string): Overlay | null {
  return overlay !== null && !underScratch(path) ? overlay : null;
}

// --- the transition bridge for reads -------------------------------------------------------------

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** What the plan collector says about `path`: planned text or bytes, a planned file whose bytes
 *  the plan does not carry (a copy, a chmod), a planned directory, a planned deletion, or nothing
 *  (the disk speaks). */
type Shadow =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array }
  | "opaque"
  | "dir"
  | "gone"
  | null;

function shadow(path: string): Shadow {
  const state = plannedState(path);
  if (state === null) return null;
  if (state.kind === "text" || state.kind === "bytes") return state;
  if (state.kind !== "opaque") return state.kind;
  if (state.file) return "opaque";
  // A plan without bytes over what the disk holds (a chmod): the disk says which kind stands there.
  try {
    return statSync(path).isDirectory() ? "dir" : "opaque";
  } catch {
    return "opaque";
  }
}

function shadowStats(seen: Exclude<Shadow, "gone" | null>, path: string): EntryStats {
  const file = seen !== "dir";
  let mode: number;
  let size = 0;
  try {
    const disk = statSync(path);
    mode = disk.mode & 0o777;
    size = disk.size;
  } catch {
    mode = file ? 0o644 : 0o755;
  }
  // A planned chmod, or a write's explicit mode, is what the run leaves there.
  mode = plannedMode(path) ?? mode;
  if (typeof seen === "object") {
    size = seen.kind === "text" ? new TextEncoder().encode(seen.text).length : seen.bytes.length;
  }
  return {
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
    mode: (file ? S_IFREG : S_IFDIR) | mode,
    size: file ? size : 0,
    mtimeMs: Date.now(),
  };
}

// --- reads -------------------------------------------------------------------------------------

export function readText(path: string): string {
  if (overlay !== null) return overlay.readText(path);
  const seen = shadow(path);
  if (seen === "gone") throw errno("ENOENT", "open", path);
  if (seen === "dir") throw errno("EISDIR", "open", path);
  // The plan carries no bytes for an opaque file: the disk is the nearest answer.
  if (seen === null || seen === "opaque") return readFileSync(path, "utf8");
  return seen.kind === "text"
    ? seen.text
    : new TextDecoder("utf-8", { ignoreBOM: true }).decode(seen.bytes);
}

export function readBytes(path: string): Uint8Array {
  if (overlay !== null) return overlay.readBytes(path);
  const seen = shadow(path);
  if (seen === null || seen === "opaque") return new Uint8Array(readFileSync(path));
  if (typeof seen === "object" && seen.kind === "bytes") return seen.bytes.slice();
  return new TextEncoder().encode(readText(path));
}

/** "absent" and "unreadable" stay apart: a caller that authorizes destructive action on "absent"
 *  must never see a permission error or a directory collapsed into it. */
export type TextReadResult =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

/** A dangling symlink reads ENOENT through the read but the entry itself exists (lstat), so it is
 *  unreadable, never absent. */
export function readTextResult(path: string): TextReadResult {
  try {
    return { kind: "text", text: readText(path) };
  } catch (e) {
    if (isEnoentOrNotdir(e) && entryAbsent(path)) return { kind: "absent" };
    return { kind: "unreadable", error: e instanceof Error ? e.message : String(e) };
  }
}

function isEnoentOrNotdir(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Fail-closed: only lstat's own ENOENT/ENOTDIR confirms absence; EACCES or a transient error reads
 *  as "something may be there". */
function entryAbsent(path: string): boolean {
  try {
    lstat(path);
    return false;
  } catch (e) {
    return isEnoentOrNotdir(e);
  }
}

export function stat(path: string): EntryStats {
  if (overlay !== null) return overlay.stat(path);
  const seen = shadow(path);
  if (seen === "gone") throw errno("ENOENT", "stat", path);
  return seen === null ? statSync(path) : shadowStats(seen, path);
}

export function lstat(path: string): EntryStats {
  if (overlay !== null) return overlay.stat(path, false);
  const seen = shadow(path);
  if (seen === "gone") throw errno("ENOENT", "lstat", path);
  return seen === null ? lstatSync(path) : shadowStats(seen, path);
}

export function exists(path: string): boolean {
  if (overlay !== null) return overlay.exists(path);
  const seen = shadow(path);
  if (seen === null) return existsSync(path);
  return seen !== "gone";
}

export function readdir(path: string): string[] {
  if (overlay !== null) return overlay.readdir(path);
  if (!planCollecting()) return readdirSync(path);
  const seen = shadow(path);
  if (seen === "gone") throw errno("ENOENT", "scandir", path);
  if (seen !== null && seen !== "dir") throw errno("ENOTDIR", "scandir", path);
  if (seen === null && !existsSync(path)) throw errno("ENOENT", "scandir", path);
  return readPlannedDir(path);
}

/** Each name with its kind (a link is the link, never what it points at). */
export function readdirEntries(path: string): DirEntry[] {
  if (overlay !== null) return overlay.readdirEntries(path);
  if (!planCollecting()) return readdirSync(path, { withFileTypes: true });
  return readdir(path).map((name) => {
    const stats = lstat(join(path, name));
    return {
      name,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink(),
    };
  });
}

export function readlink(path: string): string {
  return overlay === null ? readlinkSync(path) : overlay.readlink(path);
}

/** The canonical path as the OS spells it (`realpathSync.native`): on Windows a junction and an
 *  8.3 short name resolve, which the JS walk leaves alone. */
export function realpath(path: string): string {
  return overlay === null ? realpathSync.native(path) : overlay.realpath(path);
}

// --- writes ------------------------------------------------------------------------------------

/** Atomic by default: staged beside the target, fsynced, renamed over it, the parent made. */
export function writeText(path: string, text: string, options: disk.WriteOptions = {}): void {
  const run = overlayFor(path);
  if (run === null) {
    disk.writeText(path, text, options);
    return;
  }
  if (options.atomic !== false) run.mkdir(dirname(path));
  run.writeText(path, text, {
    mode: options.mode,
    replace: options.atomic !== false,
    secretKeys: options.secretKeys,
    secret: options.secret,
  });
}

export function writeBytes(path: string, bytes: Uint8Array, options: disk.WriteOptions = {}): void {
  const run = overlayFor(path);
  if (run === null) {
    disk.writeBytes(path, bytes, options);
    return;
  }
  if (options.atomic !== false) run.mkdir(dirname(path));
  run.writeBytes(path, bytes, { mode: options.mode, replace: options.atomic !== false });
}

/** The bytes of `from` land at `to`. A dry run carries them by path (by value out of scratch, which
 *  goes before the report) and prints the verdict alone; the copy is real only when both paths are
 *  scratch. */
export function copyFile(from: string, to: string, detail?: string): void {
  if (overlay === null || (underScratch(from) && underScratch(to))) {
    disk.copyFile(from, to, detail);
    return;
  }
  overlay.copyFile(from, to, underScratch(from));
  if (underScratch(to)) overlay.hide(to);
}

/** Always `mkdir -p`. */
export function mkdir(path: string, options: { mode?: number; detail?: string } = {}): void {
  const run = overlayFor(path);
  if (run === null) disk.mkdir(path, options.mode, options.detail);
  else run.mkdir(path, options.mode);
}

/** node's rmSync: a directory needs `recursive` (ERR_FS_EISDIR), an absent path needs `force`
 *  (ENOENT). Returns whether anything was there. */
export function rm(path: string, options: disk.RemoveOptions = {}): boolean {
  const run = overlayFor(path);
  return run === null ? disk.rm(path, options) : run.rm(path, options);
}

/** node's rmdir: an empty directory (or a Windows junction) goes; entries, a file, and an absent
 *  path are its own refusals. */
export function rmdir(path: string): void {
  const run = overlayFor(path);
  if (run === null) disk.rmdir(path);
  else run.rmdir(path);
}

export function chmod(path: string, mode: number, detail?: string): void {
  const run = overlayFor(path);
  if (run === null) disk.chmod(path, mode, detail);
  else run.chmod(path, mode);
}

/** Real only when both paths are scratch: a move touching anything else is planned whole, so a
 *  dry run never takes a real source away. */
export function rename(from: string, to: string): void {
  if (overlay === null || (underScratch(from) && underScratch(to))) {
    disk.rename(from, to);
    return;
  }
  overlay.rename(from, to, underScratch(from));
  if (underScratch(to)) overlay.hide(to);
}

export function symlink(target: string, path: string, type?: "junction"): void {
  const run = overlayFor(path);
  if (run === null) disk.symlink(target, path, type);
  else run.symlink(target, path);
}

/** The replacement link is built aside and renamed over `link`, so a concurrent reader never sees
 *  a missing link. */
export function atomicSymlink(target: string, link: string): void {
  const run = overlayFor(link);
  if (run === null) disk.atomicSymlink(target, link);
  else run.atomicSymlink(target, link);
}

/** A file opened for writing (created or truncated at the open): the one way runtime code streams
 *  bytes to a path (a release download, the daemon's log). A dry run has no handle to hand back
 *  and refuses outside scratch. */
export function openWritable(path: string, detail?: string): Promise<Deno.FsFile> {
  refuseHandle(path);
  return disk.openWritable(path, detail);
}

/** openWritable as a node fd, for a child's stdio. */
export function openWriteFd(path: string, detail?: string): number {
  refuseHandle(path);
  return disk.openWriteFd(path, detail);
}

function refuseHandle(path: string): void {
  if (overlayFor(path) !== null) throw new Error(`${path}: a dry run opens no file for writing`);
}

/** A process-transient directory: real in every mode, never reported or planned, and taken away
 *  whole by removeScratchDir before exit. */
export function scratchDir(prefix: string): disk.ScratchDir {
  return disk.scratchDir(prefix);
}

export function removeScratchDir(dir: disk.ScratchDir): void {
  disk.removeScratchDir(dir);
}
