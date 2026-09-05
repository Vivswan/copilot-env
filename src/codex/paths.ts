// Codex path derivation: the Codex home and its config.toml. Dependency-light
// on purpose (node builtins only) so any layer -- config writer, health,
// migrations, proxy-float -- can name the same files without importing the full
// config writer in src/codex/config.ts.
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * The default Codex home: $CODEX_HOME, else homedir()/.codex. Deliberately no
 * process.env.HOME precedence (on Windows homedir() is %USERPROFILE%, where Codex
 * reads, while HOME may be a Git-for-Windows/MSYS path) and path.join, not string
 * concat, so every writer and checker produces byte-identical paths. `||` (not
 * `??`) treats an empty CODEX_HOME as unset.
 */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/** The managed provider id: the `model_provider` a copilot-env-written config.toml
 *  selects (both direct and proxy; the mode is read from the table's contents). */
export const CODEX_PROVIDER_ID = "copilot-env";

/** `config.toml` under `codexHome` -- THE spelling of Codex's config file path,
 *  so every writer and checker produces byte-identical paths. */
export function codexConfigPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}
