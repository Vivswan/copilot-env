// The `agent start` launch pipeline, one named function per step; src/commands/start.ts orchestrates
// them. String literals here are external contracts (config-file keys, copilot-api model ids, log
// markers): never change them in a refactor.
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { floatProxy, proxyFloatVerifyStatus } from "../proxy_float.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { withFileLock } from "../utils/file_lock.ts";
import { isRecord } from "../utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig, ensureDict } from "./config.ts";
import { Credential } from "./credential.ts";
import { assertProfileSlot, type AuthProvider } from "./env_state.ts";
import { directOverlay, landDirectPair, renderDirectPair } from "./direct_pair.ts";
import type { ConfigValue, ProxyConfigPath } from "./config_registry.ts";
import { configSetCommand, CopilotEnvConfig, projectedProxyConfig } from "./env_config.ts";
import {
  daemonClientHeaders,
  type selectDirectIdentityAndHost,
  usePatPassthrough,
} from "./integration_identity.ts";
import { generateAliases } from "./models.ts";
import { CopilotApiPaths, DAEMON_KEEP_PORT_ENV, resolveRootHome, ROOT_HOME_ENV } from "./paths.ts";
import { isStandaloneBinary } from "../utils/root.ts";
import { colorEnabled, paintFor } from "../utils/ansi.ts";
import { formatTable, terminalWidth } from "../utils/table.ts";
import * as fs from "../utils/fs_facade.ts";
import { detectSidecar, ensureSidecar, resolveDenoBin } from "./sidecar.ts";
import {
  checkProxyPort,
  copilotApiFindPort,
  copilotApiResolvePort,
  daemonPolicy,
  proxyPortFree,
  reserveProfilePort,
} from "./port.ts";
import {
  type CopilotApiEntry,
  type DaemonCredential,
  LAUNCH_SETTLE_MS,
  launchDaemon,
  pidAlive,
  printLogTail,
  resolveCopilotApiEntry,
} from "./process.ts";
import type { Profile } from "./profile.ts";
import { CopilotEnvRunState } from "./run_state.ts";
import { installedProxyVersion, PROXY_PACKAGE_NAME, proxyVersionFloorStatus } from "./version.ts";

// --- the start lock -----------------------------------------------------------

// Two concurrent `agent start` (two agents auto-starting at once) would each reap the OTHER's freshly
// launched daemon. The lock reclaims ONLY a DEAD holder (staleMs = Infinity): a start may hold it
// for a while (the float, the cleanup), and age-stealing it would let the waiter kill its daemon.
const START_LOCK_RETRY_MS = 250;
const START_LOCK_NOTICE_MS = 2000;

/** ONE GLOBAL lock in the DEFAULT run dir: the orphan sweep scans machine-wide, so two starts of
 *  DIFFERENT profiles could each reap the other's not-yet-tracked daemon. PURE (no dir creation):
 *  the default-home migration probes this path without materializing run dirs. */
export function startLockPath(): string {
  return join(new CopilotApiPaths().runDir, ".start.lock");
}

/** The wait is UNBOUNDED and never proceeds unlocked, which could let a waiter reap the holder's daemon.
 *  Only a DEAD holder is reclaimed (staleMs Infinity), so a live holder keeps every other start waiting for
 *  as long as it runs -- and an unopenable `.start.lock.oslock` (EACCES) retries forever, with no holder.
 *  So fn ALWAYS runs held: the launch critical section (ensureProxyFloor, cleanupExistingProxies) runs
 *  inside it, an order its one caller (commands/start.ts) keeps. */
export function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = startLockPath();
  fs.mkdir(dirname(lockPath));
  return withFileLock(lockPath, {
    staleMs: Number.POSITIVE_INFINITY,
    waitMs: Number.POSITIVE_INFINITY,
    retryMs: START_LOCK_RETRY_MS,
    noticeAfterMs: START_LOCK_NOTICE_MS,
    onWait: () =>
      consola.info("Another `agent start` is in progress; waiting for it to finish ..."),
  }, fn);
}

// --- the proxy freshness + floor gate ---------------------------------------------

/** null when the version cannot be known ahead of the launch: a mapped entry whose node_modules copy
 *  is missing, or a file override that runs whatever the file is (the CI fake has no version at all). */
export function entryProxyVersion(entry: CopilotApiEntry): string | null {
  switch (entry.kind) {
    case "floated":
      return entry.version;
    case "package":
      return installedProxyVersion();
    case "file":
      return null;
    default:
      return assertNever(entry);
  }
}

/**
 * Runs INSIDE the start lock (withStartLock, held by its one caller in commands/start.ts) so two
 * concurrent starts never re-warm the float's cache over each other, and BEFORE spawnConfiguredDaemon,
 * which runs the entry judged here. The float is best-effort (offline keeps what is cached), but the
 * floor is a hard contract: fail-closed, before disturbing any running daemon. A `COPILOT_API_ENTRY`
 * override skips both: it runs a file we did not resolve or version.
 */
export async function ensureProxyFloor(): Promise<CopilotApiEntry> {
  const preflight = resolveCopilotApiEntry();
  if (preflight.kind === "file") return preflight;

  // A compiled build's own executable is not a deno CLI, so SOME deno (PATH or a provisioned sidecar)
  // must exist before the float can warm a cache or the daemon can launch. A no-op from a checkout.
  const sidecar = await ensureSidecar(resolveRootHome());
  if (isStandaloneBinary()) consola.info(`Using deno for proxy work: ${sidecar}`);

  const status = await proxyFloatVerifyStatus();
  if (!status.upToDate) {
    consola.info(status.message);
    try {
      await floatProxy();
    } catch (e) {
      consola.warn(`proxy float failed (${errMessage(e)}); checking what is already available`);
    }
  }

  // A successful float just wrote the record, which moves the entry from the mapped fallback to the
  // floated version.
  return judgeProxyFloor();
}

/** The start preview's floor gate, at the point in the order the live gate holds: the verify look
 *  (read-only but for the daemon config it re-renders, which lands on the overlay) and the same
 *  judgment of the resolved entry, without the float that would warm the real cache. The live gate
 *  provisions a sidecar deno first; the preview downloads nothing, so with no deno to hand the look
 *  (which spawns one) is skipped and the recorded entry alone is judged. A refusal is the live
 *  gate's, word for word. */
export async function previewProxyFloor(): Promise<void> {
  if (resolveCopilotApiEntry().kind === "file") return;
  if (detectSidecar(resolveRootHome()).kind !== "absent") {
    const status = await proxyFloatVerifyStatus();
    if (!status.upToDate) consola.info(status.message);
  }
  judgeProxyFloor();
}

/** The resolved entry against the floor: fail-closed on an unresolved version or one below it. */
function judgeProxyFloor(): CopilotApiEntry {
  const entry = resolveCopilotApiEntry();
  const version = entryProxyVersion(entry);
  if (version === null) {
    throw new Error(
      `${PROXY_PACKAGE_NAME} is not resolved or installed - run 'agent start' online to float it, ` +
        "or 'deno install' to restore the baseline.",
    );
  }
  let config: ProjectConfig;
  try {
    config = readProjectConfig();
  } catch (e) {
    throw new Error(`could not read the proxy floor from copilot-env.config: ${errMessage(e)}`);
  }
  const floorStatus = proxyVersionFloorStatus(version, config);
  if (!floorStatus.ok && floorStatus.reason === "belowFloor") {
    throw new Error(
      `${PROXY_PACKAGE_NAME} ${floorStatus.version} is below the required ${floorStatus.floor} floor - the proxy ` +
        `float likely failed (offline?) or was skipped because both ` +
        `agents are wired Direct. Re-run 'agent start' online, set COPILOT_API_VERSION to a ` +
        `known-good release, or rewire an agent to the proxy ('agent init --proxy') first.`,
    );
  }
  return entry;
}

// --- port resolution --------------------------------------------------------------

/**
 * A pinned `--port` must be free: never silently move off the port the user asked for. The soft base
 * is PERSISTED only when `reserve` (the live launch path; the dry run peeks without recording).
 */
export async function resolveStartPort(
  pinned: number | undefined,
  announce: boolean,
  profile: Profile,
  reserve: boolean,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): Promise<number> {
  const min = config.minPort();
  const max = config.maxPort();
  if (min > max) {
    throw new Error(
      `invalid port range: daemon.min-port (${min}) is greater than daemon.max-port (${max}); ` +
        `fix it with \`${configSetCommand("daemon.min-port", "<n>")}\` / \`${
          configSetCommand("daemon.max-port", "<n>")
        }\`.`,
    );
  }
  if (pinned !== undefined) {
    switch (await checkProxyPort(pinned)) {
      case "out-of-range":
        throw new Error(
          `requested port ${pinned} is out of range; the proxy port must be between ${min} and ${max} ` +
            `(\`${configSetCommand("daemon.min-port", "<n>")}\` / \`${
              configSetCommand("daemon.max-port", "<n>")
            }\` change the range).`,
        );
      case "busy":
        throw new Error(
          `requested port ${pinned} is busy (held by another process). Free it or pick another --port.`,
        );
      case "free":
        return pinned;
    }
  }
  // An EXISTING reservation is honored even when min/max later narrowed past it (the range governs
  // NEW allocations), so it gets a liveness-only probe instead of the range gate.
  const policy = daemonPolicy(profile);
  let honoredReservation = false;
  let def: number;
  if (policy.port.source === "config") {
    def = config.defaultPort();
  } else {
    const name = policy.port.name;
    const recorded = CopilotEnvRunState.forProfile(name).read().port;
    honoredReservation = recorded !== undefined;
    def = recorded ??
      (reserve ? reserveProfilePort(name) : Number(copilotApiResolvePort(name)));
  }
  switch (await checkProxyPort(def)) {
    case "free":
      return def;
    case "out-of-range":
      if (honoredReservation) {
        if (await proxyPortFree(def)) return def;
        break; // a busy reservation auto-increments back inside the range
      }
      throw new Error(
        `configured port ${def} is outside the allowed range ${min}-${max}; run ` +
          `\`${
            configSetCommand("daemon.port", "<n>")
          }\` within the range, or adjust daemon.min-port/daemon.max-port.`,
      );
    case "busy":
      break;
  }
  if (policy.strictPortEligible && config.strictPortEnabled()) {
    throw new Error(
      `port ${def} is busy and auto-increment is disabled (\`daemon.strict-port\`); free it, pick another ` +
        `\`--port\`, or set \`${configSetCommand("daemon.strict-port", "false")}\`.`,
    );
  }
  if (announce) consola.warn(`Port ${def} is busy (held by another process/user).`);
  let port: number;
  try {
    port = await copilotApiFindPort(def + 1);
  } catch {
    throw new Error("could not find a free port to start the proxy.");
  }
  if (announce) consola.success(`Using alternative port: ${port}`);
  return port;
}

// --- credential resolution ---------------------------------------------------------

/** What the refusal gate read from the slot: the token the daemon runs with and the provider that
 *  stored it, handed on to the resolution so a launch reads its slot once. */
export interface LaunchToken {
  token: string;
  provider: AuthProvider | null;
}

/**
 * The launch's refusal, and NOTHING else: reads of state.json alone (a recorded gh-cli's `gh auth
 * token` IS the credential), so `agent start` refuses before it takes the start lock, makes a
 * directory, stops the running daemon (`--force`), probes a port, or spawns anything, the codex
 * User-Agent's version lookup included. A named profile must exist (`agent profile <name> add` is its one
 * creator): its slot's own reason would otherwise send the user to an `agent profile <name> auth` that
 * cannot create it. It resolves ONLY its own slot, never the default credential, and NO credential
 * refuses the launch: the daemon never logs in on its own (a token it minted would live in the
 * proxy's files, outside the store), so the refusal names the `agent auth` the slot needs.
 */
export function readLaunchToken(profile: Profile): LaunchToken {
  if (profile !== null) assertProfileSlot(profile);
  const credential = new Credential(undefined, profile);
  // Passed as `--github-token`, copilot-api holds the token in memory and writes no github_token file
  // of its own, so the proxy stays on our single source of truth.
  const resolved = credential.resolveWithReason();
  if (resolved.token === null) {
    throw new Error(`cannot start the proxy without a credential: ${resolved.reason}`);
  }
  return { token: resolved.token, provider: credential.provider() };
}

/** `userAgent` is REQUIRED: the daemon sends the codex User-Agent the agent configs bake
 *  (codexUserAgent(), the codex layer), and the probe must run under the bytes the daemon then
 *  sends. */
export interface LaunchCredentialDeps {
  userAgent: string;
  selectIdentity?: typeof selectDirectIdentityAndHost;
}

/** What a daemon launch resolved: the credential it runs with and the Copilot host it is pinned
 *  to, one pair, so the daemon never sends an identity to a host that was not judged under it. */
export interface DaemonLaunchAuth {
  credential: DaemonCredential;
  copilotHost: string;
}

/**
 * The daemon's DaemonCredential itself for the token the gate read (readLaunchToken), so the launch
 * never carries a passthrough decision apart from the token it applies to. The client identity is
 * THE one per credential, read and landed through direct_pair.ts like every Direct re-render; the
 * daemon then applies it upstream through the client-headers preload, so the proxy serves the
 * catalog the Direct configs see. This half may probe Copilot and land the pair: it runs after the
 * gate, under the start lock, never before a refusal could.
 */
export async function resolveLaunchCredential(
  profile: Profile,
  launch: LaunchToken,
  config: CopilotEnvConfig,
  deps: LaunchCredentialDeps,
): Promise<DaemonLaunchAuth> {
  const overlay = directOverlay(profile, config);
  const githubToken = launch.token;
  // A gh-cli OAuth token or a PAT cannot perform copilot-api's editor token exchange, so the
  // passthrough shim fakes it and hands the token straight through as the Copilot bearer.
  const forcePassthrough = config.passthroughOverride(profile);
  const patPassthrough = usePatPassthrough({
    force: forcePassthrough,
    token: githubToken,
    provider: launch.provider,
  });
  if (patPassthrough) {
    consola.info(
      "Token passthrough on: faking the editor token exchange so the proxy uses the token directly.",
    );
  } else if (forcePassthrough === false) {
    consola.info("Token passthrough off: using the standard editor token exchange.");
  }
  // A half the slot never probed is landed here, BEFORE launching, so an unusable credential fails
  // with the real reason instead of an opaque daemon-side "Failed to get models".
  const { integrationId, apiBase } = renderDirectPair(profile, overlay) ??
    await landDirectPair(profile, githubToken, deps.userAgent, {
      ...overlay,
      selectIdentity: deps.selectIdentity,
    });
  const clientHeaders = daemonClientHeaders(deps.userAgent, integrationId);
  return {
    credential: patPassthrough
      ? { kind: "pat", token: githubToken, clientHeaders }
      : { kind: "token", token: githubToken, clientHeaders },
    copilotHost: apiBase,
  };
}

// --- the configured daemon spawn ------------------------------------------------------

/** `relaunch` blanks the log and launches on a new port with the IDENTICAL env and preloads (the
 *  EADDRINUSE bind-race retry); the caller seeds the watchdog heartbeat after readiness. */
export interface SpawnedDaemon {
  pid: number;
  idleWatchdog: boolean;
  relaunch: (port: number) => number;
}

/**
 * Every daemon runs against its OWN home (paths.ts), so concurrent daemons never contend on one.
 *
 *   the root home rides alongside      -> the in-daemon preloads still find the ACCOUNT-WIDE files
 *   keep-port is set, never inherited  -> a stale environment cannot steer the idle watchdog's auto-stop clear
 */
export function daemonLifecycleEnv(
  profile: Profile,
  paths: CopilotApiPaths,
): Record<string, string> {
  return {
    COPILOT_API_SQLITE_DB_PATH: paths.sqliteDb,
    [ROOT_HOME_ENV]: resolveRootHome(),
    [DAEMON_KEEP_PORT_ENV]: daemonPolicy(profile).releasesPortOnStop ? "0" : "1",
  };
}

/** The credential's own environment and preload set are derived inside launchDaemon from the
 *  DaemonCredential, so they cannot disagree with it here. */
export function spawnConfiguredDaemon(opts: {
  port: number;
  logFile: string;
  profile: Profile;
  paths: CopilotApiPaths;
  credential: DaemonCredential;
  /** resolveLaunchCredential's host for `credential` (one pair), so the spawn never re-probes. */
  copilotHost: string;
  /** The entry ensureProxyFloor judged (the caller runs that gate first); every bind-race relaunch
   *  runs exactly it. */
  entry: CopilotApiEntry;
  config?: CopilotEnvConfig;
}): SpawnedDaemon {
  const { port, logFile, profile, paths, credential, copilotHost, entry } = opts;
  const config = opts.config ?? new CopilotEnvConfig();
  const denoBin = resolveDenoBin();
  const daemonEnv = daemonLifecycleEnv(profile, paths);
  // The idle watchdog lives in the daemon process, so server and watchdog are one unit (no orphan
  // either way) and every (re)start re-attaches it. With `daemon.auto-start` off there is no watchdog.
  const idleWatchdog = config.autoStartEnabled();
  // Activity detection is unaffected by the mute: the always-loaded inference observer watches inbound
  // requests, not log files.
  const muteProxyLogs = !config.proxyLogsEnabled();
  if (muteProxyLogs) {
    consola.info("Proxy request logs off: discarding writes under <home>/logs (`daemon.logs`).");
  }
  const relaunch = (p: number): number => {
    // Blanked only HERE, at spawn time: a failure BEFORE launch (a login error, an identity-probe
    // rejection) keeps the previous run's log for diagnosis. In place (not atomic): the file the
    // daemon holds open is the one truncated.
    fs.writeText(logFile, "", { atomic: false, detail: "proxy log, blanked for this launch" });
    return launchDaemon({
      port: p,
      logFile,
      home: paths.home,
      env: daemonEnv,
      credential,
      copilotHost,
      idleWatchdog,
      muteProxyLogs,
      entry,
      denoBin,
    });
  };
  return { pid: relaunch(port), idleWatchdog, relaunch };
}

// --- the readiness wait ---------------------------------------------------------------

/** The daemon logs "Failed to get Copilot token" when the exchange returns 404/403. A gh-cli or PAT
 *  credential needs the passthrough; anything else needs a Copilot-capable login. */
function copilotTokenFailureHint(log: string, profile: Profile): string | null {
  if (!/Failed to get Copilot token/i.test(log)) return null;
  const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
  return (
    "The credential was not accepted by Copilot's token exchange. For a gh-cli or PAT credential, " +
    `enable passthrough (\`${
      configSetCommand("passthrough", "on", profile)
    }\`); otherwise re-authenticate with a ` +
    `Copilot-capable login (\`${authCommand} --provider copilot\`).`
  );
}

/**
 * A lost bind race (EADDRINUSE in the log) retries ONCE on another port, unless the port was pinned by
 * `--port` or `daemon.strict-port` steers the DEFAULT daemon; a named profile's reservation is soft, so its
 * bind race always retries. Readiness is the "Listening on:" log line.
 */
export async function awaitReadiness(opts: {
  pid: number;
  port: number;
  logFile: string;
  profile: Profile;
  /** A lost bind race on a pinned port fails, never moves. */
  pinnedPort: number | undefined;
  state: CopilotEnvRunState;
  relaunch: (port: number) => number;
  config?: CopilotEnvConfig;
  /** Test seam, to avoid real port scans. */
  findPort?: (start: number) => Promise<number>;
}): Promise<{ pid: number; port: number }> {
  const { logFile, profile, pinnedPort, state, relaunch } = opts;
  const config = opts.config ?? new CopilotEnvConfig();
  const findPort = opts.findPort ?? copilotApiFindPort;
  let { pid, port } = opts;

  let retried = false;
  for (;;) {
    await sleep(LAUNCH_SETTLE_MS);
    if (pidAlive(pid)) break;
    if (retried) {
      printLogTail(logFile, 20);
      throw new Error(
        `the proxy failed to start after retrying on a different port. See ${logFile}`,
      );
    }
    let logContent = "";
    try {
      logContent = fs.readText(logFile);
    } catch {
      logContent = "";
    }
    if (!/address already in use|EADDRINUSE|bind.*failed/i.test(logContent)) {
      printLogTail(logFile, 20);
      const hint = copilotTokenFailureHint(logContent, profile);
      if (hint) consola.error(hint);
      throw new Error(`the proxy failed to start. See ${logFile}`);
    }
    // Same exemption as resolveStartPort: `daemon.strict-port` gates only the policy-eligible daemon.
    const strictPort = daemonPolicy(profile).strictPortEligible && config.strictPortEnabled();
    if (pinnedPort !== undefined || strictPort) {
      printLogTail(logFile, 20);
      throw new Error(
        `port ${port} was taken by another process just before launch` +
          `${
            strictPort && pinnedPort === undefined
              ? " (daemon.strict-port is on, so no auto-increment)"
              : ""
          }. See ${logFile}`,
      );
    }
    consola.warn(
      `Port ${port} was taken by another process just before launch; retrying on a different port ...`,
    );
    try {
      port = await findPort(port + 1);
    } catch {
      throw new Error("could not find a free port after the retry.");
    }
    pid = relaunch(port);
    retried = true;
  }
  if (retried) consola.success(`Started on port ${port} after retry.`);

  state.set({ pid, port });
  consola.info(`Started the proxy (PID ${pid}) on port ${port}, detached.`);

  consola.start("Waiting for the proxy to start (tailing its log) ...");

  const maxWait = 120;
  let ready = false;
  let printedLogBytes = 0;
  for (let i = 0; i < maxWait; i++) {
    if (!pidAlive(pid)) {
      try {
        const hint = copilotTokenFailureHint(fs.readText(logFile), profile);
        if (hint) consola.error(hint);
      } catch {
        // A missing or unreadable log just means no hint.
      }
      throw new Error(`the proxy (PID ${pid}) exited during startup. See ${logFile}.`);
    }
    let logContent = "";
    try {
      const logBytes = fs.readBytes(logFile);
      if (logBytes.length < printedLogBytes) {
        printedLogBytes = 0;
      }
      if (logBytes.length > printedLogBytes) {
        process.stderr.write(logBytes.subarray(printedLogBytes));
        printedLogBytes = logBytes.length;
      }
      logContent = new TextDecoder().decode(logBytes);
    } catch {
      // A failed read is not a proven "not listening", but the loop RE-READS every second, so a
      // transient failure self-heals; a persistently unreadable log still fails loudly below,
      // pointing at the file, never as a confident health verdict.
      logContent = "";
    }
    if (logContent.includes("Listening on:")) {
      ready = true;
      break;
    }
    await sleep(LAUNCH_SETTLE_MS);
  }

  if (!ready) {
    consola.warn(`The proxy did not start listening on port ${port} within ${maxWait}s.`);
    consola.warn(`It may still be coming up; check the log file: ${logFile}`);
    throw new Error(`the proxy did not start listening on port ${port} within ${maxWait}s`);
  }

  consola.success(`The proxy is up on port ${port} (PID ${pid}).`);
  return { pid, port };
}

// --- proxy-config defaults + the post-start alias sync ------------------------------------

/** Merges into existing nested records so sibling keys the daemon owns (`contextManagement.messages`)
 *  survive; a non-record in the way is replaced. */
function setProxyConfigValue(
  doc: Record<string, unknown>,
  path: ProxyConfigPath,
  value: ConfigValue,
): void {
  const [head, ...rest] = path;
  let node = doc;
  let leaf = head;
  for (const key of rest) {
    node = ensureDict(node, leaf);
    leaf = key;
  }
  node[leaf] = value;
}

/** A missing or non-record parent means nothing of ours can be there; parents are never created or pruned. */
function deleteProxyConfigValue(doc: Record<string, unknown>, path: ProxyConfigPath): void {
  const [head, ...rest] = path;
  let node = doc;
  let leaf = head;
  for (const key of rest) {
    const child = node[leaf];
    if (!isRecord(child)) return;
    node = child;
    leaf = key;
  }
  delete node[leaf];
}

export function applyDefaultConfig(
  profile: Profile,
  paths: CopilotApiPaths,
  envConfig: CopilotEnvConfig = new CopilotEnvConfig(),
): void {
  // The projected preferences are static defaults the daemon reads at startup with no admin REST
  // endpoint, so they go into config.json before launch (model aliases are pushed live instead),
  // resolved for THIS daemon's profile. Every projected path lands on every start: set as it
  // resolves, cleared while its opt-in key is unset, so `agent config unset` reverts the daemon to
  // the proxy's own default. The daemon's config.json is an output: a value at one of our paths is
  // re-rendered from the store whoever wrote it, and the daemon's own keys are never touched.
  const config = new CopilotApiConfig(paths.configFile);
  config.update((d) => {
    for (const entry of projectedProxyConfig(profile, envConfig)) {
      if (entry.value === undefined) deleteProxyConfigValue(d, entry.path);
      else setProxyConfigValue(d, entry.path, entry.value);
    }
  });
  // Without an admin key the live `/admin/config/model-mappings` route (syncModelAliases) 401s.
  config.ensureAdminApiKey();
}

/**
 * The floated proxy re-adds any MISSING default extraPrompt key on every config reload
 * (`mergeDefaultConfig`), so an empty or absent map is futile; every key the daemon has already
 * written is blanked instead, and discovering the set at runtime survives new default prompts. Must
 * run after the daemon is up (config.json then holds the full default set) and before the
 * model-mappings POST, whose reloadConfig() applies the blanks.
 */
function disableExtraPrompts(config: CopilotApiConfig): void {
  config.update((d) => {
    const current = d.extraPrompts;
    const blanked: Record<string, string> = {};
    if (isRecord(current)) {
      for (const key of Object.keys(current)) {
        blanked[key] = "";
      }
    }
    d.extraPrompts = blanked;
  });
}

/** Best-effort: on failure no aliases are set and the proxy still resolves plain dash-form ids via
 *  its own normalizer. */
async function syncModelAliases(admin: CopilotAdminClient): Promise<void> {
  try {
    const catalog = await admin.getModels();
    const aliases = generateAliases(catalog);
    await admin.setModelMappings(aliases);
    consola.success(`Synced ${Object.keys(aliases).length} model aliases from catalog.`);
  } catch (e) {
    consola.warn(
      `Could not sync model aliases from catalog (${errMessage(e)}); check \`agent health\`.`,
    );
  }
  await printModelAliases(admin);
}

async function printModelAliases(admin: CopilotAdminClient): Promise<void> {
  let mappings: Record<string, string>;
  try {
    mappings = await admin.getModelMappings();
  } catch (e) {
    consola.warn(`Could not read live model mappings (${errMessage(e)}); check \`agent health\`.`);
    return;
  }
  // One message, one consola timestamp: a stamp per row wraps and interleaves at terminal width.
  consola.info(renderModelAliases(mappings));
}

/** One row per target model; its aliases wrap inside their own column. */
export function renderModelAliases(
  mappings: Record<string, string>,
  width: number | null = terminalWidth(),
  color = colorEnabled(),
): string {
  const sources = Object.keys(mappings);
  const byTarget = new Map<string, string[]>();
  for (const source of sources) {
    const target = mappings[source];
    if (target === undefined) {
      continue;
    }
    const list = byTarget.get(target) ?? [];
    list.push(source);
    byTarget.set(target, list);
  }
  const targets = [...byTarget.keys()].sort();
  const rows = formatTable(
    targets.map((target) => [target, "<-", (byTarget.get(target) ?? []).sort().join(", ")]),
    { indent: "   ", wrap: [false, false, true], width, color },
  );
  const heading = paintFor(color).bold(
    `Model aliases (${sources.length} -> ${targets.length} models):`,
  );
  return `${heading}\n${rows.join("\n")}`;
}

/** The extraPrompts blank must precede the alias sync: the setModelMappings POST triggers the daemon's
 *  reloadConfig(), which applies it. */
export async function syncAliasesAfterStart(config: CopilotApiConfig, port: number): Promise<void> {
  disableExtraPrompts(config);
  const admin = new CopilotAdminClient({
    port,
    apiKey: config.ensureApiKey(),
    adminKey: config.ensureAdminApiKey(),
  });
  await syncModelAliases(admin);
}
