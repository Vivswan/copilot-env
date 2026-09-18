// The migration runner: selects and runs version-to-version fix-ups after an update. Reached
// through `agent migrate <from> <to>`: runPostFlipMigrations (src/install/installer.ts) spawns it
// on the NEW binary after `agent update` or a reinstall flips `current`, so the migrations load
// from the new code, not the already-running old process. A dev checkout may run it directly:
//   deno run -P=cli src/migrations/index.ts <fromVersion> <toVersion>
import "../utils/dotenv.ts";
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { configureConsolaOutput } from "../utils/logger.ts";
import { type SemverString, stripV, toSemverString, versionLessThan } from "../utils/semver.ts";
import { v400AutoupdateFlag, v400ClaudeWiring, v400CodexWiring, v400ShellFence } from "./4.0.0.ts";
import { v402DesktopHelpers, v402GhAccountPin, v402RootLayout } from "./4.0.2.ts";
import {
  v409CodexProfileFiles,
  v409IdentityCache,
  v409IntegrationIdPin,
  v409LaunchersBlock,
  v409RootDaemonHome,
  v409StateFold,
  v409StaticKeyScope,
} from "./4.0.9.ts";
import { dryRunActive } from "../utils/fs_facade.ts";

/** One step, named for the release it migrates AWAY FROM (authored against the current release,
 *  with no future number to predict). It runs when an update leaves that version behind:
 *  oldVersion <= version < newVersion. `run` must be IDEMPOTENT: an update can be retried. */
export interface Migration {
  /** The release this migrates away from, as a bare "X.Y.Z" (the file name). */
  version: SemverString;
  /** One line shown when the migration runs. */
  description: string;
  /** This step RELOCATES the shared stores the others read. dueMigrations hoists every selected
   *  layout step to the FRONT of the run, ahead of older versions' steps too, which read those
   *  stores through the NEW code and so at the new paths. Version-then-registry order still
   *  applies within each half. */
  layout?: true;
  run: () => void | Promise<void>;
}

/** Ascending version order; a release with several INDEPENDENT fix-ups registers them all under
 *  its version, and registry order is their run order within it. The earliest step leaves 4.0.0:
 *  an install older than that is not migrated (reinstall). */
const MIGRATIONS: Migration[] = [
  v400ShellFence,
  v400CodexWiring,
  v400ClaudeWiring,
  v400AutoupdateFlag,
  v402GhAccountPin,
  v402RootLayout,
  v402DesktopHelpers,
  v409StateFold,
  v409RootDaemonHome,
  v409CodexProfileFiles,
  v409IntegrationIdPin,
  v409StaticKeyScope,
  v409IdentityCache,
  v409LaunchersBlock,
];

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

/** The migrations whose version falls in [from, to): every version an update from `from` to
 *  `to` leaves behind, layout steps first (Migration.layout), then version-ascending. Pure and
 *  exported so the selection is unit-tested without running one. `from`/`to` may carry a
 *  leading "v". */
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
  // Equal ranks compare 0: Array.sort is stable, so within a version the
  // registry order is the run order.
  const layoutRank = (m: Migration) => (m.layout === true ? 0 : 1);
  return migrations
    .filter((m) => !versionLessThan(m.version, f) && versionLessThan(m.version, t))
    .sort((a, b) =>
      layoutRank(a) - layoutRank(b) ||
      (versionLessThan(a.version, b.version) ? -1 : versionLessThan(b.version, a.version) ? 1 : 0)
    );
}

/** Best-effort: a failing migration warns and the rest still run; migrations must never abort
 *  an otherwise-successful update. `migrations` is the test seam, as for dueMigrations. */
export async function runMigrations(
  from: string,
  to: string,
  migrations: Migration[] = MIGRATIONS,
): Promise<void> {
  const due = dueMigrations(from, to, migrations);
  if (due.length === 0) return;
  consola.info(`Running ${due.length} migration(s): ${stripV(from)} -> ${stripV(to)}`);
  const preview = dryRunActive();
  for (const m of due) {
    consola.start(`${preview ? "Would migrate" : "Migrating"} from ${m.version}: ${m.description}`);
    try {
      // A dry run runs the step too: its moves and removals record through the seam and print as
      // the plan; nothing lands. The step narrates as it runs (a skip says what to do next), so a
      // preview hears the step's own lines under its "Would migrate" header.
      await m.run();
      if (!preview) consola.success(`Migration ${m.version} complete.`);
    } catch (e) {
      consola.warn(
        `Migration ${m.version} did not complete (non-fatal): ${errMessage(e)}. ` +
          `Re-run it with \`agent migrate ${stripV(from)} ${stripV(to)}\` once fixed.`,
      );
    }
  }
}

// Guarded by import.meta.main so importing the registry never executes the runner.
if (import.meta.main) {
  configureConsolaOutput();
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
