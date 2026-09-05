// The shared contracts of the usage index: what one session file CONTRIBUTES
// to a cost report, and the shapes the scanner, the readers, and the index
// exchange. Everything here is types plus a few small helpers (the hash, the
// walk-order re-sequencing, the no-index reconcile), so every module (and
// every test) imports the same names and nothing here pulls in SQLite, the
// scanner, or a reader.
//
// Why contributions and not results: the index must never cache a report. It
// stores, per file, exactly the facts a fresh fold needs to reproduce today's
// cross-file dedup (Codex fork prefixes, Claude streaming repeats) and NOTHING a
// session's owner might delete for privacy: no text, no raw ids (every id is
// hashed), no paths inside the contribution itself. The report is folded fresh
// on every run from the contributions of the files that exist right now.
import { createHash } from "node:crypto";
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";

/** The two session-log sources the index tracks. */
export type UsageSource = "codex" | "claude";

/** Bump when a parser's OUTPUT for the same bytes changes (a new field, a fixed
 *  bug in what counts): a stored contribution with another version is parsed
 *  whole again. Never bump for a pure speedup. */
export const CONTRIBUTION_VERSION = 1;

/** A dedup key: 32 hex chars (128 bits) of SHA-256. Equality is all the dedup
 *  needs, 128 bits keeps accidental collisions out of any realistic corpus
 *  (about 4e-30 at 50k keys), and the truncation halves the index's key bytes.
 *  Used for Codex `info` objects and session ids and for Claude message ids, so
 *  none of them is stored in the clear. */
export function dedupKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ---------- Codex ----------

/**
 * Per-file parser state a tail re-read resumes from: exactly what
 * `parseRolloutFile` carried across lines. The `session_meta` line is honoured
 * while `sessionIdHash` is still undefined (a meta line without an id does not
 * close the gate), which is today's rule verbatim.
 */
export interface CodexParseState {
  /** dedupKey of `session_meta.payload.id` (or `.session_id`). */
  sessionIdHash?: string;
  /** `session_meta.payload.model_provider`, else the reader's default provider. */
  provider: string;
  /** The current raw model (turn_context / thread_settings_applied). */
  model: string;
  /** `session_meta` line timestamp, for the parent-missing fork fallback window. */
  metaTsMs?: number;
  /** dedupKey of `session_meta.payload.forked_from_id`, when the session is a fork. */
  forkedFromIdHash?: string;
}

/**
 * One `token_count` event as the fold consumes it, with the provider and model
 * that were current WHEN IT WAS SEEN (both are mutable per file and a late
 * metadata line changes them for later events only, as today). Tuple, not
 * object: ~50k of these per 30 days sit in the index as JSON.
 */
export type CodexEvent = [
  tsMs: number | null,
  rawProvider: string,
  rawModel: string,
  infoHash: string,
  input: number,
  output: number,
  cacheRead: number,
];

export interface CodexContribution {
  v: typeof CONTRIBUTION_VERSION;
  state: CodexParseState;
  /** Every token_count event with a usable `info.last_token_usage`, in line
   *  order, duplicates and out-of-window events included: the fold applies the
   *  dedup and then the window, never the parser. Order matters twice over:
   *  today every event's `infoHash` enters the file's own dedup set (and, via
   *  the session, its forks' parent set) BEFORE the `sinceMs` check, so an
   *  out-of-window event still suppresses its in-window copies. `infoHash` is
   *  exactly `dedupKey(JSON.stringify(payload.info))`. */
  events: CodexEvent[];
}

// ---------- Claude ----------

/**
 * One assistant usage line, in line order, exact repeats included. Nothing is
 * pruned at parse time: the fold applies the `sinceMs` window BEFORE the
 * running-max dedup (today's order), so an out-of-window higher snapshot must
 * not be allowed to suppress a later in-window lower one, which only the full
 * sequence can reproduce.
 */
export type ClaudeOccurrence = [
  idHash: string | null,
  tsMs: number | null,
  rawModel: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
];

export interface ClaudeContribution {
  v: typeof CONTRIBUTION_VERSION;
  occurrences: ClaudeOccurrence[];
}

export type Contribution = CodexContribution | ClaudeContribution;

/** The contribution type each source produces, so a reconcile call cannot pair
 *  a source with the other source's parsers. */
export type ContributionOf<S extends UsageSource> = S extends "codex" ? CodexContribution
  : ClaudeContribution;

// ---------- scanning ----------

/** One LF-terminated line the scanner cut out because it contained a needle.
 *  Byte offsets are absolute within the file. */
export interface ScanHit {
  /** The line text without its terminator (CR before LF is stripped too). */
  line: string;
  byteStart: number;
  /** Offset of the byte AFTER the LF (CRLF counts both terminator bytes). */
  byteEnd: number;
}

export interface ScanResult {
  /** Bytes actually read from disk in this call. */
  bytesRead: number;
  /** Offset just past the LF of the last COMPLETE line. An unterminated final
   *  fragment is never delivered and never counted: `parsedThrough` stays at
   *  its byte start, and the next run reads it once the writer terminates it.
   *  (Every one of 13,798 real transcripts and rollouts measured ends in LF, so
   *  a permanently unterminated last line does not occur in practice.) */
  parsedThrough: number;
  /** Hex of the last `TAIL_PROBE_BYTES` bytes before `parsedThrough` (fewer when
   *  `parsedThrough` is smaller; empty when it is 0). */
  tailProbeHex: string;
}

/** How many trailing bytes the index remembers. Matching them makes a rewrite
 *  that happens to preserve the prefix's length very unlikely to pass as an
 *  append; it is a guard, not a proof of the whole prefix. */
export const TAIL_PROBE_BYTES = 32;

/**
 * Read `path` from `fromByte`, in large chunks, and call `onLine` for every
 * complete line containing at least one of `needles`. Lines without a needle
 * are never decoded into their own string. Replaces node:readline in both
 * readers; the SAME rule (complete lines only) applies to a whole parse and to
 * a tail parse, so the two never disagree about a file's last line.
 *
 * Uncompressed files only. A `.jsonl.zst` rollout is decompressed whole and
 * its text split on LF with the same complete-lines rule; it is never
 * resumable (`WalkedFile.resumable` is false), so its ParsedFile reports
 * `parsedThrough` = the compressed file's size and an empty `tailProbeHex`,
 * and reuse relies on size + mtime alone.
 */
export type ScanLines = (
  path: string,
  fromByte: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
) => ScanResult;

// ---------- walking and reconciling ----------

/**
 * One file the directory walk saw. `candidate` is the reader's FINAL selection
 * verdict: inside the window per the existing skip heuristic (filename date /
 * mtime) AND, for Codex, the survivor of the same-basename live-vs-`.zst`
 * dedup (the plain `.jsonl` preferred), so two copies of one session are never
 * both candidates. Only candidates are parsed or folded, but EVERY walked path
 * is reported so the index can drop rows for files that no longer exist. The
 * reader hands candidates over in FOLD order: Codex ascending by basename (the
 * filename embeds the start time, so a fork's parent precedes the fork),
 * Claude ascending by path. `resumable` is false for files that cannot be read
 * from a byte offset (`.jsonl.zst`): any change re-parses them whole.
 */
export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
  candidate: boolean;
  resumable: boolean;
}

/** What one parse (whole or tail) hands the index to store. */
export interface ParsedFile<C extends Contribution> {
  /** The FULL contribution for the file as of `parsedThrough` (a tail parse
   *  returns prior + new, never a delta). */
  contribution: C;
  parsedThrough: number;
  tailProbeHex: string;
  bytesRead: number;
}

/** Parse a file from byte 0. Throws on an unreadable file (see Reconcile). */
export type ParseWhole<C extends Contribution> = (file: WalkedFile) => ParsedFile<C>;

/** Resume from `prior` at `fromByte`. The caller has already verified the tail
 *  probe, so the bytes before `fromByte` are the ones `prior` was built from. */
export type ParseTail<C extends Contribution> = (
  file: WalkedFile,
  fromByte: number,
  prior: C,
) => ParsedFile<C>;

/** The oracle the tests and the perf guard read: what the index did this run.
 *  Counting rules: `filesSeen` = every walked path; `filesReused`,
 *  `filesParsedWhole`, `filesParsedTail`, `filesFailed` partition the
 *  CANDIDATES; `filesDeleted` = rows removed because their path was not walked;
 *  `bytesRead` = every byte read from session files this run, tail-probe reads
 *  included. */
export interface IndexStats {
  filesSeen: number;
  filesReused: number;
  filesParsedWhole: number;
  filesParsedTail: number;
  filesFailed: number;
  filesDeleted: number;
  bytesRead: number;
}

export function emptyIndexStats(): IndexStats {
  return {
    filesSeen: 0,
    filesReused: 0,
    filesParsedWhole: 0,
    filesParsedTail: 0,
    filesFailed: 0,
    filesDeleted: 0,
    bytesRead: 0,
  };
}

/** A contribution the fold consumes, with the path it came from (for ordering
 *  and for the reader's own logging; never stored inside the contribution). */
export interface FileRecord<C extends Contribution> {
  path: string;
  contribution: C;
}

/** `records` re-sequenced into `walked` order (records for unwalked paths are
 *  dropped). The fold order is the reader's guarantee, so a reader applies this
 *  to whatever a Reconcile hands back rather than trusting its ordering. */
export function inWalkOrder<C extends Contribution>(
  walked: readonly WalkedFile[],
  records: readonly FileRecord<C>[],
): FileRecord<C>[] {
  const byPath = new Map(records.map((r) => [r.path, r]));
  const ordered: FileRecord<C>[] = [];
  for (const file of walked) {
    const found = byPath.get(file.path);
    if (found !== undefined) {
      ordered.push(found);
    }
  }
  return ordered;
}

export interface ReconcileResult<C extends Contribution> {
  /** Records for every CANDIDATE file that exists right now and parsed, in
   *  `walked` order. */
  records: FileRecord<C>[];
  stats: IndexStats;
}

/**
 * Bring the index in line with what the walk saw and return the candidates'
 * contributions. Per candidate, in this order:
 *
 *  1. no row, or a row whose contribution `v` is not CONTRIBUTION_VERSION
 *     -> parseWhole
 *  2. same size AND same mtimeMs -> reuse the row
 *  3. size grew AND `resumable` AND the bytes before the row's parsedThrough
 *     equal its tailProbeHex -> parseTail from parsedThrough
 *  4. anything else (shrank, same size with another mtime, probe mismatch,
 *     not resumable) -> parseWhole
 *
 * A parse that throws is one `filesFailed`: the reader's existing warning is
 * emitted (`could not read <path> (<reason>)`), the file contributes nothing
 * this run, and its row (if any) is deleted. Rows whose path was not walked are
 * deleted before the fold. Without an index, every candidate is parseWhole and
 * nothing is stored (stats still count).
 */
export type Reconcile = <S extends UsageSource>(
  source: S,
  walked: readonly WalkedFile[],
  parseWhole: ParseWhole<ContributionOf<S>>,
  parseTail: ParseTail<ContributionOf<S>>,
) => ReconcileResult<ContributionOf<S>>;

/** The no-index Reconcile: every candidate parsed whole, nothing stored; a failed
 *  parse is warned about and skipped (a throw reports no bytes). */
export const parseEveryCandidate: Reconcile = (_source, walked, parseWhole) => {
  const stats = emptyIndexStats();
  stats.filesSeen = walked.length;
  const records: FileRecord<ContributionOf<typeof _source>>[] = [];
  for (const file of walked) {
    if (!file.candidate) {
      continue;
    }
    try {
      const parsed = parseWhole(file);
      stats.filesParsedWhole++;
      stats.bytesRead += parsed.bytesRead;
      records.push({ path: file.path, contribution: parsed.contribution });
    } catch (e) {
      stats.filesFailed++;
      consola.warn(`could not read ${file.path} (${errMessage(e)}).`);
    }
  }
  return { records, stats };
};
