// Read Codex CLI session rollout logs and aggregate token usage.
//
// The Codex CLI persists every session as a JSONL "rollout" file under
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl` (archived
// sessions move to a flat `$CODEX_HOME/archived_sessions/`, optionally
// zstd-compressed to `.jsonl.zst`). Each line is
// `{"timestamp":"<UTC ISO-8601>","type":...,"payload":{...}}`:
//   - the first line (`type:"session_meta"`) carries `model_provider` and, for
//     forked sessions, `forked_from_id`;
//   - `type:"turn_context"` lines carry the model in effect (`payload.model`),
//     which can change mid-session;
//   - `type:"event_msg"` lines with `payload.type:"token_count"` carry
//     `payload.info.last_token_usage` (the turn's own tokens) plus a cumulative
//     `total_token_usage`. `input_tokens` INCLUDES `cached_input_tokens`.
//
// We attribute each token_count's `last_token_usage` to the model in effect at
// that line and bucket by the line timestamp's UTC day, grouped by the
// session's `model_provider`. This covers Direct-wired Codex, which bypasses
// the proxy and therefore never reaches the proxy's SQLite usage tables.

import { createReadStream, type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { consola } from "consola";
import { knownCodexHomes } from "../codex/config.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { canonicalModelName } from "./pricing.ts";
import type { ModelUsage, UsageReport } from "./usage.ts";

const SESSION_SUBDIRS = ["sessions", "archived_sessions"];
const ROLLOUT_FILE = /^rollout-(\d{4})-(\d{2})-(\d{2})T.*\.jsonl(\.zst)?$/;
const MAX_WALK_DEPTH = 4; // sessions/YYYY/MM/DD/<file>

/** Label for sessions whose meta omits `model_provider` (Codex's built-in). */
const DEFAULT_PROVIDER = "default";
/** Label for usage seen before any turn_context names a model. */
const UNKNOWN_MODEL = "unknown";

/**
 * Forked sessions copy the parent's rollout items -- token_count events
 * included -- into the new file in one batch at session start; the fork's own
 * first turn needs a model round-trip. When the parent file is unavailable for
 * exact dedup, a copied-prefix token_count is recognized by landing within
 * this window of the session_meta line timestamp.
 */
const FORK_PREFIX_WINDOW_MS = 2_000;

/**
 * The `sessions/` date tree and rollout filenames use LOCAL dates while the
 * `--days` cutoff and per-line timestamps are UTC, so file-level skipping
 * keeps a day and a half of slack and the per-event cutoff does the exact cut.
 */
const FILENAME_CUTOFF_SLACK_MS = 1.5 * MILLISECONDS_PER_DAY;

/**
 * Locate every Codex session directory worth scanning: `sessions/` and
 * `archived_sessions/` under each known Codex home (active home, ~/.codex,
 * per-host farm homes). Farm homes symlink these directories back into the
 * shared ~/.codex, so roots are deduplicated by realpath.
 */
export function discoverCodexSessionRoots(homes: string[] = knownCodexHomes().homes): string[] {
  const byRealpath = new Map<string, string>();
  for (const home of homes) {
    for (const sub of SESSION_SUBDIRS) {
      const dir = path.join(home, sub);
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
  }
  return [...byRealpath.values()];
}

/**
 * Parse every rollout file under `roots` and aggregate token usage per
 * `model_provider`, per model, per UTC day. `sinceMs` (unix ms) bounds the
 * report to recent events when set. A file that fails to read is skipped with
 * a warning rather than aborting the whole report.
 */
export async function readCodexSessions(
  roots: string[],
  sinceMs?: number,
): Promise<Map<string, UsageReport>> {
  const files: string[] = [];
  for (const root of roots) {
    collectRolloutFiles(root, 1, sinceMs, files);
  }
  // Ascending start order (the filename embeds the start timestamp), so a
  // fork's parent is always parsed before the fork itself. The rollout
  // filename embeds the session uuid, so the same session showing up twice
  // (e.g. a live copy plus a compressed archived one) dedupes by basename,
  // plain `.jsonl` preferred over `.jsonl.zst`.
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const byBasename = new Map<string, string>();
  for (const file of files) {
    const key = path.basename(file).replace(/\.zst$/, "");
    const prev = byBasename.get(key);
    if (prev === undefined || (prev.endsWith(".zst") && !file.endsWith(".zst"))) {
      byBasename.set(key, file);
    }
  }
  const uniqueFiles = [...byBasename.values()];

  const providers = new Map<string, UsageReport>();
  // Every token_count `info` seen per session (counted or not), keyed by the
  // session id, so a later fork can drop the events it copied from its parent.
  const infoHashesBySession = new Map<string, Set<string>>();

  for (const file of uniqueFiles) {
    try {
      await parseRolloutFile(file, sinceMs, providers, infoHashesBySession);
    } catch (e) {
      consola.warn(`could not read ${file} (${errMessage(e)}).`);
    }
  }
  return providers;
}

// ---------- internals ----------

/** Recursively collect rollout files, skipping ones started long before the cutoff. */
function collectRolloutFiles(
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
        collectRolloutFiles(full, depth + 1, sinceMs, out);
      }
      continue;
    }
    const m = ROLLOUT_FILE.exec(entry.name);
    if (m === null) {
      continue;
    }
    if (sinceMs !== undefined) {
      // A resumed session appends new events to its ORIGINAL rollout, so an
      // old start date alone cannot exclude a file -- only an old start date
      // AND no writes since the cutoff can. A failed stat falls through to
      // the parse (which warns if the file is truly unreadable).
      const startedMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      if (Number.isFinite(startedMs) && startedMs + FILENAME_CUTOFF_SLACK_MS < sinceMs) {
        let mtimeMs: number | undefined;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          mtimeMs = undefined;
        }
        if (mtimeMs !== undefined && mtimeMs < sinceMs) {
          continue;
        }
      }
    }
    out.push(full);
  }
}

/** Yield the lines of a rollout file, transparently decompressing `.jsonl.zst`. */
async function* rolloutLines(file: string): AsyncGenerator<string> {
  if (file.endsWith(".zst")) {
    const raw = Bun.zstdDecompressSync(await Bun.file(file).arrayBuffer());
    yield* new TextDecoder().decode(raw).split("\n");
    return;
  }
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    yield* rl;
  } finally {
    rl.close();
  }
}

interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Map one `last_token_usage` object onto the proxy report's token buckets. */
function tokenBuckets(last: Record<string, unknown>): TokenBuckets {
  // Non-finite or negative counts (hostile or torn lines) never enter a report.
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const cached = num(last.cached_input_tokens);
  return {
    // Codex reports input INCLUSIVE of the cached tokens; the pricing buckets
    // charge cached reads separately, so split them out here.
    input: Math.max(0, num(last.input_tokens) - cached),
    cacheRead: cached,
    // output_tokens already includes the reasoning tokens (a details field).
    output: num(last.output_tokens),
    cacheCreation: 0, // no cache-write bucket in the Responses usage payload
  };
}

/** Fold one event's buckets into a model->usage map. */
function accumulate(target: Map<string, ModelUsage>, model: string, b: TokenBuckets): void {
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
  prev.events += 1;
  target.set(model, prev);
}

/**
 * Parse one rollout file, folding its token_count events into `providers`.
 *
 * Fork handling: a forked session persists COPIES of its parent's rollout
 * items (token_count events included) at the head of the new file, and its
 * cumulative totals then continue from the copied prefix -- so counting every
 * event would double count the parent. Identical `info` implies identical
 * cumulative totals implies zero new usage, so an event is counted only when
 * its exact info JSON was seen neither earlier in this file (also absorbs
 * re-emitted counts on resume) nor anywhere in the parent session. When the
 * parent was not scanned (deleted, or outside the cutoff), fall back to
 * dropping token_counts inside the batch-write window right after the
 * session_meta line.
 */
async function parseRolloutFile(
  file: string,
  sinceMs: number | undefined,
  providers: Map<string, UsageReport>,
  infoHashesBySession: Map<string, Set<string>>,
): Promise<void> {
  let provider = DEFAULT_PROVIDER;
  let model = UNKNOWN_MODEL;
  let sessionId: string | undefined;
  let metaTsMs: number | undefined;
  let parentHashes: Set<string> | undefined;
  let forked = false;
  const ownHashes = new Set<string>();

  for await (const line of rolloutLines(file)) {
    // Cheap substring gates before JSON.parse; most lines are response items.
    const isMeta = line.includes('"session_meta"');
    const isTurnContext = line.includes('"turn_context"');
    const isTokenCount = line.includes('"token_count"');
    const isSettings = line.includes('"thread_settings_applied"');
    if (!isMeta && !isTurnContext && !isTokenCount && !isSettings) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn or corrupt line
    }
    if (!isRecord(parsed) || !isRecord(parsed.payload)) {
      continue;
    }
    const payload = parsed.payload;

    if (isMeta && parsed.type === "session_meta" && sessionId === undefined) {
      const id = payload.id ?? payload.session_id;
      sessionId = typeof id === "string" ? id : undefined;
      if (typeof payload.model_provider === "string" && payload.model_provider !== "") {
        provider = payload.model_provider;
      }
      if (typeof payload.forked_from_id === "string") {
        forked = true;
        parentHashes = infoHashesBySession.get(payload.forked_from_id);
      }
      const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      metaTsMs = Number.isFinite(ts) ? ts : undefined;
      continue;
    }

    if (isTurnContext && parsed.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model !== "") {
        model = canonicalModelName(payload.model);
      }
      continue;
    }

    if (parsed.type !== "event_msg") {
      continue;
    }

    if (isSettings && payload.type === "thread_settings_applied") {
      const settings = payload.thread_settings;
      if (isRecord(settings) && typeof settings.model === "string" && settings.model !== "") {
        model = canonicalModelName(settings.model);
      }
      continue;
    }

    if (!isTokenCount || payload.type !== "token_count" || !isRecord(payload.info)) {
      continue;
    }
    const last = payload.info.last_token_usage;
    if (!isRecord(last)) {
      continue;
    }

    const hash = JSON.stringify(payload.info);
    const tsMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
    const duplicate =
      ownHashes.has(hash) ||
      parentHashes?.has(hash) === true ||
      (forked &&
        parentHashes === undefined &&
        metaTsMs !== undefined &&
        Number.isFinite(tsMs) &&
        tsMs - metaTsMs <= FORK_PREFIX_WINDOW_MS);
    ownHashes.add(hash);
    if (duplicate) {
      continue;
    }
    if (sinceMs !== undefined && !(tsMs >= sinceMs)) {
      continue; // outside the window (or unparseable timestamp under a cutoff)
    }

    let report = providers.get(provider);
    if (report === undefined) {
      report = { byModel: new Map(), activeDays: 0, perDay: new Map() };
      providers.set(provider, report);
    }
    const buckets = tokenBuckets(last);
    accumulate(report.byModel, model, buckets);
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
      accumulate(dayModels, model, buckets);
    }
    report.activeDays = report.perDay.size;
  }

  if (sessionId !== undefined && ownHashes.size > 0) {
    infoHashesBySession.set(sessionId, ownHashes);
  }
}
