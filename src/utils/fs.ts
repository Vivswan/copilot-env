// Shared filesystem predicates and small read helpers.
import { lstatSync, readFileSync, statSync } from "node:fs";
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

/** One text read with the failure mode preserved: "absent" (nothing at the
 *  path -- ENOENT/ENOTDIR) is a different fact from "unreadable" (something IS
 *  there but could not be read: permissions, a directory). A caller that
 *  authorizes destructive action on "absent" must never see "unreadable"
 *  collapsed into it. */
export type TextReadResult =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

/** Read `path` as UTF-8 text, keeping WHY a read produced no text. A dangling
 *  symlink reads ENOENT through readFileSync, but the entry ITSELF exists
 *  (lstat), so it reports unreadable, never absent. The error message is
 *  derived inline rather than via utils/error.ts: fs.ts sits inside the daemon
 *  shims' materialized-asset closure (pinned by
 *  test/installer_pinning.test.ts), which one line must not grow. */
export function readTextResult(path: string): TextReadResult {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (e) {
    if (isEnoentOrNotdir(e) && entryAbsent(path)) return { kind: "absent" };
    return { kind: "unreadable", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether NO directory entry exists at `path` (lstat: a dangling symlink still
 *  counts as an entry). Fail-closed: only lstat's own ENOENT/ENOTDIR confirms
 *  absence -- any other failure (EACCES, a transient error) reads as "something
 *  may be there", so the caller reports unreadable rather than absent. */
function entryAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return isEnoentOrNotdir(e);
  }
}

/** Read `path` as UTF-8 text, or null on ANY error (absent, unreadable, a
 *  directory) -- readTextResult for callers that genuinely don't care why.
 *  The one read-or-null helper every wiring/config/health reader shares, so
 *  the same file can never read differently between them. */
export function readTextOrNull(path: string): string | null {
  const read = readTextResult(path);
  return read.kind === "text" ? read.text : null;
}
