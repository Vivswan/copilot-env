// Away from 4.0.0: the installed launcher shims gained the autoupdate preflight hook
// (`update --preflight` before `agent start`, src/install/installer.ts). The per-version
// shims are written by the NEW binary's own provision step, but the stable top-level
// `<top>/bin/agent(.ps1)` is refreshed at commit time by the OLD binary, from ITS shim
// text -- so the PATH entry would carry this release's hook only after the update
// AFTER this one. adoptVersionedLayout's repair path converges an already-versioned
// root on the running release (top shims from this binary's text, the rest idempotent)
// and keeps its own checkout / incomplete-link guards.
import { adoptVersionedLayout } from "../install/installer.ts";
import type { Migration } from "./index.ts";

export const v400LauncherShims: Migration = {
  version: "4.0.0",
  description: "refresh the top-level launcher shims (they now run the autoupdate preflight)",
  run: () => adoptVersionedLayout(),
};
