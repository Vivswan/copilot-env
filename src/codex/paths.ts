// Dependency-light on purpose (node builtins only) so any layer names the same files without
// importing the config writer in src/codex/config.ts.
import { homedir } from "node:os";
import * as path from "node:path";
import type { ProfileName } from "../copilot_api/profile.ts";

/** No process.env.HOME precedence: on Windows homedir() is %USERPROFILE%, where Codex reads, while
 *  HOME may be a Git-for-Windows/MSYS path. path.join, not string concat, so every writer and
 *  checker produces byte-identical paths; `||` (not `??`) treats an empty CODEX_HOME as unset. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || plainCodexHome();
}

/** `~/.codex` with no `$CODEX_HOME` precedence: where unmanagedCodexHome lands once the export is
 *  recognised as our own farm's, and a home the cleanup sweep always visits. */
export function plainCodexHome(): string {
  return path.join(homedir(), ".codex");
}

/** The `model_provider` a copilot-env-written config.toml selects, direct and proxy alike (the mode
 *  is read from the table's contents). */
export const CODEX_PROVIDER_ID = "copilot-env";

/** THE spelling of Codex's config file path, so every writer and checker agrees byte for byte. */
export function codexConfigPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}

/** A named profile's own file, `<name>.config.toml`, which `codex --profile <name>` layers over
 *  config.toml. */
export function codexProfileConfigPath(codexHome: string, name: ProfileName): string {
  return path.join(codexHome, `${name}.config.toml`);
}
