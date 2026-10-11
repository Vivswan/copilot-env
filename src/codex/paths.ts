// Dependency-light on purpose (node builtins only) so any layer names the same files without
// importing the config writer in src/codex/config.ts.
import * as path from "node:path";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { userHomeDir } from "../utils/home.ts";

/** The home is userHomeDir's (src/utils/home.ts): %USERPROFILE% on Windows, where Codex reads,
 *  never a Git-for-Windows/MSYS HOME. path.join, not string concat, so every writer and checker
 *  produces byte-identical paths; `||` (not `??`) treats an empty CODEX_HOME as unset. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || plainCodexHome();
}

/** `~/.codex` with no `$CODEX_HOME` precedence: where unmanagedCodexHome lands once the export is
 *  recognised as our own farm's, and a home the cleanup sweep always visits. */
export function plainCodexHome(): string {
  return path.join(userHomeDir(), ".codex");
}

/** The `model_provider` a copilot-env-written config.toml selects, direct and proxy alike (the mode
 *  is read from the table's contents). */
export const CODEX_PROVIDER_ID = "copilot-env";

/** A named profile is selected by its own `<name>.config.toml` (`codex --profile <name>` layers it
 *  over config.toml), whose top-level `model_provider` points here; config.toml's default selection
 *  is never touched. */
export function codexProviderId(profile: Profile = null): string {
  return profile === null ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${profile}`;
}

/** THE spelling of Codex's config file path, so every writer and checker agrees byte for byte. */
export function codexConfigPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}

/** A named profile's own file, `<name>.config.toml`, which `codex --profile <name>` layers over
 *  config.toml. */
export function codexProfileConfigPath(codexHome: string, name: ProfileName): string {
  return path.join(codexHome, `${name}.config.toml`);
}
