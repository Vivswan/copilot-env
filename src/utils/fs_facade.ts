// The one seam for every file the CLI reads or writes. A real run passes through to node:fs for
// reads and to the reporting wrappers (report_write.ts) for writes, so every write outside
// copilot-env's homes is still named on stderr; a dry run routes both to the overlay, so nothing
// touches the disk and every later read in the same run sees the planned state. Synchronous and
// node:fs-shaped, so a caller's error handling (`code === "ENOENT"`) is the same in both modes.
//
// The overlay is one per process and entered once per command by the command layer; a run's
// children learn of the dry run through the marker report_write.ts hands them, not through here.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { diffOverlay, type FileChange } from "./dry_run_report.ts";
import { isEnoent } from "./fs.ts";
import { type EntryStats, errno, Overlay, rmDirectoryRefused } from "./fs_overlay.ts";
import {
  atomicWriteFile,
  chmodReported,
  mkdirReported,
  removeReported,
  removeTreeReported,
  renameReported,
  writeFileReported,
} from "./report_write.ts";

export type { EntryStats, FileChange };

let overlay: Overlay | null = null;

export function dryRunActive(): boolean {
  return overlay !== null;
}

/** A body that fails partway has planned what precedes the failure, as the real command would have
 *  landed it, so the changes travel with the error instead of being lost to a throw. */
export type DryRunOutcome<T> =
  | { status: "done"; result: T; changes: FileChange[] }
  | { status: "failed"; error: unknown; changes: FileChange[] };

export async function withDryRun<T>(body: () => Promise<T>): Promise<DryRunOutcome<T>> {
  if (overlay !== null) throw new Error("a dry run is already active");
  const run = new Overlay();
  overlay = run;
  try {
    const result = await body();
    return { status: "done", result, changes: diffOverlay(run) };
  } catch (error) {
    return { status: "failed", error, changes: diffOverlay(run) };
  } finally {
    overlay = null;
  }
}

export function readText(path: string): string {
  return overlay === null ? readFileSync(path, "utf8") : overlay.readText(path);
}

export interface WriteOptions {
  /** Set on the file whether it is fresh or exists (Deno chmods after the write). */
  mode?: number;
  /** Staged beside the target and renamed over it; a missing parent directory is created. */
  atomic?: boolean;
  /** Rides on the stderr write line. */
  detail?: string;
  /** Dotted keys of this file whose values a dry run prints as `<redacted>`. */
  secretKeys?: Iterable<string>;
}

export function writeText(path: string, text: string, options: WriteOptions = {}): void {
  if (overlay !== null) {
    if (options.atomic) overlay.mkdir(dirname(path));
    overlay.writeText(path, text, {
      mode: options.mode,
      replace: options.atomic,
      secretKeys: options.secretKeys,
    });
    return;
  }
  if (options.atomic) atomicWriteFile(path, text, options.mode, options.detail);
  else writeFileReported(path, text, { mode: options.mode, detail: options.detail });
}

export function stat(path: string): EntryStats {
  return overlay === null ? statSync(path) : overlay.stat(path);
}

export function lstat(path: string): EntryStats {
  return overlay === null ? lstatSync(path) : overlay.stat(path, false);
}

export function exists(path: string): boolean {
  return overlay === null ? existsSync(path) : overlay.exists(path);
}

export function readdir(path: string): string[] {
  return overlay === null ? readdirSync(path) : overlay.readdir(path);
}

/** Always `mkdir -p`. */
export function mkdir(path: string, options: { mode?: number; detail?: string } = {}): void {
  if (overlay === null) mkdirReported(path, options.mode, options.detail);
  else overlay.mkdir(path, options.mode);
}

export interface RemoveOptions {
  recursive?: boolean;
  /** An absent path is no error, as in node. */
  force?: boolean;
  detail?: string;
}

export function rm(path: string, options: RemoveOptions = {}): void {
  if (overlay !== null) {
    overlay.rm(path, options);
    return;
  }
  // The wrappers read an absent path as "nothing to do" and refuse a directory with their own
  // error; node's rmSync reads them as ENOENT and ERR_FS_EISDIR, and a lookup under a regular file
  // as ENOTDIR whatever `force` says.
  let directory: boolean;
  try {
    directory = lstatSync(path).isDirectory();
  } catch (e) {
    if (!isEnoent(e)) throw e;
    if (options.force) return;
    throw errno("ENOENT", "lstat", path);
  }
  if (directory && !options.recursive) throw rmDirectoryRefused(path);
  if (options.recursive) removeTreeReported(path, options.detail);
  else removeReported(path, options.detail);
}

export function chmod(path: string, mode: number, detail?: string): void {
  if (overlay === null) chmodReported(path, mode, detail);
  else overlay.chmod(path, mode);
}

export function rename(from: string, to: string): void {
  if (overlay === null) renameReported(from, to);
  else overlay.rename(from, to);
}
