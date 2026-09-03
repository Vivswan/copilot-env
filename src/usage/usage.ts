// Read the proxy's per-host SQLite usage tables.
//
// The daemon writes one `token_usage_events` row per request into a per-host
// database (`<home>/.run/<hostname>/copilot-api.sqlite`). Running the proxy on
// several machines therefore yields several DBs; a legacy top-level
// `<home>/copilot-api.sqlite` may also exist from before the per-host split. We
// read all of them read-only and aggregate token counts by model. The DB layout
// itself is owned by src/copilot_api/paths.ts; this module only sweeps it.

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
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
import { isDir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { dayKeyIn } from "../utils/time.ts";
import { canonicalModelName } from "./pricing.ts";

/** The four priced token buckets every usage source reduces one event to. */
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Clamp one raw token count for the report: only a finite positive number passes,
 *  floored to an integer. Non-finite or negative counts (hostile or torn lines)
 *  never enter a report -- the ONE sanitization rule every session reader applies
 *  to its buckets. Counts are integral by nature; flooring drops torn fractions
 *  and keeps report arithmetic (sums, the undated remainder) exact. */
export function sanitizeTokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The four token buckets plus an event count: an accumulated per-model total in the
 *  report maps, and equally a usage increment on its way into record. */
export interface ModelUsage extends TokenBuckets {
  events: number;
}

/** One aggregated `token_usage_events` row, in the shape the report consumes: counts
 *  already sanitized, and `bucket` null only when the group carried no timestamp.
 *  parseUsageRow below is the only mint, so nothing downstream re-checks. */
export interface UsageRow {
  bucket: number | null;
  model: string;
  buckets: TokenBuckets;
  events: number;
}

/** Coerce one SQLite numeric column to a finite JS number. node:sqlite hands back a
 *  `bigint` for an integer a double cannot hold exactly, so both shapes arrive here;
 *  anything else (or a non-finite value) reads as absent. */
function numberOrNull(value: unknown): number | null {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  return typeof asNumber === "number" && Number.isFinite(asNumber) ? asNumber : null;
}

/**
 * Parse one grouped query result into a UsageRow, or null when it is not one. THE
 * boundary between untyped SQLite output and the rest of this module: every count that
 * reaches a report has passed sanitizeTokenCount here, and every field downstream is a
 * plain finite number -- so no later step re-checks for bigints, nulls, or hostile
 * values. A row with no usable `model` is dropped, since it cannot be attributed.
 * Exported for the unit tests that drive shapes a live DB will not produce.
 */
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

/** Declare-only brand class: privates are nominal, so no object literal or spread
 *  compiles as UsageReport -- mutable reports are born in usageReport(). Deliberate
 *  escape hatches (a cast, Object.assign) remain, as with any compile-time brand. */
declare class UsageReportMint {
  private readonly usageReportMint: true;
}

/**
 * Aggregated usage plus a per-day breakdown.
 *
 * `perDay` maps each distinct LOCAL calendar day (YYYY-MM-DD, the user's
 * timezone) to that day's per-model token totals, unioned across every DB.
 * `byModel` is the all-days roll-up -- derived from the same rows, kept as a
 * field so callers don't recompute it. The active-day count is `perDay.size`,
 * always read from the map itself. The mutable shape is for producers, which
 * mint one via usageReport() and fold into it through record(); readers take
 * ReadonlyUsageReport.
 */
export interface UsageReport extends UsageReportMint {
  byModel: Map<string, ModelUsage>;
  perDay: Map<string, Map<string, ModelUsage>>;
}

/** The read-only face of a UsageReport (every UsageReport is assignable to it).
 *  Consumers take this shape so they cannot mutate a report they were handed;
 *  producers keep the mutable UsageReport and fold through record(). */
export interface ReadonlyUsageReport {
  readonly byModel: ReadonlyMap<string, Readonly<ModelUsage>>;
  readonly perDay: ReadonlyMap<string, ReadonlyMap<string, Readonly<ModelUsage>>>;
}

/**
 * Mint a UsageReport: empty by default (the state every producer folds into
 * through record()), or from hand-built maps, PARSED at the boundary: every
 * count must be a non-negative integer, every perDay model must appear in
 * byModel, and per model the days' sum never exceeds the roll-up in any
 * bucket (the invariant record() maintains). An inconsistent pair fails HERE,
 * at construction, so no consumer downstream has to clamp a negative undated
 * remainder away. The maps are deep-copied: the report never aliases caller
 * state, so a later record() fold cannot double-mutate a shared entry and a
 * caller edit cannot invalidate a report already validated.
 */
export function usageReport(
  byModel: ReadonlyMap<string, Readonly<ModelUsage>> = new Map(),
  perDay: ReadonlyMap<string, ReadonlyMap<string, Readonly<ModelUsage>>> = new Map(),
): UsageReport {
  const ownByModel = new Map<string, ModelUsage>();
  for (const [model, u] of byModel) {
    ownByModel.set(model, checkedUsage(model, u));
  }
  const ownPerDay = new Map<string, Map<string, ModelUsage>>();
  const dated = new Map<string, ModelUsage>();
  for (const [day, dayModels] of perDay) {
    const ownDay = new Map<string, ModelUsage>();
    for (const [model, u] of dayModels) {
      const copy = checkedUsage(model, u);
      ownDay.set(model, copy);
      addUsage(dated, model, copy);
    }
    ownPerDay.set(day, ownDay);
  }
  for (const [model, d] of dated) {
    const total = ownByModel.get(model);
    if (
      total === undefined || d.input > total.input || d.output > total.output ||
      d.cacheRead > total.cacheRead || d.cacheCreation > total.cacheCreation ||
      d.events > total.events
    ) {
      throw new Error(`inconsistent usage report: perDay exceeds byModel for model '${model}'`);
    }
  }
  // The ONE brand assertion: the maps above were validated into consistency here.
  return { byModel: ownByModel, perDay: ownPerDay } as UsageReport;
}

/** One validated copy of a hand-built ModelUsage. Counts must be non-negative
 *  integers (what sanitizeTokenCount feeds record()): NaN passes every ordering
 *  check, so admitting it would let the perDay-vs-byModel comparison fail open. */
function checkedUsage(model: string, u: Readonly<ModelUsage>): ModelUsage {
  const copy = { ...u };
  for (const v of [copy.input, copy.output, copy.cacheRead, copy.cacheCreation, copy.events]) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `invalid usage report: count for model '${model}' is not a non-negative integer`,
      );
    }
  }
  return copy;
}

/**
 * Fold one usage increment into a report: always into `byModel`, and into
 * `perDay[day]` too unless `day` is null (byModel only -- e.g. a timestamp-less
 * row, which cannot be placed on a local calendar day but must still reach the
 * totals). `usage.events` is the increment's event count (a grouped SQL row
 * carries its COUNT, a session line counts 1, a streaming delta 0). The ONE
 * owner of the two maps' consistency: every producer records through here, so
 * the per-day split can never drift from the roll-up.
 */
export function record(
  report: UsageReport,
  day: string | null,
  model: string,
  usage: Readonly<ModelUsage>,
): void {
  // Snapshot first: the byModel fold mutates its entry in place, and `usage` may
  // BE that entry (a caller folding a report's own accumulator back in), which
  // would hand the perDay fold an already-doubled increment.
  const increment = { ...usage };
  addUsage(report.byModel, model, increment);
  if (day !== null) {
    addUsage(dayUsageMap(report.perDay, day), model, increment);
  }
}

/** Fold one usage increment into a model->usage map, seeding a zero-valued record the
 *  first time a model appears. The ONE fold both report maps share -- add a token
 *  bucket here and every source folds it. Never retains `usage` by reference. */
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

/** The per-day model map for `day`, created empty the first time the day appears. */
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

/**
 * Locate every usage DB under `home`: any unmigrated FLAT root DBs (legacy
 * top-level file plus one per host directory under `.run/`) AND every profile
 * daemon's isolated home under `<home>/profiles/<name>` -- the default
 * profile's `profiles/default` included -- each proxy records its own traffic
 * in its own DB, and the cost report covers all of them. Only the default dir
 * and valid profile names are swept (a stray hand-made folder is not a daemon
 * home), and the result is realpath-deduped so a symlinked alias can never
 * double-count a DB. Only paths that exist on disk are returned.
 */
export function discoverUsageDbs(home: string = resolveHome()): string[] {
  const paths = usageDbsUnderHome(home);

  const profilesDir = join(home, PROFILES_DIR_NAME);
  let profiles: string[] = [];
  try {
    profiles = readdirSync(profilesDir);
  } catch {
    profiles = []; // no profiles dir yet
  }
  for (const profile of profiles.sort()) {
    if (profile !== DEFAULT_PROFILE_DIR && !isValidProfileName(profile)) continue;
    const profileHome = join(profilesDir, profile);
    if (isDir(profileHome)) {
      paths.push(...usageDbsUnderHome(profileHome));
    }
  }

  // Realpath-dedup: a symlinked alias never double-counts a DB. A hand-COPIED DB
  // across homes (distinct inodes) still counts twice -- accepted: the default-home
  // migration only moves or refuses, never copies, so only a hand copy reaches it.
  const seen = new Set<string>();
  return paths.filter((path) => {
    let canonical = path;
    try {
      canonical = realpathSync(path);
    } catch {
      // unresolvable path: fall back to the literal spelling
    }
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/** Open `path` read-only, run `query`, and always close the handle. */
function withReadOnlyDb<T>(path: string, query: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

/** The database file and the two WAL sidecars a read of it may need. The main file is
 *  required; a missing -wal/-shm just means there is nothing un-checkpointed to replay. */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/** Copy the database and its WAL sidecars into a temp directory and read the COPY, then
 *  delete it. The copy is what makes the read work where the original cannot be opened:
 *  a read-only filesystem lets SQLite consult a -wal only if it can create the -shm
 *  beside it, which it can here. */
function withDbCopy<T>(path: string, query: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  try {
    const copy = join(dir, basename(path));
    copyFileSync(path, copy);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      try {
        copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
      } catch {
        // absent sidecar: the daemon checkpointed, so the main file is complete
      }
    }
    return withReadOnlyDb(copy, query);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Open `path` read-only and run `query` against it, preferring the live database.
 * The daemon runs the DB in WAL mode and only checkpoints on close, so a plain
 * read-only open (which consults the -wal) comes first; if the open OR the query
 * fails (SQLite can defer a WAL/-shm error to prepare/exec time, e.g. a read-only
 * FS where the -shm can't be created), retry against a temp copy of the database
 * and its sidecars -- which keeps the un-checkpointed rows an immutable snapshot
 * would drop. The FIRST error is what propagates when both attempts fail: it
 * describes the real database, not the copy.
 */
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

/**
 * Open each DB read-only and aggregate token usage by model. `sinceMs` (unix
 * ms) bounds the query to recent rows when set. A DB that fails to open or query
 * is skipped with a warning rather than aborting the whole report. `timeZone`
 * names the zone the per-day split is cut in (default: the system's own); it
 * exists so the slicing is assertable without pinning the process `TZ`, which
 * deno honors on unix only.
 */
export function readUsage(dbPaths: string[], sinceMs?: number, timeZone?: string): UsageReport {
  const report = usageReport();
  const since = sinceMs ?? null;
  // Resolved BEFORE any DB is opened: an unknown zone must fail here, not once per row
  // inside the per-path catch below, which would report it as an unreadable database.
  const dayKey = dayKeyIn(timeZone);

  // One grouped query by (UTC minute, model); byModel and perDay both derive from
  // it, so we never read the same rows twice. The bucket is a UTC minute so the
  // LOCAL day key can be derived in JS (localDayKey): every IANA transition and
  // offset in the standard-time era is minute-aligned (sub-minute offsets exist
  // only for pre-standard-time LMT dates, which a daemon-written Date.now()
  // timestamp can never carry), so a bucket never straddles a local midnight.
  // Minutes, not quarter-hours, deliberately: historical zones flipped DST at
  // odd minutes (America/Goose_Bay fell back at 00:01 local), which would split
  // a coarser bucket across two local days. Keeping the timezone math out of
  // SQL avoids SQLite's cached-libc `localtime` (see localDayKey). At most
  // ~1440 rows per model-day (a long fall-back day holds a few more -- up to
  // 1560 for Antarctica/Troll's two-hour shift) -- still tiny.
  const MINUTE_MS = 60_000;
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
        // flatMap over the parse: an unparseable row drops out here rather than
        // reaching a report as a zero-filled phantom.
        (db) => db.prepare(QUERY).all(since).flatMap((raw) => parseUsageRow(raw) ?? []),
      );
    } catch (e) {
      consola.warn(`could not read ${path} (${errMessage(e)}).`);
      continue;
    }

    for (const row of rows) {
      // Sources spell the same model differently; key rows by the shared form.
      // The day is the row's LOCAL calendar day; the daemon writes created_at_ms
      // on every row, so a null bucket is not expected -- record still totals
      // such a row, just outside the per-day split.
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

/** Sum several usage reports into one (models and days unioned). */
export function mergeUsageReports(reports: Iterable<ReadonlyUsageReport>): UsageReport {
  const merged = usageReport();
  for (const report of reports) {
    // A merge unions two already-consistent reports rather than recording rows:
    // each byModel entry is a full roll-up (its dated rows included), so it
    // folds in day-less, and the per-day split unions day-wise below.
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

/**
 * The share of `byModel` no perDay row accounts for: per model, byModel minus
 * the sum over the days, dropping models the days fully cover. record() folds
 * every dated increment into both maps and sanitizeTokenCount keeps every count
 * an integer, so the difference is exactly the usage recorded with a null day
 * (e.g. a timestamp-less DB row).
 */
export function undatedUsage(report: ReadonlyUsageReport): Map<string, ModelUsage> {
  const rest = new Map<string, ModelUsage>();
  for (const [model, u] of report.byModel) {
    rest.set(model, { ...u });
  }
  for (const dayModels of report.perDay.values()) {
    for (const [model, u] of dayModels) {
      const r = rest.get(model);
      if (r === undefined) {
        // record() and usageReport() put every perDay model in byModel; a miss
        // is a corrupted hand-built report, surfaced rather than papered over.
        throw new Error(`inconsistent usage report: perDay model '${model}' missing from byModel`);
      }
      r.input -= u.input;
      r.output -= u.output;
      r.cacheRead -= u.cacheRead;
      r.cacheCreation -= u.cacheCreation;
      r.events -= u.events;
    }
  }
  for (const [model, r] of rest) {
    // record() and usageReport() keep the split within the roll-up, so a
    // negative remainder can only come from totals past 2^53, where float
    // addition stops being exact; clamp it.
    r.input = Math.max(0, r.input);
    r.output = Math.max(0, r.output);
    r.cacheRead = Math.max(0, r.cacheRead);
    r.cacheCreation = Math.max(0, r.cacheCreation);
    r.events = Math.max(0, r.events);
    if (
      r.input === 0 && r.output === 0 && r.cacheRead === 0 && r.cacheCreation === 0 &&
      r.events === 0
    ) {
      rest.delete(model);
    }
  }
  return rest;
}
