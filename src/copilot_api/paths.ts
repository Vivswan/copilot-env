// Path helper for per-host copilot-api runtime files under COPILOT_API_HOME.
import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isValidProfileName, parseProfileName, type Profile, type ProfileName } from "./profile.ts";

// copilot-env's own data home. The proxy daemon never depends on this default:
// every spawn pins COPILOT_API_HOME from DaemonSpec.home (process.ts), so the dir
// carries OUR name, not the proxy package's. One spelling on every platform -- do
// NOT swap in a native %LOCALAPPDATA% location on Windows, the wrapper and the
// daemon must derive the identical path. Installs made before the rename used
// the proxy package's own default (`~/.local/share/copilot-api`); the 3.5.6
// migration moves them.
export const DEFAULT_HOME: string = join(homedir(), ".local", "share", "copilot-env");

/** The effective copilot-api home: `$COPILOT_API_HOME` or the default data dir. */
export function resolveHome(): string {
  return process.env.COPILOT_API_HOME || DEFAULT_HOME;
}

/** Directory under a daemon home that holds the per-host runtime dirs (`.run/<host>/`). */
export const RUN_DIR_NAME = ".run";

/** Basename of the proxy's OWN config file under a daemon home (the daemon writes it
 *  too, non-atomically, which is why CopilotApiConfig's store read gives exactly this
 *  name its torn-content (empty/parse) retries; the read-ERROR retry covers every
 *  store). */
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
  if (statIfPresent(legacy) !== null) {
    paths.push(legacy);
  }

  const runDir = join(home, RUN_DIR_NAME);
  let hosts: string[] = [];
  try {
    hosts = readdirSync(runDir);
  } catch (e) {
    // Only a MISSING dir reads as "no hosts": any other enumeration failure
    // (permissions, I/O) propagates, exactly as profileHomeNames below does and for
    // the same reason -- this list is rendered as "no usage databases found" and
    // summed into a cost total, so a silently short answer is worse than an error.
    if (!isEnoentOrNotdir(e)) throw e;
    hosts = [];
  }
  for (const host of hosts) {
    const hostStat = statIfPresent(join(runDir, host));
    const candidate = join(runDir, host, SQLITE_DB_FILENAME);
    if (hostStat !== null && hostStat.isDirectory() && statIfPresent(candidate) !== null) {
      paths.push(candidate);
    }
  }

  return paths;
}

/** stat with only ENOENT/ENOTDIR reading as "nothing there" (null); any other
 *  failure (permissions, I/O) propagates -- the same narrowing as the readdir in
 *  usageDbsUnderHome and for the same reason: a swallowed stat error one level
 *  below it would silently drop a DB from the cost totals it feeds. */
function statIfPresent(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return null;
    throw e;
  }
}

// --- profile homes ------------------------------------------------------------
//
// EVERY profile's daemon -- the default included -- runs against its own
// isolated home, `<root>/profiles/<name>` (own config.json + auth.apiKeys,
// .run/, sqlite, logs), because two daemons over one home would contend on
// sqlite/config.json. The ACCOUNT-WIDE copilot-env files (credential store,
// preferences, ownership ledger, the Codex catalog, copilot-api's device-login
// file, the proxy float record and its caches) always anchor at the ROOT home,
// so every profile shares one credential store and one preference set.
//
// A daemon is spawned with COPILOT_API_HOME pointing at its profile home (so
// the daemon and its in-process preloads read/write there) plus
// COPILOT_ENV_ROOT_HOME pointing back at the root -- the explicit signal that
// lets the preloads' zero-arg constructors still find the shared files.

/** Directory under the root home that holds the per-profile daemon homes. */
export const PROFILES_DIR_NAME = "profiles";

/** Directory name of the DEFAULT profile's daemon home under `profiles/`. The
 *  name is reserved for exactly this reason: a user profile can never claim it
 *  (profile.ts rejects it), so the join can never collide. */
export const DEFAULT_PROFILE_DIR = "default";

/** Directory under a daemon home where the proxy writes its per-endpoint
 *  handler logs (shared across hosts, unlike `.run/<host>/`). */
export const LOGS_DIR_NAME = "logs";

/** Basename of the per-home record of the opt-in config.json projections we
 *  wrote (ProxyProjectionState) -- lives beside the config.json it describes. */
export const PROJECTIONS_FILENAME = ".copilot-env-projections.json";

/** The artifacts that make up ONE daemon home, relative to it. Their presence
 *  directly at the ROOT home is what marks an unmigrated FLAT default daemon
 *  home (see defaultDaemonHome); the 3.5.6 default-home fix-up moves exactly
 *  this set into `profiles/default/`. daemon.lock is deliberately absent: a
 *  home that ever ran a daemon always carries `.run/` (the CLI creates it
 *  before any spawn), and keeping the list lock-free keeps this module out of
 *  the daemon shims' import closures. */
export const DAEMON_HOME_ARTIFACTS = [
  PROXY_CONFIG_FILENAME,
  PROJECTIONS_FILENAME,
  RUN_DIR_NAME,
  LOGS_DIR_NAME,
  SQLITE_DB_FILENAME,
] as const;

/** The 3.5.6 default-home move's staging dir under `profiles/` (never a valid
 *  profile name, so every enumerator skips it). Declared here because its
 *  EXISTENCE is part of the precedence rule below: artifacts staged but not yet
 *  flipped are still the flat layout's, so reads must keep resolving flat until
 *  the migration's one atomic rename creates `profiles/default`. */
export const DEFAULT_HOME_STAGING_DIR = ".default.migrating";

/** Env var carrying the ROOT home inside a profile daemon (set at spawn). */
export const ROOT_HOME_ENV = "COPILOT_ENV_ROOT_HOME";

/** Env var carrying the daemon's keep-port-on-auto-stop decision ("1"/"0", set on
 *  EVERY spawn): DaemonPolicy.releasesPortOnStop, decided once in port.ts and
 *  transported here so the in-daemon idle watchdog never re-derives the policy.
 *  A named profile's port is its stable reservation and survives auto-stop ("1");
 *  the default's reverts ("0"). Declared in this module (not port.ts) because the
 *  watchdog already has paths.ts in its preload import closure. */
export const DAEMON_KEEP_PORT_ENV = "COPILOT_ENV_DAEMON_KEEP_PORT";

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

/**
 * THE default daemon's home -- the one place its precedence is decided:
 *   1. Inside a daemon (COPILOT_ENV_ROOT_HOME set at spawn), COPILOT_API_HOME
 *      IS the daemon's own pinned home; nothing is derived.
 *   2. Otherwise the default daemon lives at `<root>/profiles/default` -- the
 *      same shape as every named profile -- whenever that directory exists,
 *      and on a fresh root carrying no daemon files at all.
 *   3. Only a root still holding an unmigrated FLAT daemon home resolves to the
 *      root itself, until the 3.5.6 default-home fix-up moves those files:
 *      any of DAEMON_HOME_ARTIFACTS directly at the root, or an unfinished
 *      staging move (DEFAULT_HOME_STAGING_DIR -- its artifacts are still the
 *      flat home's until the flip), with no profiles/default beside them.
 */
export function defaultDaemonHome(): string {
  if (process.env[ROOT_HOME_ENV]) return resolveHome();
  const root = resolveHome();
  const migrated = join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR);
  if (existsSync(migrated)) return migrated;
  const flat = DAEMON_HOME_ARTIFACTS.some((name) => existsSync(join(root, name))) ||
    existsSync(join(root, PROFILES_DIR_NAME, DEFAULT_HOME_STAGING_DIR));
  return flat ? root : migrated;
}

/** Every daemon home on this root: the default profile's plus each named
 *  profile's with a home on disk -- the sweep/corroboration sites' one list
 *  producer, so no caller can enumerate homes with a different rule. */
export function allDaemonHomes(): string[] {
  return [defaultDaemonHome(), ...profileHomeNames().map(profileHome)];
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

/** Basename of OUR per-host run-state file under `.run/<host>/` (port + pid +
 *  active CODEX_HOME), written by this tooling and read back by
 *  start/stop/env/health/port. */
export const RUN_STATE_FILENAME = ".state.json";

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
   * Anchors at the root home itself, never inside `.run/<host>/` or any
   * daemon home under `profiles/`.
   */
  sharedStateFile: string;
  /**
   * Account/machine-wide copilot-env PREFERENCES (`.copilot-env-config.json`), managed by
   * `agent config` -- separate from the credential store above, and shared by every profile
   * (anchored at the ROOT home).
   */
  envConfigFile: string;
  /**
   * The machine-local artifact-ownership ledger (`.copilot-env-ownership.json`,
   * OwnershipLedger in ownership.ts): which entries copilot-env itself wrote into
   * external config artifacts. Root-home anchored like the state file -- the
   * artifacts it describes are account/machine-wide -- and never exported by
   * `agent settings` (its records name THIS machine's files).
   */
  ownershipFile: string;
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
   *  default profile's, resolved by defaultDaemonHome). Account-wide files
   *  anchor at the root home either way. */
  constructor(profile: Profile = null) {
    this.home = profile === null ? defaultDaemonHome() : profileHome(profile);
    const rootHome = resolveRootHome();
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, RUN_DIR_NAME, hostname);
    this.configFile = join(this.home, PROXY_CONFIG_FILENAME);
    this.projectionsFile = join(this.home, PROJECTIONS_FILENAME);
    this.runDir = runDir;
    // Our own per-host state; see RUN_STATE_FILENAME.
    this.stateFile = join(runDir, RUN_STATE_FILENAME);
    this.activityFile = join(runDir, ".activity.json");
    this.logFile = join(runDir, ".log");
    // The proxy writes its inference handler logs to <home>/logs (shared, not per-host).
    this.logsDir = join(this.home, LOGS_DIR_NAME);
    this.sqliteDb = join(runDir, SQLITE_DB_FILENAME);
    this.sharedStateFile = join(rootHome, ".copilot-env-state.json");
    this.envConfigFile = join(rootHome, ".copilot-env-config.json");
    this.ownershipFile = join(rootHome, ".copilot-env-ownership.json");
    this.githubTokenFile = join(rootHome, "github_token");
    this.githubTokenLoginLock = `${this.githubTokenFile}.login.lock`;
    this.codexModelCatalogFile = join(rootHome, "codex-model-catalog.json");
  }
}
