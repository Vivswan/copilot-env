// Error predicates and the read helpers callers share, each read on the fs seam
// (src/utils/fs_facade.ts) so a dry run answers them from its planned state.
import * as fs from "./fs_facade.ts";
import { isRecord } from "./json.ts";
import { sleepSync } from "./time.ts";

export const WIN = process.platform === "win32";

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

/** What Windows surfaces when another process holds the file open (the daemon, antivirus, the
 *  search indexer, a scanner on a just-released lock marker). */
const OPEN_HANDLE_REFUSAL_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isOpenHandleRefusal(e: unknown): boolean {
  return isRecord(e) && typeof e.code === "string" && OPEN_HANDLE_REFUSAL_CODES.has(e.code);
}

/** A POSIX rename or unlink over an open file always succeeds; Windows transiently refuses it while
 *  another process holds the handle, so `op` gets a few more chances there. */
export function retryOpenHandleRefusal(op: () => void, attempts = 5): void {
  for (let i = 0;; i++) {
    try {
      op();
      return;
    } catch (err) {
      if (i >= attempts || !isOpenHandleRefusal(err)) throw err;
      sleepSync(50);
    }
  }
}

/** readTextResult collapsed to text-or-null, so a reader with no use for the absent/unreadable
 *  split still judges absence the same way. */
export function readTextOrNull(path: string): string | null {
  const read = fs.readTextResult(path);
  return read.kind === "text" ? read.text : null;
}
