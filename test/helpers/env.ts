// The agent-state sandbox a test body sets up in THIS process: the env snapshot that restores
// every key a test may poke, the temp homes the readers resolve, and the one spelling of the
// five-key agent-home env a child or this process is pointed at.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultDaemonHome } from "../../src/copilot_api/paths.ts";
import { removeDir, tempDir } from "./testing.ts";

// --- env snapshot / restore ---------------------------------------------------

// Every snapshot covers the whole union, so a file whose tests poke one key still restores the
// rest.
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

// --- the agent-home env -------------------------------------------------------

interface AgentHomeEnv {
  HOME: string;
  /** node:os homedir() resolves from it on Windows, so HOME alone would leave every
   *  homedir()-based sweep pointed at the real profile there. */
  USERPROFILE: string;
  COPILOT_API_HOME: string;
  CLAUDE_CONFIG_DIR: string;
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
  Object.assign(process.env, agentHomeEnv(dir, homes));
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
