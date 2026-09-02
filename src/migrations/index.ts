// Migration runner: selects and executes version-to-version fixups after update.
//
// Run via the `agent migrate <fromVersion> <toVersion>` subcommand -- a compiled
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
import { type SemverString, stripV, toSemverString, versionLessThan } from "../utils/semver.ts";
import { v356, v356DefaultSlot, v356Ownership, v356VersionedLayout } from "./3.5.6.ts";

/**
 * One step in the version history, named for the release it migrates AWAY FROM (so a
 * migration is authored against the current released version -- no need to predict the
 * future release number). It runs when an update leaves that version behind: oldVersion
 * <= version < newVersion. Keep `run` IDEMPOTENT: an update can be retried, and a
 * migration may run more than once.
 */
export interface Migration {
  /** The release this migrates away from, as a bare "X.Y.Z" (the file name). */
  version: SemverString;
  /** One line shown when the migration runs. */
  description: string;
  run: () => void | Promise<void>;
}

/**
 * One file per version step (named for the from-version), registered in ascending order.
 * A release that needs several INDEPENDENT fix-ups registers them all under its version
 * (still in that one file); registry order is their run order -- dueMigrations sorts
 * across versions but keeps registry order within one.
 *
 * Every step shipped before the deno rewrite was deleted: a pre-rewrite install runs the
 * OLD bun-based updater, which cannot even load this file (its first import reaches
 * `@std/dotenv`, a jsr specifier only deno's import map resolves), so no historical step
 * could still be reached. Each deleted step's persisted-state fix was re-derivable by
 * `agent init` / `auth` / `claude` / `shell`, or self-healing on the catalog sync timer.
 */
const MIGRATIONS: Migration[] = [v356, v356Ownership, v356DefaultSlot, v356VersionedLayout];

// versionLessThan tolerates unparseable input by answering "not less-than", so a
// garbage version on either side of the range filter silently empties or floods the
// selection instead of failing. Every version entering dueMigrations goes through here.
function requireSemver(value: string, what: string): SemverString {
  const parsed = toSemverString(value);
  if (parsed === null) {
    throw new Error(`migrate: ${what} "${value}" is not a semver version`);
  }
  return parsed;
}

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
  // The Migration type already demands a version-shaped literal; this catches a cast.
  for (const m of migrations) {
    requireSemver(m.version, `registry version (${m.description})`);
  }
  const f = requireSemver(from, "from version");
  const t = requireSemver(to, "to version");
  // Equal versions (one release's several fix-ups) compare 0: Array.sort is
  // stable, so their registry order is their run order.
  return migrations
    .filter((m) => !versionLessThan(m.version, f) && versionLessThan(m.version, t))
    .sort((a, b) =>
      versionLessThan(a.version, b.version) ? -1 : versionLessThan(b.version, a.version) ? 1 : 0
    );
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
// the `agent migrate` subcommand instead -- this process still holds the
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
