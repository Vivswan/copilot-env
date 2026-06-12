// Read the proxy's per-host SQLite usage tables.
//
// The daemon writes one `token_usage_events` row per request into a per-host
// database (`<home>/.run/<hostname>/copilot-api.sqlite`). Running the proxy on
// several machines therefore yields several DBs; a legacy top-level
// `<home>/copilot-api.sqlite` may also exist from before the per-host split. We
// read all of them read-only and aggregate token counts by model.

// biome-ignore lint/correctness/noUnresolvedImports: `bun:sqlite` is a bun runtime built-in (typed via @types/bun), not a resolvable file.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { consola } from "consola";
import { resolveHome } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";

const DB_FILENAME = "copilot-api.sqlite";

// Raw SQLite open flags. We open via URI (`file:...?immutable=1`) so SQLite
// skips all locking -- the proxy DBs live on NFS where POSIX shared locks
// fail with SQLITE_PROTOCOL ("locking protocol"), and the daemon is actively
// writing to them. `immutable=1` promises SQLite the file won't change for
// the connection's lifetime, which is the right semantic for a best-effort
// reporting snapshot: a concurrent write may yield slightly stale data, but
// never an error.
const SQLITE_OPEN_READONLY = 0x00000001;
const SQLITE_OPEN_URI = 0x00000040;

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
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  events: number;
}

/** Aggregated usage plus the number of distinct UTC days that have data. */
export interface UsageReport {
  byModel: Map<string, ModelUsage>;
  activeDays: number;
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
  const totals = new Map<string, ModelUsage>();
  const activeDays = new Set<string>();
  const since = sinceMs ?? null;

  for (const path of dbPaths) {
    let db: Database | undefined;
    try {
      // Build a proper file URI (pathToFileURL handles Windows drive letters /
      // backslashes); immutable=1 skips locking for this read-only snapshot.
      db = new Database(
        `${pathToFileURL(path).href}?immutable=1`,
        SQLITE_OPEN_READONLY | SQLITE_OPEN_URI,
      );
      const rows = db
        .query(
          `SELECT model,
                  SUM(input_tokens)                 AS input,
                  SUM(output_tokens)                AS output,
                  SUM(cache_read_input_tokens)      AS cacheRead,
                  SUM(cache_creation_input_tokens)  AS cacheCreation,
                  COUNT(*)                          AS events
           FROM token_usage_events
           WHERE (?1 IS NULL OR created_at_ms >= ?1)
           GROUP BY model`,
        )
        .all(since) as UsageRow[];

      for (const row of rows) {
        const prev = totals.get(row.model) ?? {
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
        totals.set(row.model, prev);
      }

      // Distinct UTC calendar days with data, unioned across all DBs.
      const dayRows = db
        .query(
          `SELECT DISTINCT substr(created_at_utc, 1, 10) AS day
           FROM token_usage_events
           WHERE (?1 IS NULL OR created_at_ms >= ?1)`,
        )
        .all(since) as Array<{ day: string }>;
      for (const { day } of dayRows) {
        if (day) {
          activeDays.add(day);
        }
      }
    } catch (e) {
      consola.warn(`could not read ${path} (${errMessage(e)}).`);
    } finally {
      db?.close();
    }
  }

  return { byModel: totals, activeDays: activeDays.size };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
