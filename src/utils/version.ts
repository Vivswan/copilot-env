import pkg from "../../package.json" with { type: "json" };
import * as fs from "./fs_facade.ts";
import { parseJsonRecord } from "./json.ts";

export function readPackageVersion(path: string): string | null {
  try {
    const parsed = parseJsonRecord(fs.readText(path));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Statically imported so `deno compile` embeds the version. */
export function packageVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
