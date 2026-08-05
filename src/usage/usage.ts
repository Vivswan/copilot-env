// Read the proxy's per-host SQLite usage tables.
//
// The daemon writes one `token_usage_events` row per request into a per-host
// database (`<home>/.run/<hostname>/copilot-api.sqlite`). Running the proxy on
// several machines therefore yields several DBs; a legacy top-level
// `<home>/copilot-api.sqlite` may also exist from before the per-host split. We
// read all of them read-only and aggregate token counts by model. The DB layout
// itself is owned by src/copilot_api/paths.ts; this module only sweeps it.

// biome-ignore lint/correctness/noUnresolvedImports: `bun:sqlite` is a bun runtime built-in (typed via @types/bun), not a resolvable file.
import { constants, Database } from "bun:sqlite";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { consola } from "consola";
import { PROFILES_DIR_NAME, resolveHome, usageDbsUnderHome } from "../copilot_api/paths.ts";
import { isValidProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";
import { localDayKey } from "../utils/time.ts";
import { canonicalModelName } from "./pricing.ts";

/** The four priced token buckets every usage source reduces one event to. */
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Clamp one raw token count for the report: only a finite positive number passes.
 *  Non-finite or negative counts (hostile or torn lines) never enter a report --
 *  the ONE sanitization rule every session reader applies to its buckets. */
export function sanitizeTokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Per-model token totals, summed across every DB. */
export interface ModelUsage extends TokenBuckets {
  events: number;
}

/** One aggregated `token_usage_events` row as returned by the grouped query. The SUM()
 *  columns and the bucket are null when a group has no non-null inputs. */
interface UsageRow {
  bucket: number | null;
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  events: number;
}

/**
 * Aggregated usage plus a per-day breakdown.
 *
 * `perDay` maps each distinct LOCAL calendar day (YYYY-MM-DD, the user's
 * timezone) to that day's per-model token totals, unioned across every DB.
 * `byModel` is the all-days roll-up -- derived from the same rows, kept as a
 * field so callers don't recompute it. The active-day count is `perDay.size`,
 * always read from the map itself.
 */
export interface UsageReport {
  byModel: Map<string, ModelUsage>;
  perDay: Map<string, Map<string, ModelUsage>>;
}

/**
 * Fold one source's token buckets into a model->usage map, seeding a zero-valued record
 * the first time a model appears. `events` is this occurrence's event-count increment (a
 * grouped SQL row carries its COUNT, a session line counts 1, a streaming delta 0). The
 * ONE fold every usage source shares -- add a token bucket here and every source folds it.
 */
export function addUsage(
  target: Map<string, ModelUsage>,
  model: string,
  buckets: TokenBuckets,
  events: number,
): void {
  const prev = target.get(model) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 0,
  };
  prev.input += buckets.input;
  prev.output += buckets.output;
  prev.cacheRead += buckets.cacheRead;
  prev.cacheCreation += buckets.cacheCreation;
  prev.events += events;
  target.set(model, prev);
}

/** addUsage into the per-day split: fold into `perDay[day]`, creating the day's
 *  model->usage map the first time that day appears. */
export function addDayUsage(
  perDay: Map<string, Map<string, ModelUsage>>,
  day: string,
  model: string,
  buckets: TokenBuckets,
  events: number,
): void {
  let dayModels = perDay.get(day);
  if (dayModels === undefined) {
    dayModels = new Map<string, ModelUsage>();
    perDay.set(day, dayModels);
  }
  addUsage(dayModels, model, buckets, events);
}

/**
 * Locate every usage DB under `home`: the root daemon home's DBs (legacy
 * top-level file plus one per host directory under `.run/`) AND every named
 * profile daemon's isolated home under `<home>/profiles/<name>` -- each profile
 * proxy records its own traffic in its own DB, and the cost report covers all
 * of them. Only valid profile names are swept (a stray hand-made folder is not
 * a daemon home), and the result is realpath-deduped so a symlinked alias can
 * never double-count a DB. Only paths that exist on disk are returned.
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
    if (!isValidProfileName(profile)) continue;
    const profileHome = join(profilesDir, profile);
    if (isDir(profileHome)) {
      paths.push(...usageDbsUnderHome(profileHome));
    }
  }

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

/**
 * Open `path` read-only and run `query` against it, preferring a WAL-aware open.
 * The daemon runs the DB in WAL mode and only checkpoints on close, so a plain
 * read-only open (which consults the -wal) comes first; if the open OR the query
 * fails (SQLite can defer a WAL/-shm error to prepare/exec time, e.g. a read-only
 * FS where the -shm can't be created), retry as an `immutable=1` snapshot --
 * missing un-checkpointed rows beats failing the report. Throws the last error
 * when both attempts fail.
 */
function openSqliteReadOnlyWithWalFallback<T>(path: string, query: (db: Database) => T): T {
  // pathToFileURL handles Windows drive letters / backslashes.
  const uri = pathToFileURL(path).href;
  let lastErr: unknown;
  for (const dbUri of [uri, `${uri}?immutable=1`]) {
    let db: Database | undefined;
    try {
      db = new Database(dbUri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
      return query(db);
    } catch (e) {
      lastErr = e;
    } finally {
      db?.close();
    }
  }
  throw lastErr;
}

/**
 * Open each DB read-only and aggregate token usage by model. `sinceMs` (unix
 * ms) bounds the query to recent rows when set. A DB that fails to open or query
 * is skipped with a warning rather than aborting the whole report.
 */
export function readUsage(dbPaths: string[], sinceMs?: number): UsageReport {
  const byModel = new Map<string, ModelUsage>();
  const perDay = new Map<string, Map<string, ModelUsage>>();
  const since = sinceMs ?? null;

  // Normalize one grouped row's nullable SUM columns into the shared fold's buckets.
  const rowBuckets = (row: UsageRow): TokenBuckets => ({
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cacheRead ?? 0,
    cacheCreation: row.cacheCreation ?? 0,
  });

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
        (db) => db.query(QUERY).all(since) as UsageRow[],
      );
    } catch (e) {
      consola.warn(`could not read ${path} (${errMessage(e)}).`);
      continue;
    }

    for (const row of rows) {
      // Sources spell the same model differently; key rows by the shared form.
      const model = canonicalModelName(row.model);
      const buckets = rowBuckets(row);
      addUsage(byModel, model, buckets, row.events ?? 0);
      // Distinct LOCAL calendar days with data, unioned across all DBs. The
      // daemon writes created_at_ms on every row, so a null bucket is not
      // expected; such a row still counts toward byModel (the aggregate total)
      // but is omitted from the per-day split.
      if (row.bucket !== null) {
        addDayUsage(perDay, localDayKey(row.bucket * MINUTE_MS), model, buckets, row.events ?? 0);
      }
    }
  }

  return { byModel, perDay };
}

/** Sum several usage reports into one (models and days unioned). */
export function mergeUsageReports(reports: Iterable<UsageReport>): UsageReport {
  const byModel = new Map<string, ModelUsage>();
  const perDay = new Map<string, Map<string, ModelUsage>>();
  for (const report of reports) {
    for (const [model, u] of report.byModel) {
      addUsage(byModel, model, u, u.events);
    }
    for (const [day, dayModels] of report.perDay) {
      // A day with an empty model map still counts as active in the union.
      if (!perDay.has(day)) perDay.set(day, new Map());
      for (const [model, u] of dayModels) {
        addDayUsage(perDay, day, model, u, u.events);
      }
    }
  }
  return { byModel, perDay };
}
