// Path helper for per-host copilot-api runtime files under COPILOT_API_HOME.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { assertProfileName, isValidProfileName, type Profile } from "./profile.ts";

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

// --- profile homes ------------------------------------------------------------
//
// A NAMED profile's daemon runs against its own isolated home,
// `<root>/profiles/<name>` (own config.json + auth.apiKeys, .run/, sqlite,
// logs), because two daemons over one home would contend on sqlite/config.json.
// The ACCOUNT-WIDE copilot-env files (credential store, preferences, the Codex
// catalog, copilot-api's device-login file) always anchor at the ROOT home, so
// every profile shares one credential store and one preference set.
//
// A profile daemon is spawned with COPILOT_API_HOME pointing at its profile
// home (so the daemon and its in-process preloads read/write there) plus
// COPILOT_ENV_ROOT_HOME pointing back at the root -- the explicit signal that
// lets the preloads' zero-arg constructors still find the shared files.

/** Directory under the root home that holds the per-profile daemon homes. */
export const PROFILES_DIR_NAME = "profiles";

/** Env var carrying the ROOT home inside a profile daemon (set at spawn). */
export const ROOT_HOME_ENV = "COPILOT_ENV_ROOT_HOME";

/** The ROOT copilot-api home (where the account-wide files live): inside a
 *  profile daemon `$COPILOT_ENV_ROOT_HOME`, else the effective home itself. */
export function resolveRootHome(): string {
  return process.env[ROOT_HOME_ENV] || resolveHome();
}

/** A named profile's isolated daemon home under the root. */
export function profileHome(name: string): string {
  assertProfileName(name);
  return join(resolveRootHome(), PROFILES_DIR_NAME, name);
}

/** Names of profiles that have a daemon home on disk (sorted; missing dir = none).
 *  Complements the credential store's `profiles` map: a proxy-mode profile can
 *  exist here with no credential of its own, and vice versa. Directories that are
 *  not valid profile names (a stray hand-made folder) are skipped -- every
 *  downstream path constructor validates and would otherwise throw mid-sweep.
 *  Only a MISSING dir reads as "no profiles": any other enumeration failure
 *  (permissions, I/O) propagates, because callers use this list to avoid port
 *  collisions and to protect tracked daemons from the orphan sweep -- an
 *  incomplete answer there is worse than an error. */
export function profileHomeNames(): string[] {
  try {
    return readdirSync(join(resolveRootHome(), PROFILES_DIR_NAME), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return []; // no profiles dir yet
    throw e;
  }
}

/** True when the named profile has a daemon home on disk. */
export function profileHomeExists(name: string): boolean {
  return existsSync(profileHome(name));
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
   * Shared (NOT per-host, NOT per-profile) copilot-env state under the ROOT
   * copilot-api home -- holds the provisioned GitHub credentials (default +
   * named profile slots), which are account/machine-wide regardless of host.
   * Lives beside the root config.json, never inside `.run/<host>/` or a
   * profile home.
   */
  sharedStateFile: string;
  /**
   * Account/machine-wide copilot-env PREFERENCES (`.copilot-env-config.json`), managed by
   * `agent config` -- separate from the credential store above, and shared by every profile
   * (anchored at the ROOT home).
   */
  envConfigFile: string;
  /**
   * copilot-api's OWN device-login token file (`github_token`), written when the
   * proxy authenticates itself via the device flow. copilot-env never writes it
   * (we pass `--github-token` from `sharedStateFile`); we only read+scrub it when
   * consolidating an existing proxy login into our single-source-of-truth store.
   * Root-home only: profile daemons always receive their token via `--github-token`.
   */
  githubTokenFile: string;
  /**
   * The patched Codex model catalog (account-wide): the bundled `codex debug
   * models` catalog with GitHub Copilot's live context-window limits overlaid.
   * Referenced by absolute path from the managed Codex config.toml via its
   * `model_catalog_json` key. Not dot-prefixed: Codex (and users) read it.
   */
  codexModelCatalogFile: string;

  /** `profile` selects a NAMED profile's isolated daemon home (null = the
   *  effective home). Account-wide files anchor at the root home either way. */
  constructor(profile: Profile = null) {
    this.home = profile === null ? resolveHome() : profileHome(profile);
    const rootHome = resolveRootHome();
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
    this.sharedStateFile = join(rootHome, ".copilot-env-state.json");
    this.envConfigFile = join(rootHome, ".copilot-env-config.json");
    this.githubTokenFile = join(rootHome, "github_token");
    this.codexModelCatalogFile = join(rootHome, "codex-model-catalog.json");
  }
}
