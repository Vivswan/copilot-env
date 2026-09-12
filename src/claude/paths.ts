// Dependency-light on purpose (node builtins plus the profile vocabulary) so any layer names the
// same files without importing the config writer in src/claude/config.ts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Profile } from "../copilot_api/profile.ts";

export const WIN = process.platform === "win32";

/** THE single reader of CLAUDE_CONFIG_DIR: claudeJsonPath (mcp_registration.ts) and
 *  resolveClaudeHome derive from it with different fallbacks. Resolved absolute because the
 *  web-search deny ownership record keys on the exact string, so a relative override must not drift
 *  with the cwd between a write and a later removal. */
export function claudeConfigDirOverride(): string | null {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== "" ? resolve(override) : null;
}

/** `$CLAUDE_CONFIG_DIR` is the single knob; there is no per-command override flag. */
export function resolveClaudeHome(): string {
  const override = claudeConfigDirOverride();
  if (override !== null) return override;
  // homedir() WITHOUT a HOME override, matching src/codex/paths.ts: on Windows homedir() is
  // %USERPROFILE%, where Claude Code reads, while HOME may be a Git-for-Windows/MSYS path;
  // diverging would put settings.json where Claude never looks. On POSIX homedir() already honors
  // $HOME.
  return join(homedir(), ".claude");
}

function profileSuffix(profile: Profile): string {
  return profile === null ? "" : `-${profile}`;
}

/** Launch a named profile with `claude --settings <this path>`; the `cl --profile <name>` launcher
 *  resolves it via `agent profile --settings-for <name>`. */
export function settingsPathFor(claudeHome: string, profile: Profile = null): string {
  return join(claudeHome, `settings${profileSuffix(profile)}.json`);
}
