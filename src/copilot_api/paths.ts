import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** One per host dir (usageDbsUnderHome). */
export const SQLITE_DB_FILENAME = "copilot-api.sqlite";

/** Lives here so `agent cost`'s sweep follows any future move of the DB layout. Only paths that exist
 *  are returned. */
export function usageDbsUnderHome(home: string): string[] {
  const paths: string[] = [];

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

// EVERY profile's daemon, the default included, runs against its own home (`<root>/profiles/<name>`): two
// daemons over one home would contend on sqlite and config.json. The ACCOUNT-WIDE files anchor at the ROOT
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
 * THE one place the default daemon's home is decided. Inside a daemon, COPILOT_API_HOME IS the pinned
 * home; nothing is derived. Outside one it is `profiles/default`, whatever else the root holds: the root
 * anchors the account-wide files and is never a daemon home.
 */
export function defaultDaemonHome(): string {
  if (process.env[ROOT_HOME_ENV]) return resolveHome();
  return join(resolveHome(), PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR);
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

/** The one account-wide store at the ROOT home (src/copilot_api/state_store.ts). */
export const STATE_STORE_FILENAME = "state.json";

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
   *  liveness pings); the `daemon.logs` config key (off) discards writes here entirely. */
  logsDir: string;
  sqliteDb: string;
  /** `state.json`: the ONE account-wide store (src/copilot_api/state_store.ts): `global` and each
   *  `profiles.<name>` hold the settings (`agent config`) beside the state (the credential slots,
   *  the catalog throttle), and `ownership` holds the claims on files we wrote. Account-wide, so it
   *  anchors at the ROOT home, never under `.run/<host>/` or a profile home. */
  stateStoreFile: string;
  locksDir: string;
  /** The store's one lock, derived from its basename so a rename cannot silently orphan it. */
  stateStoreLock: string;
  /** One root-wide mutex for reserveProfilePort (port.ts), best-effort: past its bounded wait a
   *  reserver proceeds UNLOCKED, so two racing reservers can still mint the same port. */
  profilePortsLock: string;
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
    this.stateStoreFile = join(rootHome, STATE_STORE_FILENAME);
    this.locksDir = join(rootHome, LOCKS_DIR_NAME);
    this.stateStoreLock = join(this.locksDir, `${STATE_STORE_FILENAME}.lock`);
    this.profilePortsLock = join(this.locksDir, "profile-ports.lock");
    this.codexModelCatalogFile = join(rootHome, "codex-model-catalog.json");
  }
}
