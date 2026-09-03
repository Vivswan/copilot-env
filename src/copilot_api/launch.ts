// The `agent start` launch pipeline, one named function per step: the proxy
// freshness/floor gate, the start lock, port resolution, the tracked-pid/orphan cleanup,
// credential resolution (with the PAT-passthrough and integration-identity decisions), the
// configured daemon spawn, the readiness wait (with the EADDRINUSE bind-race retry),
// and the post-start alias sync. src/commands/start.ts stays the command layer
// (flag parsing, dry-run reporting, summary rendering) and orchestrates these.
//
// String literals here are external contracts (config-file keys, copilot-api
// model ids, log markers). Do not change them during refactors.
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
  STALE_PROXY_CONFIG_KEYS,
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

// The launch critical section (orphan sweep + spawn + readiness wait) is serialized by a start
// lock so two concurrent `agent start` (e.g. two agents auto-starting at once) don't each reap
// the OTHER's freshly launched daemon. The lock reclaims ONLY a DEAD holder (staleMs = Infinity),
// never age-stealing a live launcher -- a start may legitimately hold it for minutes while it
// prompts for interactive auth, and stealing it then would let the waiter kill its daemon.
const START_LOCK_RETRY_MS = 250;
const START_LOCK_NOTICE_MS = 2000;

/** The ONE GLOBAL start-lock path, in the DEFAULT run dir and shared by every profile:
 *  the orphan sweep scans copilot-api processes machine-wide, so two concurrent starts of
 *  DIFFERENT profiles could otherwise each reap the other's freshly spawned (not-yet-tracked)
 *  daemon. Serializing all starts also makes the tracked-pid snapshot race-free. PURE (no
 *  dir creation): withStartLock ensures the dir when acquiring, and the 3.5.6 default-home
 *  migration probes the path without materializing run dirs (a lock cannot be held where
 *  its directory does not exist). */
export function startLockPath(): string {
  return join(new CopilotApiPaths().runDir, ".start.lock");
}

declare const startLockBrand: unique symbol;

/** Evidence that the global start lock is held for the caller's scope: minted only by
 *  withStartLock (whose wait is unbounded, so its fn ALWAYS runs held). APIs that must
 *  stay inside the launch critical section (ensureProxyFloor) demand one. */
export interface HeldStartLock {
  readonly held: true;
  readonly [startLockBrand]: true;
}

const HELD_START_LOCK: HeldStartLock = Object.freeze({ held: true } as HeldStartLock);

/** Run `fn` holding the start lock, waiting UNBOUNDED for it: a live holder is waited out
 *  (it releases when done), and a crashed holder is reclaimed (dead pid), so the wait always
 *  terminates -- and never proceeds unlocked, which could let a waiter reap the holder's
 *  daemon. Emits a one-time notice once the wait is noticeable. The lock is scoped to `fn`
 *  (released on every exit path, in ONE owner), so an early return cannot leak it. */
export function withStartLock<T>(fn: (lock: HeldStartLock) => Promise<T>): Promise<T> {
  const lockPath = startLockPath();
  fs.mkdirSync(dirname(lockPath), { recursive: true });
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

/** The proxy version `entry` will actually run, or null when it cannot be known ahead of
 *  the launch: a mapped entry whose node_modules copy is missing, or a file override,
 *  which runs whatever that file is (the CI fake has no version at all). */
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

/** Evidence that an entry passed the start gate: floated when stale, then judged against
 *  the PROXY_MIN_VERSION floor (or exempt as a file override). Minted only by
 *  ensureProxyFloor, so spawnConfiguredDaemon -- which demands one -- cannot be handed an
 *  entry the gate never saw, and the gate-then-spawn order is carried by the data. */
export type FloorCheckedEntry = CopilotApiEntry & { readonly [floorCheckedBrand]: true };

function floorChecked(entry: CopilotApiEntry): FloorCheckedEntry {
  return entry as FloorCheckedEntry;
}

/**
 * The `agent start` proxy gate: float the proxy if its recorded resolution has gone
 * stale, then refuse to launch below the PROXY_MIN_VERSION floor. Returns the entry it
 * validated -- the one the launch must spawn from.
 *
 * The float runs at start, INSIDE the start lock (`_lock` is the evidence), because
 * `start` is the one command that needs a runnable proxy -- and serializing it there
 * means two concurrent starts can never re-warm the float's cache over each other.
 * `proxyFloatVerifyStatus` is offline while the record is younger than the cooldown, so
 * the common start pays no network cost. The float itself is best-effort (an offline
 * machine keeps whatever is already cached), but the floor is a hard runtime contract:
 * fail-closed, and before disturbing any running daemon. A `COPILOT_API_ENTRY` override
 * skips both -- it runs a file we did not resolve and do not version.
 */
export async function ensureProxyFloor(_lock: HeldStartLock): Promise<FloorCheckedEntry> {
  const preflight = resolveCopilotApiEntry();
  if (preflight.kind === "file") return floorChecked(preflight);

  // Before anything spawns deno: a compiled build's own executable is not a deno CLI, so
  // the pinned sidecar has to exist before the float can warm a cache or the daemon can
  // launch. Provisioning is a no-op from a checkout, where our runtime already is one.
  const sidecar = await ensureSidecar(resolveRootHome());
  if (isStandaloneBinary()) consola.info(`Using the provisioned deno sidecar: ${sidecar}`);

  const status = await proxyFloatVerifyStatus();
  if (!status.upToDate) {
    consola.info(status.message);
    try {
      await floatProxy();
    } catch (e) {
      consola.warn(`proxy float failed (${errMessage(e)}); checking what is already available`);
    }
  }

  // Re-resolve: a successful float just wrote the record, which moves the entry from the
  // mapped fallback to the floated version.
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
 * Resolve the port `start` will bind for `profile`: a pinned `--port` is used as-is but must
 * be free (else throw -- never silently move off the port the user asked for); with no
 * pin, use the base port or the next free port above it. The base is the default proxy port
 * (config `port`, else the built-in) for the default daemon, and the profile's stable
 * reservation for a named one -- PERSISTED only when `reserve` (the live launch path; the
 * read-only dry-run peeks at the candidate without recording it). `strict-port` steers the
 * DEFAULT daemon only. `announce` emits the busy/alternative-port notices on the live path.
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
  // No hard `--port` pin: the auto-resolve base is the policy's port source -- the default
  // proxy port (config `port`, else the built-in 4141) or the profile's stable reservation
  // -- a SOFT base that moves to the next free port if busy, unless `strict-port` gates
  // this daemon (then a busy default is fatal, no auto-increment). An EXISTING
  // reservation is honored even when min/max later narrowed past it (the range governs
  // NEW allocations -- same round-trip contract as the default's recorded port), so it
  // gets a liveness-only probe instead of the range gate.
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
        break; // reservation busy -> auto-increment below (back inside the range)
      }
      throw new Error(
        `configured port ${def} is outside the allowed range ${min}-${max}; run \`agent config --set port <n>\` within the range, or adjust min-port/max-port.`,
      );
    case "busy":
      break; // fall through to strict-port / auto-increment below
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

/** Tracked daemon pids across the default and every profile's run state -- the set the
 *  orphan sweep must NEVER signal (in a multi-daemon world, another profile's healthy
 *  daemon is not an orphan). `except` drops ONE slot's claim: the planner judges against
 *  the POST-clear tracking, whose own slot the same plan clears before any signal --
 *  another slot's claim on the same pid still counts. */
export function trackedDaemonPids(except?: Profile): Set<number> {
  const pids = new Set<number>();
  for (const profile of [null, ...profileHomeNames()]) {
    if (except !== undefined && profile === except) continue;
    const pid = CopilotEnvRunState.forProfile(profile).read().pid;
    if (pid !== undefined) pids.add(pid);
  }
  return pids;
}

/** The sweep's lock-derived spare judgment: the live daemon.lock holders across the
 *  default and every profile home (the STRONGER keep-signal beside run-state tracking --
 *  a held lock proves its holder is a live daemon of ours, OS-enforced, immune to pid
 *  reuse and run-state loss), or `indeterminate` when some home's lock state cannot be
 *  established (an unreadable probe, or a lock held by a pid the marker cannot name).
 *  Indeterminate means the sweep cannot prove ANY pid unprotected, so it must not run. */
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

/** Orphaned copilot-api pids: every daemon-shaped process EXCEPT us, our parent, the
 *  pids in `keepPids` (the tracked-daemon exclusion set -- another profile's healthy daemon
 *  must never be listed while (re)starting this one), and every live daemon.lock holder
 *  (applied HERE, at the one list producer, so no caller can forget it). A home whose
 *  lock state is indeterminate empties the list outright -- fail closed, since the spare
 *  set can then vouch for nobody. `listPids` is injectable for tests. */
export async function listUntrackedOrphans(
  myPid: number,
  myPpid: number,
  keepPids: Set<number>,
  listPids: (myPid: number, myPpid: number) => Promise<number[]> = getOrphanPids,
): Promise<number[]> {
  const spares = lockProtectedDaemonPids();
  if (spares.kind === "indeterminate") {
    consola.warn(
      `Skipping the orphan sweep: the daemon lock state under ${spares.home} cannot be established, so no process can be proven orphaned.`,
    );
    return [];
  }
  return (await listPids(myPid, myPpid)).filter((p) => !keepPids.has(p) && !spares.pids.has(p));
}

/** How often the lock-holder stop below re-derives its proof while waiting out the
 *  TERM grace (bounded by DAEMON_SIGKILL_GRACE_MS, the shared teardown horizon). */
const HOLDER_STOP_POLL_MS = 100;

/**
 * Whether THIS host can vouch that `holder` -- the marker-named pid of `home`'s held
 * daemon.lock -- is OUR daemon in the LOCAL pid table. The lock alone cannot: a daemon
 * home can be shared across hosts (in-design; see the cross-host note on the config
 * apply lock below), where the lock is held by another HOST's daemon and its marker pid
 * may name any innocent local process. Nor can run state: the per-host record proves the
 * pid was ours on this host ONCE, never that today's process is still it -- so every
 * lock-held signal, tracked or not, earns its provenance here, requiring all of:
 *   - no run-state record in `trackedSpares` tracks the pid. The default is EVERY slot's
 *     record; the planner passes the POST-clear set (its own slot's record is cleared
 *     before any holder stop executes) -- exempting that one RECORD, never the pid, so a
 *     second slot's claim on the same pid (a stale-state pid-reuse collision) still
 *     refuses,
 *   - no OTHER home's lock can claim it -- judged fail-closed: a hold this host cannot
 *     read or attribute might be exactly this pid, so it also refuses, and
 *   - the OWNER-FILTERED process scan confirms a daemon invocation of the CURRENT user
 *     (isCopilotApiPid -- the same scan the sweep trusts before SIGKILLs; a failed or
 *     unreadable scan reads false), trading auto-recovery where the process table is
 *     unreadable for never signalling a pid this host cannot prove.
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
        // Another home's named holder, or one held by a pid the marker cannot name --
        // which might be this very pid.
        if (hold.pid === null || hold.pid === holder) return false;
        break;
      case "free":
        break;
      case "unreadable":
        return false; // "failed to look" is never "not this pid"
      default:
        return assertNever(hold);
    }
  }
  return await isCopilotApiPid(holder);
}

/**
 * Stop `holder`, the corroborated live holder of `home`'s daemon.lock: SIGTERM, then wait
 * out the grace RE-DERIVING every proof, and SIGKILL only if the pid STILL corroborates as
 * our local daemon AND still holds the lock immediately before the
 * signal. Holding alone must never drive the force-kill (on a shared home the lock
 * outlives any local signal -- another host's daemon keeps it held), and corroboration
 * can lapse during the grace (the pid died and was recycled, became tracked, or acquired
 * another home's lock). Any doubt at the deadline skips the kill -- worst case is the
 * preload's legible failure.
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

/** One would-be action of the launch cleanup. planCleanup is the SINGLE decision source:
 *  the live cleanup executes exactly this enumeration and `start --dry-run` narrates it,
 *  both through exhaustive switches -- so a future live action cannot ship without its
 *  dry-run line (omitting it does not compile). */
export type CleanupAction =
  | { readonly kind: "stop-tracked"; readonly pid: number }
  | { readonly kind: "clear-tracking"; readonly pid: number }
  | { readonly kind: "stop-holder"; readonly pid: number }
  | { readonly kind: "leave-holder"; readonly pid: number }
  | { readonly kind: "stop-orphan"; readonly pid: number };

/**
 * Decide -- READ-ONLY: no signals, no writes -- what stands in the way of a fresh launch
 * over `home` (passed in, not derived: the callers own the path derivation), in execution
 * order:
 *   - the tracked pid: signalled only when the lock rules it "unproven" (the shared
 *     daemonLockVerdict table: "dead" is never signalled however alive the pid table says
 *     it is -- pid reuse -- and "alive" DEFERS to the corroborated holder stop below) AND
 *     the argv scan confirms a pre-lock daemon; its tracking is cleared regardless (a
 *     durable state write, so it is an enumerated action the dry run must report),
 *   - THIS home's live daemon.lock holder -- tracked or not: stopped only under host-local
 *     corroboration, left alone (with the shared-home warning) otherwise; the self/parent
 *     case is no action at all,
 *   - the machine-wide orphans (`listPids` is the scan seam, injectable for tests),
 *     sparing every tracked pid and every live lock holder.
 * Every tracked-pid judgment past the clear uses the POST-clear set (`profile`'s own
 * record is exempted as a RECORD, never as a pid -- another slot's claim on the same pid
 * still spares/refuses), matching the pre-split order where the clear preceded both the
 * corroboration and the sweep's keep-set snapshot.
 */
export async function planCleanup(
  home: string,
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[]> = getOrphanPids,
): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];
  const tracked = state.read().pid;
  if (tracked !== undefined) {
    if (daemonLockVerdict(home, tracked) === "unproven" && (await isCopilotApiPid(tracked))) {
      actions.push({ kind: "stop-tracked", pid: tracked });
    }
    actions.push({ kind: "clear-tracking", pid: tracked });
  }
  const postClearTracked = trackedDaemonPids(profile);
  // Without the holder stop a live holder is unstoppable: the sweep spares every holder,
  // so the new daemon's preload fails lock acquisition on every retry of `agent start`,
  // and `agent stop` no-ops. Every uncorroborated case -- and the self/parent guard --
  // falls back to the preload's legible failure instead of signalling what this host
  // cannot prove.
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

/** The shared-home leave warning: emitted for a planned leave, and again when a planned
 *  holder stop finds its corroboration lapsed at the signal boundary. */
function warnLeaveHolder(pid: number): void {
  consola.warn(
    `   Leaving the daemon.lock holder (pid=${pid}) alone: this host cannot identify that pid as our daemon (a shared home's daemon on another host, or an unreadable process table). If the lock stays held, the launch below fails its lock acquisition - stop that daemon from its own host.`,
  );
}

/**
 * Execute the cleanup plan for `profile` (planCleanup above -- the same decision source
 * `start --dry-run` narrates): stop the tracked pre-lock daemon, clear its tracking (up
 * front, so a throw below never leaves a stale port pointing at a dead daemon), stop or
 * spare this home's daemon.lock holder, then run the orphan sweep as one batch (SIGTERM
 * the enumerated pids, one grace wait, SIGKILL whatever a fresh scan still lists). The
 * plan authorizes; every SIGNAL still re-derives its proof at the signal boundary (the
 * argv re-scan, the still-holds + re-corroborate check, the fresh orphan scan the batch
 * is intersected with), so a pid that exited or lapsed since planning is never signalled
 * on the stale snapshot. Ends with a settle pause before the caller probes ports.
 * Demands the held start lock (`_lock`, like ensureProxyFloor): the plan's snapshots and
 * the sweep are only race-free serialized against every other start, so an un-locked
 * cleanup must not compile.
 */
export async function cleanupExistingProxies(
  _lock: HeldStartLock,
  profile: Profile,
  state: CopilotEnvRunState = CopilotEnvRunState.forProfile(profile),
  listPids: (myPid: number, myPpid: number) => Promise<number[]> = getOrphanPids,
): Promise<void> {
  consola.start("Cleaning up existing proxy processes ...");

  const home = new CopilotApiPaths(profile).home;
  const plan = await planCleanup(home, profile, state, listPids);

  const orphans: number[] = [];
  for (const action of plan) {
    switch (action.kind) {
      case "stop-tracked":
        if (await isCopilotApiPid(action.pid)) {
          consola.info(`   Stopping tracked proxy (pid=${action.pid}) ...`);
          await terminatePid(action.pid, DAEMON_SIGKILL_GRACE_MS);
        }
        break;
      case "clear-tracking":
        // A daemon whose policy keeps its port -- a named profile's stable
        // reservation -- only clears the pid.
        state.set(
          daemonPolicy(profile).releasesPortOnStop ? { pid: null, port: null } : { pid: null },
        );
        break;
      case "stop-holder":
        // Gone (released the lock, or died) means nothing to stop; a lapsed
        // corroboration draws the same leave the plan would have decided then.
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
    // The plan authorizes, a FRESH scan confirms: only pids in both are signalled, so a
    // pid recycled since planning (the tracked/holder stops above can take a grace) is
    // never TERM'd off the stale snapshot. An empty confirmation ends the sweep -- the
    // same gate the scan-just-before-TERM carried pre-split.
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

/** Injectable seams for resolveLaunchCredential. `interactiveLogin` is REQUIRED: the
 *  login flow lives in the command layer (src/commands/auth.ts), which this domain
 *  module must not import, so the orchestrator hands it down. */
export interface LaunchCredentialDeps {
  /** Interactive login for the addressed credential slot (ensureAuthenticated). */
  interactiveLogin: (profile: Profile) => Promise<void>;
  /** The credential facade (default: the addressed slot's own). */
  credential?: Credential;
  /** TTY gate override for tests (default: process.stdin.isTTY). */
  isTTY?: boolean;
  /** Identity-probe seam (default: the real resolvePassthroughIntegrationId). */
  resolveIntegrationId?: typeof resolvePassthroughIntegrationId;
}

/**
 * Resolve the credential the daemon launches with, and the two per-credential
 * decisions that hang off it: the PAT-passthrough shim and the client-integration
 * identity. A named profile resolves ONLY its own slot (never the default credential);
 * with nothing resolved and a TTY, the interactive login runs first. The result is the
 * daemon's DaemonCredential itself, so the launch never carries a passthrough decision
 * apart from the token it applies to.
 */
export async function resolveLaunchCredential(
  profile: Profile,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
  deps: LaunchCredentialDeps,
): Promise<DaemonCredential> {
  const credential = deps.credential ?? new Credential(undefined, profile);
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const resolveIntegrationId = deps.resolveIntegrationId ?? resolvePassthroughIntegrationId;
  // Feed the daemon the resolved credential -- the SAME resolution Direct uses
  // (`agent auth --get`), driven by the recorded provider (gh-cli -> `gh auth token`,
  // copilot/gh-token -> the stored token). Passing it as `--github-token` keeps the
  // proxy on our single source of truth (copilot-api uses it in-memory and won't
  // write its own github_token file).
  let githubToken = credential.resolve() ?? undefined;
  if (githubToken === undefined && isTTY) {
    // Nothing resolved AND we have a terminal: log in (provider choice -> the addressed
    // slot) so the proxy stays on the single source. Errors out if login fails.
    // Headless/CI (no TTY) can't complete an interactive login, so skip and let the
    // daemon handle its own cold-start login (a fake proxy in tests just starts
    // without a token).
    await deps.interactiveLogin(profile);
    githubToken = credential.resolve() ?? undefined;
  }
  // A gh-cli OAuth token or a PAT can't perform copilot-api's editor token exchange, so load the
  // passthrough shim (it fakes the exchange, handing the token straight through as the Copilot
  // bearer). Precedence: config `passthrough` (on/off) > `auto` (gh-cli provider or PAT shape).
  // Set it with `agent config --set passthrough on|off`. Only meaningful when a token resolved.
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
  // A passthrough bearer is only accepted under a client-integration identity that
  // matches its token class (a fine-grained PAT needs `copilot-developer-cli`;
  // copilot-api sends `vscode-chat`). Resolve it NOW, before launching, so an
  // unusable credential fails here with the real reason instead of an opaque
  // daemon-side "Failed to get models" -- and hand a non-default pick to the
  // passthrough preload, which rewrites the header on the daemon's upstream calls.
  const integrationId = await resolveIntegrationId(githubToken, {
    pinned: config.pinnedIntegrationId(),
  });
  return { kind: "pat", token: githubToken, integrationId };
}

// --- the configured daemon spawn ------------------------------------------------------

/** A spawned daemon plus the plan to spawn it again: `relaunch` blanks the log and
 *  launches on a new port with the IDENTICAL env/preloads (the EADDRINUSE bind-race
 *  retry), and `idleWatchdog` reports whether the in-daemon watchdog preload was armed
 *  (the caller seeds its heartbeat after readiness). */
export interface SpawnedDaemon {
  pid: number;
  idleWatchdog: boolean;
  relaunch: (port: number) => number;
}

/**
 * The copilot-env lifecycle environment every daemon spawn gets. Every daemon -- the
 * default included -- runs against its OWN home under `<root>/profiles/` (config.json
 * incl. auth.apiKeys, .run/, sqlite, logs) so concurrent daemons never contend on one
 * home; the root home is passed alongside so the in-daemon preloads still find the
 * ACCOUNT-WIDE files (credential store, preferences) there. The home itself rides in
 * DaemonSpec.home (pinned for every daemon). The keep-port value transports the
 * daemon's releasesPortOnStop policy to the idle watchdog's auto-stop clear -- always
 * set (never inherited), so a stale environment can't steer it. Pure, so the contract
 * is testable without spawning anything.
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

/**
 * Assemble the daemon's environment (daemonLifecycleEnv), decide the config-driven
 * knobs (idle watchdog, log mute), and launch copilot-api detached on `port`. The
 * credential's own environment and preload set are derived inside launchDaemon from
 * the DaemonCredential, so they can't disagree with it here.
 */
export function spawnConfiguredDaemon(opts: {
  port: number;
  logFile: string;
  profile: Profile;
  paths: CopilotApiPaths;
  credential: DaemonCredential;
  /** The gate's validated entry (only ensureProxyFloor mints one): the spawn -- and every
   *  bind-race relaunch below -- runs exactly what the floor check judged, and a spawn
   *  without the gate does not compile. The deno binary is resolved ONCE beside it; on a
   *  compiled install that is the sidecar ensureProxyFloor provisioned under the same
   *  root home. */
  entry: FloorCheckedEntry;
  config?: CopilotEnvConfig;
}): SpawnedDaemon {
  const { port, logFile, profile, paths, credential, entry } = opts;
  const config = opts.config ?? new CopilotEnvConfig();
  const denoBin = resolveDenoBin();
  const daemonEnv = daemonLifecycleEnv(profile, paths);
  // Managed lifecycle on (the `auto-start` config key)? Preload the in-daemon idle watchdog
  // so the proxy stops itself after the idle window. It lives in the daemon process, so
  // the server and watchdog are one unit (no orphan either way), and every (re)start
  // re-attaches it. With the flag off, the proxy never auto-starts and gets no watchdog.
  const idleWatchdog = config.autoStartEnabled();
  // `proxy-logs false` mutes the daemon's verbose handler logs: a preload shim discards the
  // writes under <home>/logs. Activity detection is unaffected -- the always-loaded inference
  // observer watches inbound requests, not log files.
  const muteProxyLogs = !config.proxyLogsEnabled();
  if (muteProxyLogs) {
    consola.info("Proxy request logs off: discarding writes under <home>/logs (`proxy-logs`).");
  }
  const relaunch = (p: number): number => {
    // Blank the log only HERE, at spawn time: a failure BEFORE launch -- a
    // login error, an identity-probe rejection -- keeps the previous run's log
    // around for diagnosis until a new daemon actually launches.
    fs.writeFileSync(logFile, "");
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

/** An actionable hint when the daemon died because the credential could not be exchanged for a
 *  Copilot token (the daemon logs "Failed to get Copilot token" on a 404/403). A gh-cli/PAT
 *  credential needs the passthrough; anything else needs a Copilot-capable login (addressed at
 *  `profile`'s credential slot). */
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
 * Wait until the freshly spawned daemon is genuinely up: retry ONCE on a different port when
 * the daemon lost a bind race (EADDRINUSE in its log) -- unless the port was pinned by
 * `--port`, or `strict-port` steers the DEFAULT daemon (a named profile's reservation is
 * soft, so its bind race always retries) -- then record pid+port in run state and tail the
 * log until the "Listening on:" readiness line (or fail with the log tail and, when the
 * token exchange rejected the credential, an actionable hint).
 */
export async function awaitReadiness(opts: {
  pid: number;
  port: number;
  logFile: string;
  profile: Profile;
  /** The explicit `--port` pin, when one was given (a lost bind race then fails, never moves). */
  pinnedPort: number | undefined;
  state: CopilotEnvRunState;
  relaunch: (port: number) => number;
  config?: CopilotEnvConfig;
  /** Retry-port finder seam; tests inject to avoid real port scans. */
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
      // `strict-port` gates only the policy-eligible daemon (same exemption as
      // resolveStartPort): a named profile's reservation is soft, so a bind race
      // retries on another port.
      const strictPort = daemonPolicy(profile).strictPortEligible && config.strictPortEnabled();
      if (pinnedPort !== undefined || strictPort) {
        // A pinned port -- or any port under strict-port -- that loses the race fails rather
        // than silently moving to a different port.
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
  consola.info(`Started the proxy (PID ${pid}) on port ${port}, detached. Logs: ${logFile}`);

  consola.start(`Waiting for the proxy to start (tailing ${logFile}) ...`);

  const maxWait = 120;
  let ready = false;
  let printedLogBytes = 0;
  for (let i = 0; i < maxWait; i++) {
    if (!pidAlive(pid)) {
      try {
        const hint = copilotTokenFailureHint(fs.readFileSync(logFile, "utf-8"), profile);
        if (hint) consola.error(hint);
      } catch {
        // best-effort: a missing/unreadable log just means no hint.
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

/** Set `value` at `path` inside the proxy config.json document, merging into existing
 *  nested records so sibling keys the daemon owns (e.g. `contextManagement.messages`)
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

/** Delete the value at `path` when present. A missing or non-record parent means nothing of
 *  ours can be there, so nothing is touched (parents are never created or pruned). */
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
  // Project copilot-env's tunable proxy preferences (the CONFIG_REGISTRY entries marked for
  // projection) into the daemon's config.json before launch. These are static defaults the
  // daemon reads at startup and have no admin REST endpoint, so they must be written to the
  // file here (unlike model aliases, pushed live via CopilotAdminClient). A force-projected
  // key falls back to its built-in proxy default when unset; an unset OPT-IN key is simply
  // not written -- and when a previous start wrote it (recorded in ProxyProjectionState),
  // the leftover value is cleared here so `agent config --del` truly reverts to the proxy's
  // own default without ever deleting a value we didn't project. Keys the proxy renamed
  // away from are dropped too, so an old install self-heals on its next start.
  const config = new CopilotApiConfig(paths.configFile);
  const projection = projectedProxyConfig(envConfig);
  const projectedKeys = new Set(projection.map((e) => JSON.stringify(e.path)));
  const registryOptInKeys = new Set(optInProxyConfigPaths().map((p) => JSON.stringify(p)));
  const ownership = new ProxyProjectionState(paths);
  // The record-read -> config-write -> record-write sequence is one read-modify-write,
  // guarded by a per-HOME lock: the global start lock lives in the per-host run dir, so two
  // hosts sharing a daemon home would not exclude each other there (the exclusion stays
  // best-effort across hosts, since dead-holder reclaim is pid-based and host-local).
  // Named `.apply.lock` because plain `<file>.lock` is CopilotApiConfig.update()'s own
  // inner per-file lock, which the writes below still take.
  const lockPath = `${ownership.path}.apply.lock`;
  withFileLockSync(lockPath, BOUNDED_LOCK_POLICY, (outcome) => {
    if (!outcome.held) {
      consola.info("Proxy-config apply lock is busy; applying unlocked after the bounded wait.");
    }
    // Only paths the CURRENT registry projects opt-in may be deleted: a recorded path
    // outside that set (an older registry's, or a foreign write to the record) never
    // claims anything -- it stays in config.json and just falls out of the record.
    const ownedBefore = ownership
      .ownedPaths()
      .filter((p) => registryOptInKeys.has(JSON.stringify(p)));
    config.update((d) => {
      for (const key of STALE_PROXY_CONFIG_KEYS) {
        delete d[key];
      }
      for (const path of ownedBefore) {
        if (!projectedKeys.has(JSON.stringify(path))) deleteProxyConfigValue(d, path);
      }
      for (const entry of projection) {
        setProxyConfigValue(d, entry.path, entry.value);
      }
    });
    ownership.setOwnedPaths(projection.filter((e) => e.optIn).map((e) => e.path));
  });
  // Persist an admin key so the live `/admin/config/model-mappings` route (used
  // by syncModelAliases) accepts our request instead of 401-ing.
  config.ensureAdminApiKey();
}

/**
 * Disable every built-in extraPrompt the proxy injects.
 *
 * The floated `@jeffreycao/copilot-api` re-adds any *missing* default extraPrompt
 * key on every config reload (`mergeDefaultConfig`), so an empty or absent map
 * is futile -- the defaults always come back. Instead we blank every key the
 * daemon has already written to config.json. Discovering the key set at runtime
 * (rather than hardcoding it) keeps this correct when a future package version
 * adds new default prompts.
 *
 * Must run after the daemon is up (so config.json holds the package's full
 * default set) and before the model-mappings POST, whose reloadConfig() makes
 * the blanked values take effect.
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

/**
 * Pull the daemon's live model catalog and replace its aliases with a
 * catalog-derived map. Best-effort: on failure no aliases are set (the proxy
 * still resolves plain dash-form ids via its own normalizer), and a warning is
 * logged.
 */
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

/** Fetch the daemon's live model mappings and print them grouped by target. */
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
  // Emit the whole table as a single message so consola stamps one timestamp
  // instead of one per row (which wraps and interleaves at terminal width).
  const rows = targets.map((target) => {
    const aliases = (byTarget.get(target) ?? []).sort();
    return `   ${target.padEnd(width)}  <-  ${aliases.join(", ")}`;
  });
  consola.info(
    `Model aliases (${sources.length} -> ${targets.length} models):\n${rows.join("\n")}`,
  );
}

/**
 * The post-readiness config/alias pass: blank the proxy's built-in extraPrompts now that
 * config.json holds the package's full default set (the setModelMappings POST below
 * triggers the daemon's reloadConfig(), which makes the blanked values take effect),
 * then sync + print the catalog-derived model aliases through the admin API.
 */
export async function syncAliasesAfterStart(config: CopilotApiConfig, port: number): Promise<void> {
  disableExtraPrompts(config);
  const admin = new CopilotAdminClient({
    port,
    apiKey: config.ensureApiKey(),
    adminKey: config.ensureAdminApiKey(),
  });
  await syncModelAliases(admin);
}
