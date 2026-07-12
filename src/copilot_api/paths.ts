// Path helper for per-host copilot-api runtime files under COPILOT_API_HOME.
import { homedir } from "node:os";
import { join } from "node:path";
import { getSanitizedHostname } from "../utils/hostname.ts";

// Mirror the proxy's own default (`@jeffreycao/copilot-api` lib/paths.ts):
//   path.join(os.homedir(), ".local", "share", "copilot-api")
// applied on every platform. Must stay byte-for-byte compatible so the wrapper
// reads the same config/run dir the daemon writes -- do NOT swap in a native
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
  /**
   * The daemon's inference-activity mark (`.run/<host>/.activity.json`), written ONLY by the
   * in-daemon observer (src/scripts/inference_activity.ts) and read by `agent health`. A
   * separate file from `.state.json` on purpose: the CLI and the daemon write state
   * concurrently, and CopilotApiConfig.update() is atomic per replacement but not across
   * load-mutate-save -- a single-writer file sidesteps the lost-update race entirely.
   */
  activityFile: string;
  logFile: string;
  /** Directory where the proxy writes its per-endpoint handler logs -- distinct from the
   *  daemon access `logFile`, which also records liveness `GET /` pings. `agent health` reads
   *  the INFERENCE ones (`responses-handler-*.log`, `messages-handler-*.log`) as a fallback
   *  activity signal for daemons started by an older copilot-env; the `proxy-logs` config key
   *  (off) discards writes here entirely. */
  logsDir: string;
  sqliteDb: string;
  /**
   * Shared (NOT per-host) copilot-env state under the copilot-api home -- holds
   * the provisioned GitHub token, which is account/machine-wide regardless of
   * host. Lives beside config.json, never inside `.run/<host>/`.
   */
  sharedStateFile: string;
  /**
   * Account/machine-wide copilot-env PREFERENCES (`.copilot-env-config.json`), managed by
   * `agent config` -- separate from the credential store above. Holds the user-tunable knobs
   * (auto-start, passthrough, idle-timeout, small-model, port, proxy float pins, etc.).
   */
  envConfigFile: string;
  /**
   * copilot-api's OWN device-login token file (`github_token`), written when the
   * proxy authenticates itself via the device flow. copilot-env never writes it
   * (we pass `--github-token` from `sharedStateFile`); we only read+scrub it when
   * consolidating an existing proxy login into our single-source-of-truth store.
   */
  githubTokenFile: string;
  /**
   * The patched Codex model catalog (account-wide): the bundled `codex debug
   * models` catalog with GitHub Copilot's live context-window limits overlaid.
   * Referenced by absolute path from the managed Codex config.toml via its
   * `model_catalog_json` key. Not dot-prefixed: Codex (and users) read it.
   */
  codexModelCatalogFile: string;

  constructor() {
    this.home = resolveHome();
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, ".run", hostname);
    this.configFile = join(this.home, "config.json");
    this.runDir = runDir;
    // Our own per-host state (port + pid + active CODEX_HOME), written by this
    // tooling and read back by start/stop/env/health/port.
    this.stateFile = join(runDir, ".state.json");
    this.activityFile = join(runDir, ".activity.json");
    this.logFile = join(runDir, ".log");
    // The proxy writes its inference handler logs to <home>/logs (shared, not per-host).
    this.logsDir = join(this.home, "logs");
    this.sqliteDb = join(runDir, "copilot-api.sqlite");
    this.sharedStateFile = join(this.home, ".copilot-env-state.json");
    this.envConfigFile = join(this.home, ".copilot-env-config.json");
    this.githubTokenFile = join(this.home, "github_token");
    this.codexModelCatalogFile = join(this.home, "codex-model-catalog.json");
  }
}
