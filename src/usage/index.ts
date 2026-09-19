// A pre-index, never a cache of results: rows hold a file's identity, resume point, and
// contribution (contribution.ts), and the report is folded fresh from them every run. An index that
// fails to open or read degrades to whole parses, never to a missing or "unreadable" session.
//
// No session text and no raw ids on disk: a contribution holds only numbers, model names, and dedup
// keys (contribution.ts), the tail probe is stored hashed, and secure_delete plus a truncating
// checkpoint keep deleted rows out of free pages and old WAL frames. The open and each run's one
// write transaction take the advisory lock; without it a run keeps its results and saves nothing.
import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { BOUNDED_LOCK_POLICY, type LockPolicy, withFileLockSync } from "../utils/file_lock.ts";
import { createStderrLogger } from "../utils/logger.ts";
import * as fs from "../utils/fs_facade.ts";
import {
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
import { usageIndexDir } from "../copilot_api/paths.ts";

// `cost --json` owns stdout and its consumers parse the whole of it.
const logger = createStderrLogger();

export const USAGE_INDEX_DB_NAME = "index.sqlite";
export const USAGE_INDEX_LOCK_NAME = "index.lock";

/** The one stamp: a database stamped otherwise, or holding unstamped rows, has its rows deleted and
 *  is restamped. A table-layout change bumps CONTRIBUTION_VERSION with it, so the rows are rebuilt
 *  at once instead of row by row. */
export const DEFAULT_PARSER_FINGERPRINT = `contribution-v${CONTRIBUTION_VERSION}`;

/** The advisory lock serializes our own writers, so this only covers a writer from a release that
 *  does not take it. */
const BUSY_TIMEOUT_MS = 2_000;

const DB_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

const META_PARSER_FINGERPRINT = "parser_fingerprint";

/** A garbage file no connection can hold. */
const SQLITE_NOTADB = 26;

/** Our own statements against a sound database whose tables are not ours: an index a build with
 *  another table layout left behind. */
const LAYOUT_MISMATCH_RE = /^(no such column: |table "?\w+"? has no column named )/;

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

/** The rows are this program's own, written by its typed parsers: a record is trusted once it
 *  parses as JSON and carries the current contribution version. Anything else reads as "no row" (a
 *  whole parse), never as a bad session. */
function parseStoredContribution<S extends UsageSource>(text: string): ContributionOf<S> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(doc) && doc.v === CONTRIBUTION_VERSION
    ? doc as unknown as ContributionOf<S>
    : null;
}

/** The identity columns of a stored row, as the reuse and resume decisions read them. */
interface KnownFile {
  size: number;
  mtimeMs: number;
  parsedThrough: number;
  /** dedupKey of the parse's tailProbeHex. */
  tailProbeKey: string;
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

/** Only an `unwalked` delete counts toward the `filesDeleted` stat; a failed parse also deletes the
 *  row, uncounted. */
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

  /** One query for the not-walked deletion set and the reuse/resume decisions alike. */
  #knownFiles(source: UsageSource): Map<string, KnownFile> {
    const rows = this.#db.prepare(
      `SELECT "path", "size", "mtime_ms" AS mtimeMs, "parsed_through" AS parsedThrough,
              "tail_probe" AS tailProbeKey
         FROM "files" WHERE "source" = ?`,
    ).all(source) as unknown as (KnownFile & { path: string })[];
    return new Map(rows.map(({ path, ...known }) => [path, known]));
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
    const knownFiles = indexRead(() => this.#knownFiles(source), new Map<string, KnownFile>());
    for (const path of knownFiles.keys()) {
      if (!walkedPaths.has(path)) writes.push({ kind: "delete", path, unwalked: true });
    }
    // Prepared once: a per-file prepare cost as much as the read itself.
    const recordStatement = indexRead(
      () => this.#db.prepare(`SELECT "record" FROM "files" WHERE "path" = ? AND "source" = ?`),
      null,
    );
    const stored = (path: string): ContributionOf<S> | null =>
      recordStatement === null ? null : indexRead(() => {
        const row = recordStatement.get(path, source) as { record: string } | undefined;
        return row === undefined ? null : parseStoredContribution<S>(row.record);
      }, null);

    for (const file of walked) {
      if (!file.candidate) continue;
      // Once the index has failed the snapshot is not consulted either, so no probe read happens on
      // its behalf.
      const known = indexFailure === null ? knownFiles.get(file.path) : undefined;
      try {
        let parsed: ParsedFile<ContributionOf<S>> | null = null;
        if (known !== undefined) {
          if (known.size === file.size && known.mtimeMs === file.mtimeMs) {
            const contribution = stored(file.path);
            if (contribution !== null) {
              stats.filesReused++;
              records.push({ path: file.path, contribution });
              continue;
            }
          } else if (
            file.size > known.size && file.resumable &&
            tailProbeMatches(file.path, known.parsedThrough, known.tailProbeKey, stats)
          ) {
            const prior = stored(file.path);
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
        writes.push({
          kind: "upsert",
          source,
          path: file.path,
          size: file.size,
          mtimeMs: file.mtimeMs,
          parsedThrough: parsed.parsedThrough,
          tailProbeKey: dedupKey(parsed.tailProbeHex),
          record: JSON.stringify(parsed.contribution),
        });
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

/** The open failures answered by removing the file and creating it afresh: a garbage file, or a
 *  database with another table layout. node:sqlite does not always expose `errcode`, so the message
 *  SQLite emits counts too. Anything else (a corrupt database, say) is left as it is. */
function isRebuildable(e: unknown): boolean {
  const message = errMessage(e);
  return (e as { errcode?: unknown }).errcode === SQLITE_NOTADB ||
    message === "file is not a database" || LAYOUT_MISMATCH_RE.test(message);
}

/** Configures and stamps a fresh connection, or closes it and throws. Rows under another stamp, or
 *  under none, go with their table (a stamp change may carry a layout change) and the stamp is
 *  rewritten in the same connection, so the file itself never has to go. */
function stamped(db: DatabaseSync, fingerprint: string): DatabaseSync {
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(SCHEMA_SQL);
    const stamp = db.prepare(`SELECT "value" FROM "meta" WHERE "key" = ?`)
      .get(META_PARSER_FINGERPRINT) as { value: string } | undefined;
    if (stamp?.value === fingerprint) return db;
    const hasRows = db.prepare(`SELECT 1 FROM "files" LIMIT 1`).get() !== undefined;
    if (stamp !== undefined || hasRows) {
      const detail = stamp === undefined
        ? "unstamped rows"
        : `${META_PARSER_FINGERPRINT} ${stamp.value}`;
      logger.info(`rebuilding the usage index (${detail}).`);
    }
    // A fresh database recreates an empty table, silently.
    db.exec(`DROP TABLE "files"`);
    db.exec(SCHEMA_SQL);
    db.prepare(`INSERT OR REPLACE INTO "meta" ("key", "value") VALUES (?, ?)`)
      .run(META_PARSER_FINGERPRINT, fingerprint);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {
      // the open failure is the one to report
    }
    throw e;
  }
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of DB_FILE_SUFFIXES) fs.rm(`${dbPath}${suffix}`, { force: true });
}

/** Null means "run index-less": the reader falls back to `parseEveryCandidate`. */
export function openUsageIndex(opts: OpenUsageIndexOptions = {}): UsageIndex | null {
  const dir = opts.dir ?? usageIndexDir();
  const fingerprint = opts.fingerprint ?? DEFAULT_PARSER_FINGERPRINT;
  const lockPolicy = opts.lockPolicy ?? BOUNDED_LOCK_POLICY;
  try {
    fs.mkdir(dir, { mode: 0o700 });
    // mkdir's mode only applies on creation; a pre-existing wider dir must still end up 0700, since
    // the index names every session file, its models and timestamps.
    if (process.platform !== "win32") fs.chmod(dir, 0o700);
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
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch (e) {
      logger.warn(`could not open the usage index (${errMessage(e)}); running without it.`);
      return null;
    }
    try {
      return new SqliteUsageIndex(stamped(db, fingerprint), lockPath, lockPolicy);
    } catch (e) {
      if (!isRebuildable(e)) {
        logger.warn(`usage index unavailable (${errMessage(e)}); running without it.`);
        return null;
      }
      logger.info(`rebuilding the usage index (${errMessage(e)}).`);
    }
    try {
      removeDbFiles(dbPath);
    } catch (e) {
      logger.warn(`could not remove the stale usage index (${errMessage(e)}).`);
      return null;
    }
    try {
      return new SqliteUsageIndex(
        stamped(new DatabaseSync(dbPath), fingerprint),
        lockPath,
        lockPolicy,
      );
    } catch (e) {
      logger.warn(`could not create the usage index (${errMessage(e)}).`);
      return null;
    }
  });
}
