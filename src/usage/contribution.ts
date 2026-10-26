// The index stores contributions, never results: per file, exactly the facts a fresh fold needs to
// reproduce the cross-file dedup (Codex fork prefixes, Claude streaming repeats) and nothing a
// session's owner might delete for privacy: no text, no raw ids (every id is hashed), no paths
// inside the contribution itself. Nothing here pulls in SQLite, the scanner, or a reader.
//
// A parser change that alters the output for the same bytes (a new field, a fixed bug in what
// counts) bumps CONTRIBUTION_VERSION; a pure speedup never does.
import { createHash } from "node:crypto";
import { consola } from "consola";
import { caught } from "../utils/message.ts";

export type UsageSource = "codex" | "claude";

/** Every stored contribution with another version is parsed whole again. */
export const CONTRIBUTION_VERSION = 3;

/** 128 bits of SHA-256: equality is all the dedup needs, collisions stay out of any realistic
 *  corpus (about 4e-30 at 50k keys), and the truncation halves the index's key bytes. */
export function dedupKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ---------- Codex ----------

/** The state a tail re-read resumes from: exactly what parseCodexLine carries across lines. */
interface CodexParseState {
  /** dedupKey of `session_meta.payload.id` (or `.session_id`). */
  sessionIdHash?: string;

  /** `session_meta.payload.model_provider`, else the reader's default provider. */
  provider: string;

  /** The current raw model (turn_context / thread_settings_applied). */
  model: string;

  /** `session_meta` line timestamp, for the parent-missing fork fallback window. */
  metaTsMs?: number;

  /** From `knownAfter` on; a token_count before a late `session_meta` stays an ordinary turn. */
  fork?: CodexFork;
}

interface CodexFork {
  /** dedupKey of `session_meta.payload.forked_from_id`. */
  parentHash: string;

  /** The events index the fork rules start at: `events.length` when the session_meta was read. */
  knownAfter: number;
}

/** Provider and model are the ones current when the event was seen; a late metadata line changes
 *  them for later events only. A tuple, not an object: ~50k of these per 30 days sit in the index
 *  as JSON. */
export type CodexEvent = [
  tsMs: number | null,
  rawProvider: string,
  rawModel: string,
  infoHash: string,
  input: number,
  output: number,
  cacheRead: number,
];

/** `events` keep line order, duplicates and out-of-window events included: the fold, never the
 *  parser, applies the dedup and then the window, and an out-of-window event must still suppress
 *  its in-window copies. */
export interface CodexContribution {
  /** CONTRIBUTION_VERSION as stored; the index parses a row with another whole again. */
  v: typeof CONTRIBUTION_VERSION;

  /** What a tail parse resumes from; a whole parse starts it fresh. */
  state: CodexParseState;

  /** In line order; `infoHash` is exactly `dedupKey(JSON.stringify(payload.info))`. */
  events: CodexEvent[];
}

// ---------- Claude ----------

/** Line order, exact repeats included: the fold applies the `sinceMs` window BEFORE the running-max
 *  dedup, so an out-of-window higher snapshot must not suppress a later in-window lower one.
 *  `billedNanoAiu` is `message.copilot_usage.total_nano_aiu`, GitHub's own bill for the request in
 *  nano AI credits; 0 on the lines that carry none. */
export type ClaudeOccurrence = [
  idHash: string | null,
  tsMs: number | null,
  rawModel: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  billedNanoAiu: number,
];

export interface ClaudeContribution {
  v: typeof CONTRIBUTION_VERSION;
  occurrences: ClaudeOccurrence[];
}

type Contribution = CodexContribution | ClaudeContribution;

/** The contribution type each source produces, so a reconcile call cannot pair
 *  a source with the other source's parsers. */
export type ContributionOf<S extends UsageSource> = S extends "codex"
  ? CodexContribution
  : ClaudeContribution;

// ---------- scanning ----------

/** Byte offsets are absolute within the file. */
export interface ScanHit {
  /** Without its terminator; a CR before the LF is stripped too. */
  line: string;

  /** The line's first byte; `byteEnd - byteStart` spans the terminator too. */
  byteStart: number;

  /** The byte AFTER the LF; CRLF counts both terminator bytes. */
  byteEnd: number;
}

/** Both writers end every line they complete in LF, so only an append cut short mid-line leaves a
 *  fragment, and that fragment is never counted. */
export interface ScanResult {
  /** Every byte the source handed over: a resume's probe seed, the chunks, a fragment included. */
  bytesRead: number;

  /** Just past the LF of the last COMPLETE line; an unterminated fragment waits for a later run. */
  parsedThrough: number;

  /** Hex of the TAIL_PROBE_BYTES before `parsedThrough`: fewer when it is smaller, empty at 0. */
  tailProbeHex: string;
}

/** Matching tails make a same-length rewrite unlikely to pass as an append: a guard, not proof. */
export const TAIL_PROBE_BYTES = 32;

/** Complete lines only, for a whole parse and a tail parse alike, so the two never disagree about a
 *  file's last line. A `.jsonl.zst` rollout is decompressed whole and never resumable: its
 *  ParsedFile reports the compressed size as `parsedThrough` and an empty `tailProbeHex`, so reuse
 *  relies on size + mtime alone. */
export type ScanLines = (
  path: string,
  fromByte: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
) => ScanResult;

// ---------- walking and reconciling ----------

/**
 * Every walked path is reported, candidate or not, so the index can drop rows for files that no
 * longer exist. The reader hands candidates over in FOLD order: Codex ascending by basename (the
 * filename embeds the start time, so a fork's parent precedes the fork), Claude ascending by path.
 * A live rollout and its same-basename `.zst` are two copies of one session, never both candidates.
 */
export interface WalkedFile {
  /** The index keys its row by it; no contribution ever holds it. */
  path: string;

  /** Bytes at walk time; with `mtimeMs` the row's reuse identity. */
  size: number;

  /** At walk time; another value with the same size means a whole parse. */
  mtimeMs: number;

  /** In the window (slack; the fold cuts exactly) and, for Codex, the live-vs-`.zst` survivor. */
  candidate: boolean;

  /** False for `.jsonl.zst`, which cannot resume at an offset: any change re-parses it whole. */
  resumable: boolean;
}

export interface ParsedFile<C extends Contribution> {
  /** The FULL contribution as of `parsedThrough`: a tail parse returns prior + new, not a delta. */
  contribution: C;

  /** Where the next tail parse resumes; a `.zst` rollout reports its compressed size. */
  parsedThrough: number;

  /** Stored hashed by the index; empty for a `.zst` rollout, reused by size + mtime alone. */
  tailProbeHex: string;

  /** What this parse read, summed into `IndexStats.bytesRead`. */
  bytesRead: number;
}

/** Throws on an unreadable file (see Reconcile). */
export type ParseWhole<C extends Contribution> = (file: WalkedFile) => ParsedFile<C>;

/** The caller has matched the tail probe: a guard that the bytes before `fromByte` are still the
 *  ones `prior` was built from, never proof of the whole prefix. */
export type ParseTail<C extends Contribution> = (
  file: WalkedFile,
  fromByte: number,
  prior: C,
) => ParsedFile<C>;

/**
 * The oracle the tests and the perf guard read; a parse that throws contributes no bytes.
 *   filesSeen                                                   -> every walked path
 *   filesReused, filesParsedWhole, filesParsedTail, filesFailed -> a partition of the candidates
 *   filesDeleted                                                -> rows whose path was not walked
 *   bytesRead                                                   -> bytes read, probes included
 */
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

/** The path names the file for the caller; it is never stored inside the contribution. */
export interface FileRecord<C extends Contribution> {
  path: string;
  contribution: C;
}

export interface ReconcileResult<C extends Contribution> {
  /** Every candidate that exists and parsed, in `walked` order: the reader's fold order, kept. */
  records: FileRecord<C>[];

  /** This reconcile's own counters; a reader's meter sums them across sources. */
  stats: IndexStats;
}

/**
 * Per candidate:
 *   no row, or another contribution `v`                               -> parseWhole
 *   same size and mtimeMs                                             -> reuse the row
 *   grew, `resumable`, bytes before parsedThrough match tailProbeHex  -> parseTail
 *   anything else (shrank, other mtime, probe mismatch, not resumable) -> parseWhole
 * A parse that throws is one `filesFailed`: the reader warns `could not read <path> (<reason>)`,
 * the file contributes nothing, and its row is deleted. Rows whose path was not walked are deleted
 * before the fold.
 */
export type Reconcile = <S extends UsageSource>(
  source: S,
  walked: readonly WalkedFile[],
  parseWhole: ParseWhole<ContributionOf<S>>,
  parseTail: ParseTail<ContributionOf<S>>,
) => ReconcileResult<ContributionOf<S>>;

/** The no-index Reconcile. */
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
      consola.warn(caught(e, (message) => `could not read ${file.path} (${message}).`));
    }
  }
  return { records, stats };
};
