// The two sources' transcript trees: the roster, JSONL reading, and which files a session owns.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_SOURCES = ["claude", "codex"] as const;
export type Source = (typeof SUMMARY_SOURCES)[number];

export const ROLLOUT_FILE_RE =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function walkJsonl(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** The parsed records of a JSONL file (torn lines skipped). */
function readRecords(file: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // torn line
    }
  }
  return records;
}

/** The session's own transcript(s) by each source's exact basename: `<id>.jsonl` (Claude) or
 *  `rollout-<stamp>-<id>.jsonl` (Codex). A nested subagent file under `<id>/` is neither. */
export function filesFor(files: string[], id: string, source: Source): string[] {
  return files.filter((file) => {
    const base = file.split(/[\\/]/).at(-1) ?? "";
    if (source === "claude") return base === `${id}.jsonl`;
    const rollout = ROLLOUT_FILE_RE.exec(base);
    return rollout !== null && rollout[2]!.toLowerCase() === id.toLowerCase();
  });
}

export function recordsUnder(dir: string): Map<string, Record<string, unknown>[]> {
  const files: string[] = [];
  walkJsonl(dir, files);
  return new Map(files.map((file) => [file, readRecords(file)]));
}
