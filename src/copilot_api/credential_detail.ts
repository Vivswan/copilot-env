import type { ProfileMode } from "./env_state.ts";
import { agentStartCommand, type Profile } from "./profile.ts";

/** The write-report clause for a baked static key. On the proxy no resolver command of ours runs
 *  on the agent's behalf, so the daemon is the user's to start and the clause names the command
 *  (and the agent's launcher, when it has one). */
export function staticKeyDetail(mode: ProfileMode, profile: Profile, launcher?: string): string {
  if (mode === "direct") return "static key";
  const via = launcher === undefined ? "" : `, or the ${launcher} launcher`;
  return `static key, start the proxy yourself (${agentStartCommand(profile)}${via})`;
}
