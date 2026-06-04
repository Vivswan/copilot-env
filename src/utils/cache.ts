import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user cache directory, following OS conventions:
 *   - Linux:   $XDG_CACHE_HOME/copilot-env or ~/.cache/copilot-env
 *   - macOS:   ~/Library/Caches/copilot-env
 *   - Windows: %LOCALAPPDATA%\copilot-env\Cache
 */
export function cacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "copilot-env", "Cache");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "copilot-env");
  }
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "copilot-env");
}
