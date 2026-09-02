// Filesystem paths for the opt-in autoupdate state, under the install root.
//
// State lives in `<install>/.autoupdate/`. In a VERSIONED install the state is
// machine state, not release payload, so it sits beside `versions/` at the TOP
// root (installStateRoot) -- never inside a version dir a later update
// garbage-collects, and never through the `current` link (which would resolve
// into one). A flat install and a dev checkout keep it at the root itself.
import { join } from "node:path";
import { installStateRoot, PROJECT_ROOT } from "../utils/root.ts";

/** The autoupdate state directory: `<install>/.autoupdate`. */
export function autoupdateDir(root: string = PROJECT_ROOT): string {
  return join(installStateRoot(root), ".autoupdate");
}

/** Persistent autoupdate state file (JSON). */
export function autoupdateStateFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), "state.json");
}

/** Lock file guarding concurrent preflight updates. */
export function autoupdateLockFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), "update.lock");
}
