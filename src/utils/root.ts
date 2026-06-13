// PROJECT_ROOT discovery for launchers, tests, and installed release archives.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this module's own directory to the nearest ancestor holding a
 * package.json -- the project root, where node_modules lives. Robust to however
 * deep this file is nested (no fixed dirname() hop count), so moving it doesn't
 * break resolution. Bounded so a missing marker can't loop.
 */
function findProjectRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return start;
}

export const PROJECT_ROOT = findProjectRoot();

/** Absolute path to the POSIX `agent` launcher (bin/agent). */
const AGENT_LAUNCHER: string = join(PROJECT_ROOT, "bin", "agent");
/** Absolute path to the PowerShell `agent` launcher (bin/agent.ps1). */
const AGENT_LAUNCHER_PS1: string = join(PROJECT_ROOT, "bin", "agent.ps1");

/**
 * The argv for the credential resolver the agent Direct configs shell into. Single
 * source of truth so the WRITE sites (Codex `auth.command`, Claude apiKeyHelper) and
 * the health VERIFY site stay byte-identical -- if they drift, health stops
 * recognizing the very config the writer just wrote.
 */
export const AGENT_AUTH_GET_ARGS: readonly string[] = ["auth", "--get"];

/** The shared proxy-token scripts (ensure the proxy + print its key); .ps1 is the
 *  Windows parity. Referenced by Codex's `auth.command` and Claude's `apiKeyHelper`. */
export const PROXY_TOKEN_SCRIPT_SH: string = join(PROJECT_ROOT, "scripts", "proxy-token.sh");
const PROXY_TOKEN_SCRIPT_PS1: string = join(PROJECT_ROOT, "scripts", "proxy-token.ps1");

/**
 * The platform `{ command, args }` to run the shared proxy-token script as a NATIVE
 * subprocess (Codex's `auth.command`): `/bin/sh <script>.sh` on POSIX,
 * `powershell -File <script>.ps1` on Windows.
 */
export function proxyTokenCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROXY_TOKEN_SCRIPT_PS1],
    };
  }
  return { command: "/bin/sh", args: [PROXY_TOKEN_SCRIPT_SH] };
}

/**
 * The platform `{ command, args }` to invoke `agent <subArgs...>` as a NATIVE
 * subprocess -- i.e. spawned directly by another program (Codex's `auth.command`,
 * which the codex binary runs itself), not from inside a shell. On Windows the
 * bash launcher isn't directly executable, so go through PowerShell + the `.ps1`.
 */
export function agentLauncherCommand(subArgs: readonly string[]): {
  command: string;
  args: string[];
} {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", AGENT_LAUNCHER_PS1, ...subArgs],
    };
  }
  return { command: AGENT_LAUNCHER, args: [...subArgs] };
}
