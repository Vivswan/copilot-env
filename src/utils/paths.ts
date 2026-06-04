import { homedir } from "node:os";
import { join } from "node:path";
import { getSanitizedHostname } from "./hostname.ts";

// Mirror the gateway's own default (`@jeffreycao/copilot-api` lib/paths.ts):
//   path.join(os.homedir(), ".local", "share", "copilot-api")
// applied on every platform. Must stay byte-for-byte compatible so the wrapper
// reads the same config/run dir the daemon writes — do NOT swap in a native
// %LOCALAPPDATA% location on Windows, that would diverge from the daemon.
export const DEFAULT_HOME: string = join(homedir(), ".local", "share", "copilot-api");

/** Per-host runtime file paths for the copilot-api gateway. */
export class CopilotApiPaths {
  home: string;
  configFile: string;
  runDir: string;
  pidFile: string;
  portFile: string;
  logFile: string;
  sqliteDb: string;

  constructor() {
    this.home = process.env.COPILOT_API_HOME || DEFAULT_HOME;
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, ".run", hostname);
    this.configFile = join(this.home, "config.json");
    this.runDir = runDir;
    this.pidFile = join(runDir, ".pid");
    this.portFile = join(runDir, ".port");
    this.logFile = join(runDir, ".log");
    this.sqliteDb = join(runDir, "copilot-api.sqlite");
  }
}
