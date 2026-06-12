// Path helper for per-host copilot-api runtime files under COPILOT_API_HOME.
import { homedir } from "node:os";
import { join } from "node:path";
import { getSanitizedHostname } from "../utils/hostname.ts";

// Mirror the proxy's own default (`@jeffreycao/copilot-api` lib/paths.ts):
//   path.join(os.homedir(), ".local", "share", "copilot-api")
// applied on every platform. Must stay byte-for-byte compatible so the wrapper
// reads the same config/run dir the daemon writes — do NOT swap in a native
// %LOCALAPPDATA% location on Windows, that would diverge from the daemon.
export const DEFAULT_HOME: string = join(homedir(), ".local", "share", "copilot-api");

/** The effective copilot-api home: `$COPILOT_API_HOME` or the default data dir. */
export function resolveHome(): string {
  return process.env.COPILOT_API_HOME || DEFAULT_HOME;
}

/** Per-host runtime file paths for the copilot-api proxy. */
export class CopilotApiPaths {
  home: string;
  configFile: string;
  runDir: string;
  stateFile: string;
  logFile: string;
  sqliteDb: string;
  /**
   * Shared (NOT per-host) copilot-env state under the copilot-api home — holds
   * the provisioned GitHub token, which is account/machine-wide regardless of
   * host. Lives beside config.json, never inside `.run/<host>/`.
   */
  sharedStateFile: string;

  constructor() {
    this.home = resolveHome();
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, ".run", hostname);
    this.configFile = join(this.home, "config.json");
    this.runDir = runDir;
    // Our own per-host state (port + pid + active CODEX_HOME), written by this
    // tooling and read back by start/stop/env/health/port.
    this.stateFile = join(runDir, ".state.json");
    this.logFile = join(runDir, ".log");
    this.sqliteDb = join(runDir, "copilot-api.sqlite");
    this.sharedStateFile = join(this.home, ".copilot-env-state.json");
  }
}
