// Migration from 3.3.20: remove the always-on Codex model catalog artifacts.
//
// Up to 3.3.20 the patched Codex model catalog (codex-model-catalog.json +
// the `model_catalog_json` reference in the managed config.toml) was generated
// unconditionally. It is now OPT-IN via the `codex-model-catalog` config key
// (default false), so an existing install that merely runs `agent update` must
// have the previously generated artifacts removed -- otherwise the stale file
// would keep replacing Codex's bundled catalog wholesale, hiding models added
// by future codex releases, with nothing left to refresh it.
//
// The removal IS syncCodexCatalogReference()'s disabled branch (strip the
// reference from every known Codex config FIRST, then delete the file, then
// clear the refresh-throttle state -- never leaving a dangling reference, which
// is a Codex startup error). Calling it instead of duplicating the logic also
// keeps this idempotent and correct for a user who opted in BEFORE updating:
// enabled means the sync self-heals rather than removes. The auth-time hooks
// run the same sync every ~300s, so this migration only closes the window for
// installs where Codex is wired but not running.
import { syncCodexCatalogReference } from "../codex/config.ts";
import type { Migration } from "./index.ts";

export const migration: Migration = {
  version: "3.3.20",
  description: "remove the previously always-on Codex model catalog (now opt-in)",
  run: () => {
    syncCodexCatalogReference();
  },
};
