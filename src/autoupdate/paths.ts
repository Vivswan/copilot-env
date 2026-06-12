// Filesystem paths for the opt-in autoupdate state, under the install checkout.
//
// State lives in `<PROJECT_ROOT>/.autoupdate/` (the install dir, default
// ~/.copilot-env). That directory is overwritten by `agent update` and the
// installers, so `.autoupdate` is added to the updater's PRESERVE set and is
// snapshot/restored by install.sh / install.ps1 -- keeping the opt-in durable.
import { join } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

/** The autoupdate state directory: `<install>/.autoupdate`. */
export function autoupdateDir(): string {
  return join(PROJECT_ROOT, ".autoupdate");
}

/** Persistent autoupdate state file (JSON). */
export function autoupdateStateFile(): string {
  return join(autoupdateDir(), "state.json");
}

/** Lock file guarding concurrent preflight updates. */
export function autoupdateLockFile(): string {
  return join(autoupdateDir(), "update.lock");
}
