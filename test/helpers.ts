// Shared test harness + fixture builders for the suite. This is NOT a test
// file (bun's runner only collects *.test.* / *.spec.* names), so importing it
// never registers tests. Plain functions only -- each test file keeps its own
// afterEach and calls these from it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";

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
 * Reset to 0 (NOT undefined -- bun's process.exitCode setter ignores undefined
 * and keeps the last value, which would leak a test's exit 1 into the whole
 * `bun test` run).
 */
export function resetExitCode(): void {
  process.exitCode = 0;
}

// --- temp homes -----------------------------------------------------------------

/** A fresh temp directory under the OS tmpdir (no env vars touched). */
export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** rmSync -rf a temp dir (no-op on ""); returns "" so callers can `dir = removeDir(dir)`. */
export function removeDir(dir: string): "" {
  if (dir) rmSync(dir, { recursive: true, force: true });
  return "";
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
