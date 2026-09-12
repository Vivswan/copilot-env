// Rollouts live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl`; archived
// sessions move to a flat `archived_sessions/`, optionally zstd-compressed. This is the only usage
// source for Direct-wired Codex, which never reaches the proxy's SQLite tables.

import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { consola } from "consola";
import { knownCodexHomes } from "../codex/host.ts";
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

const CODEX_NEEDLES: readonly string[] = [
  '"session_meta"',
  '"turn_context"',
  '"token_count"',
  '"thread_settings_applied"',
];

/** A meta line without `model_provider` means Codex's built-in provider. */
const DEFAULT_PROVIDER = "default";
const UNKNOWN_MODEL = "unknown";

/** A fork copies the parent's items, token_count events included, in one batch at session start,
 *  while its own first turn needs a model round-trip. With the parent file unavailable for exact
 *  dedup, a token_count within this window of the session_meta timestamp is read as copied. */
const FORK_PREFIX_WINDOW_MS = 2_000;

/** The date tree and filenames use LOCAL dates while the cutoff and line timestamps are UTC, so
 *  file-level skipping keeps a day and a half of slack and the per-event cutoff does the exact cut.
 */
const FILENAME_CUTOFF_SLACK_MS = 1.5 * MILLISECONDS_PER_DAY;

/** Farm homes symlink these directories back into the shared ~/.codex, hence the realpath dedup. */
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

/** One report per `model_provider`. `timeZone` exists so the per-day slicing is assertable without
 *  pinning the process `TZ`, which deno honors on unix only. */
export async function readCodexSessions(
  roots: string[],
  sinceMs?: number,
  timeZone?: string,
  reconcile?: Reconcile,
): Promise<Map<string, UsageReport>> {
  // Before any file read: an unknown zone must fail here, not inside the per-file parse catch.
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

/** Ascending by basename, which embeds the start timestamp, so a fork's parent precedes the fork.
 *  Of a same-session `.jsonl` / `.jsonl.zst` pair the resumable plain file wins, but only among
 *  the files the cutoff left as candidates: a plain file dropped for an old mtime leaves the
 *  compressed twin. */
export function walkCodexSessions(roots: string[], sinceMs: number | undefined): WalkedFile[] {
  const collected: WalkedFile[] = [];
  for (const root of roots) {
    collectRolloutFiles(root, 1, sinceMs, collected);
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

/** Copies of `prior`'s state and events: the index still holds `prior`. */
export const parseCodexTail: ParseTail<CodexContribution> = (file, fromByte, prior) => {
  return parseCodexFrom(file, fromByte, {
    v: prior.v,
    state: { ...prior.state },
    events: [...prior.events],
  });
};

/** Per event: the fork dedup (an info hash seen in this file or in the parent is a copied
 *  token_count; parent unscanned, the FORK_PREFIX_WINDOW_MS heuristic), THEN the window. Every hash
 *  enters the file's own set, counted or not. */
export function foldCodex(
  records: readonly FileRecord<CodexContribution>[],
  sinceMs: number | undefined,
  dayKey: DayKey,
): Map<string, UsageReport> {
  const providers = new Map<string, UsageReport>();
  const canonical = canonicalModelNames();
  // Every info hash seen per session, counted or not, so a later fork can drop the events it
  // copied.
  const infoHashesBySession = new Map<string, Set<string>>();
  for (const { contribution: { state, events } } of records) {
    const { fork, metaTsMs } = state;
    const parentHashes = fork === undefined ? undefined : infoHashesBySession.get(fork.parentHash);
    const ownHashes = new Set<string>();
    for (let index = 0; index < events.length; index++) {
      const [tsMs, rawProvider, rawModel, infoHash, input, output, cacheRead] = events[index]!;
      const forked = fork !== undefined && index >= fork.knownAfter;
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
      // The day is the user's local one, not the UTC day the timestamp spells; a line with no
      // parseable timestamp still counts toward the totals.
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
      // A resumed session appends to its ORIGINAL rollout, so an old start date alone cannot
      // exclude a file; only an old start date AND no writes since the cutoff can.
      const startedMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      if (Number.isFinite(startedMs) && startedMs + FILENAME_CUTOFF_SLACK_MS < sinceMs) {
        candidate = !(mtimeMs < sinceMs);
      }
    }
    out.push({ path: full, size, mtimeMs, candidate, resumable: m[4] === undefined });
  }
}

/** Only the archive path strips a BOM; the file scanner (scan.ts) is byte-faithful on purpose. */
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

function tokenBuckets(last: Record<string, unknown>): TokenBuckets {
  // Hostile or torn counts never enter a report.
  const num = sanitizeTokenCount;
  const cached = num(last.cached_input_tokens);
  return {
    // Codex reports input INCLUSIVE of the cached tokens; the pricing buckets charge cached reads
    // separately.
    input: Math.max(0, num(last.input_tokens) - cached),
    cacheRead: cached,
    // output_tokens already includes the reasoning tokens (a details field).
    output: num(last.output_tokens),
    cacheCreation: 0, // no cache-write bucket in the Responses usage payload
  };
}

/** A needle may sit inside another line's content, so the type checks stay. */
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
      state.fork = { parentHash: dedupKey(payload.forked_from_id), knownAfter: events.length };
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
