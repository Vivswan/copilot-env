// The direct-vs-proxy decision for one agent, shared by the Codex and Claude writers so "a mode
// flag plus a provisioned token" is answered once. The live probe behind "auto" is
// ./live_probe.ts; this module only decides when to consult it.
import { assertNever } from "../utils/assert.ts";
import type { RequestedMode } from "./provider_mode.ts";

/** On "auto" a provisioned token selects Direct without probing: holding a credential is the
 *  evidence the probe would look for. The contradictory flag pair never reaches here; it is
 *  rejected once, at the CLI boundary parse (parseModeFlags). */
export function resolveDirectMode(
  mode: RequestedMode,
  ghToken: string | null,
  detectDirect: () => boolean,
): boolean {
  switch (mode) {
    case "proxy":
      return false;
    case "direct":
      return true;
    case "auto":
      return ghToken !== null || detectDirect();
    default:
      return assertNever(mode);
  }
}
