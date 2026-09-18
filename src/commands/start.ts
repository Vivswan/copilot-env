import { consola } from "consola";
import { type PreflightOptions, runPreflight } from "../autoupdate/preflight.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { assertProfileSlot } from "../copilot_api/env_state.ts";
import {
  applyDefaultConfig,
  awaitReadiness,
  type CleanupAction,
  cleanupExistingProxies,
  ensureProxyFloor,
  entryProxyVersion,
  type FloorCheckedEntry,
  type HeldStartLock,
  type LaunchToken,
  planCleanup,
  readLaunchToken,
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
import { codexUserAgent } from "../codex/user_agent.ts";
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger, withConsolaOnStderr } from "../utils/logger.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { COLOR_ENABLED, statusPaint } from "../utils/ansi.ts";
import { formatTable, terminalWidth } from "../utils/table.ts";
import { formatDuration } from "../utils/time.ts";
import * as fs from "../utils/fs_facade.ts";
import { runDryRun } from "./dry_run.ts";
import { credentialSourceLabel } from "./auth.ts";
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
  const { profile, paths, envConfig, state, logFile } = ctx;
  // The launch's own gate, first here as it is first in the real run: no credential is the same
  // refusal, and the plan names the source the daemon would run with.
  const launch = readLaunchToken(profile);
  const source = credentialSourceLabel(new Credential(undefined, profile).read());
  if (isIdempotentNoOp(action, envConfig) && (await proxyStatus(profile)).up) {
    consola.info(
      "DRY RUN: proxy already running (managed lifecycle); would leave it up. --force forces one.",
    );
    return;
  }
  consola.info(`DRY RUN: no proxy runtime changes will be made (${profileLabel(profile)}).`);
  // In the real start's order, so a refusal leaves the plan the real run's writes up to it: the
  // home and the projected configuration land (a config.json the real start refuses to rewrite
  // refuses the preview too), then the cleanup plan, the port, and the credential resolution (the
  // token judged under the daemon's identity, the pair landed in the slot: a rejected token is the
  // same refusal, the landing store rows).
  fs.mkdir(paths.home);
  applyDefaultConfig(profile, paths, envConfig);
  const plan = await planCleanup(paths.home, profile, state);
  const port = await resolveStartPort(action.port, false, profile, false, envConfig);
  const { copilotHost } = await resolveLaunchCredential(profile, launch, envConfig, {
    userAgent: codexUserAgent(),
  });
  // The real launch records the port it took before anything wires from it (a launcher's config
  // reads copilotApiResolvePort), so the plan records it too; the pid beside it is minted at spawn.
  state.set({ port });
  consola.info(`   Would ensure the run directory: ${paths.runDir}`);
  for (const step of plan) {
    narrateCleanupAction(step);
  }
  consola.info(`   Would launch the proxy on port ${port} with the ${source} credential.`);
  consola.info(`   Would send the daemon's requests to ${copilotHost}.`);
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
        `(\`${configSetCommand("daemon.idle-timeout", "0")}\` disables auto-stop; ` +
        `\`${configSetCommand("daemon.auto-start", "false")}\` keeps it up).`,
    );
  } else {
    consola.info(
      "Managed lifecycle on (daemon.auto-start); idle auto-stop disabled (daemon.idle-timeout 0) -- " +
        "the proxy stays up until `agent stop`.",
    );
  }
}

/** The summary's first line, consola-decorated; the table rows go through console.log: consola
 *  would put its icon in front of the first row and read a hard-split path chunk as markup. */
async function proxyLine(entry: FloorCheckedEntry): Promise<string> {
  if (entry.kind === "file") return `   Proxy: ${entry.path} (COPILOT_API_ENTRY)`;
  const version = entryProxyVersion(entry);
  if (version === null) return `   Proxy: ${PROXY_PACKAGE_NAME} (version unknown)`;
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
  return `   Proxy: ${PROXY_PACKAGE_NAME} ${version}${published}`;
}

/** The label column stays put; a value column too wide for the terminal (a path) splits at its
 *  own edge. */
export function renderStartSummary(
  summary: ReadonlyArray<readonly [label: string, value: string]>,
  width: number | null = terminalWidth(),
  color = COLOR_ENABLED,
): string {
  return formatTable(summary.map(([label, value]) => [`${label}:`, value]), {
    indent: "   ",
    wrap: [false, "hard"],
    width,
    color,
  }).join("\n");
}

/** The proxy line and the path block print back to back, so their lines never interleave with
 *  other output. */
async function reportStartSummary(
  profile: Profile,
  live: { pid: number; port: number },
  paths: CopilotApiPaths,
  logFile: string,
  entry: FloorCheckedEntry,
): Promise<void> {
  consola.info(await proxyLine(entry));
  console.log(renderStartSummary([
    ["Logs", logFile],
    ["PID", String(live.pid)],
    ["Port", String(live.port)],
    ["SQLite", paths.sqliteDb],
    ["Install root", PROJECT_ROOT],
  ]));
  // The default box is an output contract.
  consola.log("");
  consola.box(
    profile === null
      ? [
        "Next steps",
        "",
        "  • Launch an agent:  `cl` (Claude) / `cx` (Codex) / `co` (Copilot)",
        "    ...or run `claude` / `codex` directly.",
        `  • Enable those launchers:  \`${configSetCommand("shell.launchers", "true")}\``,
        "  • `agent cost` reports proxy usage  ·  `agent stop` stops the proxy.",
      ].join("\n")
      : [
        "Next steps",
        "",
        `  • Launch an agent under this profile:  \`cl --profile ${profile}\` / \`cx --profile ${profile}\``,
        `    ...or \`claude --settings <the path cl --profile ${profile} resolves>\` / \`codex --profile ${profile}\`.`,
        `  • \`agent stop --profile ${profile}\` stops this daemon (\`agent stop --all\` stops every one).`,
      ].join("\n"),
  );
}

/** The exit code is the contract: every machine caller (the proxy resolver, the launchers) discards
 *  the output and reads only it. */
async function reportCheckProbe(profile: Profile): Promise<void> {
  const status = await proxyStatus(profile);
  if (status.up) {
    consola.success(`proxy is ${statusPaint("running", COLOR_ENABLED)} on port ${status.port}`);
  } else {
    consola.info(`proxy is ${statusPaint("not running", COLOR_ENABLED)}`);
  }
  process.exitCode = status.up ? 0 : 1;
}

/** Injectable so a test can hand runPreflight hermetic state and lock paths. */
export type PreflightRunner = (opts: PreflightOptions) => Promise<void>;

/**
 * Runs inside the start lock because PROJECT_ROOT names the `current` link (src/utils/root.ts): a
 * daemon spawned after the flip would run the new release's preloads under this binary's launch
 * logic. Best-effort by contract: a failed check or update is a stderr warning, never a failed
 * `start`, and consola rides stderr for this scope so the installer's narration cannot reach stdout.
 *
 *   spawn this turn's daemon -> preflight may flip `current` -> lock released -> waiting starts spawn
 *
 * A waiter that already loaded the OLD binary spawns through the NEW `current`: an accepted one-launch skew.
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
  // Before any directory is made: a launch of a profile that does not exist must not leave a
  // half-created daemon home behind its refusal.
  if (profile !== null) assertProfileSlot(profile);
  /** Resolved together so paths and stores can never disagree. */
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
    // Under a collecting dry run already (proxy-token's, a launcher's) the plan is the caller's;
    // a bare `start --dry-run` collects its own, so its landings (the port, the credential pair)
    // record instead of writing.
    const preview = (): Promise<void> => reportDryRun(action, launchContext());
    if (fs.dryRunActive()) await preview();
    else await runDryRun(preview);
    return;
  }

  // The refusal is the FIRST thing a launch does (readLaunchToken): before the start lock, any
  // directory, the cleanup of the running daemon, the port probe, or a spawn. A `--force` with no
  // credential would otherwise stop the daemon and then refuse, leaving the user worse off than
  // before the command.
  const launch = readLaunchToken(profile);

  // Every human-facing follow-up command must address THIS daemon.
  const profileFlag = daemonPolicy(profile).flagSuffix;
  await withStartLock(async (lock) => {
    try {
      await launchUnderLock(lock, action, profile, profileFlag, launchContext, launch);
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
  launch: LaunchToken,
): Promise<void> {
  const ctx = launchContext();
  const paths = ctx.paths;
  fs.mkdir(paths.runDir);
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

  fs.mkdir(paths.home);
  applyDefaultConfig(profile, ctx.paths, ctx.envConfig);
  for (
    const warning of unreadProjectedKeyWarnings(ctx.envConfig, entryProxyVersion(entry), profile)
  ) {
    consola.warn(warning);
  }
  await cleanupExistingProxies(lock, profile, ctx.state);

  const port = await resolveStartPort(action.port, true, profile, true, ctx.envConfig);
  const { credential, copilotHost } = await resolveLaunchCredential(
    profile,
    launch,
    ctx.envConfig,
    {
      // The daemon sends the codex User-Agent the agent configs bake, so it is probed under it.
      userAgent: codexUserAgent(),
    },
  );
  const spawned = spawnConfiguredDaemon({
    port,
    logFile: ctx.logFile,
    profile,
    paths,
    credential,
    copilotHost,
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
