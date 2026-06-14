// Migration runner: selects and executes version-to-version fixups after update.
//
// Direct run:
//   bun src/migrations/index.ts <fromVersion> <toVersion>
//
// Arguments:
//   <fromVersion>  Version being updated away from, with or without a leading v.
//   <toVersion>    Version being updated to, with or without a leading v.
//
// `agent update` spawns this after swapping in the new release so migrations load
// from the new code on disk instead of the already-running old update process.
import "../utils/dotenv.ts";
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { disableConsolaTimestamps } from "../utils/logger.ts";
import { stripV, versionLessThan } from "../utils/semver.ts";
import { migration as v121 } from "./1.2.1.ts";
import { migration as v320 } from "./3.2.0.ts";
import { migration as v333 } from "./3.3.3.ts";
import { migration as v336 } from "./3.3.6.ts";

/**
 * One step in the version history, named for the release it migrates AWAY FROM (so a
 * migration is authored against the current released version -- no need to predict the
 * future release number). It runs when an update leaves that version behind: oldVersion
 * <= version < newVersion. Keep `run` IDEMPOTENT: an update can be retried, and a
 * migration may run more than once.
 */
export interface Migration {
  /** The release this migrates away from, as a bare "X.Y.Z" (the file name). */
  version: string;
  /** One line shown when the migration runs. */
  description: string;
  run: () => void | Promise<void>;
}

// One file per version step (named for the from-version), registered in ascending order;
// `dueMigrations` re-sorts defensively, so order here is for readability only.
const MIGRATIONS: Migration[] = [v121, v320, v333, v336];

/**
 * The migrations whose (from-)version falls in the half-open range [from, to), sorted
 * ascending -- i.e. every version left behind by an update from `from` to `to`. Pure (no
 * side effects) and exported so the selection logic is unit-tested without running any
 * migration. `from`/`to` may carry a leading "v".
 */
export function dueMigrations(
  from: string,
  to: string,
  migrations: Migration[] = MIGRATIONS,
): Migration[] {
  const f = stripV(from);
  const t = stripV(to);
  return migrations
    .filter((m) => !versionLessThan(m.version, f) && versionLessThan(m.version, t))
    .sort((a, b) => (versionLessThan(a.version, b.version) ? -1 : 1));
}

/**
 * Run every due migration in order. Best-effort: a failing migration warns and the rest
 * still run -- migrations must never abort an otherwise-successful update.
 */
export async function runMigrations(from: string, to: string): Promise<void> {
  const due = dueMigrations(from, to);
  if (due.length === 0) return;
  consola.info(`Running ${due.length} migration(s): ${stripV(from)} -> ${stripV(to)}`);
  for (const m of due) {
    consola.start(`Migrating from ${m.version}: ${m.description}`);
    try {
      await m.run();
      consola.success(`Migration ${m.version} complete.`);
    } catch (e) {
      consola.warn(`Migration ${m.version} did not complete (non-fatal): ${errMessage(e)}`);
    }
  }
}

// Runnable entry: `agent update` spawns this in a FRESH process after swapping in the new
// release -- the running update.ts still holds the pre-update code in memory, so the new
// migration set (and the code it calls) must load from disk. Guarded by import.meta.main
// so importing this module (registry/dueMigrations) never executes it.
//   bun src/migrations/index.ts <fromVersion> <toVersion>
if (import.meta.main) {
  disableConsolaTimestamps();
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    consola.error("usage: bun src/migrations/index.ts <fromVersion> <toVersion>");
    process.exitCode = 2;
  } else {
    runMigrations(from, to).catch((e: unknown) => {
      consola.error(errMessage(e));
      process.exitCode = 1;
    });
  }
}
