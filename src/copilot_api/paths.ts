import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import { hideWritesUnder } from "../utils/report_write.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { isValidProfileName, parseProfileName, type Profile, type ProfileName } from "./profile.ts";

// One spelling on every platform: do NOT swap in a native %LOCALAPPDATA% location on Windows, the wrapper
// and the daemon must derive the identical path. The daemon never depends on this default: every spawn
// pins COPILOT_API_HOME from DaemonSpec.home (process.ts), so the dir carries OUR name, not the proxy package's.
export const DEFAULT_HOME: string = join(homedir(), ".local", "share", "copilot-env");

export function resolveHome(): string {
  return process.env.COPILOT_API_HOME || DEFAULT_HOME;
}

/** Directory under a daemon home that holds the per-host runtime dirs (`.run/<host>/`). */
export const RUN_DIR_NAME = ".run";

/** The daemon writes this file too, on a path that floats with its version (the 2.3.14 build renames
 *  atomically, the 2.0.1 floor truncates in place); CopilotApiConfig.read() keys its torn-content
 *  retries on exactly this basename. */
export const PROXY_CONFIG_FILENAME = "config.json";

/** One per host dir; a pre-host-split copy may sit at the top of the home (usageDbsUnderHome). */
export const SQLITE_DB_FILENAME = "copilot-api.sqlite";

/** Lives here so `agent cost`'s sweep follows any future move of the DB layout. Only paths that exist
 *  are returned. */
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
    // Only a MISSING dir reads as "no hosts"; any other failure propagates, because this list is rendered
    // as "no usage databases found" and summed into a cost total, where a silently short answer is worse
    // than an error.
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

/** Only ENOENT/ENOTDIR read as "nothing there"; a swallowed stat error would silently drop a DB from the
 *  cost totals this feeds. */
function statIfPresent(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return null;
    throw e;
  }
}

// --- profile homes ------------------------------------------------------------

// EVERY profile's daemon, the default included, runs against its own home (`<root>/profiles/<name>`, or
// the flat root until the 3.5.6 fix-up): two daemons over one home would contend on sqlite and config.json. The ACCOUNT-WIDE files anchor at the ROOT
// home instead, so every profile shares one credential store and one preference set.
//   COPILOT_API_HOME       -> the daemon's own profile home
//   COPILOT_ENV_ROOT_HOME  -> the root home, where the preloads' zero-arg constructors find the shared files

export const PROFILES_DIR_NAME = "profiles";

/** Reserved: a user profile can never claim this name (profile.ts rejects it), so the join can never collide. */
export const DEFAULT_PROFILE_DIR = "default";

/** The proxy's per-endpoint handler logs; shared across hosts, unlike `.run/<host>/`. */
export const LOGS_DIR_NAME = "logs";

/** ProxyProjectionState's record; lives beside the config.json it describes. */
export const PROJECTIONS_FILENAME = ".copilot-env-projections.json";

/** Their presence directly at the ROOT home marks an unmigrated FLAT default daemon home (defaultDaemonHome);
 *  the 3.5.6 default-home fix-up moves exactly this set into `profiles/default/`. daemon.lock is
 *  deliberately absent: a home that ever ran a daemon carries `.run/` (the CLI creates it before any
 *  spawn). */
export const DAEMON_HOME_ARTIFACTS = [
  PROXY_CONFIG_FILENAME,
  PROJECTIONS_FILENAME,
  RUN_DIR_NAME,
  LOGS_DIR_NAME,
  SQLITE_DB_FILENAME,
] as const;

/** The default-home move's staging dir; never a valid profile name, so every enumerator skips it. Its
 *  EXISTENCE is part of defaultDaemonHome's precedence: staged-but-unflipped artifacts are still the flat
 *  layout's, so reads resolve flat until the migration's one atomic rename creates `profiles/default`. */
export const DEFAULT_HOME_STAGING_DIR = ".default.migrating";

/** Env var carrying the ROOT home inside a profile daemon (set at spawn). */
export const ROOT_HOME_ENV = "COPILOT_ENV_ROOT_HOME";

/** Set on EVERY spawn ("1"/"0"): DaemonPolicy.releasesPortOnStop, decided once in port.ts and transported
 *  so the in-daemon idle watchdog never re-derives the policy. Declared here, not in port.ts, because the
 *  watchdog's preload import closure already has paths.ts. */
export const DAEMON_KEEP_PORT_ENV = "COPILOT_ENV_DAEMON_KEEP_PORT";

export function resolveRootHome(): string {
  return process.env[ROOT_HOME_ENV] || resolveHome();
}
// The data home is copilot-env's own: writes inside it are bookkeeping, never reported.
hideWritesUnder(resolveRootHome);

/** `ProfileName` is the proof the segment is safe to join (parsed at the producer boundaries). */
export function profileHome(name: ProfileName): string {
  return join(resolveRootHome(), PROFILES_DIR_NAME, name);
}

/**
 * THE one place the default daemon's home precedence is decided. Inside a daemon, COPILOT_API_HOME IS the
 * pinned home; nothing is derived.
 *   `profiles/default` exists                                    -> it
 *   root holds a DAEMON_HOME_ARTIFACTS entry or the staging dir   -> the root: an unmigrated FLAT home, until the 3.5.6 fix-up
 *   otherwise                                                     -> `profiles/default`
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

/** The sweep and corroboration sites' one list producer, so no caller enumerates homes with a different rule. */
export function allDaemonHomes(): string[] {
  return [defaultDaemonHome(), ...profileHomeNames().map(profileHome)];
}

/** Complements the credential store's `profiles` map: a proxy-mode profile can exist here with no
 *  credential, and vice versa. Directories that are not valid profile names are skipped. Only a MISSING
 *  dir reads as "no profiles": callers use this list to avoid port collisions and to protect tracked
 *  daemons from the orphan sweep, where an incomplete answer is worse than an error. */
export function profileHomeNames(): ProfileName[] {
  try {
    return readdirSync(join(resolveRootHome(), PROFILES_DIR_NAME), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
      .map((entry) => parseProfileName(entry.name))
      .sort();
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
}

export function profileHomeExists(name: ProfileName): boolean {
  return existsSync(profileHome(name));
}

/** OUR per-host run state (port, pid, active CODEX_HOME) under `.run/<host>/`. */
export const RUN_STATE_FILENAME = ".state.json";

/** Lock sidecars are PERMANENT (file_lock.ts never unlinks one), so the root stores' locks park here
 *  instead of cluttering the home listing. Locks inside daemon homes stay beside their files: a daemon
 *  home is the proxy's territory, not ours to reorganize. */
export const LOCKS_DIR_NAME = "locks";

/** Generated helper scripts that FOREIGN programs execute (the Claude Desktop credential helpers).
 *  Undotted contents, like codex-model-catalog.json: something other than copilot-env reads them. */
export const HELPERS_DIR_NAME = "helpers";

export class CopilotApiPaths {
  home: string;
  configFile: string;
  /** Declared beside `configFile`, the file it describes, so the two never drift onto different homes.
   *  Per HOME, not per host: hosts sharing a home share its config.json, so they share its projections. */
  projectionsFile: string;
  runDir: string;
  stateFile: string;
  /** Written ONLY by the in-daemon observer (src/scripts/inference_activity.ts) and read by `agent health`.
   *  Separate from `.state.json` on purpose: the CLI and the daemon write state concurrently, and a
   *  single-writer file sidesteps the lost-update race. */
  activityFile: string;
  logFile: string;
  /** The proxy's per-endpoint handler logs, distinct from the access `logFile` (which also records
   *  liveness pings). `agent health` reads the inference ones as a fallback activity signal for daemons
   *  started by an older copilot-env; the `proxy-logs` config key (off) discards writes here entirely. */
  logsDir: string;
  sqliteDb: string;
  /** `credentials.json`: the provisioned GitHub credentials (default + named profile slots). Account-wide,
   *  so it anchors at the ROOT home, never under `.run/<host>/` or a profile home. */
  sharedStateFile: string;
  /** `preferences.json`, the `agent config` store; account-wide, anchored at the ROOT home. */
  envConfigFile: string;
  /** `ownership.json` (OwnershipLedger). Root-anchored like the state file, and never exported by
   *  `agent settings`: its records name THIS machine's files. */
  ownershipFile: string;
  locksDir: string;
  /** Derived from each store's basename so a store rename cannot silently orphan its lock. */
  sharedStateLock: string;
  envConfigLock: string;
  ownershipLock: string;
  /** The ownership ledger's MUTATION lock (see OwnershipLedger.opsLock). */
  ownershipOpsLock: string;
  /** One root-wide mutex for reserveProfilePort (port.ts), best-effort: past its bounded wait a
   *  reserver proceeds UNLOCKED, so two racing reservers can still mint the same port. */
  profilePortsLock: string;
  /** copilot-api's OWN device-login token (`github_token`). copilot-env never writes it (the token travels
   *  via `--github-token`); it is read and scrubbed only when consolidating an existing proxy login into
   *  our store. Root-home only: profile daemons always receive their token via the flag. */
  githubTokenFile: string;
  /** A device-flow login (auth.ts) holds it across its whole spawn+read+scrub; the de-auth scrub
   *  (credential.ts) waits a bounded two seconds and then SKIPS rather than race a mid-login token write.
   *  Derived beside the file it guards so the two sites never drift onto different lock paths. */
  githubTokenLoginLock: string;
  /** The bundled `codex debug models` catalog with Copilot's live context-window limits overlaid; the
   *  managed Codex config.toml references it by absolute path (`model_catalog_json`). Not dot-prefixed:
   *  Codex and users read it. */
  codexModelCatalogFile: string;

  /** null = the default profile's home (defaultDaemonHome). Account-wide files anchor at the root either way. */
  constructor(profile: Profile = null) {
    this.home = profile === null ? defaultDaemonHome() : profileHome(profile);
    const rootHome = resolveRootHome();
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, RUN_DIR_NAME, hostname);
    this.configFile = join(this.home, PROXY_CONFIG_FILENAME);
    this.projectionsFile = join(this.home, PROJECTIONS_FILENAME);
    this.runDir = runDir;
    this.stateFile = join(runDir, RUN_STATE_FILENAME);
    this.activityFile = join(runDir, ".activity.json");
    this.logFile = join(runDir, ".log");
    this.logsDir = join(this.home, LOGS_DIR_NAME);
    this.sqliteDb = join(runDir, SQLITE_DB_FILENAME);
    this.sharedStateFile = join(rootHome, "credentials.json");
    this.envConfigFile = join(rootHome, "preferences.json");
    this.ownershipFile = join(rootHome, "ownership.json");
    this.locksDir = join(rootHome, LOCKS_DIR_NAME);
    this.sharedStateLock = join(this.locksDir, `${basename(this.sharedStateFile)}.lock`);
    this.envConfigLock = join(this.locksDir, `${basename(this.envConfigFile)}.lock`);
    this.ownershipLock = join(this.locksDir, `${basename(this.ownershipFile)}.lock`);
    this.ownershipOpsLock = join(this.locksDir, `${basename(this.ownershipFile)}.ops.lock`);
    this.profilePortsLock = join(this.locksDir, "profile-ports.lock");
    this.githubTokenFile = join(rootHome, "github_token");
    this.githubTokenLoginLock = join(this.locksDir, `${basename(this.githubTokenFile)}.login.lock`);
    this.codexModelCatalogFile = join(rootHome, "codex-model-catalog.json");
  }
}
