// package.json version reader used by CLI metadata and update comparisons.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_ROOT } from "./root.ts";

/**
 * The checkout's package.json version as bare "X.Y.Z" (release-please-maintained).
 * Falls back to "0.0.0" if package.json is missing or malformed.
 */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
