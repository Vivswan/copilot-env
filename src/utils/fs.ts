// Shared filesystem predicates and small read helpers.
import { readFileSync, statSync } from "node:fs";

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
