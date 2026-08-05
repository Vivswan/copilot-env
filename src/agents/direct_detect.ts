// The direct-vs-proxy decision for one agent, shared by the Codex and Claude
// config writers (and `agent codex --host`) so "what does a mode flag plus a
// provisioned token mean?" is answered exactly once. The live probe that backs
// the "auto" case lives in ./live_probe.ts; this module only decides when to
// consult it.
import { assertNever } from "../utils/assert.ts";
import type { RequestedMode } from "./provider_mode.ts";

/**
 * Decide whether to write DIRECT (true) or PROXY (false), honoring a provisioned
 * token (the shared store's githubToken): "proxy" => proxy, "direct" => direct,
 * and on "auto" a present token selects Direct (we already hold a credential, so
 * no probe is needed) while no token falls back to the live `detectDirect` probe.
 * Total over RequestedMode -- the contradictory flag pair cannot reach here (it is
 * rejected once, at the CLI boundary parse).
 */
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
