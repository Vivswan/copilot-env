// The direct-vs-proxy decision for one agent, shared by the Codex and Claude writers. The live
// probe behind "auto" is ./live_probe.ts; this module only decides when to consult it.
import { assertNever } from "../utils/assert.ts";
import type { RequestedMode } from "./provider_mode.ts";

/** "auto" always probes: a stored credential is not evidence of Direct access (not every account
 *  or token can use it), so the probe judges the credential the command boundary just ensured.
 *  The contradictory flag pair never reaches here; parseModeFlags rejects it. */
export async function resolveDirectMode(
  mode: RequestedMode,
  detectDirect: () => Promise<boolean>,
): Promise<boolean> {
  switch (mode) {
    case "proxy":
      return false;
    case "direct":
      return true;
    case "auto":
      return await detectDirect();
    default:
      return assertNever(mode);
  }
}
