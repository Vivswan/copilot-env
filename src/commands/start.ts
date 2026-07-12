// `agent start`: launches the proxy daemon, applies defaults, and syncs aliases.
import * as fs from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { CopilotAdminClient } from "../copilot_api/admin.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig, projectedProxyConfig } from "../copilot_api/env_config.ts";
import type { AuthProvider } from "../copilot_api/env_state.ts";
import { generateAliases } from "../copilot_api/models.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import {
  copilotApiFindPort,
  copilotApiPortAvailable,
  defaultProxyPort,
  maxProxyPort,
  minProxyPort,
  proxyPortInRange,
} from "../copilot_api/port.ts";
import {
  classifyDaemonPid,
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
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { errMessage } from "../utils/error.ts";
import { releaseFileLock, tryAcquireFileLock } from "../utils/file_lock.ts";
import { isRecord } from "../utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { formatDuration } from "../utils/time.ts";
import { ensureAuthenticated } from "./auth.ts";

// The launch critical section (orphan sweep + spawn + readiness wait) is serialized by a start
// lock so two concurrent `agent start` (e.g. two agents auto-starting at once) don't each reap
// the OTHER's freshly launched daemon. The lock reclaims ONLY a DEAD holder (staleMs = Infinity),
// never age-stealing a live launcher -- a start may legitimately hold it for minutes while it
// prompts for interactive auth, and stealing it then would let the waiter kill its daemon.
const START_LOCK_RETRY_MS = 250;

/** Wait UNBOUNDED for the start lock: a live holder is waited out (it releases when done), and a
 *  crashed holder is reclaimed (dead pid), so this always terminates -- and never proceeds
 *  unlocked, which could let a waiter reap the holder's daemon. Emits a one-time notice once the
 *  wait is noticeable. */
async function acquireStartLock(lockPath: string): Promise<void> {
  const started = Date.now();
  let noticed = false;
  while (!tryAcquireFileLock(lockPath, Number.POSITIVE_INFINITY)) {
    if (!noticed && Date.now() - started > 2000) {
      consola.info("Another `agent start` is in progress; waiting for it to finish ...");
      noticed = true;
    }
    await sleep(START_LOCK_RETRY_MS);
  }
}

// --- Default config applied on every `start`. ---
//
// String literals here are external contracts (config-file keys, copilot-api
// model ids). Do not change them during refactors.
//

/**
 * Whether a GitHub token is a Personal Access Token by its prefix: `ghp_` (classic)
 * or `github_pat_` (fine-grained). PATs cannot perform copilot-api's editor token
 * exchange (`copilot_internal/v2/token` -> 403), so they need the passthrough shim.
 * (gh OAuth tokens, `gho_`, also can't exchange -- 404 -- but that decision lives in
 * `usePatPassthrough`, not here.) Legacy unprefixed 40-hex classic PATs are NOT detected
 * here -- use `config passthrough on` for those.
 */
export function isPatToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("ghp_") || t.startsWith("github_pat_");
}

/**
 * Whether to load the PAT-passthrough preload shim into the daemon
 * (`src/scripts/pat_passthrough_preload.ts`). The shim intercepts copilot-api's
 * editor token exchange and hands the token back as the Copilot token, so the daemon
 * runs its normal `vscode-chat` path with the token as the bearer -- the only way a
 * credential that can't perform the exchange works through the proxy. Two such credentials:
 * a PAT (`ghp_`/`github_pat_`, 403s the exchange) and a `gh-cli` OAuth token (404s the
 * exchange) -- both are nonetheless accepted DIRECTLY as the Copilot bearer under vscode-chat.
 * It's a no-op for tokens the exchange accepts (the `copilot` device-flow token), so the
 * `passthrough` config key (`on`) can force it for an undetected credential and `off` forces it off.
 *
 * Precedence: an explicit `force` (resolved by the caller from the `passthrough` config:
 * on -> true, off -> false) wins; otherwise (`auto`/unset) auto-enable for the `gh-cli` provider
 * or a PAT-shaped token.
 */
export function usePatPassthrough(opts: {
  force: boolean | undefined;
  token: string | undefined;
  provider?: AuthProvider | null;
}): boolean {
  if (opts.token === undefined) return false; // no token resolved -> the shim is a no-op anyway
  if (opts.force !== undefined) return opts.force;
  // The device-flow `copilot` token CAN perform the editor token exchange (and rotate the
  // short-lived Copilot token), so never shim it -- regardless of shape. A PAT, a gh-cli login,
  // or any `gho_` GitHub-OAuth token (e.g. a gh token pasted via gh-token) CANNOT perform the
  // exchange (403/404) but ARE accepted directly as the Copilot bearer under vscode-chat, so they
  // need the passthrough.
  if (opts.provider === "copilot") return false;
  if (opts.provider === "gh-cli") return true;
  return isPatToken(opts.token) || opts.token.startsWith("gho_");
}

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
  /**
   * `--force`: launch a fresh daemon even when a healthy one is already running. Only relevant in
   * the managed lifecycle (auto-start on), where a plain `start` is otherwise an idempotent no-op
   * that leaves the running proxy up; in the unmanaged/default mode `start` always (re)starts. Use
   * `--force` after changing the credential or a config key the daemon reads at startup (port,
   * small-model, passthrough, proxy-logs).
   */
  force?: boolean;
}

// Whether OUR proxy is genuinely up (and on which recorded port): the tracked, alive
// copilot-api pid AND the port it actually recorded both confirm it. Reading pid AND port
// from the SAME run-state snapshot ties the probe to the daemon's real listening port -- so
// a moved port (start chose a different one) or a stranger on the default port can't produce
// a false result, and the returned port matches what was probed.
async function proxyStatus(): Promise<{ up: boolean; port?: number }> {
  const { pid, port } = new CopilotEnvRunState().read();
  if (pid === undefined || !pidAlive(pid)) {
    return { up: false };
  }
  // PID-reuse guard, but liveness-safe: only a CONFIDENT "no" (the recorded pid is gone or is a
  // different, identifiable process) rules the proxy out. "unknown" -- the caller's token can't
  // read the pid's command line, as in Codex's packaged/sandboxed app where WMI is unavailable --
  // falls back to probing OUR recorded pid+port, so a healthy proxy isn't false-reported as down.
  if ((await classifyDaemonPid(pid)) === "no") {
    return { up: false };
  }
  const probePort = port ?? defaultProxyPort();
  return { up: await portListening(probePort), port };
}

// A raw TCP-connect liveness probe. It opens (and immediately closes) a loopback socket to
// confirm the daemon is accepting connections WITHOUT sending an HTTP request -- so `--check`
// (run by an open agent's resolver, a monitor, etc.) leaves no trace in the daemon access log.
// The idle watchdog keys off the daemon's inbound-request observer (inference POSTs only),
// not this access log, so a liveness ping never resets the idle clock regardless; a bare
// connect still keeps the access log clean and returns faster than an HTTP round-trip.
// Probes IPv4 and IPv6 loopback
// CONCURRENTLY and settles on the FIRST success (so a healthy proxy returns immediately,
// mirroring fetch's localhost happy-eyeballs) -- only a both-fail result waits, and at most one
// timeout, never two serial.
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
  return new Promise((resolve) => {
    let remaining = 2;
    for (const host of ["127.0.0.1", "::1"]) {
      void tryHost(host).then((ok) => {
        if (ok)
          resolve(true); // first success wins; later resolve() calls are no-ops
        else if (--remaining === 0) resolve(false); // both failed
      });
    }
  });
}

/** An actionable hint when the daemon died because the credential could not be exchanged for a
 *  Copilot token (the daemon logs "Failed to get Copilot token" on a 404/403). A gh-cli/PAT
 *  credential needs the passthrough; anything else needs a Copilot-capable login. */
function copilotTokenFailureHint(log: string): string | null {
  if (!/Failed to get Copilot token/i.test(log)) return null;
  return (
    "The credential was not accepted by Copilot's token exchange. For a gh-cli or PAT credential, " +
    "enable passthrough (`agent config --set passthrough on`); otherwise re-authenticate with a " +
    "Copilot-capable login (`agent auth --provider copilot`)."
  );
}

function applyDefaultConfig(config: CopilotApiConfig): void {
  // Project copilot-env's tunable proxy preferences (CONFIG_REGISTRY entries with a
  // proxyDefault) into the daemon's config.json before launch. These are static defaults the
  // daemon reads at startup and have no admin REST endpoint, so they must be written to the
  // file here (unlike model aliases, pushed live via CopilotAdminClient). Unset preferences
  // fall back to each key's built-in proxy default, so behavior is unchanged by default.
  config.update((d) => Object.assign(d, projectedProxyConfig()));
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
  const min = minProxyPort();
  const max = maxProxyPort();
  if (min > max) {
    throw new Error(
      `invalid port range: min-port (${min}) is greater than max-port (${max}); fix it with \`agent config --set min-port <n>\` / \`--set max-port <n>\`.`,
    );
  }
  if (pinned !== undefined) {
    if (!proxyPortInRange(pinned)) {
      // Distinguish "outside the allowed range" from "busy" -- different problems.
      throw new Error(
        `requested port ${pinned} is out of range; the proxy port must be between ${min} and ${max} (\`agent config --set min-port/max-port\` to change the range).`,
      );
    }
    if (!(await copilotApiPortAvailable(pinned))) {
      throw new Error(
        `requested port ${pinned} is busy (held by another process). Free it or pick another --port.`,
      );
    }
    return pinned;
  }
  // No hard `--port` pin: the auto-resolve base is the default proxy port (config `port`,
  // else the built-in 4141) -- a SOFT default that moves to the next free port if busy,
  // unless `strict-port` is set (then a busy default is fatal, no auto-increment).
  const def = defaultProxyPort();
  if (!proxyPortInRange(def)) {
    throw new Error(
      `configured port ${def} is outside the allowed range ${min}-${max}; run \`agent config --set port <n>\` within the range, or adjust min-port/max-port.`,
    );
  }
  if (await copilotApiPortAvailable(def)) return def;
  if (new CopilotEnvConfig().read().strictPort === true) {
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

/**
 * The cheap (sync) part of the managed-lifecycle "leave a running proxy up" gate, shared by
 * the dry-run and live paths: only a no-op candidate when the lifecycle is managed AND this is
 * not a forced or explicitly-ported (re)launch. The caller still confirms the proxy is actually
 * up via `proxyStatus()` before short-circuiting.
 */
function isIdempotentNoOp(args: StartArgs): boolean {
  return !args.force && args.port === undefined && new CopilotEnvConfig().autoStartEnabled();
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
    if (isIdempotentNoOp(args) && (await proxyStatus()).up) {
      consola.info(
        "DRY RUN: proxy already running (managed lifecycle); would leave it up. --force forces one.",
      );
      return;
    }
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

  // Idempotent ONLY in the managed lifecycle (auto-start on): there the proxy is auto-started by
  // the resolver and auto-stopped by the watchdog, so a redundant manual `start` should leave the
  // running daemon (and any connected Codex/Claude) untouched rather than tearing it down and
  // relaunching. In the unmanaged/default mode the user drives start/stop by hand, so `start` stays
  // an explicit (re)start. Bump the heartbeat (a manual start is a keep-alive vs the idle watchdog).
  // `--force` launches a fresh daemon either way (e.g. after a credential/config change), and an
  // explicit `--port` is a reconfiguration request, so it always (re)launches rather than no-op'ing.
  if (isIdempotentNoOp(args)) {
    const { up, port: livePort } = await proxyStatus();
    if (up) {
      state.set({ lastEnsureAt: Date.now() });
      consola.success(
        `Proxy already running${livePort !== undefined ? ` on port ${livePort}` : ""} — leaving it up.`,
      );
      consola.info(
        "Run `agent start --force` to launch a fresh daemon (e.g. after a credential or config change).",
      );
      return;
    }
  }

  // Serialize the launch critical section (orphan sweep + spawn + readiness wait): two
  // concurrent `agent start` would otherwise each reap the OTHER's freshly launched daemon.
  // The run dir holds the lock; ensure it exists first. After acquiring, RE-CHECK the
  // idempotent no-op, since a start we waited on may have just brought the proxy up.
  fs.mkdirSync(paths.runDir, { recursive: true });
  const startLockPath = join(paths.runDir, ".start.lock");
  await acquireStartLock(startLockPath);
  try {
    if (isIdempotentNoOp(args)) {
      const { up, port: livePort } = await proxyStatus();
      if (up) {
        state.set({ lastEnsureAt: Date.now() });
        consola.success(
          `Proxy already running${livePort !== undefined ? ` on port ${livePort}` : ""} — leaving it up.`,
        );
        consola.info(
          "Run `agent start --force` to launch a fresh daemon (e.g. after a credential or config change).",
        );
        return;
      }
    }

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
    // A gh-cli OAuth token or a PAT can't perform copilot-api's editor token exchange, so load the
    // passthrough shim (it fakes the exchange, handing the token straight through as the Copilot
    // bearer). Precedence: config `passthrough` (on/off) > `auto` (gh-cli provider or PAT shape).
    // Set it with `agent config --set passthrough on|off`. Only meaningful when a token resolved.
    const cfgPassthrough = new CopilotEnvConfig().read().passthrough;
    const forcePassthrough =
      cfgPassthrough === "on" ? true : cfgPassthrough === "off" ? false : undefined;
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
    // Managed lifecycle on (the `auto-start` config key)? Preload the in-daemon idle watchdog
    // so the proxy stops itself after the idle window. It lives in the daemon process, so
    // the server and watchdog are one unit (no orphan either way), and every (re)start
    // re-attaches it. With the flag off, the proxy never auto-starts and gets no watchdog.
    const idleWatchdog = new CopilotEnvConfig().autoStartEnabled();
    // `proxy-logs false` mutes the daemon's verbose handler logs: a preload shim discards the
    // writes under <home>/logs. Activity detection is unaffected -- the always-loaded inference
    // observer watches inbound requests, not log files.
    const muteProxyLogs = new CopilotEnvConfig().read().proxyLogs === false;
    if (muteProxyLogs) {
      consola.info("Proxy request logs off: discarding writes under <home>/logs (`proxy-logs`).");
    }
    let pid = launchDaemon(
      port,
      logFile,
      daemonEnv,
      githubToken,
      patPassthrough,
      idleWatchdog,
      muteProxyLogs,
    );

    await sleep(1000);
    if (!pidAlive(pid)) {
      let logContent = "";
      try {
        logContent = fs.readFileSync(logFile, "utf-8");
      } catch {
        logContent = "";
      }
      if (/address already in use|EADDRINUSE|bind.*failed/i.test(logContent)) {
        const strictPort = new CopilotEnvConfig().read().strictPort === true;
        if (args.port !== undefined || strictPort) {
          // A pinned port -- or any port under strict-port -- that loses the race fails rather
          // than silently moving to a different port.
          printLogTail(logFile, 20);
          throw new Error(
            `port ${port} was taken by another process just before launch` +
              `${strictPort && args.port === undefined ? " (strict-port is on, so no auto-increment)" : ""}. See ${logFile}`,
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
        pid = launchDaemon(
          port,
          logFile,
          daemonEnv,
          githubToken,
          patPassthrough,
          idleWatchdog,
          muteProxyLogs,
        );
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
        const hint = copilotTokenFailureHint(logContent);
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
          const hint = copilotTokenFailureHint(fs.readFileSync(logFile, "utf-8"));
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

    // Seed the heartbeat so the in-daemon idle watchdog (preloaded above when idleWatchdog
    // is set) does not consider a freshly started, quiet proxy idle before its first request.
    // Also surface the auto-stop behavior, since a manual `start` arms the same watchdog and
    // the proxy will exit on its own later -- silence here is a surprise (see `agent config`).
    if (idleWatchdog) {
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
  } finally {
    releaseFileLock(startLockPath);
  }
}
