import { lstatSync, readFileSync, statSync } from "node:fs";
import { isRecord } from "./json.ts";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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

/** "absent" and "unreadable" stay apart: a caller that authorizes destructive action on "absent"
 *  must never see a permission error or a directory collapsed into it. */
export type TextReadResult =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

/** A dangling symlink reads ENOENT through readFileSync but the entry itself exists (lstat), so it
 *  is unreadable, never absent. The message is derived inline rather than via utils/error.ts: fs.ts
 *  sits in the daemon shims' materialized-asset closure, pinned by test/installer_pinning.test.ts.
 */
export function readTextResult(path: string): TextReadResult {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (e) {
    if (isEnoentOrNotdir(e) && entryAbsent(path)) return { kind: "absent" };
    return { kind: "unreadable", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fail-closed: only lstat's own ENOENT/ENOTDIR confirms absence; EACCES or a transient error reads
 *  as "something may be there". Shared with the JSON store's read (src/copilot_api/config.ts) so
 *  "absent" means one thing. */
export function entryAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return isEnoentOrNotdir(e);
  }
}

/** readTextResult collapsed to text-or-null, so a reader with no use for the absent/unreadable
 *  split still judges absence the same way. */
export function readTextOrNull(path: string): string | null {
  const read = readTextResult(path);
  return read.kind === "text" ? read.text : null;
}
