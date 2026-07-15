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

import { createReadStream, type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { consola } from "consola";
import { resolveClaudeHome } from "../claude/config.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { canonicalModelName } from "./pricing.ts";
import type { ModelUsage, UsageReport } from "./usage.ts";

/** Error placeholders carry this model id and no real usage attribution. */
const SYNTHETIC_MODEL = "<synthetic>";

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
 * per UTC day, into ONE report (transcripts carry no provider dimension).
 * `sinceMs` (unix ms) bounds the report to recent events when set. A file that
 * fails to read is skipped with a warning rather than aborting the report.
 */
export async function readClaudeSessions(roots: string[], sinceMs?: number): Promise<UsageReport> {
  const files: string[] = [];
  for (const root of roots) {
    collectTranscriptFiles(root, 1, sinceMs, files);
  }

  const report: UsageReport = { byModel: new Map(), activeDays: 0, perDay: new Map() };
  // One map across ALL files: streaming repeats a message.id within a file
  // (with a GROWING output_tokens snapshot) and resume/fork copies it across
  // files. Each id books the running per-bucket max -- later occurrences add
  // only the positive delta, so order never matters and nothing double counts.
  const seenMessages = new Map<string, TokenBuckets>();

  for (const file of files) {
    try {
      await parseTranscriptFile(file, sinceMs, report, seenMessages);
    } catch (e) {
      consola.warn(`could not read ${file} (${errMessage(e)}).`);
    }
  }
  return report;
}

// ---------- internals ----------

/** Recursively collect transcript files, skipping ones untouched since the cutoff. */
function collectTranscriptFiles(
  dir: string,
  depth: number,
  sinceMs: number | undefined,
  out: string[],
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
    if (sinceMs !== undefined) {
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        mtimeMs = undefined; // fall through to the parse
      }
      if (mtimeMs !== undefined && mtimeMs + MTIME_CUTOFF_SLACK_MS < sinceMs) {
        continue;
      }
    }
    out.push(full);
  }
}

/** The four priced token buckets of one message. */
interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Map one assistant `message.usage` onto the report's token buckets. */
function tokenBuckets(usage: Record<string, unknown>): TokenBuckets {
  // Non-finite or negative counts (hostile or torn lines) never enter a report.
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
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

/** Parse one transcript, folding its deduplicated assistant lines into `report`. */
async function parseTranscriptFile(
  file: string,
  sinceMs: number | undefined,
  report: UsageReport,
  seenMessages: Map<string, TokenBuckets>,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // Cheap substring gate before JSON.parse; most lines are user/tool traffic.
      if (!line.includes('"type":"assistant"')) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn or corrupt line
      }
      if (!isRecord(parsed) || parsed.type !== "assistant" || !isRecord(parsed.message)) {
        continue;
      }
      const message = parsed.message;
      if (!isRecord(message.usage)) {
        continue;
      }
      const rawModel = typeof message.model === "string" ? message.model : "unknown";
      if (rawModel === SYNTHETIC_MODEL) {
        continue;
      }
      // Transcripts log Anthropic's dashed, date-snapshotted ids; key rows by
      // the canonical spelling so they merge with the proxy's Copilot ids.
      const model = canonicalModelName(rawModel);
      const tsMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      if (sinceMs !== undefined && !(tsMs >= sinceMs)) {
        continue; // outside the window (or unparseable timestamp under a cutoff)
      }

      // Value-aware dedup: a repeated id books only the positive per-bucket
      // delta over what was already counted (streaming snapshots grow toward
      // the final count; resume/fork copies repeat it exactly, delta zero).
      // Id-less lines (not observed in practice) are counted unconditionally.
      const snapshot = tokenBuckets(message.usage);
      let buckets = snapshot;
      let isNewMessage = true;
      if (typeof message.id === "string") {
        const prev = seenMessages.get(message.id);
        if (prev === undefined) {
          seenMessages.set(message.id, snapshot);
        } else {
          isNewMessage = false;
          buckets = {
            input: Math.max(0, snapshot.input - prev.input),
            output: Math.max(0, snapshot.output - prev.output),
            cacheRead: Math.max(0, snapshot.cacheRead - prev.cacheRead),
            cacheCreation: Math.max(0, snapshot.cacheCreation - prev.cacheCreation),
          };
          seenMessages.set(message.id, {
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

      accumulate(report.byModel, model, buckets, isNewMessage);
      const day =
        typeof parsed.timestamp === "string" && /^\d{4}-\d{2}-\d{2}/.test(parsed.timestamp)
          ? parsed.timestamp.slice(0, 10)
          : undefined;
      if (day !== undefined) {
        let dayModels = report.perDay.get(day);
        if (dayModels === undefined) {
          dayModels = new Map<string, ModelUsage>();
          report.perDay.set(day, dayModels);
        }
        accumulate(dayModels, model, buckets, isNewMessage);
      }
      report.activeDays = report.perDay.size;
    }
  } finally {
    rl.close();
  }
}

/** Fold one message's (possibly delta) buckets into a model->usage map. */
function accumulate(
  target: Map<string, ModelUsage>,
  model: string,
  b: TokenBuckets,
  isNewMessage: boolean,
): void {
  const prev = target.get(model) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 0,
  };
  prev.input += b.input;
  prev.output += b.output;
  prev.cacheRead += b.cacheRead;
  prev.cacheCreation += b.cacheCreation;
  if (isNewMessage) {
    prev.events += 1;
  }
  target.set(model, prev);
}
