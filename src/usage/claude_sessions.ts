// Transcripts live under `<claude-home>/projects/<cwd-slug>/`, subagents nested deeper, so the walk
// is recursive.
//   Claude Code's `stats-cache.json` -> never read, it is pre-aggregated
//   Direct-wired Claude              -> covered only here, it never reaches the proxy's tables
//
// Streaming writes one line per content block, all sharing `message.id`, and the usage snapshot
// GROWS across them (`output_tokens` rises until the final line; the input buckets never change);
// resume/fork copies finished lines into new files. So a message counts once, at the running
// per-bucket max over every occurrence.

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { consola } from "consola";
import { resolveClaudeHome } from "../claude/paths.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { type DayKey, dayKeyIn, MILLISECONDS_PER_DAY } from "../utils/time.ts";
import {
  type ClaudeContribution,
  type ClaudeOccurrence,
  CONTRIBUTION_VERSION,
  dedupKey,
  type FileRecord,
  inWalkOrder,
  type ParsedFile,
  parseEveryCandidate,
  type ParseTail,
  type ParseWhole,
  type Reconcile,
  type WalkedFile,
} from "./contribution.ts";
import { canonicalModelNames } from "./pricing.ts";
import { scanLines } from "./scan.ts";
import {
  record,
  sanitizeTokenCount,
  type TokenBuckets,
  type UsageReport,
  usageReport,
} from "./usage.ts";

/** Error placeholders carry this model id and no real usage attribution. */
const SYNTHETIC_MODEL = "<synthetic>";

const CLAUDE_NEEDLES: readonly string[] = ['"type":"assistant"'];

/** Headroom over the deepest observed layout:
 *  projects/<slug>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl */
const MAX_WALK_DEPTH = 8;

/** Transcript filenames carry no date, so `--days` skipping leans on the mtime (appends refresh it,
 *  so a resumed session is never dropped) with a day of slack for clock skew. */
const MTIME_CUTOFF_SLACK_MS = MILLISECONDS_PER_DAY;

/** There is one Claude home, but the injectable list keeps the shape of discoverCodexSessionRoots,
 *  and the realpath dedup guards against symlinked spellings of the same directory. */
export function discoverClaudeSessionRoots(homes: string[] = [resolveClaudeHome()]): string[] {
  const byRealpath = new Map<string, string>();
  for (const home of homes) {
    const dir = path.join(home, "projects");
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue; // directory does not exist
    }
    if (isDir(real) && !byRealpath.has(real)) {
      byRealpath.set(real, dir);
    }
  }
  return [...byRealpath.values()];
}

/** `timeZone` exists so the per-day slicing is assertable without pinning the process `TZ`, which
 *  deno honors on unix only. */
export async function readClaudeSessions(
  roots: string[],
  sinceMs?: number,
  timeZone?: string,
  reconcile?: Reconcile,
): Promise<UsageReport> {
  // Before any file read: an unknown zone must fail here, not inside the per-file parse catch.
  const dayKey = dayKeyIn(timeZone);
  const walked = walkClaudeSessions(roots, sinceMs);
  const { records } = (reconcile ?? parseEveryCandidate)(
    "claude",
    walked,
    parseClaudeWhole,
    parseClaudeTail,
  );
  return foldClaude(inWalkOrder(walked, records), sinceMs, dayKey);
}

export function walkClaudeSessions(roots: string[], sinceMs: number | undefined): WalkedFile[] {
  const collected: WalkedFile[] = [];
  for (const root of roots) {
    collectTranscriptFiles(root, 1, sinceMs, collected);
  }
  // Roots may overlap (the same directory named twice).
  const seen = new Set<string>();
  const files = collected.filter((f) => {
    if (seen.has(f.path)) {
      return false;
    }
    seen.add(f.path);
    return true;
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export const parseClaudeWhole: ParseWhole<ClaudeContribution> = (file) => {
  return parseClaudeFrom(file, 0, { v: CONTRIBUTION_VERSION, occurrences: [] });
};

/** A copy of `prior`'s occurrences: the index still holds `prior`. */
export const parseClaudeTail: ParseTail<ClaudeContribution> = (file, fromByte, prior) => {
  return parseClaudeFrom(file, fromByte, { v: prior.v, occurrences: [...prior.occurrences] });
};

/** Per occurrence: the window, THEN the running-max dedup (one map across all files). */
export function foldClaude(
  records: readonly FileRecord<ClaudeContribution>[],
  sinceMs: number | undefined,
  dayKey: DayKey,
): UsageReport {
  const report = usageReport();
  const seenMessages = new Map<string, TokenBuckets>();
  // Transcripts log Anthropic's dashed, date-snapshotted ids; the canonical spelling merges them
  // with the proxy's Copilot ids.
  const canonical = canonicalModelNames();
  for (const { contribution } of records) {
    for (const occurrence of contribution.occurrences) {
      const [idHash, tsMs, rawModel] = occurrence;
      if (sinceMs !== undefined && !(tsMs !== null && tsMs >= sinceMs)) {
        continue; // outside the window (or no timestamp under a cutoff)
      }
      const model = canonical(rawModel);
      const snapshot: TokenBuckets = {
        input: occurrence[3],
        output: occurrence[4],
        cacheRead: occurrence[5],
        cacheCreation: occurrence[6],
      };
      // Id-less lines (not observed in practice) are counted unconditionally.
      let buckets = snapshot;
      let isNewMessage = true;
      if (idHash !== null) {
        const prev = seenMessages.get(idHash);
        if (prev === undefined) {
          seenMessages.set(idHash, snapshot);
        } else {
          isNewMessage = false;
          buckets = {
            input: Math.max(0, snapshot.input - prev.input),
            output: Math.max(0, snapshot.output - prev.output),
            cacheRead: Math.max(0, snapshot.cacheRead - prev.cacheRead),
            cacheCreation: Math.max(0, snapshot.cacheCreation - prev.cacheCreation),
          };
          seenMessages.set(idHash, {
            input: Math.max(prev.input, snapshot.input),
            output: Math.max(prev.output, snapshot.output),
            cacheRead: Math.max(prev.cacheRead, snapshot.cacheRead),
            cacheCreation: Math.max(prev.cacheCreation, snapshot.cacheCreation),
          });
          if (
            buckets.input === 0 &&
            buckets.output === 0 &&
            buckets.cacheRead === 0 &&
            buckets.cacheCreation === 0
          ) {
            continue; // an exact repeat adds nothing
          }
        }
      }
      // Only the first occurrence of an id is an event. The day is the user's local one, not the
      // UTC day the timestamp spells; a line with no parseable timestamp still counts toward the
      // totals.
      record(report, tsMs === null ? null : dayKey(tsMs), model, {
        ...buckets,
        events: isNewMessage ? 1 : 0,
      });
    }
  }
  return report;
}

// ---------- internals ----------

function collectTranscriptFiles(
  dir: string,
  depth: number,
  sinceMs: number | undefined,
  out: WalkedFile[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    consola.warn(`could not list ${dir} (${errMessage(e)}).`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) {
        collectTranscriptFiles(full, depth + 1, sinceMs, out);
      }
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(full));
    } catch (e) {
      consola.warn(`could not read ${full} (${errMessage(e)}).`);
      continue;
    }
    const candidate = sinceMs === undefined || !(mtimeMs + MTIME_CUTOFF_SLACK_MS < sinceMs);
    out.push({ path: full, size, mtimeMs, candidate, resumable: true });
  }
}

function parseClaudeFrom(
  file: WalkedFile,
  fromByte: number,
  contribution: ClaudeContribution,
): ParsedFile<ClaudeContribution> {
  const scan = scanLines(file.path, fromByte, CLAUDE_NEEDLES, (hit) => {
    parseClaudeLine(hit.line, contribution.occurrences);
  });
  return { contribution, ...scan };
}

function tokenBuckets(usage: Record<string, unknown>): TokenBuckets {
  // Hostile or torn counts never enter a report.
  const num = sanitizeTokenCount;
  return {
    // Unlike Codex, Claude's input_tokens already excludes the cache buckets.
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    // The 5m/1h split (usage.cache_creation) is not priced separately: the OpenRouter cache-write
    // rate approximates the 5m tier, and the 1h bucket is 0 in all observed data.
    cacheCreation: num(usage.cache_creation_input_tokens),
  };
}

/** A needle may sit inside another line's content, so the type checks stay. Synthetic placeholders
 *  touch no cross-file state, so they are dropped here rather than in the fold. */
function parseClaudeLine(line: string, occurrences: ClaudeOccurrence[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // torn or corrupt line
  }
  if (!isRecord(parsed) || parsed.type !== "assistant" || !isRecord(parsed.message)) {
    return;
  }
  const message = parsed.message;
  if (!isRecord(message.usage)) {
    return;
  }
  const rawModel = typeof message.model === "string" ? message.model : "unknown";
  if (rawModel === SYNTHETIC_MODEL) {
    return;
  }
  const tsMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
  const buckets = tokenBuckets(message.usage);
  occurrences.push([
    typeof message.id === "string" ? dedupKey(message.id) : null,
    Number.isFinite(tsMs) ? tsMs : null,
    rawModel,
    buckets.input,
    buckets.output,
    buckets.cacheRead,
    buckets.cacheCreation,
  ]);
}
