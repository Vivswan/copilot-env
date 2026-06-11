// `agent start`: launches the proxy daemon, applies defaults, and syncs aliases.
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { CopilotAdminClient } from "../copilot_api/admin.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { generateAliases } from "../copilot_api/models.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import {
  COPILOT_API_PORT_DEFAULT,
  copilotApiFindPort,
  copilotApiPortAvailable,
} from "../copilot_api/port.ts";
import {
  getOrphanPids,
  isCopilotApiPid,
  launchDaemon,
  pidAlive,
  printLogTail,
} from "../copilot_api/process.ts";
import { CopilotApiState } from "../copilot_api/state.ts";
import {
  installedProxyVersion,
  PROXY_PACKAGE_NAME,
  proxyVersionFloorStatus,
} from "../copilot_api/version.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

// --- Default config applied on every `start`. ---
//
// String literals here are external contracts (config-file keys, copilot-api
// model ids). Do not change them during refactors.
//

const DEFAULT_SMALL_MODEL = "gpt-5.5";

const DEFAULT_FLAGS: Record<string, unknown> = {
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
};

export interface StartArgs {
  "dry-run"?: boolean;
  /** Pin the proxy to this port instead of auto-resolving (fails if busy). */
  port?: number;
}

function applyDefaultConfig(config: CopilotApiConfig): void {
  // These are static defaults the daemon reads from config.json at startup.
  // They have no admin REST endpoint, so they must be written to the file before
  // launch (unlike model aliases, which are pushed live via CopilotAdminClient).
  config.update((d) => {
    d.smallModel = DEFAULT_SMALL_MODEL;
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
 * is futile — the defaults always come back. Instead we blank every key the
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
      `Could not sync model aliases from catalog (${e instanceof Error ? e.message : String(e)}); check \`agent health\`.`,
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
    consola.warn(
      `Could not read live model mappings (${e instanceof Error ? e.message : String(e)}); check \`agent health\`.`,
    );
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
    // offline / slow registry — version alone is still useful
  }
  consola.info(`   Proxy: @jeffreycao/copilot-api ${version}${published}`);
}

/**
 * Refuse to launch on a proxy below the PROXY_MIN_VERSION floor. The float
 * (`bun install`'s postinstall) is best-effort, so an offline/failed install can
 * leave a sub-floor proxy in node_modules; the floor is a hard runtime contract,
 * so we enforce it here — **fail-closed** and before disturbing any running daemon.
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
    throw new Error(
      `could not read the proxy floor from copilot-env.config: ${e instanceof Error ? e.message : String(e)}`,
    );
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
  const paths = new CopilotApiPaths();
  const config = new CopilotApiConfig();

  const logFile = paths.logFile;
  const state = new CopilotApiState();

  if (args["dry-run"]) {
    let port: number;
    if (args.port !== undefined) {
      port = args.port;
    } else {
      port = Number(COPILOT_API_PORT_DEFAULT);
      if (!(await copilotApiPortAvailable(port))) {
        port = await copilotApiFindPort(port + 1);
      }
    }
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
      try {
        process.kill(tracked, "SIGTERM");
      } catch {
        /* OSError */
      }
      await sleep(2000);
      if (pidAlive(tracked)) {
        try {
          process.kill(tracked, "SIGKILL");
        } catch {
          /* OSError */
        }
      }
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

  let port = Number(COPILOT_API_PORT_DEFAULT);
  if (args.port !== undefined) {
    // Pinned port: use it as-is, but fail clearly rather than silently moving off
    // the port the user asked for.
    if (!(await copilotApiPortAvailable(args.port))) {
      throw new Error(
        `requested port ${args.port} is busy (held by another process). Free it or pick another --port.`,
      );
    }
    port = args.port;
  } else if (!(await copilotApiPortAvailable(port))) {
    consola.warn(`Port ${port} is busy (held by another process/user).`);
    try {
      port = await copilotApiFindPort(port + 1);
    } catch {
      throw new Error("could not find a free port to start the proxy.");
    }
    consola.success(`Using alternative port: ${port}`);
  }

  fs.writeFileSync(logFile, "");
  const daemonEnv: Record<string, string> = { COPILOT_API_SQLITE_DB_PATH: paths.sqliteDb };
  // A `--gh-token` provisioned into our state is passed to the daemon as
  // `--github-token` (in-memory only; never written to copilot-api's own login file).
  const githubToken = state.read().githubToken;
  let pid = launchDaemon(port, logFile, daemonEnv, githubToken);

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
      pid = launchDaemon(port, logFile, daemonEnv, githubToken);
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
  // One message, one timestamp — keeps the path block from interleaving.
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
      "  • Install those launchers:  `agent setup-launchers`",
      "  • `agent cost` reports proxy usage  ·  `agent stop` stops the proxy.",
    ].join("\n"),
  );
}
