import { consola } from "consola";
import { type PreflightOptions, runPreflight } from "../autoupdate/preflight.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  applyDefaultConfig,
  awaitReadiness,
  type CleanupAction,
  cleanupExistingProxies,
  ensureProxyFloor,
  entryProxyVersion,
  type FloorCheckedEntry,
  type HeldStartLock,
  planCleanup,
  resolveLaunchCredential,
  resolveStartPort,
  spawnConfiguredDaemon,
  syncAliasesAfterStart,
  withStartLock,
} from "../copilot_api/launch.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { daemonPolicy } from "../copilot_api/port.ts";
import { parseProfileFlag, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { PROXY_PACKAGE_NAME } from "../copilot_api/version.ts";
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger, withConsolaOnStderr } from "../utils/logger.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { formatDuration } from "../utils/time.ts";
import { mkdirReported } from "../utils/report_write.ts";
import { ensureAuthenticated } from "./auth.ts";
import { unreadProjectedKeyWarnings } from "./config.ts";

export interface StartFlags {
  dryRun?: boolean;
  port?: number;
  /** The agents' proxy resolver calls this on each token fetch, so an open agent keeps the proxy
   *  alive. */
  recordEvent?: boolean;
  check?: boolean;
  force?: boolean;
  profile?: string;
}

export type StartAction =
  | { kind: "check"; profile: Profile }
  | { kind: "record-event"; profile: Profile }
  | { kind: "launch"; dryRun: boolean; force: boolean; port?: number; profile: Profile };

/** The proxy resolver invokes `--check` and `--record-event` in separate calls, so a combination is
 *  an error here, never a silently dropped heartbeat. */
export function parseStartAction(flags: StartFlags): StartAction {
  const probes = (flags.check ? 1 : 0) + (flags.recordEvent ? 1 : 0);
  const launchFlags = Boolean(flags.dryRun) || Boolean(flags.force) || flags.port !== undefined;
  if (probes > 1 || (probes === 1 && launchFlags)) {
    throw new Error(
      "--check and --record-event are mutually exclusive and cannot combine with --dry-run/--port/--force",
    );
  }
  const profile: Profile = parseProfileFlag(flags.profile);
  if (flags.check) return { kind: "check", profile };
  if (flags.recordEvent) return { kind: "record-event", profile };
  return {
    kind: "launch",
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    port: flags.port,
    profile,
  };
}

/** Idempotent only in the managed lifecycle: there the resolver auto-starts and the watchdog
 *  auto-stops, so a redundant manual `start` must leave the running daemon (and any connected
 *  agent) alone. Unmanaged, `start` is an explicit (re)start; `--force` and an explicit `--port`
 *  always (re)launch. */
function isIdempotentNoOp(
  action: { force: boolean; port?: number },
  envConfig: CopilotEnvConfig,
): boolean {
  return !action.force && action.port === undefined && envConfig.autoStartEnabled();
}

/** Constructed once per launch and passed down, so every step reads the same config cursor. */
interface LaunchContext {
  profile: Profile;
  paths: CopilotApiPaths;
  config: CopilotApiConfig;
  envConfig: CopilotEnvConfig;
  state: CopilotEnvRunState;
  logFile: string;
}

/** The narration half of the planCleanup contract; the live half executes the same enumeration, and
 *  a new CleanupAction without a line here does not compile. Each string is a pinned output
 *  contract. */
function narrateCleanupAction(step: CleanupAction): void {
  switch (step.kind) {
    case "stop-tracked":
      consola.info(`   Would stop tracked proxy (pid=${step.pid}).`);
      break;
    case "clear-tracking":
      consola.info(`   Would clear tracked run state (pid=${step.pid}).`);
      break;
    case "stop-holder":
      consola.info(`   Would stop this home's untracked daemon.lock holder (pid=${step.pid}).`);
      break;
    case "leave-holder":
      consola.warn(
        `   Would leave the daemon.lock holder (pid=${step.pid}) alone: this host cannot identify that pid as our daemon.`,
      );
      break;
    case "stop-orphan":
      consola.info(`   Would stop orphaned proxy (pid=${step.pid}).`);
      break;
    default:
      assertNever(step);
  }
}

/** planCleanup is the same decision source the live path executes, so no live action can go
 *  unreported. */
async function reportDryRun(
  action: { force: boolean; port?: number },
  ctx: LaunchContext,
): Promise<void> {
  const { profile, paths, config, envConfig, state, logFile } = ctx;
  if (isIdempotentNoOp(action, envConfig) && (await proxyStatus(profile)).up) {
    consola.info(
      "DRY RUN: proxy already running (managed lifecycle); would leave it up. --force forces one.",
    );
    return;
  }
  const port = await resolveStartPort(action.port, false, profile, false, envConfig);
  const plan = await planCleanup(paths.home, profile, state);

  consola.info(`DRY RUN: no proxy runtime changes will be made (${profileLabel(profile)}).`);
  consola.info(`   Would ensure runtime directories: ${paths.home}, ${paths.runDir}`);
  consola.info(`   Would apply default configuration: ${config.path}`);
  for (const step of plan) {
    narrateCleanupAction(step);
  }
  consola.info(`   Would launch the proxy on port ${port}.`);
  consola.info(`   Would write runtime state + log: ${paths.stateFile}, ${logFile}`);
  consola.info("   Would wait for readiness, sync model aliases, and report proxy details.");
}

/** A manual start is a keep-alive against the idle watchdog, hence the heartbeat. */
function reportStartNoOp(state: CopilotEnvRunState, port: number, profileFlag: string): void {
  state.set({ lastEnsureAt: Date.now() });
  consola.success(`Proxy already running on port ${port} - leaving it up.`);
  // "[start:noop]" is an external contract: CI's lifecycle smoke keys its managed-no-op gate on
  // this token.
  consola.info("[start:noop]");
  consola.info(
    `Run \`agent start${profileFlag} --force\` to launch a fresh daemon (e.g. after a credential or config change).`,
  );
}

/** The heartbeat keeps a freshly started, quiet proxy from reading as idle before its first
 *  request. The auto-stop is said out loud because a manual `start` arms the same watchdog and the
 *  proxy will exit on its own. */
function reportManagedLifecycle(state: CopilotEnvRunState): void {
  state.set({ lastEnsureAt: Date.now() });
  // idle-timeout 0 never arms a timer, so auto-stop is promised only when a window is in effect.
  const idleMs = idleTimeoutMs();
  if (idleMs > 0) {
    consola.info(
      `Managed lifecycle on: auto-stops after ${formatDuration(idleMs)} idle ` +
        "(`agent config --set idle-timeout 0` disables auto-stop; `auto-start false` keeps it up).",
    );
  } else {
    consola.info(
      "Managed lifecycle on (auto-start); idle auto-stop disabled (idle-timeout 0) -- " +
        "the proxy stays up until `agent stop`.",
    );
  }
}

async function logProxyVersion(entry: FloorCheckedEntry): Promise<void> {
  const version = entryProxyVersion(entry);
  if (version === null) {
    return;
  }
  let published = "";
  try {
    const res = await fetch(`https://registry.npmjs.org/${PROXY_PACKAGE_NAME}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = (await res.json()) as { time?: Record<string, string> };
      const ts = body.time?.[version];
      if (ts) {
        published = ` (published ${ts.slice(0, 10)})`;
      }
    }
  } catch {
    // offline or slow registry: the version alone is still useful
  }
  consola.info(`   Proxy: ${PROXY_PACKAGE_NAME} ${version}${published}`);
}

/** The path block is one message so its lines cannot interleave with other output. */
async function reportStartSummary(
  profile: Profile,
  live: { pid: number; port: number },
  paths: CopilotApiPaths,
  logFile: string,
  entry: FloorCheckedEntry,
): Promise<void> {
  await logProxyVersion(entry);
  const summary: Array<[string, string]> = [
    ["Logs", logFile],
    ["PID", String(live.pid)],
    ["Port", String(live.port)],
    ["SQLite", paths.sqliteDb],
    ["Install root", PROJECT_ROOT],
  ];
  const labelWidth = summary.reduce((m, [label]) => Math.max(m, label.length), 0);
  consola.info(
    summary
      .map(([label, value]) => `   ${`${label}:`.padEnd(labelWidth + 1)}  ${value}`)
      .join("\n"),
  );
  // The default box is an output contract.
  consola.log("");
  consola.box(
    profile === null
      ? [
        "Next steps",
        "",
        "  • Launch an agent:  `cl` (Claude) / `cx` (Codex) / `co` (Copilot)",
        "    ...or run `claude` / `codex` directly.",
        "  • Enable those launchers:  `agent config --set launchers true`",
        "  • `agent cost` reports proxy usage  ·  `agent stop` stops the proxy.",
      ].join("\n")
      : [
        "Next steps",
        "",
        `  • Launch an agent under this profile:  \`cl --profile ${profile}\` / \`cx --profile ${profile}\``,
        `    ...or \`claude --settings <path from agent profile --settings-for ${profile}>\` / \`codex --profile ${profile}\`.`,
        `  • \`agent stop --profile ${profile}\` stops this daemon (\`agent stop --all\` stops every one).`,
      ].join("\n"),
  );
}

/** The exit code is the contract: every machine caller (the proxy resolver, the launchers) discards
 *  the output and reads only it. */
async function reportCheckProbe(profile: Profile): Promise<void> {
  const status = await proxyStatus(profile);
  if (status.up) {
    consola.success(`proxy is running on port ${status.port}`);
  } else {
    consola.info("proxy is not running");
  }
  process.exitCode = status.up ? 0 : 1;
}

/** Injectable so a test can hand runPreflight hermetic state and lock paths. */
export type PreflightRunner = (opts: PreflightOptions) => Promise<void>;

/**
 * The last step of every live `start`, still inside the start lock, because PROJECT_ROOT names the
 * `current` link (src/utils/root.ts): a daemon spawned after the flip would run the new release's
 * preloads under this binary's launch logic. Best-effort by contract: a failed check or update is a
 * stderr warning, never a failed `start`, and consola rides stderr for this scope so the installer's
 * narration cannot reach stdout.
 *
 *   spawn this turn's daemon -> preflight may flip `current` -> lock released -> waiting starts spawn
 *
 * A waiter that already loaded the OLD binary spawns through the NEW `current`: an accepted
 * one-launch skew.
 */
async function selfUpdatePreflight(preflight: PreflightRunner): Promise<void> {
  await withConsolaOnStderr(async () => {
    try {
      await preflight({ nowMs: Date.now() });
    } catch (e) {
      createStderrLogger().warn(`autoupdate preflight error: ${errMessage(e)}`);
    }
  });
}

export async function runStart(
  action: StartAction,
  preflight: PreflightRunner = runPreflight,
): Promise<void> {
  const profile = action.profile;
  if (action.kind === "check") {
    await reportCheckProbe(profile);
    return;
  }
  if (action.kind === "record-event") {
    recordHeartbeat(profile);
    return;
  }
  /** Resolved together so paths and stores can never disagree. The live launch resolves INSIDE the
   *  start lock: the 3.5.6 default-home migration refuses to move the home while that lock is held,
   *  so a held-lock resolution cannot go stale against a concurrent move. */
  const launchContext = (): LaunchContext => {
    const paths = new CopilotApiPaths(profile);
    return {
      profile,
      paths,
      config: CopilotApiConfig.forProfile(profile),
      envConfig: new CopilotEnvConfig(),
      state: CopilotEnvRunState.forProfile(profile),
      logFile: paths.logFile,
    };
  };

  if (action.dryRun) {
    await reportDryRun(action, launchContext());
    return;
  }

  // Every human-facing follow-up command must address THIS daemon.
  const profileFlag = daemonPolicy(profile).flagSuffix;
  await withStartLock(async (lock) => {
    try {
      await launchUnderLock(lock, action, profile, profileFlag, launchContext);
    } finally {
      // On every exit path: a failed launch still gets its daily check, and its error passes
      // through.
      await selfUpdatePreflight(preflight);
    }
  });
}

async function launchUnderLock(
  lock: HeldStartLock,
  action: { force: boolean; port?: number },
  profile: Profile,
  profileFlag: string,
  launchContext: () => LaunchContext,
): Promise<void> {
  const ctx = launchContext();
  const paths = ctx.paths;
  mkdirReported(paths.runDir);
  // Inside the start lock: the gate rewrites the shared daemon config and re-warms the float's
  // cache, so two concurrent starts must not run it over each other.
  const entry = await ensureProxyFloor(lock);

  if (isIdempotentNoOp(action, ctx.envConfig)) {
    const status = await proxyStatus(profile);
    if (status.up) {
      reportStartNoOp(ctx.state, status.port, profileFlag);
      return;
    }
  }

  mkdirReported(paths.home);
  applyDefaultConfig(ctx.paths, ctx.envConfig);
  for (const warning of unreadProjectedKeyWarnings(ctx.envConfig, entryProxyVersion(entry))) {
    consola.warn(warning);
  }
  await cleanupExistingProxies(lock, profile, ctx.state);

  const port = await resolveStartPort(action.port, true, profile, true, ctx.envConfig);
  const credential = await resolveLaunchCredential(profile, ctx.envConfig, {
    interactiveLogin: ensureAuthenticated,
  });
  const spawned = spawnConfiguredDaemon({
    port,
    logFile: ctx.logFile,
    profile,
    paths,
    credential,
    entry,
    config: ctx.envConfig,
  });
  const live = await awaitReadiness({
    pid: spawned.pid,
    port,
    logFile: ctx.logFile,
    profile,
    pinnedPort: action.port,
    state: ctx.state,
    relaunch: spawned.relaunch,
    config: ctx.envConfig,
  });

  if (spawned.idleWatchdog) {
    reportManagedLifecycle(ctx.state);
  }
  await syncAliasesAfterStart(ctx.config, live.port);
  await reportStartSummary(profile, live, paths, ctx.logFile, entry);
}
