// PROJECT_ROOT discovery for launchers, tests, and installed release archives.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "../copilot_api/profile.ts";

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

/** `AGENT_AUTH_GET_ARGS` addressed at `profile` (null = the default credential). */
export function agentAuthGetArgs(profile: Profile = null): string[] {
  return profile === null
    ? [...AGENT_AUTH_GET_ARGS]
    : [...AGENT_AUTH_GET_ARGS, "--profile", profile];
}

/** The shared proxy-token scripts (ensure the proxy + print its key); .ps1 is the
 *  Windows parity. Referenced by Codex's `auth.command` and Claude's `apiKeyHelper`. */
export const PROXY_TOKEN_SCRIPT_SH: string = join(PROJECT_ROOT, "src", "scripts", "proxy-token.sh");
const PROXY_TOKEN_SCRIPT_PS1: string = join(PROJECT_ROOT, "src", "scripts", "proxy-token.ps1");

/** The proxy-token script arguments for the HEADLESS path at `profile`:
 *  `--yes` (never prompt), plus the profile selector when named. */
export function proxyTokenScriptArgs(profile: Profile = null): string[] {
  return profile === null ? ["--yes"] : ["--yes", "--profile", profile];
}

/**
 * The platform `{ command, args }` to run the shared proxy-token script as a NATIVE
 * subprocess (Codex's `auth.command`): `/bin/sh <script>.sh --yes` on POSIX,
 * `powershell -File <script>.ps1 --yes` on Windows. `--yes` selects the headless path
 * (never prompt) -- Codex/Claude run this on a timer and can't answer a prompt.
 * `profile` routes the resolver at that profile's daemon.
 */
export function proxyTokenCommand(profile: Profile = null): { command: string; args: string[] } {
  const scriptArgs = proxyTokenScriptArgs(profile);
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PROXY_TOKEN_SCRIPT_PS1,
        ...scriptArgs,
      ],
    };
  }
  return { command: "/bin/sh", args: [PROXY_TOKEN_SCRIPT_SH, ...scriptArgs] };
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
