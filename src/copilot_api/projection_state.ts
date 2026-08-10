// Ownership record for the OPT-IN proxy config.json projections: which paths copilot-env
// itself wrote into a daemon's config.json. Recorded ownership is what lets a later
// `agent start` clear OUR leftover value once its `agent config` key is unset (`--del`),
// while a value at the same path we never projected -- a hand edit, or the daemon's own
// write -- is never deleted: the same recorded-ownership philosophy as the WebSearch-deny
// paths in CopilotEnvState. The record lives in `.copilot-env-projections.json`
// (CopilotApiPaths.projectionsFile, beside the config.json it describes).
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import type { ProxyConfigPath } from "./env_config.ts";
import type { CopilotApiPaths } from "./paths.ts";

/** THE parser for the recorded path list: junk entries (non-arrays, blank or non-string
 *  keys, empty paths) are dropped WHOLE, never truncated to a parent path, and never fail
 *  the read -- a hand-mangled file degrades to "owns less", not to a crash. A well-formed
 *  path that is not ours parses fine but still claims nothing: applyDefaultConfig
 *  intersects the record with the registry's own opt-in paths before deleting anything. */
function recordedPathList(value: unknown): ProxyConfigPath[] {
  if (!Array.isArray(value)) return [];
  const out: ProxyConfigPath[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const keys = entry.filter((k): k is string => typeof k === "string" && k !== "");
    const [head, ...rest] = keys;
    if (head !== undefined && keys.length === entry.length) out.push([head, ...rest]);
  }
  return out;
}

const PROJECTION_STATE_SCHEMA = v.object({
  optInPaths: v.fallback(v.pipe(v.unknown(), v.transform(recordedPathList)), []),
});

/**
 * Read/write helper for the per-daemon-home projection-ownership record. Backed by
 * CopilotApiConfig (sorted keys, 0600, atomic rename, Windows EPERM/EBUSY retry),
 * mirroring CopilotEnvRunState. applyDefaultConfig writes the record AFTER the config.json
 * apply, so a crash between the two writes can leave a projected value the record does not
 * claim -- the safe direction: an unclaimed value is never deleted, and the next successful
 * apply rewrites both files.
 */
export class ProxyProjectionState {
  private readonly store: CopilotApiConfig;
  /** The record file (`paths.projectionsFile`); the applyDefaultConfig RMW lock derives
   *  from it. */
  readonly path: string;

  constructor(paths: CopilotApiPaths) {
    this.path = paths.projectionsFile;
    this.store = new CopilotApiConfig(this.path);
  }

  /** The opt-in paths copilot-env last projected into this home's config.json. */
  ownedPaths(): ProxyConfigPath[] {
    return v.parse(PROJECTION_STATE_SCHEMA, this.store.load()).optInPaths;
  }

  /** Replace the record with the paths the CURRENT apply projected. An empty record drops
   *  the key -- and when nothing was recorded before either, skips the write entirely, so
   *  a default-configured start never materializes an empty record file. */
  setOwnedPaths(paths: readonly ProxyConfigPath[]): void {
    if (paths.length === 0 && this.ownedPaths().length === 0) return;
    this.store.update((d) => {
      if (paths.length === 0) delete d.optInPaths;
      else d.optInPaths = paths.map((p) => [...p]);
    });
  }
}
