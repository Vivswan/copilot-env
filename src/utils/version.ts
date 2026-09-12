import { readFileSync } from "node:fs";

import pkg from "../../package.json" with { type: "json" };
import { parseJsonRecord } from "./json.ts";

export function readPackageVersion(path: string): string | null {
  try {
    const parsed = parseJsonRecord(readFileSync(path, "utf-8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Statically imported so `deno compile` embeds the version. */
export function packageVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
