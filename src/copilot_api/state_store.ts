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
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** The file's top-level maps (external contracts: never rename). */
export const STATE_TOP_KEYS = ["global", "profiles", "ownership"] as const;
export type StateTopKey = (typeof STATE_TOP_KEYS)[number];

/** The root store over `state.json` (one file, one lock under `locks/`). */
export function rootStateStore(path?: string): CopilotApiConfig {
  if (path !== undefined) return new CopilotApiConfig(path);
  const paths = new CopilotApiPaths();
  return new CopilotApiConfig(paths.stateStoreFile, paths.stateStoreLock);
}
