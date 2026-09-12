// Autoupdate state is machine state, not release payload, so it lives clear of the version dirs a
// later update garbage-collects: installStateRoot maps `<top>/current` to `<top>` rather than
// resolving the link into one.
//
//   versioned install  -> `<top>/.autoupdate/`, beside `versions/` (installStateRoot)
//   flat install       -> `<root>/.autoupdate/`
//   dev checkout       -> `<root>/.autoupdate/`
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
