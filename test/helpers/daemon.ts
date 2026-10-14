// A live daemon and its neighbours as fixtures: the credential resolution `agent start` runs, a
// real detached fake daemon over a home, daemon-side children run the way the daemon runs (the
// running bun as a bun CLI, a shim under `--preload`), the waits that bound themselves by the test
// deadline, and the shared-home stop refusal.
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { abortable, delay } from "@std/async";
import {
  acquireDaemonLockForLife,
  daemonLockHolderPid,
  daemonLockPath,
} from "../../src/copilot_api/daemon_lock.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  daemonClientHeaders,
} from "../../src/copilot_api/integration_identity.ts";
import {
  type DaemonLaunchAuth,
  type LaunchCredentialDeps,
  readLaunchToken,
  resolveLaunchCredential,
} from "../../src/copilot_api/launch.ts";
import { resolveRootHome } from "../../src/copilot_api/paths.ts";
import { proxyPortFree } from "../../src/copilot_api/port.ts";
import { BUN_CLI_ENV, type DaemonCredential, launchDaemon } from "../../src/copilot_api/process.ts";
import type { Profile, ProfileName } from "../../src/copilot_api/profile.ts";
import { PROXY_PACKAGE_NAME } from "../../src/copilot_api/version.ts";
import { denoLockSidecarPath } from "../../src/migrations/legacy_daemon.ts";
import { proxyHome, proxyInstallDir, renderProxyManifest } from "../../src/proxy_float.ts";
import { releaseFileLock } from "../../src/utils/file_lock.ts";
import { pidAlive } from "../../src/utils/pid.ts";
import { writeRunState } from "./fixtures.ts";
import { freePort } from "./net.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  type RunOptions,
  runSync,
  spawnChild,
} from "./run.ts";
import { step, tempDir, testAbortSignal } from "./testing.ts";

/** `agent start`'s two credential steps as one call, the refusal gate and the resolution it feeds,
 *  so a decision table holds refusals and resolved credentials side by side (a refusal rejects). */
export async function launchAuth(
  profile: Profile,
  deps: LaunchCredentialDeps,
): Promise<DaemonLaunchAuth> {
  return await resolveLaunchCredential(
    profile,
    readLaunchToken(profile),
    new CopilotEnvConfig(),
    deps,
  );
}

/** Every daemon carries a credential and a host (a launch without one is refused); the fake proxy
 *  reads neither, so the spawn fixtures share one placeholder pair. */
export const FAKE_DAEMON_CREDENTIAL: DaemonCredential = {
  kind: "token",
  token: "gho_fake_daemon",
  clientHeaders: daemonClientHeaders("copilot-env-test/0", null),
};
export const FAKE_DAEMON_HOST = DEFAULT_COPILOT_API_BASE;

/** The fake proxy as a file entry under the resolved root home's proxy home, the shape
 *  COPILOT_API_ENTRY resolves to. */
export function fakeProxyEntry(): {
  kind: "file";
  path: string;
  proxyHome: string;
  nodeModules: string;
} {
  const rootHome = resolveRootHome();
  return {
    kind: "file",
    path: join(ROOT, "test", "copilot-api-fake.mjs"),
    proxyHome: proxyHome(rootHome),
    nodeModules: join(proxyInstallDir(rootHome), "node_modules"),
  };
}

/**
 * A complete install tree in `rootHome`'s proxy home, as a float leaves it: this build's manifest
 * for `version` (null: the shims-only tree), a lockfile, the proxy package's own manifest naming
 * its bin and that file, and every shim package's manifest. Returns the proxy's entry path.
 */
export function plantProxyInstall(rootHome: string, version: string | null): string {
  const dir = proxyInstallDir(rootHome);
  const manifest = renderProxyManifest(version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), manifest);
  writeFileSync(join(dir, "bun.lock"), "{}\n");
  const dependencies = (JSON.parse(manifest) as { dependencies: Record<string, string> })
    .dependencies;
  for (const [name, range] of Object.entries(dependencies)) {
    const packageDir = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name,
        version: name === PROXY_PACKAGE_NAME ? range : "0.0.0",
        bin: { "copilot-api": "./dist/main.js" },
      }),
    );
    writeFileSync(join(packageDir, "dist", "main.js"), "");
  }
  return join(dir, "node_modules", ...PROXY_PACKAGE_NAME.split("/"), "dist", "main.js");
}

/** A real detached daemon over `home`, preloads included, so it takes the daemon.lock at boot like
 *  production: the running bun spawned as the daemon's runtime. */
export function launchFakeDaemon(home: string, port: number): number {
  mkdirSync(home, { recursive: true });
  const logFile = join(home, "daemon.log");
  writeFileSync(logFile, "");
  return launchDaemon({
    port,
    logFile,
    home,
    env: {},
    credential: FAKE_DAEMON_CREDENTIAL,
    idleWatchdog: false,
    muteProxyLogs: false,
    copilotHost: FAKE_DAEMON_HOST,
    entry: fakeProxyEntry(),
  });
}

/**
 * Shaped so the owner-filtered scan (isDaemonProcess) classifies it as our daemon: bun running an
 * entry whose basename starts with `copilot-api`, `start` next on argv, and a `--preload` under
 * this root home's proxy home, the mark only our spawn leaves.
 *
 *   stdin: a pipe held until the decoy is gone -> the parent-exit preload exits on stdin's EOF, so
 *                                                 `ignore` would end the decoy before its entry ran
 *   stderr: inherited                          -> a child that dies says why in the run
 */
export function spawnDaemonShapedChild(
  entry: string,
  args: string[] = ["start"],
  env: Record<string, string> = {},
): Bun.Subprocess<"pipe", "ignore", "inherit"> {
  const preload = join(proxyHome(resolveRootHome()), "decoy_preload.ts");
  mkdirSync(join(preload, ".."), { recursive: true });
  writeFileSync(
    preload,
    `import ${JSON.stringify(pathToFileURL(join(ROOT, "test", "helpers", "exit_with_parent_preload.ts")).href)};\n`,
  );
  const child = spawnChild(process.execPath, {
    args: [...bunRunArgs("--preload", preload), entry, ...args],
    env: { ...env, ...BUN_CLI_ENV },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "inherit",
  });
  void child.exited.then(() => child.stdin.end());
  return child;
}

/** `source` written under a fresh temp dir and run with `--preload shim` ahead of it, the way the
 *  daemon launcher loads the shims; `args` follow the target on its argv. */
export function runWithPreload(
  shim: string,
  source: string,
  opts: RunOptions & { args?: string[] } = {},
): ReturnType<typeof runSync> {
  const target = join(tempDir("preload-target-"), "target.ts");
  writeFileSync(target, source);
  const { args = [], ...run } = opts;
  return runSync(process.execPath, [...bunRunArgs("--preload", shim), target, ...args], {
    ...run,
    env: { ...(run.env ?? process.env), ...BUN_CLI_ENV },
  });
}

/**
 * Resolves once `probe` answers true. No clock of its own: the test deadline is the one budget.
 * A pending probe or sleep rejects with the deadline's reason the moment it fires, so a `finally`
 * behind the wait runs before the runner can exit; a sync probe already true is still answered
 * after it, so an abandoned body's `finally` finishes the cleanup it can.
 */
export async function until(probe: () => boolean | Promise<boolean>): Promise<void> {
  const signal = testAbortSignal();
  if (signal === undefined) throw new Error("until: no test deadline to bound the wait");
  for (;;) {
    const answer = probe();
    if (typeof answer === "boolean" ? answer : await abortable(answer, signal)) return;
    await delay(50, { signal });
  }
}

/** Returns once the pid is gone: a daemon outliving its test would hold the temp home open into
 *  removeDir. */
export async function killAndAwaitExit(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await until(() => !pidAlive(pid));
}

/**
 * The thrower carries no errno `code`, the one shape pidLiveness (src/utils/pid.ts) reads as
 * "unproven" rather than alive or dead. Inside `body` every liveness read is "unproven" and every
 * signal fails, as they do for a daemon whose probe cannot run.
 */
export async function withUnprovablePidProbe(body: () => Promise<void>): Promise<void> {
  const realKill = process.kill;
  process.kill = ((_pid: number, _signal?: string | number): true => {
    throw new Error("the liveness probe cannot run");
  }) as typeof process.kill;
  try {
    await body();
  } finally {
    process.kill = realKill;
  }
}

// --- the refused-stop fixture -------------------------------------------------------

interface RefusedStopFixture {
  /** The live local pid the marker and run state both name (never a daemon). */
  bystanderPid: number;
  teardown: () => Promise<void>;
}

/**
 * The shared-home stop refusal; `home` must be `profile`'s effective home under the current env.
 *   this process holds home's daemon.lock (the remote host's daemon) -> the lock reads alive
 *   marker and slot run state name a live local bystander            -> the pid is uncorroborated
 *   stopTrackedProxy refuses with tracking kept  -> { signalled: false, stopped: false }
 */
export function stageRefusedStop(home: string, profile?: ProfileName): RefusedStopFixture {
  mkdirSync(home, { recursive: true });
  const script = join(home, "bystander.ts");
  writeFileSync(script, "setInterval(() => {}, 60_000);\n");
  const child = spawnChild(process.execPath, {
    args: [...bunRunArgs(), script],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!acquireDaemonLockForLife(home, { waitMs: 0 })) {
    throw new Error(`could not hold ${home}'s daemon.lock for the refused-stop fixture`);
  }
  writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
  writeRunState({ pid: child.pid, port: 4141 }, profile);
  return {
    bystanderPid: child.pid,
    teardown: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      // Our own lock first: the wait below can end with the deadline's error.
      releaseFileLock(daemonLockPath(home));
      await until(() => !pidAlive(child.pid));
    },
  };
}

// --- a lock holder of another process ---------------------------------------------------

/** A child holding each home's daemon.lock as a daemon does (the OS lock on the sidecar, the marker
 *  naming its pid): a plain bun (nothing of either release's daemon on its argv) or, with `daemon`,
 *  this release's daemon shape on `--port`. Returns once every lock reads held by it. */
export async function lockHoldingChild(
  root: string,
  homes: readonly string[],
  daemon: { port: number } | null = null,
): Promise<Bun.Subprocess> {
  const script = join(root, "copilot-api", "lock-holder.ts");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(
    script,
    `import { acquireDaemonLockForLife } from ${importSpecifier(
      join(ROOT, "src", "copilot_api", "daemon_lock.ts"),
    )};\n` +
      `for (const home of ${CHILD_VALUES}.homes) {\n` +
      "  if (!acquireDaemonLockForLife(home, { waitMs: 0 })) process.exit(1);\n" +
      "}\n" +
      "setInterval(() => {}, 60_000);\n",
  );
  const env = childValuesEnv({ homes });
  const child =
    daemon === null
      ? spawnChild(process.execPath, {
          args: [...bunRunArgs(), script],
          env,
          stdout: "ignore",
          stderr: "ignore",
        })
      : spawnDaemonShapedChild(script, ["start", "--port", String(daemon.port)], env);
  await until(() => homes.every((home) => daemonLockHolderPid(home) === child.pid));
  return child;
}

// --- the deno release's daemon --------------------------------------------------------

/** The modes a deno-era fixture runs in; each is one gap the migration must close. */
export interface DenoEraDaemonOptions {
  /** The marker's own timestamp; by default now, after the process started. */
  markerMs?: () => number;
  /** No `--port`, nothing listened on: the shape the step must not stop. */
  portless?: true;
  /** On SIGTERM unlinks the lock pair and keeps running: a hung shutdown. */
  dropsLockOnTerm?: true;
  /** On SIGTERM closes its listener and keeps running: the pid that stays behind stands in for
   *  a stranger the OS handed the dead daemon's pid. */
  closesOnTerm?: true;
  /** Ignores SIGTERM outright, lock and listener kept. */
  ignoresTerm?: true;
  /** `<root>/proxy/deno.json` on argv, as that release's `--config` put it (after `start` here:
   *  bun run exits on a `--config` of its own). */
  provenance?: true;
  /** The marker alone, as a lock this release's file lock wrote. */
  sidecar?: false;
}

export interface DenoEraDaemon {
  pid: number;
  port: number | null;
  teardown: () => Promise<void>;
}

/** The deno release's daemon as the migration meets it: this run's bun under the name `deno`, on
 *  that release's argv shape, holding `home`'s lock in the old form (the marker and the `.oslock`
 *  sidecar). A copy, not a link, except on Linux: macOS reports a linked executable's own name as
 *  ucomm, and a Windows link needs a privilege. */
export async function denoEraDaemon(
  root: string,
  home: string,
  opts: DenoEraDaemonOptions = {},
): Promise<DenoEraDaemon> {
  // Under its own directory: `<root>/deno` is the deno-era sidecar directory the step removes.
  const runtime = join(root, "runtime", process.platform === "win32" ? "deno.exe" : "deno");
  if (!existsSync(runtime)) {
    mkdirSync(join(runtime, ".."), { recursive: true });
    if (process.platform === "linux") symlinkSync(process.execPath, runtime);
    else copyFileSync(process.execPath, runtime);
  }
  const entry = join(root, "copilot-api", "daemon.ts");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(
    entry,
    'import { createServer } from "node:net";\n' +
      'import { rmSync } from "node:fs";\n' +
      "const flag = (name) => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };\n" +
      'const port = flag("--port");\n' +
      "const server = createServer((socket) => socket.destroy());\n" +
      'if (port !== null) server.listen(Number(port), "127.0.0.1");\n' +
      "setInterval(() => {}, 60_000);\n" +
      'if (process.argv.includes("--close-on-term")) process.on("SIGTERM", () => server.close());\n' +
      'if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => {});\n' +
      'const drop = flag("--drop-lock-on-term");\n' +
      'if (drop !== null) process.on("SIGTERM", () => { rmSync(drop, { force: true }); rmSync(drop + ".oslock", { force: true }); });\n',
  );
  const port = opts.portless ? null : await freePort();
  const config = join(root, "proxy", "deno.json");
  if (opts.provenance) {
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, "{}\n");
  }
  const child = spawnChild(runtime, {
    args: [
      ...bunRunArgs(),
      entry,
      "start",
      "--verbose",
      ...(port === null ? [] : ["--port", String(port)]),
      ...(opts.dropsLockOnTerm ? ["--drop-lock-on-term", daemonLockPath(home)] : []),
      ...(opts.closesOnTerm ? ["--close-on-term"] : []),
      ...(opts.ignoresTerm ? ["--ignore-term"] : []),
      ...(opts.provenance ? ["--config", config] : []),
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  step(`deno-era fixture ${home} listening`);
  if (port !== null) await until(async () => !(await proxyPortFree(port)));
  mkdirSync(home, { recursive: true });
  writeFileSync(daemonLockPath(home), `${child.pid}\n${(opts.markerMs ?? Date.now)()}\n`);
  if (opts.sidecar !== false) writeFileSync(denoLockSidecarPath(home), "");
  return { pid: child.pid, port, teardown: () => killAndAwaitExit(child.pid) };
}
