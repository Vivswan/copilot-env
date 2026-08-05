// Shared filesystem predicates and small read helpers.
import { readFileSync, statSync } from "node:fs";
import { isRecord } from "./json.ts";

/** True iff `path` exists and is a regular file (any stat error => false). */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True iff `path` exists and is a directory (any stat error => false). */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True iff `e` is a thrown value whose `code` is "ENOENT" (the path is absent).
 *  False for anything that is not a plain error-shaped record, so callers
 *  rethrow such values instead of misreading them. */
export function isEnoent(e: unknown): boolean {
  return isRecord(e) && e.code === "ENOENT";
}

/** True iff `e` carries "ENOENT" or "ENOTDIR" -- the two codes a lookup under a
 *  missing or non-directory parent produces, which callers read alike as
 *  "nothing there". */
export function isEnoentOrNotdir(e: unknown): boolean {
  return isRecord(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");
}

/** Read `path` as UTF-8 text, or null on ANY error (absent, unreadable, a
 *  directory). The one read-or-null helper every wiring/config/health reader
 *  shares, so the same file can never read differently between them. */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
