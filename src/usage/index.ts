// A pre-index, never a cache of results: rows hold a file's identity, resume point, and
// contribution (contribution.ts), and the report is folded fresh from them every run. An index that
// fails to open or read degrades to whole parses, never to a missing or "unreadable" session.
//
// No session text and no raw ids on disk: contributions pass a schema admitting only numbers, model
// names, and dedup keys, the tail probe is stored hashed, and secure_delete plus a truncating
// checkpoint keep deleted rows out of free pages and old WAL frames. The open and each run's one
// write transaction take the advisory lock; without it a run keeps its results and saves nothing.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { BOUNDED_LOCK_POLICY, type LockPolicy, withFileLockSync } from "../utils/file_lock.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { chmodReported, mkdirReported, removeReported } from "../utils/report_write.ts";
import {
  type ClaudeContribution,
  type CodexContribution,
  type Contribution,
  CONTRIBUTION_VERSION,
  type ContributionOf,
  dedupKey,
  emptyIndexStats,
  type FileRecord,
  type IndexStats,
  type ParsedFile,
  type ParseTail,
  type ParseWhole,
  type Reconcile,
  type ReconcileResult,
  TAIL_PROBE_BYTES,
  type UsageSource,
  type WalkedFile,
} from "./contribution.ts";
import { usageIndexDir } from "./paths.ts";

// `cost --json` owns stdout and its consumers parse the whole of it.
const logger = createStderrLogger();

export const USAGE_INDEX_DB_NAME = "index.sqlite";
export const USAGE_INDEX_LOCK_NAME = "index.lock";

/** Bump when the TABLE layout changes: a database stamped with another version is deleted and
 *  rebuilt. Contribution-shape changes are `CONTRIBUTION_VERSION`'s business and re-parse per row
 *  instead. */
export const USAGE_INDEX_SCHEMA_VERSION = 2;

/** The contribution version, so a bump of it alone rebuilds the whole index at once instead of row
 *  by row. */
export const DEFAULT_PARSER_FINGERPRINT = `contribution-v${CONTRIBUTION_VERSION}`;

/** The advisory lock serializes our own writers, so this only covers a writer from a release that
 *  does not take it. */
const BUSY_TIMEOUT_MS = 2_000;

const DB_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

const META_SCHEMA_VERSION = "schema_version";
const META_PARSER_FINGERPRINT = "parser_fingerprint";

// The quoted snake_case names are the on-disk contract. `tail_probe` holds dedupKey(tailProbeHex),
// never the probe bytes: the last bytes of a session line are session text, and the equality check
// needs only a hash.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "meta" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "files" (
  "path" TEXT PRIMARY KEY,
  "source" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mtime_ms" REAL NOT NULL,
  "parsed_through" INTEGER NOT NULL,
  "tail_probe" TEXT NOT NULL,
  "record" TEXT NOT NULL
);
`;

export interface OpenUsageIndexOptions {
  dir?: string;
  /** A database stamped differently is rebuilt. */
  fingerprint?: string;
  lockPolicy?: LockPolicy;
}

// ---------- the stored contribution, parsed at BOTH boundaries ----------

// Reading is STRICT (any undeclared field means "no row", so the file is re-parsed and the row
// rewritten clean); writing is a PROJECTION (undeclared parser fields are stripped).
/** Infinity would serialize as null and turn a stored row into a re-parse. */
const FINITE_SCHEMA = v.pipe(v.number(), v.finite());
const TS_SCHEMA = v.nullable(FINITE_SCHEMA);
const COUNT_SCHEMA = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** A parser regression that leaks a raw id fails this and the row is not stored. */
const HASH_SCHEMA = v.pipe(v.string(), v.regex(new RegExp(`^[0-9a-f]{${dedupKey("").length}}$`)));
const CODEX_EVENT_ITEMS = [
  TS_SCHEMA,
  v.string(),
  v.string(),
  HASH_SCHEMA,
  FINITE_SCHEMA,
  FINITE_SCHEMA,
  FINITE_SCHEMA,
] as const;
const CODEX_FORK_ENTRIES = { parentHash: HASH_SCHEMA, knownAfter: COUNT_SCHEMA } as const;
const CODEX_STATE_ENTRIES = {
  sessionIdHash: v.optional(HASH_SCHEMA),
  provider: v.string(),
  model: v.string(),
  metaTsMs: v.optional(FINITE_SCHEMA),
  fork: v.optional(v.object(CODEX_FORK_ENTRIES)),
} as const;
const CLAUDE_OCCURRENCE_ITEMS = [
  v.nullable(HASH_SCHEMA),
  TS_SCHEMA,
  v.string(),
  FINITE_SCHEMA,
  FINITE_SCHEMA,
  FINITE_SCHEMA,
  FINITE_SCHEMA,
] as const;

const STORABLE_CODEX_SCHEMA = v.object({
  v: v.literal(CONTRIBUTION_VERSION),
  state: v.object(CODEX_STATE_ENTRIES),
  events: v.array(v.tuple(CODEX_EVENT_ITEMS)),
});
const STORABLE_CLAUDE_SCHEMA = v.object({
  v: v.literal(CONTRIBUTION_VERSION),
  occurrences: v.array(v.tuple(CLAUDE_OCCURRENCE_ITEMS)),
});

// The READ side is hand-written because a schema-library parse of half a million stored tuples
// dominated the warm run. It admits exactly what the STORABLE_* schemas write;
// test/usage_index.test.ts holds the two together.

const HASH_LENGTH = dedupKey("").length;
const HASH_RE = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`);

function isHash(value: unknown): value is string {
  return typeof value === "string" && value.length === HASH_LENGTH && HASH_RE.test(value);
}

function isFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOnlyDeclaredKeys(
  value: unknown,
  declared: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) return false;
  }
  return true;
}

const CODEX_KEYS: ReadonlySet<string> = new Set(["v", "state", "events"]);
const CODEX_STATE_KEYS: ReadonlySet<string> = new Set(Object.keys(CODEX_STATE_ENTRIES));
const CODEX_FORK_KEYS: ReadonlySet<string> = new Set(Object.keys(CODEX_FORK_ENTRIES));
const CLAUDE_KEYS: ReadonlySet<string> = new Set(["v", "occurrences"]);
const TUPLE_LENGTH = 7;

function readStoredCodex(doc: unknown): CodexContribution | null {
  if (!hasOnlyDeclaredKeys(doc, CODEX_KEYS) || doc.v !== CONTRIBUTION_VERSION) return null;
  const state = doc.state;
  if (!hasOnlyDeclaredKeys(state, CODEX_STATE_KEYS)) return null;
  if (typeof state.provider !== "string" || typeof state.model !== "string") return null;
  if (state.sessionIdHash !== undefined && !isHash(state.sessionIdHash)) return null;
  if (state.metaTsMs !== undefined && !isFinite(state.metaTsMs)) return null;
  if (state.fork !== undefined) {
    const fork = state.fork;
    if (!hasOnlyDeclaredKeys(fork, CODEX_FORK_KEYS)) return null;
    if (!isHash(fork.parentHash) || !isCount(fork.knownAfter)) return null;
  }
  const events = doc.events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (!Array.isArray(event) || event.length !== TUPLE_LENGTH) return null;
    if (
      !(event[0] === null || isFinite(event[0])) || typeof event[1] !== "string" ||
      typeof event[2] !== "string" || !isHash(event[3]) || !isFinite(event[4]) ||
      !isFinite(event[5]) || !isFinite(event[6])
    ) {
      return null;
    }
  }
  // Every field was checked above; the assertion only names what the checks proved.
  return doc as unknown as CodexContribution;
}

function readStoredClaude(doc: unknown): ClaudeContribution | null {
  if (!hasOnlyDeclaredKeys(doc, CLAUDE_KEYS) || doc.v !== CONTRIBUTION_VERSION) return null;
  const occurrences = doc.occurrences;
  if (!Array.isArray(occurrences)) return null;
  for (const occurrence of occurrences) {
    if (!Array.isArray(occurrence) || occurrence.length !== TUPLE_LENGTH) return null;
    if (
      !(occurrence[0] === null || isHash(occurrence[0])) ||
      !(occurrence[1] === null || isFinite(occurrence[1])) ||
      typeof occurrence[2] !== "string" || !isFinite(occurrence[3]) ||
      !isFinite(occurrence[4]) || !isFinite(occurrence[5]) || !isFinite(occurrence[6])
    ) {
      return null;
    }
  }
  return doc as unknown as ClaudeContribution;
}

function parseStoredContribution(source: UsageSource, text: string): Contribution | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  return source === "codex" ? readStoredCodex(doc) : readStoredClaude(doc);
}

/** A parser that hands over extra properties cannot smuggle them onto disk; one that leaks a raw id
 *  or a non-finite count stores nothing. */
function storableContribution(source: UsageSource, contribution: Contribution): string | null {
  const parsed = source === "codex"
    ? v.safeParse(STORABLE_CODEX_SCHEMA, contribution)
    : v.safeParse(STORABLE_CLAUDE_SCHEMA, contribution);
  return parsed.success ? JSON.stringify(parsed.output) : null;
}

// ---------- the row, parsed at the boundary ----------

/** A row that fails the shape checks reads as "no row" (a whole parse), never as a bad session. */
interface KnownFile {
  size: number;
  mtimeMs: number;
  parsedThrough: number;
  /** dedupKey of the parse's tailProbeHex. */
  tailProbeKey: string;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readKnownFile(raw: unknown): { path: string; known: KnownFile } | null {
  if (!isRecord(raw)) return null;
  const { path, size, mtimeMs, parsedThrough, tailProbeKey } = raw;
  if (
    typeof path !== "string" || !isCount(size) || !isFinite(mtimeMs) ||
    !isCount(parsedThrough) || !isHash(tailProbeKey)
  ) {
    return null;
  }
  return { path, known: { size, mtimeMs, parsedThrough, tailProbeKey } };
}

/** A short read is a mismatch; the bytes read count either way. */
function tailProbeMatches(
  path: string,
  parsedThrough: number,
  tailProbeKey: string,
  stats: IndexStats,
): boolean {
  const probeBytes = Math.min(TAIL_PROBE_BYTES, parsedThrough);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(probeBytes);
    const read = probeBytes === 0
      ? 0
      : readSync(fd, buffer, 0, probeBytes, parsedThrough - probeBytes);
    stats.bytesRead += read;
    return read === probeBytes && dedupKey(buffer.toString("hex")) === tailProbeKey;
  } finally {
    closeSync(fd);
  }
}

/** Only an `unwalked` delete counts toward the `filesDeleted` stat; a failed parse or an unstorable
 *  contribution also deletes the row, uncounted. */
type PendingWrite =
  | {
    kind: "upsert";
    source: UsageSource;
    path: string;
    size: number;
    mtimeMs: number;
    parsedThrough: number;
    tailProbeKey: string;
    record: string;
  }
  | { kind: "delete"; path: string; unwalked: boolean };

/** Built at parse time, so the storable verdict does not depend on whether the commit lock is taken
 *  later. */
function upsertFor(
  source: UsageSource,
  file: WalkedFile,
  parsed: ParsedFile<Contribution>,
): PendingWrite | null {
  const record = storableContribution(source, parsed.contribution);
  if (record === null) return null;
  return {
    kind: "upsert",
    source,
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    parsedThrough: parsed.parsedThrough,
    tailProbeKey: dedupKey(parsed.tailProbeHex),
    record,
  };
}

/** One instance belongs to one run: open, reconcile per source, close. Only `openUsageIndex` mints
 *  one, so every instance has been stamped, configured, and locked the same way. */
export interface UsageIndex {
  readonly reconcile: Reconcile;
  /** Checkpoints the WAL (best effort) before closing. */
  close(): void;
}

class SqliteUsageIndex implements UsageIndex {
  readonly #db: DatabaseSync;
  readonly #lockPath: string;
  readonly #lockPolicy: LockPolicy;

  constructor(db: DatabaseSync, lockPath: string, lockPolicy: LockPolicy) {
    this.#db = db;
    this.#lockPath = lockPath;
    this.#lockPolicy = lockPolicy;
  }

  /** One query for the not-walked deletion set and the reuse/resume decisions alike. A row with
   *  malformed identity columns is listed with no identity, so its file parses whole and its path
   *  can still be deleted. */
  #knownFiles(source: UsageSource): Map<string, KnownFile | null> {
    const rows = this.#db.prepare(
      `SELECT "path", "size", "mtime_ms" AS mtimeMs, "parsed_through" AS parsedThrough,
              "tail_probe" AS tailProbeKey
         FROM "files" WHERE "source" = ?`,
    ).all(source);
    const known = new Map<string, KnownFile | null>();
    for (const raw of rows) {
      const row = readKnownFile(raw);
      if (row !== null) {
        known.set(row.path, row.known);
      } else if (isRecord(raw) && typeof raw.path === "string") {
        known.set(raw.path, null);
      }
    }
    return known;
  }

  /** The identity is re-checked against `known` because the snapshot and this fetch are not one
   *  transaction: another run may have rewritten the row between them. Null = the caller parses
   *  whole. */
  #storedContribution<S extends UsageSource>(
    source: S,
    path: string,
    known: KnownFile,
    statement: StatementSync,
  ): ContributionOf<S> | null {
    const raw = statement.get(path, source);
    if (!isRecord(raw) || typeof raw.record !== "string") return null;
    const row = readKnownFile(raw);
    if (
      row === null || row.known.size !== known.size || row.known.mtimeMs !== known.mtimeMs ||
      row.known.parsedThrough !== known.parsedThrough ||
      row.known.tailProbeKey !== known.tailProbeKey
    ) {
      return null;
    }
    // parseStoredContribution validated against the reader `source` selects, so the
    // value IS this source's contribution type; the generic cannot say so.
    return parseStoredContribution(source, raw.record) as ContributionOf<S> | null;
  }

  /** Null = the lock could not be taken and nothing was written. */
  #commit(writes: readonly PendingWrite[]): number | null {
    if (writes.length === 0) return 0;
    return withFileLockSync(this.#lockPath, this.#lockPolicy, (outcome) => {
      if (!outcome.held) return null;
      return this.#write(writes);
    });
  }

  #write(writes: readonly PendingWrite[]): number {
    const upsert = this.#db.prepare(
      `INSERT OR REPLACE INTO "files"
           ("path", "source", "size", "mtime_ms", "parsed_through", "tail_probe", "record")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const remove = this.#db.prepare(`DELETE FROM "files" WHERE "path" = ?`);
    let removed = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        if (write.kind === "delete") {
          const changes = Number(remove.run(write.path).changes);
          if (write.unwalked) removed += changes;
          continue;
        }
        upsert.run(
          write.path,
          write.source,
          write.size,
          write.mtimeMs,
          write.parsedThrough,
          write.tailProbeKey,
          write.record,
        );
      }
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
    return removed;
  }

  /** `bytesRead` counts successful parses and probe reads only: a parse that throws contributes no
   *  bytes, so the warm-run and append oracles stay exact. */
  readonly reconcile: Reconcile = <S extends UsageSource>(
    source: S,
    walked: readonly WalkedFile[],
    parseWhole: ParseWhole<ContributionOf<S>>,
    parseTail: ParseTail<ContributionOf<S>>,
  ): ReconcileResult<ContributionOf<S>> => {
    const stats = emptyIndexStats();
    stats.filesSeen = walked.length;
    const records: FileRecord<ContributionOf<S>>[] = [];
    const writes: PendingWrite[] = [];

    // A read the index itself fails (not the session file) turns the rest of the run index-less:
    // every remaining candidate parses whole and nothing is saved. Warned once, not once per file.
    let indexFailure: string | null = null;
    const indexRead = <T>(read: () => T, fallback: T): T => {
      if (indexFailure !== null) return fallback;
      try {
        return read();
      } catch (e) {
        indexFailure = errMessage(e);
        logger.warn(`usage index unreadable, parsing every file (${indexFailure}).`);
        return fallback;
      }
    };

    const walkedPaths = new Set(walked.map((file) => file.path));
    const knownFiles = indexRead(
      () => this.#knownFiles(source),
      new Map<string, KnownFile | null>(),
    );
    for (const path of knownFiles.keys()) {
      if (!walkedPaths.has(path)) writes.push({ kind: "delete", path, unwalked: true });
    }
    // Prepared once: a per-file prepare cost as much as the read itself.
    const recordStatement = indexRead(
      () =>
        this.#db.prepare(
          `SELECT "path", "size", "mtime_ms" AS mtimeMs, "parsed_through" AS parsedThrough,
                  "tail_probe" AS tailProbeKey, "record"
             FROM "files" WHERE "path" = ? AND "source" = ?`,
        ),
      null,
    );
    const stored = (path: string, known: KnownFile): ContributionOf<S> | null =>
      recordStatement === null
        ? null
        : indexRead(() => this.#storedContribution(source, path, known, recordStatement), null);

    for (const file of walked) {
      if (!file.candidate) continue;
      // Once the index has failed the snapshot is not consulted either, so no probe read happens on
      // its behalf.
      const known = indexFailure === null ? knownFiles.get(file.path) ?? null : null;
      try {
        let parsed: ParsedFile<ContributionOf<S>> | null = null;
        if (known !== null) {
          if (known.size === file.size && known.mtimeMs === file.mtimeMs) {
            const contribution = stored(file.path, known);
            if (contribution !== null) {
              stats.filesReused++;
              records.push({ path: file.path, contribution });
              continue;
            }
          } else if (
            file.size > known.size && file.resumable &&
            tailProbeMatches(file.path, known.parsedThrough, known.tailProbeKey, stats)
          ) {
            const prior = stored(file.path, known);
            if (prior !== null) {
              parsed = parseTail(file, known.parsedThrough, prior);
              stats.filesParsedTail++;
            }
          }
        }
        if (parsed === null) {
          parsed = parseWhole(file);
          stats.filesParsedWhole++;
        }
        stats.bytesRead += parsed.bytesRead;
        records.push({ path: file.path, contribution: parsed.contribution });
        const upsert = upsertFor(source, file, parsed);
        if (upsert === null) {
          logger.warn(`not indexing ${file.path}: its contribution is not storable.`);
          writes.push({ kind: "delete", path: file.path, unwalked: false });
        } else {
          writes.push(upsert);
        }
      } catch (e) {
        stats.filesFailed++;
        logger.warn(`could not read ${file.path} (${errMessage(e)}).`);
        writes.push({ kind: "delete", path: file.path, unwalked: false });
      }
    }

    if (indexFailure !== null) return { records, stats };
    try {
      const removed = this.#commit(writes);
      if (removed === null) {
        logger.info("usage index lock unavailable; this run's results were not saved.");
      } else {
        stats.filesDeleted = removed;
      }
    } catch (e) {
      logger.warn(`could not update the usage index (${errMessage(e)}).`);
    }
    return { records, stats };
  };

  close(): void {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // a failed checkpoint leaves frames for the next open to replay; not an error
    }
    this.#db.close();
  }
}

/** Busy: another connection holds the database. Not-a-database: a garbage file no connection can
 *  hold. */
const SQLITE_BUSY = 5;
const SQLITE_NOTADB = 26;

/** node:sqlite does not always expose `errcode`, so the two messages SQLite emits for these codes
 *  count too. */
function sqliteErrcode(e: unknown): number | null {
  const errcode = (e as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") return errcode;
  const message = errMessage(e);
  if (message === "database is locked") return SQLITE_BUSY;
  if (message === "file is not a database") return SQLITE_NOTADB;
  return null;
}

/** The connection travels with a `stale` or `broken` verdict when there is one, because only it
 *  can prove the file is safe to remove (relinquishDb). */
type OpenAttempt =
  | { kind: "ok"; db: DatabaseSync }
  | { kind: "stale"; db: DatabaseSync; detail: string }
  | { kind: "broken"; db: DatabaseSync | null; detail: string };

/** Only an EMPTY database gets our stamps; one with rows but no stamps is of unknown provenance and
 *  is stale like any other mismatch. */
function tryOpenDb(dbPath: string, fingerprint: string): OpenAttempt {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    return { kind: "broken", db: null, detail: errMessage(e) };
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(SCHEMA_SQL);
    const meta = new Map<string, string>();
    for (const raw of db.prepare(`SELECT "key", "value" FROM "meta"`).all()) {
      const row = v.safeParse(v.object({ key: v.string(), value: v.string() }), raw);
      if (row.success) meta.set(row.output.key, row.output.value);
    }
    const wanted: ReadonlyMap<string, string> = new Map([
      [META_SCHEMA_VERSION, String(USAGE_INDEX_SCHEMA_VERSION)],
      [META_PARSER_FINGERPRINT, fingerprint],
    ]);
    if (meta.size === 0) {
      const anyRow = db.prepare(`SELECT 1 FROM "files" LIMIT 1`).get();
      if (anyRow !== undefined) return { kind: "stale", db, detail: "unstamped rows" };
      const stamp = db.prepare(`INSERT INTO "meta" ("key", "value") VALUES (?, ?)`);
      for (const [key, value] of wanted) stamp.run(key, value);
      return { kind: "ok", db };
    }
    for (const [key, value] of wanted) {
      const stored = meta.get(key);
      if (stored !== value) {
        return { kind: "stale", db, detail: `${key} ${stored ?? "missing"}` };
      }
    }
    return { kind: "ok", db };
  } catch (e) {
    return { kind: "broken", db, detail: errMessage(e) };
  }
}

type Relinquish =
  | { kind: "exclusive" }
  | { kind: "not-a-database" }
  | { kind: "in-use" }
  | { kind: "failed"; detail: string };

/** The file may be unlinked only after a WAL round trip (enter, then leave) proved no other
 *  WAL-mode connection holds it, or when it is not a database at all. Anything else, a close
 *  failure included, fails closed. */
function relinquishDb(db: DatabaseSync): Relinquish {
  const journalModeSchema = v.object({ journal_mode: v.picklist(["wal", "delete"]) });
  const switchTo = (mode: "wal" | "delete"): Relinquish | null => {
    const row = v.safeParse(journalModeSchema, db.prepare(`PRAGMA journal_mode = ${mode}`).get());
    if (row.success && row.output.journal_mode === mode) return null;
    const observed = row.success ? row.output.journal_mode : "an unrecognized result";
    return { kind: "failed", detail: `journal_mode = ${mode} returned ${observed}` };
  };
  let verdict: Relinquish;
  try {
    verdict = switchTo("wal") ?? switchTo("delete") ?? { kind: "exclusive" };
  } catch (e) {
    const errcode = sqliteErrcode(e);
    verdict = errcode === SQLITE_BUSY
      ? { kind: "in-use" }
      : errcode === SQLITE_NOTADB
      ? { kind: "not-a-database" }
      : { kind: "failed", detail: errMessage(e) };
  }
  try {
    db.close();
  } catch (e) {
    if (verdict.kind === "exclusive" || verdict.kind === "not-a-database") {
      verdict = { kind: "failed", detail: `could not close the stale database (${errMessage(e)})` };
    }
  }
  return verdict;
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of DB_FILE_SUFFIXES) removeReported(`${dbPath}${suffix}`);
}

/** Null means "run index-less": the reader falls back to `parseEveryCandidate`. */
export function openUsageIndex(opts: OpenUsageIndexOptions = {}): UsageIndex | null {
  const dir = opts.dir ?? usageIndexDir();
  const fingerprint = opts.fingerprint ?? DEFAULT_PARSER_FINGERPRINT;
  const lockPolicy = opts.lockPolicy ?? BOUNDED_LOCK_POLICY;
  try {
    mkdirReported(dir, 0o700);
    // mkdir's mode only applies on creation; a pre-existing wider dir must still end up 0700, since
    // the index names every session file, its models and timestamps.
    if (process.platform !== "win32") chmodReported(dir, 0o700);
  } catch (e) {
    logger.warn(`could not create the usage index directory ${dir} (${errMessage(e)}).`);
    return null;
  }
  const dbPath = join(dir, USAGE_INDEX_DB_NAME);
  const lockPath = join(dir, USAGE_INDEX_LOCK_NAME);
  return withFileLockSync(lockPath, lockPolicy, (outcome) => {
    if (!outcome.held) {
      logger.info("usage index lock unavailable; running without it.");
      return null;
    }
    const first = tryOpenDb(dbPath, fingerprint);
    if (first.kind === "ok") return new SqliteUsageIndex(first.db, lockPath, lockPolicy);
    if (first.db === null) {
      logger.warn(`could not open the usage index (${first.detail}); running without it.`);
      return null;
    }
    const relinquished = relinquishDb(first.db);
    if (relinquished.kind === "in-use") {
      logger.info(`usage index in use by another run (${first.detail}); running without it.`);
      return null;
    }
    if (relinquished.kind === "failed") {
      logger.warn(`usage index unavailable (${relinquished.detail}); running without it.`);
      return null;
    }
    logger.info(`rebuilding the usage index (${first.detail}).`);
    try {
      removeDbFiles(dbPath);
    } catch (e) {
      logger.warn(`could not remove the stale usage index (${errMessage(e)}).`);
      return null;
    }
    const second = tryOpenDb(dbPath, fingerprint);
    if (second.kind === "ok") return new SqliteUsageIndex(second.db, lockPath, lockPolicy);
    if (second.db !== null) relinquishDb(second.db);
    logger.warn(`could not create the usage index (${second.detail}).`);
    return null;
  });
}
