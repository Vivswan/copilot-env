// Path helper for per-host copilot-api runtime files under COPILOT_API_HOME.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDir, isEnoentOrNotdir } from "../utils/fs.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isValidProfileName, parseProfileName, type Profile, type ProfileName } from "./profile.ts";

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

/** Directory under a daemon home that holds the per-host runtime dirs (`.run/<host>/`). */
export const RUN_DIR_NAME = ".run";

/** Basename of the proxy's OWN config file under a daemon home (the daemon writes it
 *  too, which is why CopilotApiConfig.load() gives exactly this name its transient-read
 *  retry). */
export const PROXY_CONFIG_FILENAME = "config.json";

/** Basename of the proxy's SQLite DB (`token_usage_events` etc.), one per host dir; a
 *  legacy top-level copy may predate the per-host split. */
export const SQLITE_DB_FILENAME = "copilot-api.sqlite";

/** The usage DBs directly under ONE daemon home: the legacy top-level file plus
 *  one per host directory under `.run/`. Only paths that exist are returned.
 *  Lives here so `agent cost`'s sweep follows any future move of the DB layout. */
export function usageDbsUnderHome(home: string): string[] {
  const paths: string[] = [];

  const legacy = join(home, SQLITE_DB_FILENAME);
  if (existsSync(legacy)) {
    paths.push(legacy);
  }

  const runDir = join(home, RUN_DIR_NAME);
  let hosts: string[] = [];
  try {
    hosts = readdirSync(runDir);
  } catch {
    hosts = []; // no .run dir yet
  }
  for (const host of hosts) {
    const candidate = join(runDir, host, SQLITE_DB_FILENAME);
    if (isDir(join(runDir, host)) && existsSync(candidate)) {
      paths.push(candidate);
    }
  }

  return paths;
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

/** A named profile's isolated daemon home under the root. `ProfileName` is the
 *  proof the segment is safe to join (parsed at the producer boundaries). */
export function profileHome(name: ProfileName): string {
  return join(resolveRootHome(), PROFILES_DIR_NAME, name);
}

/** Names of profiles that have a daemon home on disk (sorted; missing dir = none).
 *  Complements the credential store's `profiles` map: a proxy-mode profile can
 *  exist here with no credential of its own, and vice versa. Directories that are
 *  not valid profile names (a stray hand-made folder) are skipped -- they are not
 *  profile homes; the survivors are minted into `ProfileName` so every downstream
 *  path constructor can trust them.
 *  Only a MISSING dir reads as "no profiles": any other enumeration failure
 *  (permissions, I/O) propagates, because callers use this list to avoid port
 *  collisions and to protect tracked daemons from the orphan sweep -- an
 *  incomplete answer there is worse than an error. */
export function profileHomeNames(): ProfileName[] {
  try {
    return readdirSync(join(resolveRootHome(), PROFILES_DIR_NAME), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
      .map((entry) => parseProfileName(entry.name))
      .sort();
  } catch (e) {
    if (isEnoentOrNotdir(e)) return []; // no profiles dir yet
    throw e;
  }
}

/** True when the named profile has a daemon home on disk. */
export function profileHomeExists(name: ProfileName): boolean {
  return existsSync(profileHome(name));
}

/** Per-host runtime file paths for the copilot-api proxy. */
export class CopilotApiPaths {
  home: string;
  configFile: string;
  /**
   * The per-home record of the OPT-IN config.json projections copilot-env wrote
   * (ProxyProjectionState). Declared here beside `configFile` -- the file it describes --
   * so the two can never drift onto different homes (the githubTokenLoginLock precedent).
   * Per HOME, not per host: hosts sharing a home share its config.json, so they share
   * its projections too.
   */
  projectionsFile: string;
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
   * The mutex guarding `githubTokenFile` (`github_token.login.lock`): a device-flow
   * login (auth.ts) holds it across its whole spawn+read+scrub, and the de-auth
   * scrub (credential.ts) briefly takes the same lock, so `--del` cannot race a
   * mid-login token write. Derived here, next to the file it guards, so the two
   * sites can never drift onto different lock paths.
   */
  githubTokenLoginLock: string;
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
    const runDir = join(this.home, RUN_DIR_NAME, hostname);
    this.configFile = join(this.home, PROXY_CONFIG_FILENAME);
    this.projectionsFile = join(this.home, ".copilot-env-projections.json");
    this.runDir = runDir;
    // Our own per-host state (port + pid + active CODEX_HOME), written by this
    // tooling and read back by start/stop/env/health/port.
    this.stateFile = join(runDir, ".state.json");
    this.activityFile = join(runDir, ".activity.json");
    this.logFile = join(runDir, ".log");
    // The proxy writes its inference handler logs to <home>/logs (shared, not per-host).
    this.logsDir = join(this.home, "logs");
    this.sqliteDb = join(runDir, SQLITE_DB_FILENAME);
    this.sharedStateFile = join(rootHome, ".copilot-env-state.json");
    this.envConfigFile = join(rootHome, ".copilot-env-config.json");
    this.githubTokenFile = join(rootHome, "github_token");
    this.githubTokenLoginLock = `${this.githubTokenFile}.login.lock`;
    this.codexModelCatalogFile = join(rootHome, "codex-model-catalog.json");
  }
}
