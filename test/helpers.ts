// Not a test file (the `test` task collects only test/**/*.test.ts), so importing it registers
// nothing. Plain functions only: each test file keeps its own afterEach and calls these from it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProfileName } from "../src/copilot_api/profile.ts";
import { defaultDaemonHome } from "../src/copilot_api/paths.ts";
import { launchDaemon } from "../src/copilot_api/process.ts";
import { parseAbsolutePath } from "../src/copilot_api/sidecar.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../src/scripts/daemon_lock.ts";
import { releaseFileLock } from "../src/utils/file_lock.ts";
import { pidAlive } from "../src/utils/pid.ts";
import { denoRunArgs, ROOT, spawnChild } from "./helpers/run.ts";
import { removeDir, tempDir } from "./helpers/testing.ts";

// --- env snapshot / restore ---------------------------------------------------

// Every snapshot covers the whole union, so a file whose tests poke one key still restores the
// rest.
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

/** 0, not undefined: the runtime's exitCode setter may not clear on undefined, and a test's exit 1
 *  must not leak into the rest of the run. */
export function resetExitCode(): void {
  process.exitCode = 0;
}

// --- temp homes -----------------------------------------------------------------

function clearInheritedEnv(): void {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
  delete process.env.COPILOT_ENV_ROOT_HOME;
}

/** COPILOT_API_HOME only (the config, state, and credential stores all live under it); the caller
 *  removes the dir. */
export function isolateProxyHome(prefix: string): string {
  const dir = tempDir(prefix);
  process.env.COPILOT_API_HOME = dir;
  clearInheritedEnv();
  return dir;
}

/** Created on disk so hand-staged daemon.lock and run files land where proxyStatus,
 *  stopTrackedProxy, and the launch cleanup resolve them. */
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

/** The caller removes homes.dir. */
export function isolateAgentHomes(prefix: string, opts: { mkdirs?: boolean } = {}): AgentHomes {
  const dir = tempDir(prefix);
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
  /** The `auth` inline table (the managed proxy shape carries proxyTokenCommand()). */
  auth?: { command: string; args: readonly string[] };
}

/** A minimal stand-in for the writers' [model_providers.copilot-env] table. The optional fields are
 *  fixture knobs, not a mode's shape: both managed shapes (src/codex/config.ts) emit wire_api and
 *  an auth command, and neither emits env_key. */
export function codexConfigToml(opts: CodexConfigTomlOptions): string {
  const table = [`base_url = "${opts.baseUrl}"`];
  if (opts.envKey !== undefined) table.push(`env_key = "${opts.envKey}"`);
  if (opts.wireApi !== undefined) table.push(`wire_api = "${opts.wireApi}"`);
  if (opts.auth !== undefined) {
    // JSON string escapes are valid TOML basic-string escapes (Windows paths carry `\`).
    const args = opts.auth.args.map((a) => JSON.stringify(a)).join(", ");
    table.push(`auth = { command = ${JSON.stringify(opts.auth.command)}, args = [${args}] }`);
  }
  return ['model_provider = "copilot-env"', "", "[model_providers.copilot-env]", ...table, ""].join(
    "\n",
  );
}

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
  /** The shape our writer emits (2-space indent, trailing newline). */
  pretty?: boolean;
}

export function claudeSettingsJson(opts: ClaudeSettingsOptions): string {
  const doc: Record<string, unknown> = { "apiKeyHelper": opts.apiKeyHelper };
  if (opts.baseUrl !== undefined) doc.env = { "ANTHROPIC_BASE_URL": opts.baseUrl };
  Object.assign(doc, opts.extra);
  return opts.pretty ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}

export function writeClaudeSettings(claudeHome: string, opts: ClaudeSettingsOptions): string {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, "settings.json");
  writeFileSync(settingsPath, claudeSettingsJson(opts));
  return settingsPath;
}

export function writeRunState(
  patch: Parameters<CopilotEnvRunState["set"]>[0],
  profile?: ProfileName,
): void {
  const state = profile ? CopilotEnvRunState.forProfile(profile) : new CopilotEnvRunState();
  state.set(patch);
}

// --- live-daemon fixtures -------------------------------------------------------------

/** A real detached daemon over `home`, preloads included, so it takes the daemon.lock at boot like
 *  production. */
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

export async function until(deadlineMs: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe();
}

/** Throws if the pid survives: a daemon outliving its test would hold the temp home open into
 *  removeDir. */
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
 * The thrower mimics Deno's NotCapable (name "NotCapable", `code` undefined), what a permission set
 * without --allow-run really throws; test/pid.test.ts pins that shape. Inside `body` every
 * pidLiveness read is "unproven" and every signal fails as it does in the daemon.
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

/** "One line per written path" means this equals exactly the seam's one line: a narrative line
 *  beside it shows up here. */
export function linesNaming(text: string, path: string): string[] {
  return text.split("\n").filter((line) => line.includes(path));
}
