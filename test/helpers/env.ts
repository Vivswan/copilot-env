// The agent-state sandbox a test body sets up in THIS process: the env snapshot that restores
// every key a test may poke, the temp homes the readers resolve, and the one spelling of the
// five-key agent-home env a child or this process is pointed at.
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { forgetDiscoveryAnswers } from "../../src/copilot_api/discovery.ts";
import { defaultDaemonHome } from "../../src/copilot_api/paths.ts";
import { removeDir, tempDir } from "./testing.ts";

// --- env snapshot / restore ---------------------------------------------------

// Every snapshot covers the whole union: a file whose tests poke one key still restores the rest.
const TEST_ENV_KEYS = [
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

// The gh-token env precedence trio (GH_TOKEN_ENV_VARS); freshMachine says why isolation always clears it.
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

/** PATH with `dir` first: how a test puts a fixture shim ahead of the machine's own tools. */
export function pathLedBy(dir: string): string {
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

/** 0, not undefined: the runtime's exitCode setter may not clear on undefined, and a test's exit 1
 *  must not leak into the rest of the run. */
export function resetExitCode(): void {
  process.exitCode = 0;
}

// --- the agent-home env -------------------------------------------------------

interface AgentHomeEnv {
  /** What node:os homedir() resolves from on POSIX; the agent dot-directories default under it. */
  HOME: string;

  /** homedir() reads it on Windows, so HOME alone would leave every sweep on the real profile there. */
  USERPROFILE: string;

  /** The copilot-api home: the config, state, and credential stores; the home itself by default. */
  COPILOT_API_HOME: string;

  /** Where claude reads settings.json; `<home>/.claude` by default. */
  CLAUDE_CONFIG_DIR: string;

  /** Where codex reads config.toml; `<home>/.codex` by default. */
  CODEX_HOME: string;
}

interface AgentHomeLayout {
  proxyHome?: string;
  claudeHome?: string;
  codexHome?: string;
}

/** The five keys that point every agent-state reader at `home`, for this process or a child.
 *  The defaults are a real user home's layout (the copilot-api home IS the home, the agent homes
 *  its dot-directories); a fixture with another layout names it. */
export function agentHomeEnv(home: string, layout: AgentHomeLayout = {}): AgentHomeEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    COPILOT_API_HOME: layout.proxyHome ?? home,
    CLAUDE_CONFIG_DIR: layout.claudeHome ?? join(home, ".claude"),
    CODEX_HOME: layout.codexHome ?? join(home, ".codex"),
  };
}

// --- temp homes -----------------------------------------------------------------

/** A fresh home is a fresh machine: no inherited credential or root-home override, and none of
 *  the answers this process already got from Copilot (they go with the store). The credential
 *  trio always goes: COPILOT_GITHUB_TOKEN is FIRST in the gh-token env precedence, and a runner
 *  that exports any of the three could leak a real credential into "no token" tests and silently
 *  make them pass. */
function freshMachine(): void {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
  delete process.env.COPILOT_ENV_ROOT_HOME;
  forgetDiscoveryAnswers();
}

/** COPILOT_API_HOME only (the config, state, and credential stores all live under it); the caller
 *  removes the dir. */
export function isolateProxyHome(prefix: string): string {
  const dir = tempDir(prefix);
  process.env.COPILOT_API_HOME = dir;
  freshMachine();
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
  Object.assign(process.env, agentHomeEnv(dir, homes));
  freshMachine();
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
