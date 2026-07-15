// Read the proxy's per-host SQLite usage tables.
//
// The daemon writes one `token_usage_events` row per request into a per-host
// database (`<home>/.run/<hostname>/copilot-api.sqlite`). Running the proxy on
// several machines therefore yields several DBs; a legacy top-level
// `<home>/copilot-api.sqlite` may also exist from before the per-host split. We
// read all of them read-only and aggregate token counts by model.

// biome-ignore lint/correctness/noUnresolvedImports: `bun:sqlite` is a bun runtime built-in (typed via @types/bun), not a resolvable file.
import { constants, Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { consola } from "consola";
import { resolveHome } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import { isDir } from "../utils/fs.ts";

const DB_FILENAME = "copilot-api.sqlite";

/** Per-model token totals, summed across every DB. */
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  events: number;
}

/** One aggregated `token_usage_events` row as returned by the grouped query. */
interface UsageRow {
  day: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  events: number;
}

/**
 * Aggregated usage plus a per-day breakdown.
 *
 * `perDay` maps each distinct UTC calendar day (YYYY-MM-DD) to that day's
 * per-model token totals, unioned across every DB. `byModel` is the all-days
 * roll-up and `activeDays` is `perDay.size` -- both derived from the same rows,
 * kept as fields so callers don't recompute them.
 */
export interface UsageReport {
  byModel: Map<string, ModelUsage>;
  activeDays: number;
  perDay: Map<string, Map<string, ModelUsage>>;
}

/**
 * Locate every usage DB under `home`: the legacy top-level file plus one per
 * host directory under `.run/`. Only paths that exist on disk are returned.
 */
export function discoverUsageDbs(home: string = resolveHome()): string[] {
  const paths: string[] = [];

  const legacy = join(home, DB_FILENAME);
  if (existsSync(legacy)) {
    paths.push(legacy);
  }

  const runDir = join(home, ".run");
  let hosts: string[] = [];
  try {
    hosts = readdirSync(runDir);
  } catch {
    hosts = []; // no .run dir yet
  }
  for (const host of hosts) {
    const candidate = join(runDir, host, DB_FILENAME);
    if (isDir(join(runDir, host)) && existsSync(candidate)) {
      paths.push(candidate);
    }
  }

  return paths;
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

  // Fold one grouped row into a model->usage map (the all-days roll-up or a
  // single day's bucket), summing across DBs that share a model.
  const accumulate = (target: Map<string, ModelUsage>, row: UsageRow): void => {
    const prev = target.get(row.model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      events: 0,
    };
    prev.input += row.input ?? 0;
    prev.output += row.output ?? 0;
    prev.cacheRead += row.cacheRead ?? 0;
    prev.cacheCreation += row.cacheCreation ?? 0;
    prev.events += row.events ?? 0;
    target.set(row.model, prev);
  };

  // One grouped query by (day, model); byModel and activeDays both derive from it, so we
  // never read the same rows twice.
  const QUERY = `SELECT substr(created_at_utc, 1, 10)     AS day,
                  model,
                  SUM(input_tokens)                 AS input,
                  SUM(output_tokens)                AS output,
                  SUM(cache_read_input_tokens)      AS cacheRead,
                  SUM(cache_creation_input_tokens)  AS cacheCreation,
                  COUNT(*)                          AS events
           FROM token_usage_events
           WHERE (?1 IS NULL OR created_at_ms >= ?1)
           GROUP BY day, model`;

  for (const path of dbPaths) {
    // The daemon runs the usage DB in WAL mode and only checkpoints on close, so rows written
    // since the last checkpoint live in the -wal file. Open read-only WITHOUT `immutable` so
    // SQLite consults the -wal (an immutable open ignores it -- undercounting recent usage, or
    // "no such table" on a fresh DB whose schema is still only in the WAL). SQLite can defer a
    // WAL/-shm error to query PREPARE/EXEC time, so the immutable fallback wraps the WHOLE
    // open+query, not just the open: a read-only-FS DB where the -shm can't be created falls
    // back to an immutable snapshot (misses un-checkpointed rows, but beats failing the report).
    // pathToFileURL handles Windows drive letters / backslashes.
    const uri = pathToFileURL(path).href;
    let rows: UsageRow[] | undefined;
    let lastErr: unknown;
    for (const dbUri of [uri, `${uri}?immutable=1`]) {
      let db: Database | undefined;
      try {
        db = new Database(dbUri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
        rows = db.query(QUERY).all(since) as UsageRow[];
        break;
      } catch (e) {
        lastErr = e;
      } finally {
        db?.close();
      }
    }
    if (rows === undefined) {
      consola.warn(`could not read ${path} (${errMessage(lastErr)}).`);
      continue;
    }

    for (const row of rows) {
      accumulate(byModel, row);
      // Distinct UTC calendar days with data, unioned across all DBs. The
      // daemon writes created_at_utc alongside created_at_ms on every row, so
      // a null/empty day is not expected; such a row still counts toward
      // byModel (the aggregate total) but is omitted from the per-day split.
      if (row.day) {
        let dayModels = perDay.get(row.day);
        if (dayModels === undefined) {
          dayModels = new Map<string, ModelUsage>();
          perDay.set(row.day, dayModels);
        }
        accumulate(dayModels, row);
      }
    }
  }

  return { byModel, activeDays: perDay.size, perDay };
}

/** Sum several usage reports into one (models and days unioned). */
export function mergeUsageReports(reports: Iterable<UsageReport>): UsageReport {
  const byModel = new Map<string, ModelUsage>();
  const perDay = new Map<string, Map<string, ModelUsage>>();
  const add = (target: Map<string, ModelUsage>, model: string, u: ModelUsage): void => {
    const prev = target.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      events: 0,
    };
    prev.input += u.input;
    prev.output += u.output;
    prev.cacheRead += u.cacheRead;
    prev.cacheCreation += u.cacheCreation;
    prev.events += u.events;
    target.set(model, prev);
  };
  for (const report of reports) {
    for (const [model, u] of report.byModel) {
      add(byModel, model, u);
    }
    for (const [day, dayModels] of report.perDay) {
      let target = perDay.get(day);
      if (target === undefined) {
        target = new Map<string, ModelUsage>();
        perDay.set(day, target);
      }
      for (const [model, u] of dayModels) {
        add(target, model, u);
      }
    }
  }
  return { byModel, activeDays: perDay.size, perDay };
}
