// Bun reads os.homedir() once at startup and keeps answering it after HOME changes, where node and
// deno re-read the variable on every call; a test harness that retargets HOME per test (and
// anything else that moves HOME at run time) would otherwise land every home-derived path in the
// real home. So every `~` in src/ resolves here, reading what node's own homedir() reads:
// USERPROFILE on Windows (where Codex and Claude Code read; HOME may be a Git-for-Windows path),
// HOME elsewhere, and the runtime's answer only when neither is set.
import { homedir } from "node:os";

export function userHomeDir(): string {
  const fromEnv = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return fromEnv || homedir();
}
