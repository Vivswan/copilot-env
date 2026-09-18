// The ONE account-wide store, `~/.local/share/copilot-env/state.json`, under one lock:
//
//   global          -> the global settings (the dotted registry keys, CopilotEnvConfig) beside the
//                      account-wide state (the Codex catalog throttle and the Claude model verdicts,
//                      CopilotEnvState)
//   profiles.<name> -> that profile's settings keys (identity, host, passthrough, static-key, and its
//                      proxy.* overrides) beside its state keys, the credential slot (githubToken,
//                      authProvider, ghUser, mode, integrationIdentity, copilotHost)
//   ownership       -> the claims on the external files we wrote (OwnershipLedger)
//
// A setting and a state key never share a spelling (dotted or one of the four flat setting names
// against camelCase), so each reader picks its own keys out of a map and every write preserves the
// rest, a newer release's keys included. Which a key is, is a per-key fact: the settings registry
// (CONFIG_REGISTRY) names the settings, PROFILE_STATE_KEYS / GLOBAL_STATE_KEYS (env_state.ts) and
// LEDGER_KEY_NAMES (ownership.ts) name the state, and the preference verbs refuse a state
// key by name, naming the command that owns it (src/commands/config.ts).
import { CopilotApiConfig, ensureDict } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import { isRecord } from "../utils/json.ts";

/** The file's top-level maps (external contracts: never rename). */
export const STATE_TOP_KEYS = ["global", "profiles", "ownership"] as const;
export type StateTopKey = (typeof STATE_TOP_KEYS)[number];

/** The root store over `state.json` (one file, one lock under `locks/`). */
export function rootStateStore(path?: string): CopilotApiConfig {
  if (path !== undefined) return new CopilotApiConfig(path);
  const paths = new CopilotApiPaths();
  return new CopilotApiConfig(paths.stateStoreFile, paths.stateStoreLock);
}

/**
 * One top-level map of the store, with the read/update surface CopilotApiConfig has: `load()` is
 * the lenient flatten (an unreadable file reads as empty); `loadStrict()` throws on a file that
 * cannot be read or parsed, while an absent file, and a map that is absent or not an object, read
 * as empty; `update()` mutates the map under the store's one lock and deletes its key when the
 * mutation leaves it empty. The ownership ledger reads and writes through it; the two other readers
 * take the whole document, since each picks its keys out of `global` and `profiles`.
 */
export class StateSection {
  readonly path: string;

  constructor(readonly key: StateTopKey, private readonly store: CopilotApiConfig) {
    this.path = store.path;
  }

  private sectionOf(doc: Record<string, unknown>): Record<string, unknown> {
    const section = doc[this.key];
    return isRecord(section) ? section : {};
  }

  load(): Record<string, unknown> {
    return this.sectionOf(this.store.load());
  }

  loadStrict(): Record<string, unknown> {
    return this.sectionOf(this.store.loadStrict());
  }

  update(mutate: (section: Record<string, unknown>) => void): Record<string, unknown> {
    let out: Record<string, unknown> = {};
    this.store.update((doc) => {
      const section = ensureDict(doc, this.key);
      mutate(section);
      if (Object.keys(section).length === 0) delete doc[this.key];
      out = section;
    });
    return out;
  }
}
