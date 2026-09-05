// Read Claude Code transcript logs and aggregate token usage.
//
// Claude Code persists every conversation as JSONL transcripts under
// `<claude-home>/projects/<cwd-slug>/<sessionId>.jsonl`, with subagent
// transcripts nested deeper (`<slug>/<sessionId>/subagents/**/agent-*.jsonl`),
// so discovery walks recursively. Each assistant line is
// `{"type":"assistant","timestamp":"<UTC ISO-8601>","message":{...}}` where
// `message.model` names the model and `message.usage` carries `input_tokens`
// (EXCLUDING cache, unlike Codex), `output_tokens`, `cache_read_input_tokens`
// and `cache_creation_input_tokens` -- everything needed to price a turn.
//
// Deduplication is mandatory and value-aware: streaming writes one line per
// content block, all sharing the same `message.id`, and the usage SNAPSHOT
// GROWS across those lines -- `output_tokens` rises until the final line
// carries the true count (the input-side buckets never change; verified over
// every local transcript). Resume/fork additionally copies finished lines
// into new files. So each message is counted once, at the running per-bucket
// MAX across every occurrence: the first line books its snapshot and later
// lines add only the positive delta. This covers Direct-wired Claude, which
// bypasses the proxy and therefore never reaches the proxy's SQLite usage
// tables. The raw transcripts are the source of truth here on purpose:
// Claude Code's own `stats-cache.json` is a pre-aggregated cache, not raw
// data.
//
// Split as walk -> pure per-file parse (a ClaudeContribution, window and dedup
// NOT applied) -> fold, so a per-file index can cache the parse.

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
import { canonicalModelName } from "./pricing.ts";
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

/** The line kind the parser reads; every other line is never decoded. */
export const CLAUDE_NEEDLES: readonly string[] = ['"type":"assistant"'];

/** Headroom over the observed layout:
 *  projects/<slug>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl */
const MAX_WALK_DEPTH = 8;

/**
 * Transcript filenames carry no date, so file-level `--days` skipping leans on
 * the mtime (appends refresh it, so a resumed session is never dropped) with a
 * day of slack for clock skew.
 */
const MTIME_CUTOFF_SLACK_MS = MILLISECONDS_PER_DAY;

/**
 * Locate the Claude transcript root(s): `<home>/projects`. There is a single
 * Claude home (no per-host farm), but the injectable list keeps the shape of
 * discoverCodexSessionRoots and the realpath dedup guards against symlinked
 * spellings of the same directory.
 */
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

/**
 * Parse every transcript under `roots` and aggregate token usage per model,
 * per LOCAL calendar day, into ONE report (transcripts carry no provider dimension).
 * `sinceMs` (unix ms) bounds the report to recent events when set. A file that
 * fails to read is skipped with a warning rather than aborting the report.
 * `timeZone` names the zone the per-day split is cut in (default: the system's own);
 * it exists so the slicing is assertable without pinning the process `TZ`, which
 * deno honors on unix only. `reconcile` (the usage index) may supply the per-file
 * contributions; without it every candidate is parsed whole.
 */
export async function readClaudeSessions(
  roots: string[],
  sinceMs?: number,
  timeZone?: string,
  reconcile?: Reconcile,
): Promise<UsageReport> {
  // Resolved FIRST, before any directory walk or file read: an unknown zone must fail here,
  // not once per file inside the parse catch, which would report it as an
  // unreadable transcript and return a report silently missing its per-day split.
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

/** Every transcript under `roots`, ascending by path; a file is a candidate
 *  unless its mtime says it was untouched since the cutoff. */
export function walkClaudeSessions(roots: string[], sinceMs: number | undefined): WalkedFile[] {
  const collected: WalkedFile[] = [];
  for (const root of roots) {
    collectTranscriptFiles(root, 1, sinceMs, collected);
  }
  // Roots may overlap (the same directory named twice); a path is walked once.
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

/** Parse a transcript from its first byte. */
export const parseClaudeWhole: ParseWhole<ClaudeContribution> = (file) => {
  return parseClaudeFrom(file, 0, { v: CONTRIBUTION_VERSION, occurrences: [] });
};

/** Resume a transcript at `fromByte`, appending to a copy of `prior`'s
 *  occurrences; `prior` itself is never mutated (the index still holds it). */
export const parseClaudeTail: ParseTail<ClaudeContribution> = (file, fromByte, prior) => {
  return parseClaudeFrom(file, fromByte, { v: prior.v, occurrences: [...prior.occurrences] });
};

/** Fold the contributions (walk order) into one report. Per occurrence: the
 *  window, THEN the running-max dedup (one map across all files), then record. */
export function foldClaude(
  records: readonly FileRecord<ClaudeContribution>[],
  sinceMs: number | undefined,
  dayKey: DayKey,
): UsageReport {
  const report = usageReport();
  const seenMessages = new Map<string, TokenBuckets>();
  for (const { contribution } of records) {
    for (const [idHash, tsMs, rawModel, ...counts] of contribution.occurrences) {
      if (sinceMs !== undefined && !(tsMs !== null && tsMs >= sinceMs)) {
        continue; // outside the window (or no timestamp under a cutoff)
      }
      // Transcripts log Anthropic's dashed, date-snapshotted ids; key rows by
      // the canonical spelling so they merge with the proxy's Copilot ids.
      const model = canonicalModelName(rawModel);
      const [input, output, cacheRead, cacheCreation] = counts;
      const snapshot: TokenBuckets = { input, output, cacheRead, cacheCreation };
      // A repeated id books only the positive per-bucket delta over what was
      // already counted (streaming snapshots grow toward the final count;
      // resume/fork copies repeat it exactly, delta zero). Id-less lines (not
      // observed in practice) are counted unconditionally.
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
      // A repeated id is the same message continuing (streaming) or copied
      // (resume/fork), so only the FIRST occurrence counts as an event. Bucket
      // by the user's LOCAL calendar day, not the UTC day the transcript
      // timestamp spells; a line with no parseable timestamp still counts
      // toward the totals.
      record(report, tsMs === null ? null : dayKey(tsMs), model, {
        ...buckets,
        events: isNewMessage ? 1 : 0,
      });
    }
  }
  return report;
}

// ---------- internals ----------

/** Recursively collect transcript files, deciding candidacy by mtime. */
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

/** Map one assistant `message.usage` onto the report's token buckets. */
function tokenBuckets(usage: Record<string, unknown>): TokenBuckets {
  // sanitizeTokenCount (usage.ts): hostile or torn counts never enter a report.
  const num = sanitizeTokenCount;
  return {
    // Unlike Codex, Claude's input_tokens already excludes the cache buckets.
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    // The 5m/1h split (usage.cache_creation) is not priced separately: the
    // OpenRouter cache-write rate approximates the 5m tier, and the 1h bucket
    // is 0 in all observed data.
    cacheCreation: num(usage.cache_creation_input_tokens),
  };
}

/** Append the line's usage occurrence, if it is one. A needle may sit inside
 *  another line's content, so the type checks stay; synthetic placeholders touch
 *  no cross-file state, so they are dropped here. */
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
