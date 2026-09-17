// Autoupdate state is machine state, not release payload, so it lives clear of the version dirs a
// later update garbage-collects: installStateRoot maps `<top>/current` to `<top>` rather than
// resolving the link into one.
//
//   versioned install  -> `<top>/.autoupdate/`, beside `versions/` (installStateRoot)
//   dev checkout       -> `<root>/.autoupdate/`
import { join } from "node:path";
import { installStateRoot, PROJECT_ROOT } from "../utils/root.ts";

/** The autoupdate state directory: `<install>/.autoupdate`. */
export function autoupdateDir(root: string = PROJECT_ROOT): string {
  return join(installStateRoot(root), ".autoupdate");
}

/** The autoupdate throttle file's basename: named for what it holds, not "state" (that word is
 *  the account-wide store's, src/copilot_api/state_store.ts). */
export const AUTOUPDATE_FILENAME = "autoupdate.json";

/** Persistent autoupdate throttle file (JSON): `<install>/.autoupdate/autoupdate.json`. */
export function autoupdateStateFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), AUTOUPDATE_FILENAME);
}

/** Lock file guarding concurrent preflight updates. */
export function autoupdateLockFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), "update.lock");
}
