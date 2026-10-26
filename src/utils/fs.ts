// Error predicates, the one error class the seam's staged writers throw, and the read helpers
// callers share, each read on the fs seam (src/utils/fs_facade.ts) so a dry run answers them from
// its planned state.
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

/** Windows' answer while another process holds the file open: the daemon, antivirus, an indexer. */
const OPEN_HANDLE_REFUSAL_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isOpenHandleRefusal(e: unknown): boolean {
  return isRecord(e) && typeof e.code === "string" && OPEN_HANDLE_REFUSAL_CODES.has(e.code);
}

/** A POSIX rename or unlink over an open file always succeeds; Windows transiently refuses it while
 *  another process holds the handle (a scanner on a just-released lock marker, say), so `op` gets a
 *  few more chances there. */
export function retryOpenHandleRefusal(op: () => void, attempts = 5): void {
  for (let i = 0; ; i++) {
    try {
      op();
      return;
    } catch (err) {
      if (i >= attempts || !isOpenHandleRefusal(err)) throw err;
      sleepSync(50);
    }
  }
}

/** A staged write's rename over a live file was refused (Windows, the file held open): the live
 *  file is untouched, the staged copy dropped where removal succeeded, a leftover reported. Thrown
 *  by fs_disk.ts and mirrored by fs_overlay.ts; the one failure a caller may answer with a direct
 *  write (the installer's launcher shims), every other failure propagates as itself. */
export class RenameRefusedError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`rename over ${path} refused (the file is held open)`, { cause });
    this.name = "RenameRefusedError";
  }
}

/** readTextResult collapsed to text-or-null, so a reader with no use for the absent/unreadable
 *  split still judges absence the same way. */
export function readTextOrNull(path: string): string | null {
  const read = fs.readTextResult(path);
  return read.kind === "text" ? read.text : null;
}
