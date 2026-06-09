// package.json version reader used by CLI metadata and update comparisons.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonRecord } from "./json.ts";
import { PROJECT_ROOT } from "./root.ts";

/**
 * Read a package.json's `version` string from `path`, or null if the file is
 * missing/malformed or has no string version. Shared by the CLI's own version
 * and the installed-gateway version reader.
 */
export function readPackageVersion(path: string): string | null {
  try {
    const pkg = parseJsonRecord(readFileSync(path, "utf-8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * The checkout's package.json version as bare "X.Y.Z" (release-please-maintained).
 * Falls back to "0.0.0" if package.json is missing or malformed.
 */
export function packageVersion(): string {
  return readPackageVersion(join(PROJECT_ROOT, "package.json")) ?? "0.0.0";
}
