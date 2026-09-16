// How `agent health --live` starts each CLI: the corresponding launcher's start
// (src/commands/launch.ts) minus interactivity, so a pass or fail here is the one a `cl` / `cx`
// session would see. Direct DETECTION (src/agents/live_probe.ts) is the other intent: an isolated
// throwaway config, so a flag that isolates (`--bare`, a pinned model) belongs there and never here.
//
// The launcher also re-derives ANTHROPIC_BASE_URL / CODEX_HOME because its own wiring step may have
// just moved a port; health wires nothing, so the shell's exports are the real values and stay.
import { PROBE_PROMPT } from "../agents/live_probe.ts";
import { BASE_URL_ENV } from "../claude/config.ts";
import { settingsPathFor } from "../claude/paths.ts";
import type { Profile } from "../copilot_api/profile.ts";

/** The launcher's LaunchPlan shape plus the success postcondition; tests pin the composition
 *  without spawning. */
export interface LiveLaunch {
  cli: string;
  args: string[];
  /** Layered over the parent env, which is otherwise inherited whole. */
  env: Record<string, string>;
  /** Canonical UPPER-CASE names dropped from the child env. */
  omitEnv: readonly string[];
  /** Whether the captured stdout shows the model answered. Exit 0 alone is not that: with the
   *  user's real hooks running, a UserPromptSubmit hook that stops the prompt exits 0 after zero
   *  model turns. */
  answered: (stdout: string) => boolean;
}

type JsonEvent = Record<string, unknown>;

/** One JSON event per stdout line; a line that is not one (a hook's stray print) is skipped. */
function jsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) events.push(parsed as JsonEvent);
    } catch {
      // not an event line
    }
  }
  return events;
}

/** A NAMED profile drops a shell-exported ANTHROPIC_BASE_URL: env beats the profile's settings
 *  file, so a default-proxy export would silently answer for the profile and misattribute the
 *  result (the same scrub the `cl --profile` launcher performs). The default probe scrubs
 *  nothing: `--live` tests the real environment. */
export function claudeLiveOmitEnv(profile: Profile): readonly string[] {
  return profile === null ? [] : [BASE_URL_ENV];
}

/** The user's real Claude start (`cl`, `cl --profile`) as a one-shot `--print` in plan mode: the
 *  default discovers settings.json from CLAUDE_CONFIG_DIR exactly like a session, a named profile
 *  gets the launcher's `--settings` file; the saved model is under test, so none is pinned. */
export function claudeLiveLaunch(home: string, profile: Profile): LiveLaunch {
  return {
    cli: "claude",
    args: [
      ...(profile === null ? [] : ["--settings", settingsPathFor(home, profile)]),
      "--print",
      "--permission-mode",
      "plan",
      "--verbose",
      "--output-format",
      "stream-json",
      PROBE_PROMPT,
    ],
    // CLAUDE_CONFIG_DIR is never exported, not even as the default `home`: Claude namespaces its
    // keychain entry by that variable, so a shell without it would have a keychain-held key the
    // probe could no longer read. `home` is the same dir Claude resolves, so it serves only the
    // profile's settings path.
    env: {},
    omitEnv: claudeLiveOmitEnv(profile),
    // stream-json emits one `assistant` event per model message; a hook-stopped prompt emits none.
    answered: (stdout) => jsonEvents(stdout).some((e) => e.type === "assistant"),
  };
}

/** The user's real Codex start (`cx`, `cx --profile`) as `exec --json` in the read-only sandbox.
 *  `--skip-git-repo-check` answers the trust prompt an interactive session would, so the verdict
 *  cannot depend on the directory health was run from. */
export function codexLiveLaunch(home: string, profile: Profile): LiveLaunch {
  return {
    cli: "codex",
    args: [
      "exec",
      ...(profile === null ? [] : ["--profile", profile]),
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      PROBE_PROMPT,
    ],
    // The launcher's own pin: every inherited casing goes first (a Windows `Codex_Home` would
    // otherwise race the pinned value), then the home the writer resolved.
    env: { CODEX_HOME: home },
    omitEnv: ["CODEX_HOME"],
    // `exec --json` emits the answer as an `item.completed` event whose item is an `agent_message`.
    answered: (stdout) =>
      jsonEvents(stdout).some((e) => {
        const item = e.item;
        return e.type === "item.completed" && typeof item === "object" && item !== null &&
          (item as JsonEvent).type === "agent_message";
      }),
  };
}
