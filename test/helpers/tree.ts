// The source files a lint-shaped test scans: every `.ts` under a directory, recursively, sorted.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(dir, entry))
    .sort();
}
