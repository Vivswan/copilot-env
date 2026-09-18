// Error predicates and the read helpers callers share, each read on the fs seam
// (src/utils/fs_facade.ts) so a dry run answers them from its planned state.
import * as fs from "./fs_facade.ts";
import { isRecord } from "./json.ts";

export type { TextReadResult } from "./fs_facade.ts";
export { entryAbsent, readTextResult } from "./fs_facade.ts";

export function isFile(path: string): boolean {
  try {
    return fs.stat(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return fs.stat(path).isDirectory();
  } catch {
    return false;
  }
}

export function isEnoent(e: unknown): boolean {
  return isRecord(e) && e.code === "ENOENT";
}

/** ENOTDIR is what a lookup under a non-directory parent produces; callers read both as "nothing
 *  there". */
export function isEnoentOrNotdir(e: unknown): boolean {
  return isRecord(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");
}

/** readTextResult collapsed to text-or-null, so a reader with no use for the absent/unreadable
 *  split still judges absence the same way. */
export function readTextOrNull(path: string): string | null {
  const read = fs.readTextResult(path);
  return read.kind === "text" ? read.text : null;
}
