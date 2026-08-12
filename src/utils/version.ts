// package.json version reader used by CLI metadata and update comparisons.
import { readFileSync } from "node:fs";

import pkg from "../../package.json" with { type: "json" };
import { parseJsonRecord } from "./json.ts";

/**
 * Read a package.json's `version` string from `path`, or null if the file is
 * missing/malformed or has no string version. Shared by the CLI's own version
 * and the installed-proxy version reader.
 */
export function readPackageVersion(path: string): string | null {
  try {
    const parsed = parseJsonRecord(readFileSync(path, "utf-8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The checkout's package.json version as bare "X.Y.Z" (release-please-maintained).
 * Statically imported (so `deno compile` embeds it); "0.0.0" only if the field
 * is somehow not a string.
 */
export function packageVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
