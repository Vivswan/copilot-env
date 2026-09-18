import { lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import { dirname } from "node:path";
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
      const code = cur === path || entry === "dangling" ? "EEXIST" : "ENOTDIR";
      const err: NodeJS.ErrnoException = new Error(
        `${code}: ${
          code === "EEXIST" ? "file already exists" : "not a directory"
        }, mkdir '${path}'`,
      );
      err.code = code;
      err.syscall = "mkdir";
      err.path = path;
      throw err;
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
