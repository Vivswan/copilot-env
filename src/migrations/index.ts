// Migration runner: selects and executes version-to-version fixups after update.
//
// Run via the hidden `agent __migrate <fromVersion> <toVersion>` subcommand -- a compiled
// binary has no source file on disk to spawn, so the runner is reached through the CLI.
// Direct run still works in a dev checkout:
//   deno run -P=cli src/migrations/index.ts <fromVersion> <toVersion>
//
// Arguments:
//   <fromVersion>  Version being updated away from, with or without a leading v.
//   <toVersion>    Version being updated to, with or without a leading v.
//
// `agent update` invokes this after swapping in the new release so migrations load from
// the new code rather than from the already-running old update process.
import "../utils/dotenv.ts";
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { disableConsolaTimestamps } from "../utils/logger.ts";
import { stripV, versionLessThan } from "../utils/semver.ts";

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

/**
 * One file per version step (named for the from-version), registered in ascending order;
 * `dueMigrations` re-sorts defensively, so order here is for readability only.
 *
 * EMPTY BY DESIGN. Every step shipped before the deno rewrite was deleted. They are
 * unreachable because the rewrite is a hard runtime break, not because of their version
 * range: a pre-rewrite install runs the OLD updater, which shells out to bun, and this
 * tree cannot execute under bun at all. Nothing that could still be due can reach here.
 *
 * Each deleted step's persisted-state fix was checked first and was re-derivable by
 * `agent init` / `auth` / `claude` / `shell`, or self-healing on the catalog sync timer;
 * none was the only reader of a format the current code cannot parse. Add the next step
 * here as `[v360]` when one is needed.
 */
const MIGRATIONS: Migration[] = [];

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
 * still run -- migrations must never abort an otherwise-successful update. `migrations`
 * is the injection seam for tests, matching `dueMigrations`.
 */
export async function runMigrations(
  from: string,
  to: string,
  migrations: Migration[] = MIGRATIONS,
): Promise<void> {
  const due = dueMigrations(from, to, migrations);
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

// Runnable entry for a dev checkout. `agent update` normally reaches the runner through
// the hidden `agent __migrate` subcommand instead -- this process still holds the
// pre-update code in memory, so the new migration set must load from the new release.
// Guarded by import.meta.main so importing this module (registry/dueMigrations/CLI) never
// executes it.
//   deno run -P=cli src/migrations/index.ts <fromVersion> <toVersion>
if (import.meta.main) {
  disableConsolaTimestamps();
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    consola.error("usage: deno run -P=cli src/migrations/index.ts <fromVersion> <toVersion>");
    process.exitCode = 2;
  } else {
    runMigrations(from, to).catch((e: unknown) => {
      consola.error(errMessage(e));
      process.exitCode = 1;
    });
  }
}
