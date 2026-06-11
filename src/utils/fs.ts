// Shared filesystem predicates.
import { statSync } from "node:fs";

/** True iff `path` exists and is a regular file (any stat error => false). */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
