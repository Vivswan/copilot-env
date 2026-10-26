// A dry run, entered once per command: every call on the fs seam (src/utils/fs_facade.ts) lands in
// an overlay, and at the end the overlay is diffed against the disk into the changes the command
// prints. The marker a run hands its child processes lives here too: a child that finds it runs as
// a silent dry run, so nothing this CLI does on the child's behalf lands behind the preview.
//
// PLANNED_SECRET stands in for a secret the run never acquires. A store leaf holding it is redacted
// like any secret, so it never prints, and nothing in the same run may bake or send it: a Direct
// wiring or a model discovery planned from it would select nothing.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { diffOverlay, type FileChange } from "./dry_run_report.ts";
import { probeFileLock, withFileLock } from "./file_lock.ts";
import { removeScratchDir, type ScratchDir, underOverlay } from "./fs_facade.ts";
import { trackScratch } from "./report_write.ts";

export type { FileChange };

/** A body that fails partway has planned what precedes the failure, as the real command would have
 *  landed it, so the changes travel with the error instead of being lost to a throw. */
type DryRunOutcome<T> =
  | { status: "done"; result: T; changes: FileChange[] }
  | { status: "failed"; error: unknown; changes: FileChange[] };

export async function withDryRun<T>(body: () => Promise<T>): Promise<DryRunOutcome<T>> {
  const run = await underOverlay(body);
  const changes = diffOverlay(run.overlay);
  return run.status === "done"
    ? { status: "done", result: run.result, changes }
    : { status: "failed", error: run.error, changes };
}

/** The value a dry run lands in place of a secret it never acquires (a login that did not run). */
export const PLANNED_SECRET = "<the value the real run lands>";

/** The error a dry run raises where the real command would prompt: a preview never asks, and
 *  guessing the answer would plan a run the user did not choose. `what` names the question. */
export function promptRefusedInDryRun(what: string): Error {
  return new Error(
    `a dry run never prompts (${what}); pass the flag that answers it, or run for real`,
  );
}

// --- the marker a run hands its children ---------------------------------------------------------

/** Exported to every process a dry run spawns, so the child runs as a silent dry run too. */
export const DRY_RUN_ENV = "COPILOT_ENV_DRY_RUN";

/** A marker directory's name is this prefix and a fresh 32-hex nonce (DRY_RUN_MARKER_NAME). */
const DRY_RUN_MARKER_PREFIX = "copilot-env-dry-run-";

/** What spawnedByDryRun accepts as a marker's name; any other value names nothing. */
const DRY_RUN_MARKER_NAME = new RegExp(`^${DRY_RUN_MARKER_PREFIX}[0-9a-f]{32}$`);

/** The lock file inside the marker the minting run holds. */
const DRY_RUN_MARKER_HOLD = "held";

/**
 * Runs `body` with a dry run's marker minted, held, and exported (DRY_RUN_ENV), so every process
 * the body spawns (the Direct probes' agent CLIs, whose auth helper is this CLI again) inherits it
 * and runs as a silent dry run: nothing this CLI does on the child's behalf lands behind the plan
 * either. When the body ends the lock is released, the marker removed, and the variable restored,
 * so no value outlives the run that minted it. The marker is real disk (a child probes its lock),
 * so it is minted beside the seam, never through it.
 *
 * The value is the marker's path: a scratch directory named with a fresh nonce, whose hold file
 * this run keeps as its lock (src/utils/file_lock.ts: the file names the minting pid) for as long
 * as it collects. A child honours the value only while the process the hold names lives
 * (spawnedByDryRun), so a value that reached an environment any other way (`=1` exported in a
 * shell, a pid, a nonce with no run behind it, a directory made by hand, a marker a crashed run
 * left behind) names nothing and changes nothing.
 */
export async function underDryRunMarker<T>(body: () => Promise<T>): Promise<T> {
  const marker = join(
    tmpdir(),
    `${DRY_RUN_MARKER_PREFIX}${randomBytes(16).toString("hex")}`,
  ) as ScratchDir;
  mkdirSync(marker, { mode: 0o700 });
  trackScratch(marker);
  try {
    // A fresh nonce has no holder; the one refusal is the lock's own I/O.
    return await withFileLock(
      join(marker, DRY_RUN_MARKER_HOLD),
      { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 },
      async (outcome) => {
        if (!outcome.held) {
          throw new Error(`the dry-run marker ${marker} could not be held`, {
            cause: outcome.reason === "unavailable" ? outcome.cause : undefined,
          });
        }
        const inherited = process.env[DRY_RUN_ENV];
        process.env[DRY_RUN_ENV] = marker;
        try {
          return await body();
        } finally {
          if (inherited === undefined) delete process.env[DRY_RUN_ENV];
          else process.env[DRY_RUN_ENV] = inherited;
        }
      },
    );
  } finally {
    removeScratchDir(marker);
  }
}

/** Whether `env` carries a dry run's marker this process must honour (see DRY_RUN_ENV). */
export function spawnedByDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DRY_RUN_ENV];
  if (value === undefined || !isAbsolute(value) || !DRY_RUN_MARKER_NAME.test(basename(value))) {
    return false;
  }
  return markerHeld(value);
}

/** Only a hold file naming a live process reads held: a directory made by hand, a run that ended
 *  or crashed, and a hold file that cannot be read are no marker. A pid this process cannot probe
 *  is no marker either: a child that then wrote for real would be the child of no run of ours. */
function markerHeld(marker: string): boolean {
  return probeFileLock(join(marker, DRY_RUN_MARKER_HOLD)).kind === "held";
}
