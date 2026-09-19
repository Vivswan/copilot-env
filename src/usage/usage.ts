// One `token_usage_events` row per request, in a per-host DB, so a home shared across machines
// holds several DBs. The layout is src/copilot_api/paths.ts's; this module only sweeps it.

import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { consola } from "consola";
import {
  DEFAULT_PROFILE_DIR,
  PROFILES_DIR_NAME,
  resolveHome,
  usageDbsUnderHome,
} from "../copilot_api/paths.ts";
import { isValidProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { dayKeyIn } from "../utils/time.ts";
import * as fs from "../utils/fs_facade.ts";
import { canonicalModelName } from "./pricing.ts";

/** The four priced token buckets every usage source reduces one event to. */
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** The one sanitization rule every session reader applies. Flooring drops torn fractions and keeps
 *  report arithmetic (sums, the undated remainder) exact. */
export function sanitizeTokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface ModelUsage extends TokenBuckets {
  events: number;
}

/** parseUsageRow is the only mint, so nothing downstream re-checks the counts. */
export interface UsageRow {
  bucket: number | null;
  model: string;
  buckets: TokenBuckets;
  events: number;
}

/** node:sqlite hands back a `bigint` for an integer a double cannot hold exactly, so both shapes
 *  arrive here. */
function numberOrNull(value: unknown): number | null {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  return typeof asNumber === "number" && Number.isFinite(asNumber) ? asNumber : null;
}

/** The boundary between untyped SQLite output and the report: no later step re-checks for bigints,
 *  nulls, or hostile values. A row with no usable `model` cannot be attributed and is dropped.
 *  Exported for tests. */
export function parseUsageRow(raw: unknown): UsageRow | null {
  if (!isRecord(raw)) return null;
  const model = raw.model;
  if (typeof model !== "string" || model === "") return null;
  return {
    bucket: numberOrNull(raw.bucket),
    model,
    buckets: {
      input: sanitizeTokenCount(numberOrNull(raw.input)),
      output: sanitizeTokenCount(numberOrNull(raw.output)),
      cacheRead: sanitizeTokenCount(numberOrNull(raw.cacheRead)),
      cacheCreation: sanitizeTokenCount(numberOrNull(raw.cacheCreation)),
    },
    events: sanitizeTokenCount(numberOrNull(raw.events)),
  };
}

/** The mutable shape is for producers, which fold through record(); readers take
 *  ReadonlyUsageReport. */
export interface UsageReport {
  /** Derived from the same rows as `perDay`; kept so callers do not recompute it. */
  byModel: Map<string, ModelUsage>;
  /** Keyed by LOCAL calendar day, YYYY-MM-DD in the user's timezone. */
  perDay: Map<string, Map<string, ModelUsage>>;
}

/** Consumers take this shape so they cannot mutate a report they were handed. */
export interface ReadonlyUsageReport {
  readonly byModel: ReadonlyMap<string, Readonly<ModelUsage>>;
  readonly perDay: ReadonlyMap<string, ReadonlyMap<string, Readonly<ModelUsage>>>;
}

/** An empty report; every producer fills one through record(). */
export function usageReport(): UsageReport {
  return { byModel: new Map(), perDay: new Map() };
}

/** The one owner of a new increment's consistency: every source records through here, so the
 *  per-day split cannot drift from the roll-up. mergeUsageReports bypasses it, unioning two
 *  reports that are consistent already. `usage.events` is the increment's count: a grouped SQL
 *  row's COUNT, a session line's 1, a streaming delta's 0. */
export function record(
  report: UsageReport,
  day: string | null,
  model: string,
  usage: Readonly<ModelUsage>,
): void {
  // The byModel fold mutates its entry in place, and `usage` may BE that entry (a caller folding a
  // report's own accumulator back in), which would hand the perDay fold an already-doubled
  // increment.
  const increment = { ...usage };
  addUsage(report.byModel, model, increment);
  if (day !== null) {
    addUsage(dayUsageMap(report.perDay, day), model, increment);
  }
}

/** The one fold both report maps share: add a token bucket here and every source folds it. */
function addUsage(
  target: Map<string, ModelUsage>,
  model: string,
  usage: Readonly<ModelUsage>,
): void {
  const prev = target.get(model) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 0,
  };
  prev.input += usage.input;
  prev.output += usage.output;
  prev.cacheRead += usage.cacheRead;
  prev.cacheCreation += usage.cacheCreation;
  prev.events += usage.events;
  target.set(model, prev);
}

function dayUsageMap(
  perDay: Map<string, Map<string, ModelUsage>>,
  day: string,
): Map<string, ModelUsage> {
  let dayModels = perDay.get(day);
  if (dayModels === undefined) {
    dayModels = new Map<string, ModelUsage>();
    perDay.set(day, dayModels);
  }
  return dayModels;
}

/** A directory at `path`; absent, a file, or an unreadable look all read false (the sweep only
 *  descends into homes it can list). */
function isDirectoryAt(path: string): boolean {
  try {
    return fs.stat(path).isDirectory();
  } catch {
    return false;
  }
}

/** Only the default dir and valid profile names are swept: a stray hand-made folder is not a daemon
 *  home. Realpath-deduped so a symlinked alias can never double-count a DB. */
export function discoverUsageDbs(home: string = resolveHome()): string[] {
  const paths = usageDbsUnderHome(home);

  const profilesDir = join(home, PROFILES_DIR_NAME);
  let profiles: string[] = [];
  try {
    profiles = fs.readdir(profilesDir);
  } catch (e) {
    // Only a MISSING dir reads as "no profiles", as in usageDbsUnderHome and profileHomeNames
    // (copilot_api/paths.ts): this sweep backs a summed cost TOTAL, so a failed scan must not read
    // as empty.
    if (!isEnoentOrNotdir(e)) throw e;
    profiles = [];
  }
  for (const profile of profiles.sort()) {
    if (profile !== DEFAULT_PROFILE_DIR && !isValidProfileName(profile)) continue;
    const profileHome = join(profilesDir, profile);
    if (isDirectoryAt(profileHome)) {
      paths.push(...usageDbsUnderHome(profileHome));
    }
  }

  // A hand-COPIED DB across homes (distinct inodes) still counts twice: accepted.
  const seen = new Set<string>();
  return paths.filter((path) => {
    let canonical = path;
    try {
      canonical = fs.realpath(path);
    } catch {
      // unresolvable path: fall back to the literal spelling
    }
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

function withReadOnlyDb<T>(path: string, query: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

/** A missing sidecar just means there is nothing un-checkpointed to replay. */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/** A read-only filesystem lets SQLite consult a -wal only if it can create the -shm beside it,
 *  which it can in a temp copy. */
function withDbCopy<T>(path: string, query: (db: DatabaseSync) => T): T {
  const dir = fs.scratchDir(join(tmpdir(), "copilot-usage-"));
  try {
    const copy = join(dir, basename(path));
    fs.copyFile(path, copy);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      try {
        fs.copyFile(`${path}${suffix}`, `${copy}${suffix}`);
      } catch (e) {
        // A PROVEN-absent sidecar means the daemon checkpointed; one that is there but would not
        // copy must not be dropped, or the read would silently omit its rows.
        if (fs.readTextResult(`${path}${suffix}`).kind !== "absent") throw e;
      }
    }
    return withReadOnlyDb(copy, query);
  } finally {
    fs.removeScratchDir(dir);
  }
}

/** The daemon only checkpoints on close, so the live open (which consults the -wal) comes first;
 *  SQLite can defer a -shm error to prepare time, so the query is inside the try too. The FIRST
 *  error propagates when both fail: it describes the real database, not the copy. */
function openSqliteReadOnlyWithWalFallback<T>(path: string, query: (db: DatabaseSync) => T): T {
  try {
    return withReadOnlyDb(path, query);
  } catch (first) {
    try {
      return withDbCopy(path, query);
    } catch {
      throw first;
    }
  }
}

/** `timeZone` exists so the per-day slicing is assertable without pinning the process `TZ`, which
 *  deno honors on unix only. */
export function readUsage(dbPaths: string[], sinceMs?: number, timeZone?: string): UsageReport {
  const report = usageReport();
  const since = sinceMs ?? null;
  // Before any DB is opened: an unknown zone must fail here, not inside the per-path catch.
  const dayKey = dayKeyIn(timeZone);

  // A minute bucket never straddles a local midnight: every IANA transition in the standard-time
  // era is minute-aligned. Minutes rather than quarter-hours because historical zones flipped DST
  // at odd minutes (America/Goose_Bay fell back at 00:01 local), which would split a coarser bucket
  // across two local days.
  const MINUTE_MS = 60_000;
  // The bucket is a UTC minute so the LOCAL day key is derived in JS, away from SQLite's
  // cached-libc `localtime`. At most ~1440 rows per model-day.
  const QUERY = `SELECT (created_at_ms / ${MINUTE_MS}) AS bucket,
                  model,
                  SUM(input_tokens)                 AS input,
                  SUM(output_tokens)                AS output,
                  SUM(cache_read_input_tokens)      AS cacheRead,
                  SUM(cache_creation_input_tokens)  AS cacheCreation,
                  COUNT(*)                          AS events
           FROM token_usage_events
           WHERE (?1 IS NULL OR created_at_ms >= ?1)
           GROUP BY bucket, model`;

  for (const path of dbPaths) {
    let rows: UsageRow[];
    try {
      rows = openSqliteReadOnlyWithWalFallback(
        path,
        // An unparseable row drops out here rather than reaching a report as a zero-filled phantom.
        (db) => db.prepare(QUERY).all(since).flatMap((raw) => parseUsageRow(raw) ?? []),
      );
    } catch (e) {
      consola.warn(`could not read ${path} (${errMessage(e)}).`);
      continue;
    }

    for (const row of rows) {
      // The daemon writes created_at_ms on every row, so a null bucket is not expected; record
      // still totals such a row, just outside the per-day split.
      record(
        report,
        row.bucket !== null ? dayKey(row.bucket * MINUTE_MS) : null,
        canonicalModelName(row.model),
        { ...row.buckets, events: row.events },
      );
    }
  }

  return report;
}

export function mergeUsageReports(reports: Iterable<ReadonlyUsageReport>): UsageReport {
  const merged = usageReport();
  for (const report of reports) {
    // Each byModel entry is already a full roll-up, dated rows included, so it folds in day-less
    // and the per-day split unions day-wise below.
    for (const [model, u] of report.byModel) {
      record(merged, null, model, u);
    }
    for (const [day, dayModels] of report.perDay) {
      // A day with an empty model map still counts as active in the union.
      const target = dayUsageMap(merged.perDay, day);
      for (const [model, u] of dayModels) {
        addUsage(target, model, u);
      }
    }
  }
  return merged;
}

/** record() folds every dated increment into both maps and sanitizeTokenCount keeps every count an
 *  integer, so the difference is exactly the usage recorded with a null day. A model the days
 *  fully cover is absent, not zero-filled. */
export function undatedUsage(report: ReadonlyUsageReport): Map<string, ModelUsage> {
  const rest = new Map<string, ModelUsage>();
  for (const [model, u] of report.byModel) {
    rest.set(model, { ...u });
  }
  for (const dayModels of report.perDay.values()) {
    for (const [model, u] of dayModels) {
      // record() puts every perDay model in byModel first.
      const r = rest.get(model)!;
      r.input -= u.input;
      r.output -= u.output;
      r.cacheRead -= u.cacheRead;
      r.cacheCreation -= u.cacheCreation;
      r.events -= u.events;
    }
  }
  for (const [model, r] of rest) {
    if (
      r.input === 0 && r.output === 0 && r.cacheRead === 0 && r.cacheCreation === 0 &&
      r.events === 0
    ) {
      rest.delete(model);
    }
  }
  return rest;
}
