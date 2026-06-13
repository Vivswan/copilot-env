// `agent start`: launches the proxy daemon, applies defaults, and syncs aliases.
import * as fs from "node:fs";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { CopilotAdminClient } from "../copilot_api/admin.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { generateAliases } from "../copilot_api/models.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import {
  copilotApiFindPort,
  copilotApiPortAvailable,
  defaultProxyPort,
} from "../copilot_api/port.ts";
import {
  getOrphanPids,
  isCopilotApiPid,
  launchDaemon,
  pidAlive,
  printLogTail,
  terminatePid,
} from "../copilot_api/process.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import {
  installedProxyVersion,
  PROXY_PACKAGE_NAME,
  proxyVersionFloorStatus,
} from "../copilot_api/version.ts";
import { errMessage } from "../utils/error.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { ensureAuthenticated } from "./auth.ts";

// --- Default config applied on every `start`. ---
//
// String literals here are external contracts (config-file keys, copilot-api
// model ids). Do not change them during refactors.
//

const DEFAULT_SMALL_MODEL = "gpt-5-mini";

/**
 * Whether a GitHub token is a Personal Access Token by its prefix: `ghp_` (classic)
 * or `github_pat_` (fine-grained). PATs cannot perform copilot-api's editor token
 * exchange (`copilot_internal/v2/token` -> 403), so they need the PAT passthrough
 * shim; OAuth / app tokens (`gho_`/`ghu_`/`ghs_`/...) can, so they don't. Legacy
 * unprefixed 40-hex classic PATs are NOT detected here -- use `config passthrough on` for those.
 */
export function isPatToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("ghp_") || t.startsWith("github_pat_");
}

/**
 * Whether to load the PAT-passthrough preload shim into the daemon
 * (`src/scripts/pat_passthrough_preload.ts`). The shim intercepts copilot-api's
 * editor token exchange and hands the PAT back as the Copilot token, so the daemon
 * runs its normal `vscode-chat` path with the PAT as the bearer -- the only way a PAT
 * works through the proxy. It's a no-op for non-PAT tokens, so the `passthrough` config
 * key (`on`) can force it for an undetected (e.g. legacy unprefixed) PAT, and `off` forces
 * it off.
 *
 * Precedence: an explicit `force` (resolved by the caller from the `passthrough` config:
 * on -> true, off -> false) wins; otherwise (`auto`/unset) auto-enable for a PAT-shaped token.
 */
export function usePatPassthrough(opts: {
  force: boolean | undefined;
  token: string | undefined;
}): boolean {
  if (opts.force !== undefined) return opts.force;
  return opts.token !== undefined && isPatToken(opts.token);
}

const DEFAULT_FLAGS: Record<string, unknown> = {
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
};

export interface StartArgs {
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
}

// Whether OUR proxy is genuinely up (and on which recorded port): the tracked, alive
// copilot-api pid AND the port it actually recorded both confirm it. Reading pid AND port
// from the SAME run-state snapshot ties the probe to the daemon's real listening port -- so
// a moved port (start chose a different one) or a stranger on the default port can't produce
// a false result, and the returned port matches what was probed.
async function proxyStatus(): Promise<{ up: boolean; port?: number }> {
  const { pid, port } = new CopilotEnvRunState().read();
  if (pid === undefined || !pidAlive(pid) || !(await isCopilotApiPid(pid))) {
    return { up: false };
  }
  const probePort = port ?? defaultProxyPort();
  return { up: await portListening(probePort), port };
}

// A raw TCP-connect liveness probe. It opens (and immediately closes) a loopback socket to
// confirm the daemon is accepting connections WITHOUT sending an HTTP request -- the daemon
// runs `--verbose` and logs every HTTP request to its log file, and the idle watchdog treats
// that log's mtime as activity. An HTTP probe would therefore reset the idle clock on every
// `--check`, so anything polling liveness (an open agent's resolver, a monitor) would pin the
// proxy awake. A bare connect writes nothing the daemon logs, so liveness stays activity-neutral
// while real proxied traffic still counts. Tries IPv4 then IPv6 loopback, mirroring fetch's
// happy-eyeballs resolution of `localhost` so a daemon bound to either is detected.
export function portListening(port: number, timeoutMs = 2000): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const finish = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  return tryHost("127.0.0.1").then((ok) => (ok ? true : tryHost("::1")));
}

function applyDefaultConfig(config: CopilotApiConfig): void {
  // These are static defaults the daemon reads from config.json at startup.
  // They have no admin REST endpoint, so they must be written to the file before
  // launch (unlike model aliases, which are pushed live via CopilotAdminClient).
  config.update((d) => {
    d.smallModel = new CopilotEnvConfig().read().smallModel ?? DEFAULT_SMALL_MODEL;
    Object.assign(d, DEFAULT_FLAGS);
  });
  // Persist an admin key so the live `/admin/config/model-mappings` route (used
  // by syncModelAliases) accepts our request instead of 401-ing.
  config.ensureAdminApiKey();
}

/**
 * Disable every built-in extraPrompt the proxy injects.
 *
 * The pinned `@jeffreycao/copilot-api` re-adds any *missing* default extraPrompt
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
    if (current && typeof current === "object" && !Array.isArray(current)) {
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
  // Group the aliases by the model they resolve to, so each target is listed
  // once with its sources comma-joined.
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
    const res = await fetch("https://registry.npmjs.org/@jeffreycao/copilot-api", {
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
  consola.info(`   Proxy: @jeffreycao/copilot-api ${version}${published}`);
}

/**
 * Resolve the port `start` will bind: a pinned `--port` is used as-is but must be
 * free (else throw -- never silently move off the port the user asked for); with no
 * pin, use the default or the next free port above it. `announce` emits the
 * busy/alternative-port notices on the live path (the dry-run resolves quietly).
 * Read-only (just probes availability), so it's safe to call from `--dry-run`.
 */
async function resolveStartPort(pinned: number | undefined, announce: boolean): Promise<number> {
  if (pinned !== undefined) {
    if (!(await copilotApiPortAvailable(pinned))) {
      throw new Error(
        `requested port ${pinned} is busy (held by another process). Free it or pick another --port.`,
      );
    }
    return pinned;
  }
  // No hard `--port` pin: the auto-resolve base is the default proxy port (config `port`,
  // else the built-in 4141) -- a SOFT default that moves to the next free port if busy.
  const def = defaultProxyPort();
  if (await copilotApiPortAvailable(def)) return def;
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

/**
 * Refuse to launch on a proxy below the PROXY_MIN_VERSION floor. The float
 * (`bun install`'s postinstall) is best-effort, so an offline/failed install can
 * leave a sub-floor proxy in node_modules; the floor is a hard runtime contract,
 * so we enforce it here -- **fail-closed** and before disturbing any running daemon.
 * An unresolvable proxy or unreadable copilot-env.config is itself fatal (we
 * can't confirm the floor), so it throws rather than launching blind.
 */
function assertProxyFloor(): void {
  const version = installedProxyVersion();
  if (version === null) {
    throw new Error(
      `${PROXY_PACKAGE_NAME} is not installed or its package.json is unreadable — run 'bun install' to (re)install the proxy.`,
    );
  }
  let config: ProjectConfig;
  try {
    config = readProjectConfig(PROJECT_ROOT);
  } catch (e) {
    throw new Error(`could not read the proxy floor from copilot-env.config: ${errMessage(e)}`);
  }
  const status = proxyVersionFloorStatus(version, config);
  if (!status.ok && status.reason === "belowFloor") {
    throw new Error(
      `${PROXY_PACKAGE_NAME} ${status.version} is below the required ${status.floor} floor — the proxy ` +
        `float (bun install postinstall) likely failed (offline?). Re-run 'bun install' online, ` +
        `or set COPILOT_API_VERSION to a known-good release.`,
    );
  }
}

/** `start`: launch copilot-api detached, wait for readiness, sync aliases. */
export async function runStart(args: StartArgs): Promise<void> {
  if (args.check) {
    // "Is the proxy up?" probe -- no launch. The exit code is the contract; every machine
    // caller (the proxy resolver + cl/co/cx launchers) discards all output and reads only
    // it. The status line is purely for a human running `start --check` directly.
    const { up, port } = await proxyStatus();
    if (up) {
      consola.success(`proxy is running${port !== undefined ? ` on port ${port}` : ""}`);
    } else {
      consola.info("proxy is not running");
    }
    process.exitCode = up ? 0 : 1;
    return;
  }
  if (args.recordEvent) {
    // Record an activity heartbeat for the idle watchdog and return -- no launch. The
    // proxy resolver calls this on each token fetch so an open agent stays "active".
    new CopilotEnvRunState().set({ lastEnsureAt: Date.now() });
    return;
  }
  const paths = new CopilotApiPaths();
  const config = new CopilotApiConfig();

  const logFile = paths.logFile;
  const state = new CopilotEnvRunState();

  if (args.dryRun) {
    const port = await resolveStartPort(args.port, false);
    const statePid = state.read().pid;
    const trackedPid = statePid !== undefined && pidAlive(statePid) ? statePid : null;
    const orphans = (await getOrphanPids(process.pid, process.ppid)).filter(pidAlive);

    consola.info("DRY RUN: no proxy runtime changes will be made.");
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
    return;
  }

  // Hard floor gate (before touching the running daemon): the postinstall float
  // is best-effort, so never launch on a sub-floor proxy.
  assertProxyFloor();

  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.runDir, { recursive: true });
  applyDefaultConfig(config);
  consola.start("Cleaning up existing proxy processes ...");

  const tracked = state.read().pid;
  if (tracked !== undefined) {
    // Only signal it if it's still OUR daemon (guard against PID reuse).
    if (await isCopilotApiPid(tracked)) {
      consola.info(`   Stopping tracked proxy (pid=${tracked}) ...`);
      await terminatePid(tracked, 2000);
    }
    // Clear both pid and port up front: if the relaunch below throws, we don't
    // leave a stale port pointing at the now-dead daemon.
    state.set({ pid: null, port: null });
  }

  const myPid = process.pid;
  const myPpid = process.ppid;
  let orphans = await getOrphanPids(myPid, myPpid);
  if (orphans.length > 0) {
    for (const opid of orphans) {
      if (pidAlive(opid)) {
        consola.info(`   Stopping orphaned proxy (pid=${opid}) ...`);
        try {
          process.kill(opid, "SIGTERM");
        } catch {
          /* OSError */
        }
      }
    }
    await sleep(2000);
    orphans = await getOrphanPids(myPid, myPpid);
    for (const opid of orphans) {
      if (pidAlive(opid)) {
        try {
          process.kill(opid, "SIGKILL");
        } catch {
          /* OSError */
        }
      }
    }
  }

  await sleep(1000);

  let port = await resolveStartPort(args.port, true);

  fs.writeFileSync(logFile, "");
  const daemonEnv: Record<string, string> = { COPILOT_API_SQLITE_DB_PATH: paths.sqliteDb };
  // Feed the daemon the resolved credential -- the SAME resolution Direct uses
  // (`agent auth --get`), driven by the recorded provider (gh-cli -> `gh auth token`,
  // copilot/gh-token -> the stored token). Passing it as `--github-token` keeps the
  // proxy on our single source of truth (copilot-api uses it in-memory and won't
  // write its own github_token file).
  const credential = new Credential();
  let githubToken = credential.resolve() ?? undefined;
  if (githubToken === undefined && process.stdin.isTTY) {
    // Nothing resolved AND we have a terminal: log in (provider choice -> our store)
    // so the proxy stays on the single source. Errors out if login fails. Headless/CI
    // (no TTY) can't complete an interactive login, so skip and let the daemon handle
    // its own cold-start login (a fake proxy in tests just starts without a token).
    await ensureAuthenticated();
    githubToken = credential.resolve() ?? undefined;
  }
  // A PAT can't perform copilot-api's editor token exchange, so load the PAT passthrough
  // shim (it fakes the exchange, handing the PAT straight through as the Copilot token).
  // Precedence: config `passthrough` (on/off) > `auto` (shape-detect from the token). Set
  // it with `agent config --set passthrough on|off`. Only meaningful when a token resolved.
  const cfgPassthrough = new CopilotEnvConfig().read().passthrough;
  const forcePassthrough =
    cfgPassthrough === "on" ? true : cfgPassthrough === "off" ? false : undefined;
  const patPassthrough =
    githubToken !== undefined && usePatPassthrough({ force: forcePassthrough, token: githubToken });
  if (patPassthrough) {
    consola.info(
      "PAT passthrough on: faking the editor token exchange so the proxy uses the token directly.",
    );
  } else if (forcePassthrough === false) {
    consola.info("PAT passthrough off: using the standard editor token exchange.");
  }
  // Managed lifecycle on (the `auto-start` config key)? Preload the in-daemon idle watchdog
  // so the proxy stops itself after the idle window. It lives in the daemon process, so
  // the server and watchdog are one unit (no orphan either way), and every (re)start
  // re-attaches it. With the flag off, the proxy never auto-starts and gets no watchdog.
  const idleWatchdog = new CopilotEnvConfig().autoStartEnabled();
  let pid = launchDaemon(port, logFile, daemonEnv, githubToken, patPassthrough, idleWatchdog);

  await sleep(1000);
  if (!pidAlive(pid)) {
    let logContent = "";
    try {
      logContent = fs.readFileSync(logFile, "utf-8");
    } catch {
      logContent = "";
    }
    if (/address already in use|EADDRINUSE|bind.*failed/i.test(logContent)) {
      if (args.port !== undefined) {
        // Pinned port lost the race to another process: fail rather than moving.
        printLogTail(logFile, 20);
        throw new Error(
          `requested port ${port} was taken by another process just before launch. See ${logFile}`,
        );
      }
      consola.warn(
        `Port ${port} was taken by another process just before launch; retrying on a different port ...`,
      );
      try {
        port = await copilotApiFindPort(port + 1);
      } catch {
        throw new Error("could not find a free port after the retry.");
      }
      fs.writeFileSync(logFile, "");
      pid = launchDaemon(port, logFile, daemonEnv, githubToken, patPassthrough, idleWatchdog);
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

  // Seed the heartbeat so the in-daemon idle watchdog (preloaded above when idleWatchdog
  // is set) does not consider a freshly started, quiet proxy idle before its first request.
  if (idleWatchdog) state.set({ lastEnsureAt: Date.now() });

  // Blank the proxy's built-in extraPrompts now that config.json holds the
  // package's full default set. The setModelMappings POST below triggers the
  // daemon's reloadConfig(), which makes the blanked values take effect.
  disableExtraPrompts(config);

  const admin = new CopilotAdminClient({
    port,
    apiKey: config.ensureApiKey(),
    adminKey: config.ensureAdminApiKey(),
  });
  await syncModelAliases(admin);

  await logProxyVersion();
  // One message, one timestamp -- keeps the path block from interleaving.
  const summary: Array<[string, string]> = [
    ["Logs", logFile],
    ["PID", String(pid)],
    ["Port", String(port)],
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
  consola.log("");
  consola.box(
    [
      "Next steps",
      "",
      "  • Launch an agent:  `cl` (Claude) / `cx` (Codex) / `co` (Copilot)",
      "    …or run `claude` / `codex` directly.",
      "  • Install those launchers:  `agent shell --launchers`",
      "  • `agent cost` reports proxy usage  ·  `agent stop` stops the proxy.",
    ].join("\n"),
  );
}
