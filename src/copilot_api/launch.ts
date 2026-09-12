// The `agent start` launch pipeline, one named function per step; src/commands/start.ts orchestrates
// them. String literals here are external contracts (config-file keys, copilot-api model ids, log
// markers): never change them in a refactor.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { floatProxy, proxyFloatVerifyStatus } from "../proxy_float.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { BOUNDED_LOCK_POLICY, withFileLock, withFileLockSync } from "../utils/file_lock.ts";
import { isRecord } from "../utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { CopilotAdminClient } from "./admin.ts";
import { CopilotApiConfig, ensureDict } from "./config.ts";
import { Credential } from "./credential.ts";
import {
  type ConfigValue,
  CopilotEnvConfig,
  optInProxyConfigPaths,
  projectedProxyConfig,
  type ProxyConfigPath,
} from "./env_config.ts";
import { resolvePassthroughIntegrationId, usePatPassthrough } from "./integration_identity.ts";
import { generateAliases } from "./models.ts";
import {
  allDaemonHomes,
  CopilotApiPaths,
  DAEMON_KEEP_PORT_ENV,
  profileHomeNames,
  resolveRootHome,
  ROOT_HOME_ENV,
} from "./paths.ts";
import { daemonLockHold, daemonLockHolderPid, daemonLockVerdict } from "../scripts/daemon_lock.ts";
import { isStandaloneBinary } from "../utils/root.ts";
import { mkdirReported, writeFileReported } from "../utils/report_write.ts";
import { ensureSidecar, resolveDenoBin } from "./sidecar.ts";
import {
  checkProxyPort,
  copilotApiFindPort,
  copilotApiResolvePort,
  daemonPolicy,
  proxyPortFree,
  reserveProfilePort,
} from "./port.ts";
import {
  classifyDaemonPid,
  classifyOwnedDaemonPid,
  type CopilotApiEntry,
  DAEMON_SIGKILL_GRACE_MS,
  type DaemonCredential,
  getOrphanPids,
  isCopilotApiPid,
  launchDaemon,
  pidAlive,
  printLogTail,
  resolveCopilotApiEntry,
  terminatePid,
} from "./process.ts";
import type { Profile } from "./profile.ts";
import { ProxyProjectionState } from "./ownership.ts";
import { CopilotEnvRunState } from "./state.ts";
import { installedProxyVersion, PROXY_PACKAGE_NAME, proxyVersionFloorStatus } from "./version.ts";

// --- the start lock -----------------------------------------------------------

// Two concurrent `agent start` (two agents auto-starting at once) would each reap the OTHER's freshly
// launched daemon. The lock reclaims ONLY a DEAD holder (staleMs = Infinity): a start may hold it for
// minutes while it prompts for interactive auth, and age-stealing it would let the waiter kill its daemon.
const START_LOCK_RETRY_MS = 250;
const START_LOCK_NOTICE_MS = 2000;

/** ONE GLOBAL lock in the DEFAULT run dir: the orphan sweep scans machine-wide, so two starts of
 *  DIFFERENT profiles could each reap the other's not-yet-tracked daemon. PURE (no dir creation):
 *  the default-home migration probes this path without materializing run dirs. */
export function startLockPath(): string {
  return join(new CopilotApiPaths().runDir, ".start.lock");
}

declare const startLockBrand: unique symbol;

/** Minted only by withStartLock, whose wait is unbounded, so its fn ALWAYS runs held. APIs that must
 *  stay inside the launch critical section (ensureProxyFloor) demand one. */
export interface HeldStartLock {
  readonly held: true;
  readonly [startLockBrand]: true;
}

const HELD_START_LOCK: HeldStartLock = Object.freeze({ held: true } as HeldStartLock);

/** The wait is UNBOUNDED and never proceeds unlocked, which could let a waiter reap the holder's daemon.
 *  Only a DEAD holder is reclaimed (staleMs Infinity), so a live holder keeps every other start waiting for
 *  as long as it runs -- and an unopenable `.start.lock.oslock` (EACCES) retries forever, with no holder. */
export function withStartLock<T>(fn: (lock: HeldStartLock) => Promise<T>): Promise<T> {
  const lockPath = startLockPath();
  mkdirReported(dirname(lockPath));
  return withFileLock(lockPath, {
    staleMs: Number.POSITIVE_INFINITY,
    waitMs: Number.POSITIVE_INFINITY,
    retryMs: START_LOCK_RETRY_MS,
    noticeAfterMs: START_LOCK_NOTICE_MS,
    onWait: () =>
      consola.info("Another `agent start` is in progress; waiting for it to finish ..."),
  }, () => fn(HELD_START_LOCK));
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

declare const floorCheckedBrand: unique symbol;

/** Minted only by ensureProxyFloor, so spawnConfiguredDaemon cannot be handed an entry the gate never
 *  saw: the gate-then-spawn order is carried by the data. */
export type FloorCheckedEntry = CopilotApiEntry & { readonly [floorCheckedBrand]: true };

function floorChecked(entry: CopilotApiEntry): FloorCheckedEntry {
  return entry as FloorCheckedEntry;
}

/**
 * The float runs INSIDE the start lock (`_lock` is the evidence) so two concurrent starts never
 * re-warm the float's cache over each other. The float is best-effort (offline keeps what is cached),
 * but the floor is a hard contract: fail-closed, before disturbing any running daemon. A
 * `COPILOT_API_ENTRY` override skips both: it runs a file we did not resolve or version.
 */
export async function ensureProxyFloor(_lock: HeldStartLock): Promise<FloorCheckedEntry> {
  const preflight = resolveCopilotApiEntry();
  if (preflight.kind === "file") return floorChecked(preflight);

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
  return floorChecked(entry);
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
      `invalid port range: min-port (${min}) is greater than max-port (${max}); fix it with \`agent config --set min-port <n>\` / \`--set max-port <n>\`.`,
    );
  }
  if (pinned !== undefined) {
    switch (await checkProxyPort(pinned)) {
      case "out-of-range":
        throw new Error(
          `requested port ${pinned} is out of range; the proxy port must be between ${min} and ${max} (\`agent config --set min-port/max-port\` to change the range).`,
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
        `configured port ${def} is outside the allowed range ${min}-${max}; run \`agent config --set port <n>\` within the range, or adjust min-port/max-port.`,
      );
    case "busy":
      break;
  }
  if (policy.strictPortEligible && config.strictPortEnabled()) {
    throw new Error(
      `port ${def} is busy and auto-increment is disabled (\`strict-port\`); free it, pick another \`--port\`, or set \`agent config --set strict-port false\`.`,
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

// --- the tracked-pid / orphan cleanup -------------------------------------------------

/** The set the orphan sweep must NEVER signal: another profile's healthy daemon is not an orphan.
 *  `except` drops ONE slot's RECORD, never the pid: another slot's claim on the same pid still counts. */
export function trackedDaemonPids(except?: Profile): Set<number> {
  const pids = new Set<number>();
  for (const profile of [null, ...profileHomeNames()]) {
    if (except !== undefined && profile === except) continue;
    const pid = CopilotEnvRunState.forProfile(profile).read().pid;
    if (pid !== undefined) pids.add(pid);
  }
  return pids;
}

/** A held daemon.lock is the STRONGER keep-signal beside run-state tracking: OS-enforced, immune to
 *  pid reuse and run-state loss. `indeterminate` means the sweep cannot prove ANY pid unprotected,
 *  so it must not run. */
export type LockSweepSpares =
  | { readonly kind: "pids"; readonly pids: Set<number> }
  | { readonly kind: "indeterminate"; readonly home: string };

export function lockProtectedDaemonPids(): LockSweepSpares {
  const pids = new Set<number>();
  for (const home of allDaemonHomes()) {
    const hold = daemonLockHold(home);
    switch (hold.kind) {
      case "held":
        if (hold.pid === null) return { kind: "indeterminate", home };
        pids.add(hold.pid);
        break;
      case "free":
        break;
      case "unreadable":
        return { kind: "indeterminate", home };
      default:
        return assertNever(hold);
    }
  }
  return { kind: "pids", pids };
}

/** The lock-holder exclusion is applied HERE, at the one list producer, so no caller can forget it.
 *  Both fail-closed cases empty the list and SAY so, so an operator never mistakes a broken process
 *  table for a clean machine. `listPids` is the test seam. */
export async function listUntrackedOrphans(
  myPid: number,
  myPpid: number,
  keepPids: Set<number>,
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
): Promise<number[]> {
  const spares = lockProtectedDaemonPids();
  if (spares.kind === "indeterminate") {
    consola.warn(
      `Skipping the orphan sweep: the daemon lock state under ${spares.home} cannot be established, so no process can be proven orphaned.`,
    );
    return [];
  }
  const scanned = await listPids(myPid, myPpid);
  if (scanned === "unproven") {
    consola.warn(
      "Skipping the orphan sweep: the process scan failed, so no process can be proven orphaned.",
    );
    return [];
  }
  return scanned.filter((p) => !keepPids.has(p) && !spares.pids.has(p));
}

const HOLDER_STOP_POLL_MS = 100;

/**
 * Whether THIS host can vouch that `holder` is OUR daemon in the LOCAL pid table. The lock alone
 * cannot: a daemon home can be shared across hosts, where another HOST's daemon holds it and its marker
 * pid may name any innocent local process. Nor can run state: it proves the pid was ours ONCE.
 *   tracked by another slot's record        -> refused (a stale-state pid-reuse collision)
 *   claimed, or unreadable, in another home -> refused ("failed to look" is never "not this pid")
 *   owner-filtered scan fails or says no    -> refused
 */
async function corroborateLockHolder(
  home: string,
  holder: number,
  trackedSpares: Set<number> = trackedDaemonPids(),
): Promise<boolean> {
  if (trackedSpares.has(holder)) return false;
  for (const other of allDaemonHomes()) {
    if (other === home) continue;
    const hold = daemonLockHold(other);
    switch (hold.kind) {
      case "held":
        if (hold.pid === null || hold.pid === holder) return false;
        break;
      case "free":
        break;
      case "unreadable":
        return false;
      default:
        return assertNever(hold);
    }
  }
  return await isCopilotApiPid(holder);
}

/**
 * SIGTERM, then wait out the grace RE-DERIVING every proof, and SIGKILL only if the pid STILL
 * corroborates AND still holds the lock right before the signal. Holding alone must never drive the
 * force-kill: on a shared home another host's daemon keeps the lock held. Any doubt at the deadline
 * skips the kill; the worst case is the preload's legible failure.
 */
async function stopLockHolder(home: string, holder: number): Promise<void> {
  try {
    process.kill(holder, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
  while (daemonLockHolderPid(home) === holder) {
    if (Date.now() >= deadline) {
      if (
        await corroborateLockHolder(home, holder) &&
        daemonLockHolderPid(home) === holder
      ) {
        try {
          process.kill(holder, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      return;
    }
    await sleep(HOLDER_STOP_POLL_MS);
  }
}

/** planCleanup is the SINGLE decision source: the live cleanup and `start --dry-run` both switch on
 *  it exhaustively, so a live action cannot ship without its dry-run line. */
export type CleanupAction =
  | { readonly kind: "stop-tracked"; readonly pid: number }
  | { readonly kind: "clear-tracking"; readonly pid: number }
  | { readonly kind: "stop-holder"; readonly pid: number }
  | { readonly kind: "leave-holder"; readonly pid: number }
  | { readonly kind: "stop-orphan"; readonly pid: number };

/**
 * READ-ONLY: no signals, no writes. Every judgment past the clear uses the POST-clear set: `profile`'s
 * own record is exempted as a RECORD, never as a pid, so another slot's claim still spares or refuses.
 * `home` is passed in because the callers own the path derivation.
 */
export async function planCleanup(
  home: string,
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
  classifyPid: typeof classifyDaemonPid = classifyOwnedDaemonPid,
): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];
  const tracked = state.read().pid;
  if (tracked !== undefined) {
    // "dead" is never signalled however alive the pid table says it is (pid reuse); "alive" DEFERS to
    // the corroborated holder stop below.
    if (daemonLockVerdict(home, tracked) === "unproven") {
      // "unknown" (the scan FAILED) skips the signal like "no", but is SAID: a silent skip reads as
      // "proven not ours", and the possibly-live daemon still holds its port.
      const cls = await classifyPid(tracked);
      switch (cls) {
        case "yes":
          actions.push({ kind: "stop-tracked", pid: tracked });
          break;
        case "unknown":
          warnUnprovenTrackedPid(tracked);
          break;
        case "no":
          break;
        default:
          assertNever(cls);
      }
    }
    // A durable state write, so an enumerated action the dry run must report.
    actions.push({ kind: "clear-tracking", pid: tracked });
  }
  const postClearTracked = trackedDaemonPids(profile);
  // Without the holder stop a live holder is unstoppable: the sweep spares every holder, so the new
  // daemon's preload fails lock acquisition on every retry and `agent stop` no-ops.
  const holder = daemonLockHolderPid(home);
  if (holder !== null && holder !== process.pid && holder !== process.ppid) {
    actions.push(
      (await corroborateLockHolder(home, holder, postClearTracked))
        ? { kind: "stop-holder", pid: holder }
        : { kind: "leave-holder", pid: holder },
    );
  }
  const orphans = await listUntrackedOrphans(
    process.pid,
    process.ppid,
    postClearTracked,
    listPids,
  );
  for (const pid of orphans) {
    if (pidAlive(pid)) actions.push({ kind: "stop-orphan", pid });
  }
  return actions;
}

/** Emitted for a planned leave, and again when a planned holder stop finds its corroboration lapsed
 *  at the signal boundary. */
function warnLeaveHolder(pid: number): void {
  consola.warn(
    `   Leaving the daemon.lock holder (pid=${pid}) alone: this host cannot identify that pid as our daemon ` +
      `(a shared home's daemon on another host, or an unreadable process table). ` +
      `If the lock stays held, the launch below fails its lock acquisition - stop that daemon from its own host.`,
  );
}

/** planCleanup also narrates `start --dry-run`, where NOTHING executes, so the wording claims no
 *  completed action; it advises stopping by raw pid because the live path's clear-tracking leaves
 *  `agent stop` no record to target. */
function warnUnprovenTrackedPid(pid: number): void {
  consola.warn(
    `   Skipping the tracked-pid stop (pid=${pid}): the process scan could not prove its identity, so this stop sends no signal (fail-closed). If it remains running, stop it by pid from a shell that can read the process table.`,
  );
}

/**
 * The plan only authorizes: every signal re-derives its target's identity at its own boundary, so a
 * pid that exited or now reads as a different process is spared. Demands the held start lock, since
 * the snapshot and the sweep are race-free only when serialized against starts.
 *
 *   plan -> stop the tracked pid -> clear tracking -> holder and orphan sweeps
 *
 * Tracking is unbound before the sweeps, so a throw there leaves no port pointing at a dead daemon.
 * The residual window is terminatePid's SIGKILL gate, which signals on an UNREADABLE identity scan:
 * a pid recycled inside the grace is still killed when that scan fails.
 */
export async function cleanupExistingProxies(
  _lock: HeldStartLock,
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[] | "unproven"> = getOrphanPids,
  classifyPid: typeof classifyDaemonPid = classifyOwnedDaemonPid,
): Promise<void> {
  consola.start("Cleaning up existing proxy processes ...");

  const home = new CopilotApiPaths(profile).home;
  const plan = await planCleanup(home, profile, state, listPids, classifyPid);

  const orphans: number[] = [];
  for (const action of plan) {
    switch (action.kind) {
      case "stop-tracked": {
        // Re-derived at the signal boundary. The SAME classifier rides into terminatePid's SIGKILL
        // re-proof, so the escalation never judges under a weaker (owner-blind) standard than the TERM.
        const cls = await classifyPid(action.pid);
        if (cls === "yes") {
          consola.info(`   Stopping tracked proxy (pid=${action.pid}) ...`);
          // Verdict unused: the clear-tracking action queued right behind unbinds the pid whichever
          // way the kill went, and terminatePid reports a refused escalation itself.
          await terminatePid(action.pid, DAEMON_SIGKILL_GRACE_MS, classifyPid);
        } else if (cls === "unknown") {
          warnUnprovenTrackedPid(action.pid);
        }
        break;
      }
      case "clear-tracking":
        state.set(
          daemonPolicy(profile).releasesPortOnStop ? { pid: null, port: null } : { pid: null },
        );
        break;
      case "stop-holder":
        // A lapsed corroboration draws the same leave the plan would have decided then.
        if (daemonLockHolderPid(home) !== action.pid) break;
        if (await corroborateLockHolder(home, action.pid)) {
          consola.info(`   Stopping this home's daemon.lock holder (pid=${action.pid}) ...`);
          await stopLockHolder(home, action.pid);
        } else {
          warnLeaveHolder(action.pid);
        }
        break;
      case "leave-holder":
        warnLeaveHolder(action.pid);
        break;
      case "stop-orphan":
        orphans.push(action.pid);
        break;
      default:
        assertNever(action);
    }
  }

  if (orphans.length > 0) {
    // Only pids in both the plan and a FRESH scan are signalled: the tracked and holder stops above
    // can take a grace, so a pid recycled since planning is never TERM'd off the stale snapshot.
    const planned = new Set(orphans);
    const confirmed = (await listUntrackedOrphans(
      process.pid,
      process.ppid,
      trackedDaemonPids(),
      listPids,
    )).filter((p) => planned.has(p));
    if (confirmed.length > 0) {
      for (const opid of confirmed) {
        if (pidAlive(opid)) {
          consola.info(`   Stopping orphaned proxy (pid=${opid}) ...`);
          try {
            process.kill(opid, "SIGTERM");
          } catch {
            /* OSError */
          }
        }
      }
      await sleep(DAEMON_SIGKILL_GRACE_MS);
      const survivors = (await listUntrackedOrphans(
        process.pid,
        process.ppid,
        trackedDaemonPids(),
        listPids,
      )).filter((p) => planned.has(p));
      for (const opid of survivors) {
        if (pidAlive(opid)) {
          try {
            process.kill(opid, "SIGKILL");
          } catch {
            /* OSError */
          }
        }
      }
    }
  }

  await sleep(1000);
}

// --- credential resolution ---------------------------------------------------------

/** `interactiveLogin` is REQUIRED: the login flow lives in src/commands/auth.ts, which this domain
 *  module must not import, so the orchestrator hands it down. */
export interface LaunchCredentialDeps {
  interactiveLogin: (profile: Profile) => Promise<void>;
  credential?: Credential;
  /** Default: process.stdin.isTTY. */
  isTTY?: boolean;
  resolveIntegrationId?: typeof resolvePassthroughIntegrationId;
}

/**
 * A named profile resolves ONLY its own slot, never the default credential. The result is the
 * daemon's DaemonCredential itself, so the launch never carries a passthrough decision apart from the
 * token it applies to.
 */
export async function resolveLaunchCredential(
  profile: Profile,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
  deps: LaunchCredentialDeps,
): Promise<DaemonCredential> {
  const credential = deps.credential ?? new Credential(undefined, profile);
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const resolveIntegrationId = deps.resolveIntegrationId ?? resolvePassthroughIntegrationId;
  // Passed as `--github-token`, copilot-api holds the token in memory and writes no github_token file
  // of its own, so the proxy stays on our single source of truth.
  let githubToken = credential.resolve() ?? undefined;
  if (githubToken === undefined && isTTY) {
    // Headless (no TTY) cannot complete an interactive login, so the daemon handles its own cold-start
    // login there; a fake proxy in tests just starts without a token.
    await deps.interactiveLogin(profile);
    githubToken = credential.resolve() ?? undefined;
  }
  // A gh-cli OAuth token or a PAT cannot perform copilot-api's editor token exchange, so the
  // passthrough shim fakes it and hands the token straight through as the Copilot bearer.
  const forcePassthrough = config.passthroughOverride();
  const patPassthrough = usePatPassthrough({
    force: forcePassthrough,
    token: githubToken,
    provider: credential.provider(),
  });
  if (patPassthrough) {
    consola.info(
      "Token passthrough on: faking the editor token exchange so the proxy uses the token directly.",
    );
  } else if (forcePassthrough === false) {
    consola.info("Token passthrough off: using the standard editor token exchange.");
  }
  if (githubToken === undefined) return { kind: "none" };
  if (!patPassthrough) return { kind: "token", token: githubToken };
  // A passthrough bearer is accepted only under an identity matching its token class (a fine-grained
  // PAT needs `copilot-developer-cli`; copilot-api sends `vscode-chat`). Resolved BEFORE launching, so
  // an unusable credential fails here with the real reason instead of an opaque daemon-side
  // "Failed to get models"; the passthrough preload rewrites the header on the daemon's upstream calls.
  const integrationId = await resolveIntegrationId(githubToken, {
    pinned: config.pinnedIntegrationId(),
  });
  return { kind: "pat", token: githubToken, integrationId };
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
  /** Only ensureProxyFloor mints one, so a spawn without the gate does not compile; every bind-race
   *  relaunch runs exactly what the floor check judged. */
  entry: FloorCheckedEntry;
  config?: CopilotEnvConfig;
}): SpawnedDaemon {
  const { port, logFile, profile, paths, credential, entry } = opts;
  const config = opts.config ?? new CopilotEnvConfig();
  const denoBin = resolveDenoBin();
  const daemonEnv = daemonLifecycleEnv(profile, paths);
  // The idle watchdog lives in the daemon process, so server and watchdog are one unit (no orphan
  // either way) and every (re)start re-attaches it. With `auto-start` off there is no watchdog.
  const idleWatchdog = config.autoStartEnabled();
  // Activity detection is unaffected by the mute: the always-loaded inference observer watches inbound
  // requests, not log files.
  const muteProxyLogs = !config.proxyLogsEnabled();
  if (muteProxyLogs) {
    consola.info("Proxy request logs off: discarding writes under <home>/logs (`proxy-logs`).");
  }
  const relaunch = (p: number): number => {
    // Blanked only HERE, at spawn time: a failure BEFORE launch (a login error, an identity-probe
    // rejection) keeps the previous run's log for diagnosis.
    writeFileReported(logFile, "", { detail: "proxy log, blanked for this launch" });
    return launchDaemon({
      port: p,
      logFile,
      home: paths.home,
      env: daemonEnv,
      credential,
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
  const flag = daemonPolicy(profile).flagSuffix;
  return (
    "The credential was not accepted by Copilot's token exchange. For a gh-cli or PAT credential, " +
    "enable passthrough (`agent config --set passthrough on`); otherwise re-authenticate with a " +
    `Copilot-capable login (\`agent auth${flag} --provider copilot\`).`
  );
}

/**
 * A lost bind race (EADDRINUSE in the log) retries ONCE on another port, unless the port was pinned by
 * `--port` or `strict-port` steers the DEFAULT daemon; a named profile's reservation is soft, so its
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

  await sleep(1000);
  if (!pidAlive(pid)) {
    let logContent = "";
    try {
      logContent = fs.readFileSync(logFile, "utf-8");
    } catch {
      logContent = "";
    }
    if (/address already in use|EADDRINUSE|bind.*failed/i.test(logContent)) {
      // Same exemption as resolveStartPort: `strict-port` gates only the policy-eligible daemon.
      const strictPort = daemonPolicy(profile).strictPortEligible && config.strictPortEnabled();
      if (pinnedPort !== undefined || strictPort) {
        printLogTail(logFile, 20);
        throw new Error(
          `port ${port} was taken by another process just before launch` +
            `${
              strictPort && pinnedPort === undefined
                ? " (strict-port is on, so no auto-increment)"
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
      await sleep(1000);
      if (!pidAlive(pid)) {
        printLogTail(logFile, 20);
        throw new Error(
          `the proxy failed to start after retrying on a different port. See ${logFile}`,
        );
      }
      consola.success(`Started on port ${port} after retry.`);
    } else {
      printLogTail(logFile, 20);
      const hint = copilotTokenFailureHint(logContent, profile);
      if (hint) consola.error(hint);
      throw new Error(`the proxy failed to start. See ${logFile}`);
    }
  }

  state.set({ pid, port });
  consola.info(`Started the proxy (PID ${pid}) on port ${port}, detached.`);

  consola.start("Waiting for the proxy to start (tailing its log) ...");

  const maxWait = 120;
  let ready = false;
  let printedLogBytes = 0;
  for (let i = 0; i < maxWait; i++) {
    if (!pidAlive(pid)) {
      try {
        const hint = copilotTokenFailureHint(fs.readFileSync(logFile, "utf-8"), profile);
        if (hint) consola.error(hint);
      } catch {
        // A missing or unreadable log just means no hint.
      }
      throw new Error(`the proxy (PID ${pid}) exited during startup. See ${logFile}.`);
    }
    let logContent = "";
    try {
      const logBytes = fs.readFileSync(logFile);
      if (logBytes.length < printedLogBytes) {
        printedLogBytes = 0;
      }
      if (logBytes.length > printedLogBytes) {
        process.stderr.write(logBytes.subarray(printedLogBytes));
        printedLogBytes = logBytes.length;
      }
      logContent = logBytes.toString("utf-8");
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
    await sleep(1000);
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
  paths: CopilotApiPaths,
  envConfig: CopilotEnvConfig = new CopilotEnvConfig(),
): void {
  // The projected preferences are static defaults the daemon reads at startup with no admin REST
  // endpoint, so they go into config.json before launch (model aliases are pushed live instead). An
  // unset OPT-IN key a previous start wrote (recorded in ProxyProjectionState) is cleared, so
  // `agent config --del` truly reverts to the proxy's default without deleting a value we never projected.
  const config = new CopilotApiConfig(paths.configFile);
  const projection = projectedProxyConfig(envConfig);
  const projectedKeys = new Set(projection.map((e) => JSON.stringify(e.path)));
  const registryOptInKeys = new Set(optInProxyConfigPaths().map((p) => JSON.stringify(p)));
  const ownership = new ProxyProjectionState(paths);
  // The record-read -> config-write -> record-write sequence is guarded per HOME: the global start lock
  // lives in the per-host run dir, so two hosts sharing a daemon home would not exclude each other
  // there. Named `.apply.lock` because plain `<file>.lock` is CopilotApiConfig.update()'s own inner lock.
  const lockPath = `${ownership.path}.apply.lock`;
  withFileLockSync(lockPath, BOUNDED_LOCK_POLICY, (outcome) => {
    if (!outcome.held) {
      consola.info("Proxy-config apply lock is busy; applying unlocked after the bounded wait.");
    }
    // A recorded path outside the CURRENT registry's opt-in set (an older registry's, or a foreign
    // write to the record) claims nothing: it stays in config.json and falls out of the record.
    const ownedBefore = ownership
      .ownedPaths()
      .filter((p) => registryOptInKeys.has(JSON.stringify(p)));
    config.update((d) => {
      for (const path of ownedBefore) {
        if (!projectedKeys.has(JSON.stringify(path))) deleteProxyConfigValue(d, path);
      }
      for (const entry of projection) {
        setProxyConfigValue(d, entry.path, entry.value);
      }
    });
    ownership.setOwnedPaths(projection.filter((e) => e.optIn).map((e) => e.path));
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
  const width = targets.reduce((m, t) => Math.max(m, t.length), 0);
  // One message, one consola timestamp: a stamp per row wraps and interleaves at terminal width.
  const rows = targets.map((target) => {
    const aliases = (byTarget.get(target) ?? []).sort();
    return `   ${target.padEnd(width)}  <-  ${aliases.join(", ")}`;
  });
  consola.info(
    `Model aliases (${sources.length} -> ${targets.length} models):\n${rows.join("\n")}`,
  );
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
