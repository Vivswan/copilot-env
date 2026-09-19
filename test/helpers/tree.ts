// The source files a lint-shaped test scans: every `.ts` under a directory, recursively, in
// directory order.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}
