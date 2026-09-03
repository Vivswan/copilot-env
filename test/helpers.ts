// Shared test harness + fixture builders for the suite. This is NOT a test
// file (the `test` task only collects test/**/*.test.ts names), so importing it
// never registers tests. Plain functions only -- each test file keeps its own
// afterEach and calls these from it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProfileName } from "../src/copilot_api/profile.ts";
import { defaultDaemonHome } from "../src/copilot_api/paths.ts";
import { launchDaemon } from "../src/copilot_api/process.ts";
import { parseAbsolutePath } from "../src/copilot_api/sidecar.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../src/scripts/daemon_lock.ts";
import { releaseFileLock } from "../src/utils/file_lock.ts";
import { pidAlive } from "../src/utils/pid.ts";
import { sleepSync } from "../src/utils/time.ts";
import { denoRunArgs, ROOT, spawnChild } from "./helpers/run.ts";

// --- env snapshot / restore ---------------------------------------------------

// The union of env vars the suite's isolation harnesses touch. Every snapshot
// covers the whole union, so a file whose own tests poke only one key still
// restores the rest -- including the GH-token trio, which most hand-rolled
// harnesses forgot to save.
export const TEST_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "COPILOT_API_HOME",
  "COPILOT_ENV_CI_RC_DIR",
  "COPILOT_ENV_CI_PS_DOCUMENTS_DIR",
  "COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR",
  "COPILOT_ENV_ROOT_HOME",
  "COPILOT_API_VERSION",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

// COPILOT_GITHUB_TOKEN is FIRST in the gh-token env precedence (GH_TOKEN_ENV_VARS);
// a runner that exports any of these could leak a real credential into "no token"
// tests and silently make them pass, so isolation always clears the trio.
const CREDENTIAL_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * Snapshot the standard env keys (plus any file-specific extras) at module load
 * and return a restore function for afterEach. The function is re-callable: it
 * always restores the values captured at snapshot time.
 */
export function envSnapshot(extraKeys: readonly string[] = []): () => void {
  const keys = [...TEST_ENV_KEYS, ...extraKeys];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Reset to 0 (an explicit known value, so a test's exit 1 can never leak into
 * the rest of the run through whatever the runtime's process.exitCode setter
 * does with undefined).
 */
export function resetExitCode(): void {
  process.exitCode = 0;
}

// --- temp homes -----------------------------------------------------------------

/** A fresh temp directory under the OS tmpdir (no env vars touched). */
export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * rmSync -rf a temp dir (no-op on ""); returns "" so callers can `dir = removeDir(dir)`.
 * Windows can hold a handle (antivirus, the indexer, a just-killed child's executable
 * image) briefly past process death, so transient failures retry with backoff -- same
 * philosophy as renameWithRetry (src/copilot_api/config.ts); the final attempt rethrows.
 */
export function removeDir(dir: string): "" {
  if (!dir) return "";
  const maxRetries = 9;
  for (let i = 0;; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return "";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTEMPTY: a delete-pending file inside surfaces as not-empty on the dir itself.
      const transient = code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
      if (i >= maxRetries || !transient) throw err;
      sleepSync(300);
    }
  }
}

function clearInheritedEnv(): void {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
  delete process.env.COPILOT_ENV_ROOT_HOME;
}

/**
 * Isolate the proxy stores only: a fresh temp dir becomes COPILOT_API_HOME
 * (config/state/credential stores all live under it). Returns the dir; the
 * caller owns cleanup via removeDir.
 */
export function isolateProxyHome(prefix: string): string {
  const dir = tmpDir(prefix);
  process.env.COPILOT_API_HOME = dir;
  clearInheritedEnv();
  return dir;
}

/**
 * The DEFAULT daemon's home under the current (isolated) root, created on
 * disk: `<root>/profiles/default` on a fresh root. Tests that stage a
 * daemon.lock or run files by hand use this so they land where the consult
 * sites (proxyStatus, stopTrackedProxy, the launch cleanup) resolve them.
 */
export function defaultHomeDir(): string {
  const home = defaultDaemonHome();
  mkdirSync(home, { recursive: true });
  return home;
}

export interface AgentHomes {
  dir: string;
  proxyHome: string;
  claudeHome: string;
  codexHome: string;
}

/**
 * Isolate everything an agent-wiring test can touch: HOME plus the proxy,
 * Claude, and Codex homes, all under one temp dir. Returns the paths; the
 * caller owns cleanup via removeDir(homes.dir).
 */
export function isolateAgentHomes(prefix: string, opts: { mkdirs?: boolean } = {}): AgentHomes {
  const dir = tmpDir(prefix);
  const homes: AgentHomes = {
    dir,
    proxyHome: join(dir, "proxy-home"),
    claudeHome: join(dir, ".claude"),
    codexHome: join(dir, ".codex"),
  };
  process.env.HOME = dir;
  // USERPROFILE too: node:os homedir() resolves from it on Windows, so HOME alone would
  // leave every homedir()-based sweep pointed at the real profile there.
  process.env.USERPROFILE = dir;
  process.env.COPILOT_API_HOME = homes.proxyHome;
  process.env.CLAUDE_CONFIG_DIR = homes.claudeHome;
  process.env.CODEX_HOME = homes.codexHome;
  clearInheritedEnv();
  if (opts.mkdirs) {
    try {
      for (const d of [homes.proxyHome, homes.claudeHome, homes.codexHome]) {
        mkdirSync(d, { recursive: true });
      }
    } catch (e) {
      removeDir(dir);
      throw e;
    }
  }
  return homes;
}

// --- fixture builders -------------------------------------------------------------

export interface CodexConfigTomlOptions {
  baseUrl: string;
  envKey?: string;
  wireApi?: string;
}

/**
 * The managed Codex config shape the writers emit: our provider selected, one
 * [model_providers.copilot-env] table. envKey/wireApi are included only when
 * given (the direct shape has neither).
 */
export function codexConfigToml(opts: CodexConfigTomlOptions): string {
  const table = [`base_url = "${opts.baseUrl}"`];
  if (opts.envKey !== undefined) table.push(`env_key = "${opts.envKey}"`);
  if (opts.wireApi !== undefined) table.push(`wire_api = "${opts.wireApi}"`);
  return ['model_provider = "copilot-env"', "", "[model_providers.copilot-env]", ...table, ""].join(
    "\n",
  );
}

/** Write the managed Codex config into codexHome (created if needed); returns its path. */
export function writeCodexConfigToml(codexHome: string, opts: CodexConfigTomlOptions): string {
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, codexConfigToml(opts));
  return configPath;
}

export interface ClaudeSettingsOptions {
  apiKeyHelper: string;
  baseUrl?: string;
  extra?: Record<string, unknown>;
  /** Pretty-print (2-space indent + trailing newline), the shape our writer emits. */
  pretty?: boolean;
}

/** A Claude settings.json document: apiKeyHelper, optional ANTHROPIC_BASE_URL env. */
export function claudeSettingsJson(opts: ClaudeSettingsOptions): string {
  const doc: Record<string, unknown> = { "apiKeyHelper": opts.apiKeyHelper };
  if (opts.baseUrl !== undefined) doc.env = { "ANTHROPIC_BASE_URL": opts.baseUrl };
  Object.assign(doc, opts.extra);
  return opts.pretty ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}

/** Write settings.json into claudeHome (created if needed); returns its path. */
export function writeClaudeSettings(claudeHome: string, opts: ClaudeSettingsOptions): string {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, "settings.json");
  writeFileSync(settingsPath, claudeSettingsJson(opts));
  return settingsPath;
}

/** Seed run state (the default slot, or a profile's) through the real store. */
export function writeRunState(
  patch: Parameters<CopilotEnvRunState["set"]>[0],
  profile?: ProfileName,
): void {
  const state = profile ? CopilotEnvRunState.forProfile(profile) : new CopilotEnvRunState();
  state.set(patch);
}

// --- live-daemon fixtures -------------------------------------------------------------

/** Launch the fake proxy as a real detached daemon over `home` (all preloads, so it takes
 *  `home`'s daemon.lock at boot exactly like a production daemon). */
export function launchFakeDaemon(home: string, port: number): number {
  mkdirSync(home, { recursive: true });
  const logFile = join(home, "daemon.log");
  writeFileSync(logFile, "");
  return launchDaemon({
    port,
    logFile,
    home,
    env: {},
    credential: { kind: "none" },
    idleWatchdog: false,
    muteProxyLogs: false,
    entry: {
      kind: "file",
      path: join(ROOT, "test", "copilot-api-fake.mjs"),
      configFile: join(ROOT, "deno.json"),
    },
    denoBin: parseAbsolutePath(Deno.execPath()),
  });
}

/** Poll `probe` until it holds or `deadlineMs` passes; returns the final reading. */
export async function until(deadlineMs: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe();
}

/** SIGKILL `pid` and wait until it is genuinely gone -- throws if it survives, so a daemon
 *  outliving its test (or holding the temp home open into removeDir) fails loudly. */
export async function killAndAwaitExit(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  if (!(await until(5_000, () => !pidAlive(pid)))) {
    throw new Error(`pid ${pid} did not exit after SIGKILL`);
  }
}

/**
 * Run `body` with process.kill replaced by a thrower mimicking Deno's NotCapable --
 * name "NotCapable", `code` undefined, which is what a permission set without
 * --allow-run (the daemon's own) really throws; the fidelity of that shape is pinned
 * by the restricted-subprocess control in test/pid.test.ts. Every pidLiveness read
 * inside `body` is therefore "unproven", and every signal send fails like it does in
 * the daemon. The real kill is restored on every exit path, so teardown (and every
 * later test) signals normally.
 */
export async function withUnprovablePidProbe(body: () => Promise<void>): Promise<void> {
  const realKill = process.kill;
  process.kill = ((_pid: number, _signal?: string | number): true => {
    throw Object.assign(new Error("Requires run access to signal processes"), {
      name: "NotCapable",
    });
  }) as typeof process.kill;
  try {
    await body();
  } finally {
    process.kill = realKill;
  }
}

// --- the refused-stop fixture -------------------------------------------------------

export interface RefusedStopFixture {
  /** The live local pid the marker and run state both name (never a daemon). */
  bystanderPid: number;
  /** Kill the bystander, wait out its exit, and release the held lock. */
  teardown: () => Promise<void>;
}

/**
 * Stage the shared-home stop REFUSAL for `home` (which must be the effective home of
 * `profile` under the current env): THIS test process holds home's daemon.lock --
 * standing in for the remote host's daemon, so the lock stays held through whatever
 * runs against it -- while the lock marker and the slot's run state both name a live
 * local bystander whose argv is nothing like a daemon. stopTrackedProxy then reads
 * lock-"alive" but cannot corroborate the pid, and refuses with tracking kept
 * ({ signalled: false, stopped: false }) -- the fixture every refusal-consumer pin
 * builds on.
 */
export function stageRefusedStop(home: string, profile?: ProfileName): RefusedStopFixture {
  mkdirSync(home, { recursive: true });
  const script = join(home, "bystander.ts");
  writeFileSync(script, "setInterval(() => {}, 60_000);\n");
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), script],
    stdout: "null",
    stderr: "null",
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
      const deadline = Date.now() + 5_000;
      while (pidAlive(child.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releaseFileLock(daemonLockPath(home));
    },
  };
}
