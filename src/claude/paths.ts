// Claude Code path derivation: the Claude home, settings.json, and the managed
// apiKeyHelper script paths. Dependency-light on purpose (node builtins plus the
// dependency-free profile vocabulary) so any layer -- config writer, health,
// migrations, proxy-float -- can name the same files without importing the full
// config writer in src/claude/config.ts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Profile } from "../copilot_api/profile.ts";

export const WIN = process.platform === "win32";

// LEGACY helper file basenames. Pre-inline-apiKeyHelper releases wrote the managed
// resolver as a helper file at these names (a `.cmd` on Windows, where a `.sh` is not
// runnable by bare path); the current wiring stores an inline command instead and
// writes no files. The names live on ONLY for the reader tolerance in
// inspectClaudeWiring and for removal (uninstall / profile --del) -- delete them
// with that tolerance. A NAMED profile suffixes the stem (`copilot-token-work.sh`),
// keeping the default names (external contracts) byte-identical.
const HELPER_EXT = WIN ? "cmd" : "sh";
export const DIRECT_HELPER_NAME = WIN ? "copilot-token.cmd" : "copilot-token.sh";
export const PROXY_HELPER_NAME = WIN ? "copilot-proxy-token.cmd" : "copilot-proxy-token.sh";

/**
 * The `$CLAUDE_CONFIG_DIR` override (Claude Code's own knob), or null when
 * unset/empty. THE single reader of that env var: claudeJsonPath
 * (mcp_registration.ts, which imports this module) and resolveClaudeHome (below)
 * both derive from it, with different fallbacks. Resolved to an absolute path
 * because the web-search deny ownership record keys on the exact string, so a
 * relative override must not drift with the cwd between a write and a later
 * removal.
 */
export function claudeConfigDirOverride(): string | null {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== "" ? resolve(override) : null;
}

/**
 * Resolve the effective Claude home: `$CLAUDE_CONFIG_DIR` (Claude Code's own
 * override, via the shared claudeConfigDirOverride reader), else `~/.claude`
 * (`%USERPROFILE%\.claude` on Windows). This is the single knob -- there is no
 * per-command override flag.
 */
export function resolveClaudeHome(): string {
  const override = claudeConfigDirOverride();
  if (override !== null) return override;
  // Use homedir() WITHOUT a process.env.HOME override, matching the codex-side contract
  // (src/codex/paths.ts): on Windows homedir() is %USERPROFILE% (where Claude Code reads),
  // whereas HOME may be a Git-for-Windows/MSYS path -- the two must not diverge or `init`
  // writes settings.json where Claude never looks. On POSIX homedir() already honors $HOME.
  return join(homedir(), ".claude");
}

/** The profile's filename suffix: `""` for the default, `-<name>` for a named profile. */
function profileSuffix(profile: Profile): string {
  return profile === null ? "" : `-${profile}`;
}

/** `settings.json`, or `settings-<name>.json` for a named profile. Launch a named
 *  profile with `claude --settings <this path>` (the `cl --profile <name>` launcher
 *  resolves it via `agent profile --settings-for <name>`). */
export function settingsPathFor(claudeHome: string, profile: Profile = null): string {
  return join(claudeHome, `settings${profileSuffix(profile)}.json`);
}

/** Path of the LEGACY direct apiKeyHelper script for `profile` (tolerance/removal only). */
export function directHelperPath(claudeHome: string, profile: Profile = null): string {
  if (profile === null) return join(claudeHome, DIRECT_HELPER_NAME);
  return join(claudeHome, `copilot-token-${profile}.${HELPER_EXT}`);
}

/** Path of the LEGACY proxy apiKeyHelper script for `profile` (tolerance/removal only). */
export function proxyHelperPath(claudeHome: string, profile: Profile = null): string {
  if (profile === null) return join(claudeHome, PROXY_HELPER_NAME);
  return join(claudeHome, `copilot-proxy-token-${profile}.${HELPER_EXT}`);
}
