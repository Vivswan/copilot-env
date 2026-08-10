// `agent start`: the command layer over the launch pipeline (src/copilot_api/launch.ts).
// It parses the flags into ONE action, dispatches the check/record-event probes, reports
// the dry run, and orchestrates the live launch steps; every user-facing summary and
// next-steps rendering lives here.
import * as fs from "node:fs";
import { consola } from "consola";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  acquireStartLock,
  applyDefaultConfig,
  assertProxyFloor,
  awaitReadiness,
  cleanupExistingProxies,
  listUntrackedOrphans,
  resolveLaunchCredential,
  resolveStartPort,
  spawnConfiguredDaemon,
  startLockPath,
  syncAliasesAfterStart,
  trackedDaemonPids,
} from "../copilot_api/launch.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { pidAlive } from "../copilot_api/process.ts";
import { type Profile, parseProfileFlag, profileLabel } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { installedProxyVersion, PROXY_PACKAGE_NAME } from "../copilot_api/version.ts";
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { releaseFileLock } from "../utils/file_lock.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { formatDuration } from "../utils/time.ts";
import { ensureAuthenticated } from "./auth.ts";

/** Raw `agent start` flag values, exactly as Commander hands them over. Parsed ONCE by
 *  `parseStartAction` at the CLI boundary into a StartAction -- runStart never dispatches
 *  on these directly, so a conflicting combination is rejected instead of resolved by
 *  if-order. */
export interface StartFlags {
  dryRun?: boolean;
  /** Pin the proxy to this port instead of auto-resolving (fails if busy). */
  port?: number;
  /**
   * `--record-event`: record an activity heartbeat (`lastEnsureAt`) for the idle watchdog
   * and return WITHOUT launching. The agents' proxy resolver calls this on each token
   * fetch so an open agent keeps the proxy alive between requests.
   */
  recordEvent?: boolean;
  /**
   * `--check`: set exit code 0 iff OUR proxy is genuinely running (1 otherwise) and return
   * WITHOUT launching. The proxy resolver + shell launchers use this as the "is it up?" probe.
   */
  check?: boolean;
  /**
   * `--force`: launch a fresh daemon even when a healthy one is already running. Only relevant in
   * the managed lifecycle (auto-start on), where a plain `start` is otherwise an idempotent no-op
   * that leaves the running proxy up; in the unmanaged/default mode `start` always (re)starts. Use
   * `--force` after changing the credential or a config key the daemon reads at startup (port,
   * small-model, passthrough, proxy-logs).
   */
  force?: boolean;
  /**
   * `--profile <name>`: operate on that named profile's daemon -- an isolated instance
   * (own home/config/port) running under the profile's own credential, so several
   * accounts can serve through local proxies at once. The default daemon is untouched.
   */
  profile?: string;
}

/**
 * What ONE `agent start` invocation does -- exactly one of the liveness check, the
 * heartbeat record, or a (possibly dry-run) launch, each addressing `profile`'s daemon.
 * The launch-only knobs (`dryRun`/`force`/`port`) live on the launch variant alone, so
 * `--check --record-event` (or a probe combined with a launch flag) is unrepresentable
 * past the boundary parse and the dispatch order in runStart is not load-bearing.
 * `profile` is already PARSED (parseProfileFlag at the boundary, like McpAction), so an
 * invalid name errors before any action runs and runStart never re-validates.
 */
export type StartAction =
  | { kind: "check"; profile: Profile }
  | { kind: "record-event"; profile: Profile }
  | { kind: "launch"; dryRun: boolean; force: boolean; port?: number; profile: Profile };

/** Parse the raw flags into a StartAction (the CLI boundary). `--check` and
 *  `--record-event` are standalone probes -- the proxy resolver invokes each in its own
 *  `agent start` call -- so combining them with each other or with a launch-only flag
 *  is an error here, never a silently dropped heartbeat. */
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

/**
 * The cheap (sync) part of the managed-lifecycle "leave a running proxy up" gate, shared by
 * the dry-run and live paths: only a no-op candidate when the lifecycle is managed AND this is
 * not a forced or explicitly-ported (re)launch. The caller still confirms the proxy is actually
 * up via `proxyStatus()` before short-circuiting.
 *
 * Idempotent ONLY in the managed lifecycle (auto-start on): there the proxy is auto-started by
 * the resolver and auto-stopped by the watchdog, so a redundant manual `start` should leave the
 * running daemon (and any connected Codex/Claude) untouched rather than tearing it down and
 * relaunching. In the unmanaged/default mode the user drives start/stop by hand, so `start`
 * stays an explicit (re)start. Bump the heartbeat (a manual start is a keep-alive vs the idle
 * watchdog). `--force` launches a fresh daemon either way (e.g. after a credential/config
 * change), and an explicit `--port` is a reconfiguration request, so it always (re)launches
 * rather than no-op'ing.
 */
function isIdempotentNoOp(
  action: { force: boolean; port?: number },
  envConfig: CopilotEnvConfig,
): boolean {
  return !action.force && action.port === undefined && envConfig.autoStartEnabled();
}

/** The launch-path stores/paths one `start` invocation reads and writes -- constructed ONCE
 *  in runStart (including the single CopilotEnvConfig preference cursor) and passed down. */
interface LaunchContext {
  profile: Profile;
  paths: CopilotApiPaths;
  config: CopilotApiConfig;
  envConfig: CopilotEnvConfig;
  state: CopilotEnvRunState;
  logFile: string;
}

/** Report what a live launch WOULD do (no runtime changes): the would-be port, the tracked
 *  pid and orphans that would be stopped, and the files that would be written. */
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
  const statePid = state.read().pid;
  const trackedPid = statePid !== undefined && pidAlive(statePid) ? statePid : null;
  const keep = trackedDaemonPids();
  const orphans = (await listUntrackedOrphans(process.pid, process.ppid, keep)).filter((p) =>
    pidAlive(p),
  );

  consola.info(`DRY RUN: no proxy runtime changes will be made (${profileLabel(profile)}).`);
  consola.info(`   Would ensure runtime directories: ${paths.home}, ${paths.runDir}`);
  consola.info(`   Would apply default configuration: ${config.path}`);
  if (trackedPid !== null) {
    consola.info(`   Would stop tracked proxy (pid=${trackedPid}).`);
  }
  for (const orphan of orphans) {
    consola.info(`   Would stop orphaned proxy (pid=${orphan}).`);
  }
  consola.info(`   Would launch the proxy on port ${port}.`);
  consola.info(`   Would write runtime state + log: ${paths.stateFile}, ${logFile}`);
  consola.info("   Would wait for readiness, sync model aliases, and report proxy details.");
}

/** The managed-lifecycle no-op report: bump the heartbeat (a manual start is a keep-alive vs
 *  the idle watchdog) and leave the running daemon untouched. */
function reportStartNoOp(state: CopilotEnvRunState, port: number, profileFlag: string): void {
  state.set({ lastEnsureAt: Date.now() });
  consola.success(`Proxy already running on port ${port} - leaving it up.`);
  // "[start:noop]" is a machine marker (external contract): CI's lifecycle smoke
  // keys its managed-no-op gate on this token, not on the sentence above.
  consola.info("[start:noop]");
  consola.info(
    `Run \`agent start${profileFlag} --force\` to launch a fresh daemon (e.g. after a credential or config change).`,
  );
}

/**
 * Seed the heartbeat so the in-daemon idle watchdog (preloaded when the managed lifecycle
 * is on) does not consider a freshly started, quiet proxy idle before its first request.
 * Also surface the auto-stop behavior, since a manual `start` arms the same watchdog and
 * the proxy will exit on its own later -- silence here is a surprise (see `agent config`).
 */
function reportManagedLifecycle(state: CopilotEnvRunState): void {
  state.set({ lastEnsureAt: Date.now() });
  // idle-timeout 0 disables auto-stop: armIdleWatchdog() then never arms a timer, so only
  // promise auto-stop when a window is actually in effect.
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

/**
 * Log the running proxy's version and (best-effort) its npm publish date.
 * The installed package.json carries only the version; the publish timestamp
 * lives in the registry's `time` map, so we fetch it with a short timeout and
 * fall back to version-only when offline.
 */
async function logProxyVersion(): Promise<void> {
  const version = installedProxyVersion();
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
    // offline / slow registry -- version alone is still useful
  }
  consola.info(`   Proxy: ${PROXY_PACKAGE_NAME} ${version}${published}`);
}

/** The end-of-start report: the proxy version line, the path block (one message, one
 *  timestamp -- keeps it from interleaving), and the next-steps box. */
async function reportStartSummary(
  profile: Profile,
  live: { pid: number; port: number },
  paths: CopilotApiPaths,
  logFile: string,
): Promise<void> {
  await logProxyVersion();
  const summary: Array<[string, string]> = [
    ["Logs", logFile],
    ["PID", String(live.pid)],
    ["Port", String(live.port)],
    ["SQLite", paths.sqliteDb],
    ["Bun env", PROJECT_ROOT],
  ];
  const labelWidth = summary.reduce((m, [label]) => Math.max(m, label.length), 0);
  consola.info(
    summary
      .map(([label, value]) => `   ${`${label}:`.padEnd(labelWidth + 1)}  ${value}`)
      .join("\n"),
  );
  // What's next: set off in its own box so it doesn't blend into the path block.
  // The default box is an output contract; the named-profile variant addresses
  // the profile's own launchers and stop command.
  consola.log("");
  consola.box(
    profile === null
      ? [
          "Next steps",
          "",
          "  • Launch an agent:  `cl` (Claude) / `cx` (Codex) / `co` (Copilot)",
          "    ...or run `claude` / `codex` directly.",
          "  • Install those launchers:  `agent shell --launchers`",
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

/** The `--check` probe: "is the proxy up?" -- no launch. The exit code is the contract;
 *  every machine caller (the proxy resolver + cl/co/cx launchers) discards all output and
 *  reads only it. The status line is purely for a human running `start --check` directly. */
async function reportCheckProbe(profile: Profile): Promise<void> {
  const status = await proxyStatus(profile);
  if (status.up) {
    consola.success(`proxy is running on port ${status.port}`);
  } else {
    consola.info("proxy is not running");
  }
  process.exitCode = status.up ? 0 : 1;
}

/** `start`: launch copilot-api detached, wait for readiness, sync aliases. */
export async function runStart(action: StartAction): Promise<void> {
  const profile = action.profile;
  if (action.kind === "check") {
    await reportCheckProbe(profile);
    return;
  }
  if (action.kind === "record-event") {
    recordHeartbeat(profile);
    return;
  }
  const paths = new CopilotApiPaths(profile);
  const ctx: LaunchContext = {
    profile,
    paths,
    config: CopilotApiConfig.forProfile(profile),
    envConfig: new CopilotEnvConfig(),
    state: CopilotEnvRunState.forProfile(profile),
    logFile: paths.logFile,
  };

  if (action.dryRun) {
    await reportDryRun(action, ctx);
    return;
  }

  assertProxyFloor();

  fs.mkdirSync(paths.runDir, { recursive: true });
  const lockPath = startLockPath();
  await acquireStartLock(lockPath);
  // Every human-facing follow-up command must address THIS daemon.
  const profileFlag = profile === null ? "" : ` --profile ${profile}`;
  try {
    if (isIdempotentNoOp(action, ctx.envConfig)) {
      const status = await proxyStatus(profile);
      if (status.up) {
        reportStartNoOp(ctx.state, status.port, profileFlag);
        return;
      }
    }

    fs.mkdirSync(paths.home, { recursive: true });
    applyDefaultConfig(ctx.paths, ctx.envConfig);
    await cleanupExistingProxies(profile, ctx.state);

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
    await reportStartSummary(profile, live, paths, ctx.logFile);
  } finally {
    releaseFileLock(lockPath);
  }
}
