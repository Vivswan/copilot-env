import { join } from "node:path";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { userHomeDir } from "../utils/home.ts";
import { getSanitizedHostname } from "../utils/hostname.ts";
import { hideWritesUnder } from "../utils/report_write.ts";
import {
  DEFAULT_PROFILE_NAME,
  isValidProfileName,
  type Profile,
  type ProfileName,
  parseProfileName,
} from "./profile.ts";

// One spelling on every platform: do NOT swap in a native %LOCALAPPDATA% location on Windows, the wrapper
// and the daemon must derive the identical path. The daemon never depends on this default: every spawn
// pins COPILOT_API_HOME from DaemonSpec.home (process.ts), so the dir carries OUR name, not the proxy package's.
function defaultHome(): string {
  return join(userHomeDir(), ".local", "share", "copilot-env");
}

export function resolveHome(): string {
  return process.env.COPILOT_API_HOME || defaultHome();
}

/** Directory under a daemon home that holds the per-host runtime dirs (`.run/<host>/`). */
export const RUN_DIR_NAME = ".run";

/** The daemon writes it too, whole bytes by rename: the floor in copilot-env.config admits no older writer. */
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
    hosts = fs.readdir(runDir);
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
    if (hostStat?.isDirectory() && statIfPresent(candidate) !== null) {
      paths.push(candidate);
    }
  }

  return paths;
}

/** Only ENOENT/ENOTDIR read as "nothing there"; a swallowed stat error would silently drop a DB from the
 *  cost totals this feeds. */
function statIfPresent(path: string): fs.EntryStats | null {
  try {
    return fs.stat(path);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return null;
    throw e;
  }
}

// --- profile homes ------------------------------------------------------------

// EVERY profile's daemon, the default included, runs against its own home (`<root>/profiles/<name>`): two
// daemons over one home would contend on sqlite and config.json. The ACCOUNT-WIDE files anchor at the ROOT
// home instead, so every profile shares one credential store and one preference set.
//   COPILOT_API_HOME              -> the daemon's own profile home
//   COPILOT_ENV_ROOT_HOME         -> the root home, where the preloads' zero-arg constructors find the shared files
//   COPILOT_ENV_DAEMON_KEEP_PORT  -> DaemonPolicy.releasesPortOnStop, decided once in port.ts and carried so the
//                                    in-daemon idle watchdog never re-derives the policy; declared here, not in
//                                    port.ts, because the watchdog's preload import closure already has paths.ts

/** Under the ROOT home; every daemon home, the default's included, is `profiles/<name>` (defaultDaemonHome). */
export const PROFILES_DIR_NAME = "profiles";

/** Reserved: a user profile can never claim this name (profile.ts rejects it), so the join can never collide. */
export const DEFAULT_PROFILE_DIR = DEFAULT_PROFILE_NAME;

/** The proxy's per-endpoint handler logs; shared across hosts, unlike `.run/<host>/`. */
export const LOGS_DIR_NAME = "logs";

/** Env var carrying the ROOT home inside a profile daemon (set at spawn). */
export const ROOT_HOME_ENV = "COPILOT_ENV_ROOT_HOME";

/** "1"/"0" on EVERY spawn: DaemonPolicy.releasesPortOnStop, carried so the idle watchdog never re-derives it. */
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

/** The sweep and corroboration sites' one list producer, so no caller enumerates homes with a
 *  different rule. `rootHome` names ANOTHER root's homes (the float warming a fixture root); unset,
 *  the resolved root's, where the default daemon's home follows the env pins. */
export function allDaemonHomes(rootHome?: string): string[] {
  if (rootHome === undefined) return [defaultDaemonHome(), ...profileHomeNames().map(profileHome)];
  return [
    join(rootHome, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR),
    ...profileHomeNamesUnder(rootHome).map((name) => join(rootHome, PROFILES_DIR_NAME, name)),
  ];
}

/** Complements the credential store's `profiles` map: a proxy-mode profile can exist here with no
 *  credential, and vice versa. Directories that are not valid profile names are skipped. Only a MISSING
 *  dir reads as "no profiles": callers use this list to avoid port collisions and to protect tracked
 *  daemons from the orphan sweep, where an incomplete answer is worse than an error. */
export function profileHomeNames(): ProfileName[] {
  return profileHomeNamesUnder(resolveRootHome());
}

function profileHomeNamesUnder(rootHome: string): ProfileName[] {
  try {
    return fs
      .readdirEntries(join(rootHome, PROFILES_DIR_NAME))
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
      .map((entry) => parseProfileName(entry.name))
      .sort();
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
}

export function profileHomeExists(name: ProfileName): boolean {
  return fs.exists(profileHome(name));
}

/** OUR per-host run state (port, pid, active CODEX_HOME) under `.run/<host>/`. */
export const RUN_STATE_FILENAME = ".state.json";

/** The one account-wide store at the ROOT home (src/copilot_api/state_store.ts). */
export const STATE_STORE_FILENAME = "state.json";

/** The root stores' lock markers park here instead of cluttering the home listing (CopilotApiPaths.locksDir). */
export const LOCKS_DIR_NAME = "locks";

/**
 * Every path of one daemon home and of the ROOT home. `.activity.json` is separate from `.state.json`
 * on purpose: the CLI and the daemon write state concurrently, and a single-writer file sidesteps the
 * lost-update race. In `state.json`, `global` and each `profiles.<name>` hold the settings
 * (`agent config`) beside the state (the credential slots, the catalog throttle), and `ownership`
 * holds the claims on files we wrote.
 *
 * Undotted files (codex-model-catalog.json, which the managed Codex config.toml references by
 * absolute path) are the ones something other than copilot-env reads.
 */
export class CopilotApiPaths {
  /** The daemon home: `profiles/<name>`, or the default's (defaultDaemonHome); never the root. */
  home: string;

  /** The proxy's own config.json in the daemon home; the daemon writes it too (PROXY_CONFIG_FILENAME). */
  configFile: string;

  /** `.run/<sanitized hostname>/` under the home: the per-host runtime files. */
  runDir: string;

  /** `.state.json` under runDir: port, pid, active CODEX_HOME (RUN_STATE_FILENAME). */
  stateFile: string;

  /** Single-writer: only the in-daemon observer (inference_activity.ts) writes it, and `agent health` reads it. */
  activityFile: string;

  /** The daemon's stdout and stderr, redirected at spawn; liveness pings land here too. */
  logFile: string;

  /** The proxy's per-endpoint handler logs, apart from the access `logFile`; `daemon.logs` off discards them. */
  logsDir: string;

  /** The proxy's usage database for this host (COPILOT_API_SQLITE_DB_PATH); `agent cost` sweeps these. */
  sqliteDb: string;

  /** `state.json` (state_store.ts): the ONE account-wide store, at the ROOT home and never in a daemon home. */
  stateStoreFile: string;

  /** `locks/` at the ROOT; a daemon home's locks stay beside their files, that home being the proxy's to lay out. */
  locksDir: string;

  /** The store's one lock, derived from its basename so a rename cannot silently orphan it. */
  stateStoreLock: string;

  /** reserveProfilePort's root-wide mutex (port.ts): a late holder errors, so two reservers never mint one port. */
  profilePortsLock: string;

  /** The managed Codex config.toml's `model_catalog_json`: the bundled catalog, Copilot's live limits overlaid. */
  codexModelCatalogFile: string;

  /** null = the default profile's home (defaultDaemonHome). Account-wide files anchor at the root either way. */
  constructor(profile: Profile = null) {
    this.home = profile === null ? defaultDaemonHome() : profileHome(profile);
    const rootHome = resolveRootHome();
    const hostname = getSanitizedHostname();
    const runDir = join(this.home, RUN_DIR_NAME, hostname);
    this.configFile = join(this.home, PROXY_CONFIG_FILENAME);
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

/** The usage pre-index and the price cache (src/usage/index.ts, pricing.ts) share it: bookkeeping, never truth. */
export const USAGE_INDEX_DIR_NAME = "usage-index";

export function usageIndexDir(): string {
  return join(resolveRootHome(), USAGE_INDEX_DIR_NAME);
}
