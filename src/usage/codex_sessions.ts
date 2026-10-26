// Rollouts live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl`; archived
// sessions move to a flat `archived_sessions/`, optionally zstd-compressed. This is the only usage
// source for Direct-wired Codex, which never reaches the proxy's SQLite tables.
//
// A fork copies the parent's items, token_count events included, in one batch at session start,
// while its own first turn needs a model round-trip: with the parent file unavailable for an exact
// dedup, a token_count inside FORK_PREFIX_WINDOW_MS of the session_meta timestamp is read as
// copied.

import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { consola } from "consola";
import { knownCodexHomes } from "../codex/host.ts";
import { isDir } from "../utils/fs.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { caught } from "../utils/message.ts";
import { type DayKey, dayKeyIn, MILLISECONDS_PER_DAY } from "../utils/time.ts";
import {
  CONTRIBUTION_VERSION,
  type CodexContribution,
  type CodexEvent,
  dedupKey,
  type FileRecord,
  type ParsedFile,
  type ParseTail,
  type ParseWhole,
  type Reconcile,
  type WalkedFile,
} from "./contribution.ts";
import { canonicalModelNames, LONG_CONTEXT_PROMPT_TOKENS } from "./pricing.ts";
import { scanBytes, scanLines } from "./scan.ts";
import {
  inWindow,
  type OnCounted,
  record,
  sanitizeTokenCount,
  type TokenBuckets,
  type UsageReport,
  usageReport,
} from "./usage.ts";

/** Live rollouts sit in the dated tree under the first; archived ones lie flat under the second. */
const SESSION_SUBDIRS = ["sessions", "archived_sessions"];

/** Date groups are the LOCAL start date; a `.zst` tail marks an archived, compressed rollout. */
export const ROLLOUT_FILE = /^rollout-(\d{4})-(\d{2})-(\d{2})T.*\.jsonl(\.zst)?$/;

/** The dated tree's depth: sessions/YYYY/MM/DD/<file>. */
const MAX_WALK_DEPTH = 4;

/** The scan's byte filter: the four line types the parser reads, so no other line is decoded. */
const CODEX_NEEDLES: readonly string[] = [
  '"session_meta"',
  '"turn_context"',
  '"token_count"',
  '"thread_settings_applied"',
];

/** A meta line without `model_provider` means Codex's built-in provider. */
const DEFAULT_PROVIDER = "default";

/** The raw model until a turn_context or thread_settings_applied line names one. */
const UNKNOWN_MODEL = "unknown";

/** Parent unavailable: a token_count up to this after the session_meta stamp is a copied prefix. */
const FORK_PREFIX_WINDOW_MS = 2_000;

/** LOCAL filename dates vs a UTC cutoff: the file skip keeps slack, the per-event cut is exact. */
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
 *  pinning the process `TZ`, which the suite does on unix only (TZ_PINNABLE in
 *  test/helpers/testing.ts). `onCounted` sees every event the fold records. */
export async function readCodexSessions(
  roots: string[],
  sinceMs: number | undefined,
  timeZone: string | undefined,
  reconcile: Reconcile,
  onCounted?: OnCounted,
): Promise<Map<string, UsageReport>> {
  // Before any file read: an unknown zone must fail here, not inside the per-file parse catch.
  const dayKey = dayKeyIn(timeZone);
  const walked = walkCodexSessions(roots, sinceMs);
  const { records } = reconcile("codex", walked, parseCodexWhole, parseCodexTail);
  return foldCodex(records, sinceMs, dayKey, onCounted);
}

/** Ascending by basename, which embeds the start timestamp, so a fork's parent precedes the fork.
 *  Of a same-session `.jsonl` / `.jsonl.zst` pair the resumable plain file wins, but only among
 *  the files the cutoff left as candidates: a plain file dropped for an old mtime leaves the
 *  compressed twin. discoverCodexSessionRoots hands over realpath-distinct session directories, and
 *  none nests in another, so no file is collected twice. */
export function walkCodexSessions(roots: string[], sinceMs: number | undefined): WalkedFile[] {
  const files: WalkedFile[] = [];
  for (const root of roots) {
    collectRolloutFiles(root, 1, sinceMs, files);
  }
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

/** Nothing prior; a `.zst` rollout is decompressed whole and reports the compressed size. */
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

/** What one fold carries across its files; `infoHashesBySession` holds every info hash seen per
 *  session, counted or not, so a later fork can drop the events it copied. */
interface CodexFold {
  providers: Map<string, UsageReport>;
  canonical: (model: string) => string;
  infoHashesBySession: Map<string, Set<string>>;
  dayKey: DayKey;
  sinceMs: number | undefined;
  onCounted: OnCounted | undefined;
}

/** A token_count the fork copied from its parent: one the parent's file carried, or, with the
 *  parent unscanned, one inside FORK_PREFIX_WINDOW_MS of the session_meta. */
function copiedFromParent(
  parentHashes: Set<string> | undefined,
  metaTsMs: number | undefined,
  infoHash: string,
  tsMs: number | null,
): boolean {
  if (parentHashes !== undefined) return parentHashes.has(infoHash);
  if (metaTsMs === undefined || tsMs === null) return false;
  return tsMs - metaTsMs <= FORK_PREFIX_WINDOW_MS;
}

function providerReport(providers: Map<string, UsageReport>, provider: string): UsageReport {
  let report = providers.get(provider);
  if (report === undefined) {
    report = usageReport();
    providers.set(provider, report);
  }
  return report;
}

/** Per event: the fork dedup (an info hash seen in this file or in the parent is a copied
 *  token_count; parent unscanned, the FORK_PREFIX_WINDOW_MS heuristic), THEN the window. Every hash
 *  enters the file's own set, counted or not. */
function foldCodexFile(fold: CodexFold, { state, events }: CodexContribution): void {
  const { fork, metaTsMs } = state;
  const parentHashes =
    fork === undefined ? undefined : fold.infoHashesBySession.get(fork.parentHash);
  const ownHashes = new Set<string>();
  for (const [index, event] of events.entries()) {
    const [tsMs, rawProvider, rawModel, infoHash, input, output, cacheRead] = event;
    const forked = fork !== undefined && index >= fork.knownAfter;
    const duplicate =
      ownHashes.has(infoHash) ||
      (forked && copiedFromParent(parentHashes, metaTsMs, infoHash, tsMs));
    ownHashes.add(infoHash);
    if (duplicate) {
      continue;
    }
    if (!inWindow(tsMs, fold.sinceMs)) {
      continue;
    }
    const report = providerReport(fold.providers, rawProvider);
    // The day is the user's local one, not the UTC day the timestamp spells; a line with no
    // parseable timestamp still counts toward the totals. The prompt Codex reported is the input
    // INCLUDING the cached part (tokenBuckets split them), which is the size the tier is cut on.
    const model = fold.canonical(rawModel);
    const buckets = { input, output, cacheRead, cacheCreation: 0 };
    record(
      report,
      tsMs === null ? null : fold.dayKey(tsMs),
      model,
      { ...buckets, events: 1 },
      {
        longContext: input + cacheRead > LONG_CONTEXT_PROMPT_TOKENS,
      },
    );
    fold.onCounted?.({ id: null, tsMs, model, buckets });
  }
  if (state.sessionIdHash !== undefined && ownHashes.size > 0) {
    fold.infoHashesBySession.set(state.sessionIdHash, ownHashes);
  }
}

export function foldCodex(
  records: readonly FileRecord<CodexContribution>[],
  sinceMs: number | undefined,
  dayKey: DayKey,
  onCounted?: OnCounted,
): Map<string, UsageReport> {
  const fold: CodexFold = {
    providers: new Map(),
    canonical: canonicalModelNames(),
    infoHashesBySession: new Map(),
    dayKey,
    sinceMs,
    onCounted,
  };
  for (const { contribution } of records) {
    foldCodexFile(fold, contribution);
  }
  return fold.providers;
}

// ---------- internals ----------

/** A resumed session appends to its ORIGINAL rollout, so an old start date alone cannot exclude a
 *  file; only an old start date AND no writes since the cutoff can. */
function rolloutIsCandidate(
  match: RegExpExecArray,
  mtimeMs: number,
  sinceMs: number | undefined,
): boolean {
  if (sinceMs === undefined) return true;
  const startedMs = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(startedMs) || startedMs + FILENAME_CUTOFF_SLACK_MS >= sinceMs) return true;
  return !(mtimeMs < sinceMs);
}

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
    consola.warn(caught(e, (message) => `could not list ${dir} (${message}).`));
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
      consola.warn(caught(e, (message) => `could not read ${full} (${message}).`));
      continue;
    }
    const candidate = rolloutIsCandidate(m, mtimeMs, sinceMs);
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

/** A blank or missing model leaves the one in force. */
function noteModel(state: CodexContribution["state"], model: unknown): void {
  if (typeof model === "string" && model !== "") state.model = model;
}

/** The session's id, provider, fork parent, and start instant, from its session_meta. */
function noteSessionMeta(
  parsed: Record<string, unknown>,
  payload: Record<string, unknown>,
  contribution: CodexContribution,
): void {
  const { state, events } = contribution;
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
}

function pushTokenCount(
  parsed: Record<string, unknown>,
  payload: Record<string, unknown>,
  contribution: CodexContribution,
): void {
  if (!isRecord(payload.info)) {
    return;
  }
  const last = payload.info.last_token_usage;
  if (!isRecord(last)) {
    return;
  }
  const { state, events } = contribution;
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

/** A needle may sit inside another line's content, so the type checks stay. */
function parseCodexLine(line: string, contribution: CodexContribution): void {
  const { state } = contribution;
  const isMeta = line.includes('"session_meta"');
  const isTurnContext = line.includes('"turn_context"');
  const isTokenCount = line.includes('"token_count"');
  const isSettings = line.includes('"thread_settings_applied"');
  const parsed = parseJsonRecord(line); // null for a torn or corrupt line
  if (parsed === null || !isRecord(parsed.payload)) {
    return;
  }
  const payload = parsed.payload;

  if (isMeta && parsed.type === "session_meta") {
    // A resume re-emits the session_meta; the first one speaks for the session.
    if (state.sessionIdHash === undefined) noteSessionMeta(parsed, payload, contribution);
    return;
  }

  if (isTurnContext && parsed.type === "turn_context") {
    noteModel(state, payload.model);
    return;
  }

  if (parsed.type !== "event_msg") {
    return;
  }

  if (isSettings && payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings;
    if (isRecord(settings)) noteModel(state, settings.model);
    return;
  }

  if (isTokenCount && payload.type === "token_count") {
    pushTokenCount(parsed, payload, contribution);
  }
}
