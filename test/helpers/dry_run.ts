// What a run changed on disk, and what a dry run says it would have: the before/after tree
// fingerprint, the recorded plan of a `--dry-run` body, and the one-line-per-path narration.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type FileChange, withDryRun } from "../../src/utils/dry_run.ts";

/** Every entry under and including `dir`: a file by identity, size, mode, and mtime, a directory
 *  by identity, mode, and mtime, so a write, a create, a delete, a chmod, or a file created and
 *  deleted inside a run (its parent's mtime moves) anywhere in the tree changes the picture. */
export function fingerprintTree(dir: string, out = new Map<string, string>()): Map<string, string> {
  const stamp = (path: string): boolean => {
    const stat = lstatSync(path);
    out.set(
      path,
      stat.isDirectory()
        ? `d:${stat.ino}:${stat.mode}:${stat.mtimeMs}`
        : `f:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}`,
    );
    return stat.isDirectory();
  };
  if (out.size === 0) stamp(dir);
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (stamp(path)) fingerprintTree(path, out);
  }
  return out;
}

/** The paths a real run changed between two fingerprints (created, rewritten, or deleted), minus
 *  the lock protocol's sidecars and the atomic writer's staging files the run itself minted (a
 *  lock or staging file that existed before and changed, a migration's deleted lock, counts). Final
 *  state only: a create-then-delete inside the run is invisible to a before/after look. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): Set<string> {
  // A directory whose only change is its mtime was not written: a child was, and the child is
  // listed on its own.
  const norm = (stamp: string): string =>
    stamp.startsWith("d:") ? stamp.replace(/:[^:]*$/, "") : stamp;
  const changed = new Set<string>();
  for (const [path, stamp] of after) {
    const was = before.get(path);
    if (was === undefined || norm(was) !== norm(stamp)) changed.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  for (const path of changed) {
    if (/\.lock$|\.oslock$|\.tmp\.\d+$/.test(path) && !before.has(path)) changed.delete(path);
  }
  return changed;
}

/** "One line per written path" means this equals exactly the seam's one line: a narrative line
 *  beside it shows up here. */
export function linesNaming(text: string, path: string): string[] {
  return text.split("\n").filter((line) => line.includes(path));
}

/** `body` run as a dry run: the tree diff it would print and its result; a body that fails
 *  rethrows, as the command does. */
export async function dryRunChanges<T>(
  body: () => Promise<T>,
): Promise<{ changes: FileChange[]; result: T }> {
  const run = await withDryRun(body);
  if (run.status === "failed") throw run.error;
  return { changes: run.changes, result: run.result };
}
