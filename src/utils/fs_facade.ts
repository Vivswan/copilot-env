// The one seam for every file the CLI reads or writes. A real run passes every call to fs_disk.ts,
// which names each write on stderr; a dry run routes both reads and writes to the overlay
// (fs_overlay.ts), so nothing touches the disk and every later read in the same run sees the
// planned state. Synchronous and node:fs-shaped, so a caller's error handling
// (`code === "ENOENT"`) is the same in both modes. Scratch this process minted (scratchDir) is real
// in every mode: a probe's throwaway config must exist for the spawned CLI to read it.
//
// The overlay is one per process and entered once per command (src/utils/dry_run.ts); a run's
// children learn of the dry run through the marker that module hands them, not through here.
import { basename, dirname, join } from "node:path";
import * as disk from "./fs_disk.ts";
import { openOverlay, type Overlay } from "./fs_overlay.ts";
import { underScratch } from "./report_write.ts";

export type { DirEntry, EntryStats, RemoveOptions, ScratchDir, WriteOptions } from "./fs_disk.ts";
export { assertNotDirectory, RenameRefusedError } from "./fs_disk.ts";

let overlay: Overlay | null = null;

/** True inside withDryRun. */
export function dryRunActive(): boolean {
  return overlay !== null;
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
  const run = await openOverlay();
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

// --- reads -------------------------------------------------------------------------------------

export function readText(path: string): string {
  return overlay === null ? disk.readText(path) : overlay.readText(path);
}

export function readBytes(path: string): Uint8Array {
  return overlay === null ? disk.readBytes(path) : overlay.readBytes(path);
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
export function entryAbsent(path: string): boolean {
  try {
    lstat(path);
    return false;
  } catch (e) {
    return isEnoentOrNotdir(e);
  }
}

export function stat(path: string): disk.EntryStats {
  return overlay === null ? disk.stat(path) : overlay.stat(path);
}

export function lstat(path: string): disk.EntryStats {
  return overlay === null ? disk.lstat(path) : overlay.stat(path, false);
}

export function exists(path: string): boolean {
  return overlay === null ? disk.exists(path) : overlay.exists(path);
}

export function readdir(path: string): string[] {
  return overlay === null ? disk.readdir(path) : overlay.readdir(path);
}

/** Each name with its kind (a link is the link, never what it points at). */
export function readdirEntries(path: string): disk.DirEntry[] {
  return overlay === null ? disk.readdirEntries(path) : overlay.readdirEntries(path);
}

export function readlink(path: string): string {
  return overlay === null ? disk.readlink(path) : overlay.readlink(path);
}

/** The canonical path as the OS spells it (`realpathSync.native`): on Windows a junction and an
 *  8.3 short name resolve, which the JS walk leaves alone. */
export function realpath(path: string): string {
  return overlay === null ? disk.realpath(path) : overlay.realpath(path);
}

/** A file opened for reading, streamed: the disk's in every mode (a release binary the updater
 *  hashes; no run plans the file it streams). */
export function openReadable(path: string): Promise<Deno.FsFile> {
  return disk.openReadable(path);
}

/** A read fd for a child's stdio (`/dev/null`): the disk's in every mode. */
export function openReadFd(path: string): number {
  return disk.openReadFd(path);
}

export function closeFd(fd: number): void {
  disk.closeFd(fd);
}

// --- writes ------------------------------------------------------------------------------------

/** Atomic by default: staged beside the target, fsynced, renamed over it, the parent made. */
export function writeText(path: string, text: string, options: disk.WriteOptions = {}): void {
  const run = overlayFor(path);
  if (run === null) {
    disk.writeText(path, text, options);
    return;
  }
  if (options.atomic !== false) stageInOverlay(run, path);
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
  if (options.atomic !== false) stageInOverlay(run, path);
  run.writeBytes(path, bytes, { mode: options.mode, replace: options.atomic !== false });
}

/** What the disk's staged write does before it writes: the parent made, and the stale temp under
 *  this pid removed (a directory there is rm's own refusal, so a dry run refuses where the real
 *  write does). */
function stageInOverlay(run: Overlay, path: string): void {
  run.mkdir(dirname(path));
  run.rm(join(dirname(path), `${basename(path)}.tmp.${process.pid}`), { force: true });
}

/** The bytes of `from` land at `to`. A dry run plans them and prints the verdict alone; the copy is
 *  real only when both paths are scratch. */
export function copyFile(from: string, to: string, detail?: string): void {
  if (overlay === null || (underScratch(from) && underScratch(to))) {
    disk.copyFile(from, to, detail);
    return;
  }
  overlay.copyFile(from, to);
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

export function chmod(path: string, mode: number): void {
  const run = overlayFor(path);
  if (run === null) disk.chmod(path, mode);
  else run.chmod(path, mode);
}

/** Real only when both paths are scratch: a move touching anything else is planned whole, so a
 *  dry run never takes a real source away. */
export function rename(from: string, to: string): void {
  if (overlay === null || (underScratch(from) && underScratch(to))) {
    disk.rename(from, to);
    return;
  }
  overlay.rename(from, to);
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
export function openWritable(path: string): Promise<Deno.FsFile> {
  refuseHandle(path);
  return disk.openWritable(path);
}

/** openWritable as a node fd, for a child's stdio. */
export function openWriteFd(path: string): number {
  refuseHandle(path);
  return disk.openWriteFd(path);
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
