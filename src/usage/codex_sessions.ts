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
// that line and bucket by the line timestamp's LOCAL calendar day, grouped by the
// session's `model_provider`. This covers Direct-wired Codex, which bypasses
// the proxy and therefore never reaches the proxy's SQLite usage tables.
//
// Split as walk -> pure per-file parse (a CodexContribution, dedup and window
// NOT applied) -> fold, so a per-file index can cache the parse.

import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { consola } from "consola";
import { knownCodexHomes } from "../codex/config.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { type DayKey, dayKeyIn, MILLISECONDS_PER_DAY } from "../utils/time.ts";
import {
  type CodexContribution,
  type CodexEvent,
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
import { scanBytes, scanLines } from "./scan.ts";
import {
  record,
  sanitizeTokenCount,
  type TokenBuckets,
  type UsageReport,
  usageReport,
} from "./usage.ts";

const SESSION_SUBDIRS = ["sessions", "archived_sessions"];
const ROLLOUT_FILE = /^rollout-(\d{4})-(\d{2})-(\d{2})T.*\.jsonl(\.zst)?$/;
const MAX_WALK_DEPTH = 4; // sessions/YYYY/MM/DD/<file>

/** The line kinds the parser reads; every other line is never decoded. */
const CODEX_NEEDLES: readonly string[] = [
  '"session_meta"',
  '"turn_context"',
  '"token_count"',
  '"thread_settings_applied"',
];

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
 * `model_provider`, per model, per LOCAL calendar day. `sinceMs` (unix ms) bounds the
 * report to recent events when set. A file that fails to read is skipped with
 * a warning rather than aborting the whole report. `timeZone` names the zone the
 * per-day split is cut in (default: the system's own); it exists so the slicing is
 * assertable without pinning the process `TZ`, which deno honors on unix only.
 * `reconcile` (the usage index) may supply the per-file contributions; without
 * it every candidate is parsed whole.
 */
export async function readCodexSessions(
  roots: string[],
  sinceMs?: number,
  timeZone?: string,
  reconcile?: Reconcile,
): Promise<Map<string, UsageReport>> {
  // Resolved FIRST, before any directory walk or file read: an unknown zone must fail here,
  // not once per file inside the parse catch, which would report it as an
  // unreadable rollout and return a report silently missing its per-day split.
  const dayKey = dayKeyIn(timeZone);
  const walked = walkCodexSessions(roots, sinceMs);
  const { records } = (reconcile ?? parseEveryCandidate)(
    "codex",
    walked,
    parseCodexWhole,
    parseCodexTail,
  );
  return foldCodex(inWalkOrder(walked, records), sinceMs, dayKey);
}

/** Every rollout under `roots`, ascending by basename (the start timestamp, so a
 *  fork's parent precedes the fork). A candidate may hold in-window events and won
 *  the same-session dedup (the plain `.jsonl` over its `.jsonl.zst` twin). */
export function walkCodexSessions(roots: string[], sinceMs: number | undefined): WalkedFile[] {
  const collected: WalkedFile[] = [];
  for (const root of roots) {
    collectRolloutFiles(root, 1, sinceMs, collected);
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
  files.sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)));
  const bySession = new Map<string, WalkedFile>();
  for (const file of files) {
    if (!file.candidate) {
      continue;
    }
    const key = path.basename(file.path).replace(/\.zst$/, "");
    const prev = bySession.get(key);
    if (prev === undefined) {
      bySession.set(key, file);
    } else if (!prev.resumable && file.resumable) {
      prev.candidate = false;
      bySession.set(key, file);
    } else {
      file.candidate = false;
    }
  }
  return files;
}

/** Parse a rollout from its first byte. A `.jsonl.zst` archive is decompressed
 *  whole and cut with the same complete-lines rule; it cannot be resumed, so it
 *  reports the compressed size as `parsedThrough` and no probe. */
export const parseCodexWhole: ParseWhole<CodexContribution> = (file) => {
  if (!file.resumable) {
    const compressed = readFileSync(file.path);
    const contribution = emptyCodexContribution();
    scanBytes(withoutBom(zstdDecompressSync(compressed)), CODEX_NEEDLES, (hit) => {
      parseCodexLine(hit.line, contribution);
    });
    return {
      contribution,
      parsedThrough: compressed.length,
      tailProbeHex: "",
      bytesRead: compressed.length,
    };
  }
  return parseCodexFrom(file, 0, emptyCodexContribution());
};

/** Resume a rollout at `fromByte`, continuing `prior`'s parser state; `prior`
 *  itself is never mutated (the index still holds it). */
export const parseCodexTail: ParseTail<CodexContribution> = (file, fromByte, prior) => {
  return parseCodexFrom(file, fromByte, {
    v: prior.v,
    state: { ...prior.state },
    events: [...prior.events],
  });
};

/** Fold the contributions (walk order) into one report per provider. Per event:
 *  fork dedup (an info hash seen in this file or the parent is a copied
 *  token_count; parent unscanned: FORK_PREFIX_WINDOW_MS), THEN the window. The
 *  fork rules start at the event the fork was learned before (`forkKnownAfter`);
 *  every event's hash enters the file's own set regardless. */
export function foldCodex(
  records: readonly FileRecord<CodexContribution>[],
  sinceMs: number | undefined,
  dayKey: DayKey,
): Map<string, UsageReport> {
  const providers = new Map<string, UsageReport>();
  const canonical = canonicalModelNames();
  // Every token_count `info` seen per session (counted or not), keyed by the
  // session id hash, so a later fork can drop the events it copied from its parent.
  const infoHashesBySession = new Map<string, Set<string>>();
  for (const { contribution: { state, events } } of records) {
    const { forkedFromIdHash, forkKnownAfter = 0, metaTsMs } = state;
    const parentHashes = forkedFromIdHash === undefined
      ? undefined
      : infoHashesBySession.get(forkedFromIdHash);
    const ownHashes = new Set<string>();
    for (let index = 0; index < events.length; index++) {
      const [tsMs, rawProvider, rawModel, infoHash, input, output, cacheRead] = events[index]!;
      const forked = forkedFromIdHash !== undefined && index >= forkKnownAfter;
      const duplicate = ownHashes.has(infoHash) ||
        (forked &&
          (parentHashes?.has(infoHash) === true ||
            (parentHashes === undefined &&
              metaTsMs !== undefined &&
              tsMs !== null &&
              tsMs - metaTsMs <= FORK_PREFIX_WINDOW_MS)));
      ownHashes.add(infoHash);
      if (duplicate) {
        continue;
      }
      if (sinceMs !== undefined && !(tsMs !== null && tsMs >= sinceMs)) {
        continue; // outside the window (or no timestamp under a cutoff)
      }
      let report = providers.get(rawProvider);
      if (report === undefined) {
        report = usageReport();
        providers.set(rawProvider, report);
      }
      // Bucket by the user's LOCAL calendar day, not the UTC day the rollout
      // timestamp spells; a line with no parseable timestamp still counts
      // toward the totals.
      record(report, tsMs === null ? null : dayKey(tsMs), canonical(rawModel), {
        input,
        output,
        cacheRead,
        cacheCreation: 0,
        events: 1,
      });
    }
    if (state.sessionIdHash !== undefined && ownHashes.size > 0) {
      infoHashesBySession.set(state.sessionIdHash, ownHashes);
    }
  }
  return providers;
}

// ---------- internals ----------

/** Recursively collect rollout files, deciding candidacy by the start date in
 *  the filename and the mtime. */
function collectRolloutFiles(
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
        collectRolloutFiles(full, depth + 1, sinceMs, out);
      }
      continue;
    }
    const m = ROLLOUT_FILE.exec(entry.name);
    if (m === null) {
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
    let candidate = true;
    if (sinceMs !== undefined) {
      // A resumed session appends new events to its ORIGINAL rollout, so an
      // old start date alone cannot exclude a file -- only an old start date
      // AND no writes since the cutoff can.
      const startedMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      if (Number.isFinite(startedMs) && startedMs + FILENAME_CUTOFF_SLACK_MS < sinceMs) {
        candidate = !(mtimeMs < sinceMs);
      }
    }
    out.push({ path: full, size, mtimeMs, candidate, resumable: m[4] === undefined });
  }
}

/** The archive path has always dropped a leading UTF-8 BOM (its whole-text
 *  decoder did); the file path never did, and the scanner keeps it that way. */
function withoutBom(bytes: Uint8Array): Uint8Array {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
}

function emptyCodexContribution(): CodexContribution {
  return {
    v: CONTRIBUTION_VERSION,
    state: { provider: DEFAULT_PROVIDER, model: UNKNOWN_MODEL },
    events: [],
  };
}

function parseCodexFrom(
  file: WalkedFile,
  fromByte: number,
  contribution: CodexContribution,
): ParsedFile<CodexContribution> {
  const scan = scanLines(file.path, fromByte, CODEX_NEEDLES, (hit) => {
    parseCodexLine(hit.line, contribution);
  });
  return { contribution, ...scan };
}

/** Map one `last_token_usage` object onto the proxy report's token buckets. */
function tokenBuckets(last: Record<string, unknown>): TokenBuckets {
  // sanitizeTokenCount (usage.ts): hostile or torn counts never enter a report.
  const num = sanitizeTokenCount;
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

/** Fold one needle-bearing line into `state` / `events`. A needle may sit inside
 *  another line's content, so the type checks stay. */
function parseCodexLine(line: string, contribution: CodexContribution): void {
  const { state, events } = contribution;
  const isMeta = line.includes('"session_meta"');
  const isTurnContext = line.includes('"turn_context"');
  const isTokenCount = line.includes('"token_count"');
  const isSettings = line.includes('"thread_settings_applied"');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // torn or corrupt line
  }
  if (!isRecord(parsed) || !isRecord(parsed.payload)) {
    return;
  }
  const payload = parsed.payload;

  if (isMeta && parsed.type === "session_meta" && state.sessionIdHash === undefined) {
    const id = payload.id ?? payload.session_id;
    state.sessionIdHash = typeof id === "string" ? dedupKey(id) : undefined;
    if (typeof payload.model_provider === "string" && payload.model_provider !== "") {
      state.provider = payload.model_provider;
    }
    if (typeof payload.forked_from_id === "string") {
      state.forkedFromIdHash = dedupKey(payload.forked_from_id);
      state.forkKnownAfter = events.length;
    }
    const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
    state.metaTsMs = Number.isFinite(ts) ? ts : undefined;
    return;
  }

  if (isTurnContext && parsed.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model !== "") {
      state.model = payload.model;
    }
    return;
  }

  if (parsed.type !== "event_msg") {
    return;
  }

  if (isSettings && payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings;
    if (isRecord(settings) && typeof settings.model === "string" && settings.model !== "") {
      state.model = settings.model;
    }
    return;
  }

  if (!isTokenCount || payload.type !== "token_count" || !isRecord(payload.info)) {
    return;
  }
  const last = payload.info.last_token_usage;
  if (!isRecord(last)) {
    return;
  }
  const tsMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
  const buckets = tokenBuckets(last);
  const event: CodexEvent = [
    Number.isFinite(tsMs) ? tsMs : null,
    state.provider,
    state.model,
    dedupKey(JSON.stringify(payload.info)),
    buckets.input,
    buckets.output,
    buckets.cacheRead,
  ];
  events.push(event);
}
