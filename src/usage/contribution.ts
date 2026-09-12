// The index stores contributions, never results: per file, exactly the facts a fresh fold needs to
// reproduce the cross-file dedup (Codex fork prefixes, Claude streaming repeats) and nothing a
// session's owner might delete for privacy: no text, no raw ids (every id is hashed), no paths
// inside the contribution itself. Nothing here pulls in SQLite, the scanner, or a reader.
import { createHash } from "node:crypto";
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";

export type UsageSource = "codex" | "claude";

/** Bump when a parser's output for the same bytes changes (a new field, a fixed bug in what
 *  counts): every stored contribution with another version is parsed whole again. Never bump for a
 *  pure speedup. */
export const CONTRIBUTION_VERSION = 2;

/** 128 bits of SHA-256: equality is all the dedup needs, collisions stay out of any realistic
 *  corpus (about 4e-30 at 50k keys), and the truncation halves the index's key bytes. */
export function dedupKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ---------- Codex ----------

/** The state a tail re-read resumes from: exactly what parseCodexLine carries across lines. */
export interface CodexParseState {
  /** dedupKey of `session_meta.payload.id` (or `.session_id`). */
  sessionIdHash?: string;
  /** `session_meta.payload.model_provider`, else the reader's default provider. */
  provider: string;
  /** The current raw model (turn_context / thread_settings_applied). */
  model: string;
  /** `session_meta` line timestamp, for the parent-missing fork fallback window. */
  metaTsMs?: number;
  /** The fork rules apply from `knownAfter` on: a token_count that precedes a late `session_meta`
   *  was seen as an ordinary turn and stays one. */
  fork?: CodexFork;
}

export interface CodexFork {
  /** dedupKey of `session_meta.payload.forked_from_id`. */
  parentHash: string;
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

export interface CodexContribution {
  v: typeof CONTRIBUTION_VERSION;
  state: CodexParseState;
  /** Line order, duplicates and out-of-window events included: the fold, never the parser, applies
   *  the dedup and then the window, and an out-of-window event must still suppress its in-window
   *  copies. `infoHash` is exactly `dedupKey(JSON.stringify(payload.info))`. */
  events: CodexEvent[];
}

// ---------- Claude ----------

/** Line order, exact repeats included: the fold applies the `sinceMs` window BEFORE the running-max
 *  dedup, so an out-of-window higher snapshot must not suppress a later in-window lower one. */
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

/** Byte offsets are absolute within the file. */
export interface ScanHit {
  /** Without its terminator; a CR before the LF is stripped too. */
  line: string;
  byteStart: number;
  /** The byte AFTER the LF; CRLF counts both terminator bytes. */
  byteEnd: number;
}

export interface ScanResult {
  bytesRead: number;
  /** Just past the LF of the last COMPLETE line: an unterminated final fragment is never delivered
   *  or counted, and the next run reads it once the writer terminates it. Every one of 13,798 real
   *  transcripts and rollouts measured ends in LF, so a permanently unterminated last line does not
   *  occur in practice. */
  parsedThrough: number;
  /** Hex of the last `TAIL_PROBE_BYTES` before `parsedThrough`; fewer when it is smaller, empty at
   *  0. */
  tailProbeHex: string;
}

/** Matching the tail makes a rewrite that happens to preserve the prefix's length very unlikely to
 *  pass as an append; a guard, not a proof of the whole prefix. */
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
 */
export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** Inside the window per the skip heuristic (filename date / mtime, with slack, so the fold makes
   *  the exact cut) AND, for Codex, the survivor of the same-basename live-vs-`.zst` dedup, so two
   *  copies of one session are never both candidates. */
  candidate: boolean;
  /** False for `.jsonl.zst`, which cannot be read from a byte offset: any change re-parses it
   *  whole. */
  resumable: boolean;
}

export interface ParsedFile<C extends Contribution> {
  /** The FULL contribution as of `parsedThrough`; a tail parse returns prior + new, never a delta.
   */
  contribution: C;
  parsedThrough: number;
  tailProbeHex: string;
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

/** The path is for ordering and the reader's own logging; it is never stored inside the
 *  contribution. */
export interface FileRecord<C extends Contribution> {
  path: string;
  contribution: C;
}

/** The fold order is the reader's guarantee, so a reader applies this to whatever a Reconcile hands
 *  back rather than trusting its ordering. */
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
  /** Every candidate that exists right now and parsed, in `walked` order. */
  records: FileRecord<C>[];
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

/** The no-index Reconcile; a failed parse is warned and skipped, reporting no bytes. */
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
