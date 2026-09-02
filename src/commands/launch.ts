// `agent launch <claude|codex|copilot>`: launch an agent CLI with the managed
// flag set, provider wiring, and child environment -- the TypeScript home of the
// logic the retired shell/agents.launchers rc pair carried, so the `agent env`-
// emitted cl/co/cx one-liners on both platforms share ONE implementation.
//
// A default launch reads the CONFIGURED provider in-process (the inspect
// functions behind `agent <name> --check`; no live probe); proxy/none ensures the
// proxy FIRST (a cold start may move the port), then re-syncs the wiring. A
// `--profile` launch never rewires the profile and hard-fails on an unknown or
// credential-less one. The child env is composed here rather than inherited
// blindly: the rc launchers relied on the `agent` wrapper's env refresh between
// wiring and exec, which an in-process launch no longer has (managedClaudeBaseUrl
// / managedCodexHome, shared with `agent env`, give the set/clear/leave verdicts).
//
// Neither deno nor node exposes an execve-style process replacement, so every
// platform launches the agent as a child with inherited stdio and passes its
// exit code (or 128+signal) through.
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { resolveAndPersistDirectIdentity, wireBothAgents } from "../agents/profile_wiring.ts";
import type { AgentProviderMode } from "../agents/provider_mode.ts";
import { readAgentModes } from "../agents/wiring.ts";
import { BASE_URL_ENV, configureClaudeConfig, runClaude } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { runCodex } from "../codex/config.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import {
  parseProfileFlag,
  parseProfileName,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { childEnvWithPath, commandExists, verbatimCliSpawn } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { managedClaudeBaseUrl, managedCodexHome, type ManagedEnvValue } from "./env.ts";
import {
  type LaunchOutput,
  type ProxyTokenDeps,
  readStartAnswer,
  resolveProxyToken,
} from "./proxy_token.ts";

/** The agent CLIs `agent launch` can start (also each one's command name). */
const LAUNCH_CLIS = ["claude", "codex", "copilot"] as const;
type LaunchCliName = (typeof LAUNCH_CLIS)[number];

/** Raw `agent launch` inputs, parsed at the CLI boundary into a LaunchAction. */
export interface LaunchFlags {
  cli: string;
  /** Pass-through args (everything after `--`), handed to the agent CLI verbatim
   *  once a leading `--profile <name>` pair is hoisted (claude/codex only). */
  args: string[];
  profile?: string;
  relaxed?: boolean;
}

/**
 * What ONE `agent launch` invocation does. Copilot's arm carries no profile:
 * profiles wire Codex and Claude, so a copilot profile launch is unrepresentable
 * rather than silently ignored.
 */
export type LaunchAction =
  | { kind: "claude"; profile: Profile; relaxed: boolean; args: string[] }
  | { kind: "codex"; profile: Profile; relaxed: boolean; args: string[] }
  | { kind: "copilot"; relaxed: boolean; args: string[] };

/** Parse the raw `agent launch` flags into a LaunchAction (the CLI boundary). */
export function parseLaunchAction(flags: LaunchFlags): LaunchAction {
  if (!(LAUNCH_CLIS as readonly string[]).includes(flags.cli)) {
    throw new Error(`unknown agent CLI '${flags.cli}' (expected claude | codex | copilot)`);
  }
  const cli = flags.cli as LaunchCliName;
  const relaxed = Boolean(flags.relaxed);
  let profile = parseProfileFlag(flags.profile);
  let args = [...flags.args];
  // The rc-launcher contract: cl/cx recognized `--profile <name>` as the LEADING
  // pass-through pair only, so `cl --profile work ...` keeps working through the
  // one-line wrappers. An explicit --profile flag wins; the pair then rides
  // through to the agent CLI untouched (the launchers only ever hoisted one).
  // co never hoisted -- a leading pair passes through to copilot itself.
  if (cli !== "copilot" && profile === null && args[0] === "--profile" && args[1]) {
    profile = parseProfileName(args[1]);
    args = args.slice(2);
  }
  if (cli === "copilot") {
    if (profile !== null) {
      throw new Error("--profile does not apply to copilot (profiles wire Codex and Claude)");
    }
    return { kind: "copilot", relaxed, args };
  }
  return { kind: cli, profile, relaxed, args };
}

/** The resolved child invocation: command, argv, and the env deltas to apply on
 *  top of the inherited environment. Pure data, so tests assert composition
 *  without spawning an agent. */
export interface LaunchPlan {
  command: LaunchCliName;
  args: string[];
  /** Vars set for the child. */
  env: Record<string, string>;
  /** Vars removed from the inherited environment (canonical UPPER-CASE names). */
  scrub: string[];
}

/**
 * The launch orchestration's effects, injectable so prepareLaunch is unit-testable
 * without daemons or config writes (the seam mirrors ProxyTokenDeps).
 */
export interface LaunchDeps {
  /** The CONFIGURED provider of the agent's default selection (no live probe). */
  agentMode(agent: "claude" | "codex"): AgentProviderMode;
  /** Ensure `profile`'s proxy daemon is reachable (the interactive resolver:
   *  managed auto-start, else a prompt). False = launch must abort. */
  ensureProxy(profile: Profile): Promise<boolean>;
  /** Re-sync the agent's DEFAULT wiring to the proxy (`agent <name> --proxy`). */
  wireProxyDefault(agent: "claude" | "codex"): Promise<void>;
  /** The named profile's store slot -- the source of truth for its mode/credential. */
  profileSlot(name: ProfileName): { mode: ProfileMode | null; authProvider: string | null };
  /** Re-sync the profile's Claude settings file against the live port and return
   *  its absolute path (what `claude --settings` gets). */
  writeClaudeProfileSettings(name: ProfileName, mode: ProfileMode): Promise<string>;
  /** Refresh the profile's wiring (both agents) against the live ports. */
  syncProfileWiring(name: ProfileName, mode: ProfileMode): Promise<void>;
  managedClaudeBaseUrl(profile: Profile): ManagedEnvValue;
  managedCodexHome(): ManagedEnvValue;
  /** A human-facing stderr line (stdout belongs to the launched agent). */
  notify(line: string): void;
}

/** The managed Claude flag set, stated ONCE (both the default and profile arms). */
const CLAUDE_MANAGED_FLAGS = ["--permission-mode", "auto", "--enable-auto-mode"] as const;

/** Fold a managed set/clear/leave verdict into the plan's env deltas. */
function applyManagedEnv(plan: LaunchPlan, key: string, value: ManagedEnvValue): void {
  if (value === null) return;
  if ("unset" in value) plan.scrub.push(key);
  else plan.env[key] = value.value;
}

/**
 * Ensure a NAMED profile is launchable and return its mode: it must exist with a
 * credential (hard-fail -- named profiles never fall back to the default), and a
 * proxy profile's own daemon must be reachable (null = the resolver said no and
 * already explained itself on stderr).
 */
async function ensureProfileReady(
  name: ProfileName,
  deps: LaunchDeps,
): Promise<ProfileMode | null> {
  const slot = deps.profileSlot(name);
  if (slot.mode === null) {
    throw new Error(
      `${
        profileLabel(name)
      } does not exist - create it with \`agent profile --add ${name} --direct|--proxy\``,
    );
  }
  if (slot.authProvider === null) {
    throw new Error(
      `${profileLabel(name)} has no credential - repair it with \`agent auth --profile ${name}\` ` +
        `or \`agent profile --add ${name}\``,
    );
  }
  if (slot.mode === "proxy" && !(await deps.ensureProxy(name))) return null;
  return slot.mode;
}

/**
 * Sync the default selection's provider before launch, mirroring the rc
 * launchers' _copilot_wire_provider: proxy/none ensures the proxy THEN re-syncs
 * the wiring (a cold start may have moved the port); "other" is not ours to
 * touch, so just say so; direct needs nothing. False = abort the launch.
 */
async function wireDefaultProvider(
  agent: "claude" | "codex",
  display: string,
  deps: LaunchDeps,
): Promise<boolean> {
  const mode = deps.agentMode(agent);
  if (mode === "proxy" || mode === "none") {
    if (!(await deps.ensureProxy(null))) return false;
    await deps.wireProxyDefault(agent);
  } else if (mode === "other") {
    deps.notify(
      `agent launch: ${display} has a custom provider config (not managed by copilot-env); ` +
        "launching it as-is.",
    );
  }
  return true;
}

/**
 * Resolve a LaunchAction into the child invocation, running the provider/profile
 * wiring on the way (pure orchestration over `deps`). Null = abort with exit 1;
 * the failing step already narrated on stderr.
 */
export async function prepareLaunch(
  action: LaunchAction,
  deps: LaunchDeps,
): Promise<LaunchPlan | null> {
  const relaxed = action.relaxed;
  switch (action.kind) {
    case "claude": {
      const plan: LaunchPlan = {
        command: "claude",
        args: [],
        env: { CLAUDE_CODE_NO_FLICKER: "1" },
        scrub: [],
      };
      // IS_SANDBOX tells Claude it runs sandboxed, so skipping permission
      // prompts is acceptable -- scoped to the child, exactly like the rc
      // launchers' subshell export.
      if (relaxed) plan.env.IS_SANDBOX = "1";
      const flags = [
        ...CLAUDE_MANAGED_FLAGS,
        ...(relaxed ? ["--dangerously-skip-permissions"] : []),
      ];
      if (action.profile !== null) {
        const mode = await ensureProfileReady(action.profile, deps);
        if (mode === null) return null;
        const settings = await deps.writeClaudeProfileSettings(action.profile, mode);
        // The shell may carry the DEFAULT proxy's URL (from `agent env`), which
        // would override the profile's own env block: scrub it unconditionally.
        plan.scrub.push(BASE_URL_ENV);
        plan.args = ["--settings", settings, ...flags, ...action.args];
        return plan;
      }
      if (!(await wireDefaultProvider("claude", "Claude", deps))) return null;
      // Read AFTER the wiring step so a fresh proxy port is what gets exported.
      applyManagedEnv(plan, BASE_URL_ENV, deps.managedClaudeBaseUrl(null));
      plan.args = [...flags, ...action.args];
      return plan;
    }
    case "codex": {
      const plan: LaunchPlan = { command: "codex", args: [], env: {}, scrub: [] };
      applyManagedEnv(plan, "CODEX_HOME", deps.managedCodexHome());
      const flags = relaxed ? ["--sandbox", "danger-full-access"] : [];
      if (action.profile !== null) {
        const mode = await ensureProfileReady(action.profile, deps);
        if (mode === null) return null;
        // Order matters: the daemon was ensured FIRST (a cold start may move its
        // port), so this refresh bakes the port the daemon actually bound. A
        // failed refresh warns and launches with the existing config, like the
        // rc launchers did.
        try {
          await deps.syncProfileWiring(action.profile, mode);
        } catch (e) {
          deps.notify(
            "agent launch: could not refresh the profile wiring; launching with the " +
              `existing config (${errMessage(e)}).`,
          );
        }
        plan.args = ["--profile", action.profile, ...flags, ...action.args];
        return plan;
      }
      if (!(await wireDefaultProvider("codex", "Codex", deps))) return null;
      plan.args = [...flags, ...action.args];
      return plan;
    }
    case "copilot": {
      return {
        command: "copilot",
        args: [
          "--autopilot",
          "--enable-reasoning-summaries",
          "--experimental",
          ...(relaxed ? ["--allow-all"] : []),
          ...action.args,
        ],
        env: {},
        scrub: [],
      };
    }
  }
}

// --- production effects --------------------------------------------------------

/** Launch `agent start [--profile <name>]` as a child (proxy_token.ts's twin --
 *  that module keeps its own copy private). The exit status is deliberately
 *  unread; the resolver's follow-up probe is the verdict. */
function launchProxyChild(profile: Profile, output: LaunchOutput): void {
  const { command, args } = agentLauncherCommand(
    profile === null ? ["start"] : ["start", "--profile", profile],
  );
  spawnSync(command, args, {
    // `2` = our stderr fd: the visible child's start progress shows on stderr,
    // leaving stdout to the agent CLI about to take over the terminal.
    stdio: output === "suppressed" ? ["ignore", "ignore", "ignore"] : ["inherit", 2, "inherit"],
    windowsHide: true,
  });
}

/**
 * Ensure the addressed proxy is reachable via the SHARED resolver decision matrix
 * (resolveProxyToken): managed auto-start silently, else offer to start it (no
 * `--yes` -- a down unmanaged proxy prompts, exactly like the rc launchers'
 * `agent proxy-token` call). The key print is a no-op: launch needs reachability,
 * not the credential; the agent's own wiring resolves the token itself.
 */
async function ensureProxyUp(profile: Profile): Promise<boolean> {
  const deps: ProxyTokenDeps = {
    proxyUp: async (p) => (await proxyStatus(p)).up,
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    launchProxy: launchProxyChild,
    readAnswer: readStartAnswer,
    recordHeartbeat,
    printProxyToken: async () => {},
    notify: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
  return (await resolveProxyToken({ assumeYes: false, profile }, deps)) === 0;
}

/** The production dependency set (see LaunchDeps). */
function commandDeps(): LaunchDeps {
  return {
    agentMode: (agent) => readAgentModes()[agent],
    ensureProxy: ensureProxyUp,
    wireProxyDefault: (agent) =>
      agent === "claude" ? runClaude({ mode: "proxy" }) : runCodex({ mode: "proxy" }),
    profileSlot: (name) => new CopilotEnvState().readProfileSlot(name),
    writeClaudeProfileSettings: async (name, mode) => {
      const claudeHome = resolveClaudeHome();
      configureClaudeConfig(claudeHome, mode, {
        quiet: true,
        profile: name,
        directIntegrationId: mode === "direct"
          ? await resolveAndPersistDirectIdentity(name)
          : undefined,
      });
      return settingsPathFor(claudeHome, name);
    },
    syncProfileWiring: (name, mode) => wireBothAgents(name, mode, true),
    managedClaudeBaseUrl,
    managedCodexHome,
    notify: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * Run the planned agent as a child with inherited stdio (see the module header
 * for why there is no exec) and return the exit code to pass through: the
 * child's own status, or the conventional 128+N when a signal killed it.
 */
function spawnAgentCli(plan: LaunchPlan): number {
  // verbatimCliSpawn keeps the pass-through contract: the resolved CLI gets the
  // args as plain argv (POSIX exec-direct with the nvm fallback; Windows via a
  // native .exe or the npm .ps1 shim through `powershell -File` -- never cmd.exe,
  // whose parser expands %VAR% even inside quotes; only a batch-ONLY shim still
  // falls back to it). The resolved bin dir joins the child PATH: an npm/nvm
  // shim needs node beside it.
  const spawn = verbatimCliSpawn(plan.command, plan.args);
  // Deno's node:child_process MERGES the `env` option over the parent environment
  // (node replaces), so a scrubbed key must also be cleared from the parent for
  // the child's span, then restored.
  const scrubbed: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && plan.scrub.includes(key.toUpperCase())) {
      scrubbed.push([key, value]);
      delete process.env[key];
    }
  }
  try {
    const result = spawnSync(spawn.file, spawn.args, {
      stdio: "inherit",
      shell: spawn.shell,
      env: childEnvWithPath([spawn.binDir], {
        extra: plan.env,
        omit: (upper) => plan.scrub.includes(upper),
      }),
    });
    if (result.error) throw result.error;
    if (result.status !== null) return result.status;
    const signalNumber = result.signal ? constants.signals[result.signal] : undefined;
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  } finally {
    for (const [key, value] of scrubbed) process.env[key] = value;
  }
}

/** `agent launch`: prepare (wiring + env), then hand the terminal to the agent.
 *  process.exitCode (never process.exit) so pending stderr writes flush. */
export async function runLaunch(
  action: LaunchAction,
  deps: LaunchDeps = commandDeps(),
): Promise<void> {
  if (!commandExists(action.kind)) {
    // The rc launchers' wording, verbatim -- the fix is the same command.
    throw new Error(
      `'${action.kind}' is not installed. Run 'agent shell --clis' to install the agent CLIs.`,
    );
  }
  const plan = await prepareLaunch(action, deps);
  if (plan === null) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = spawnAgentCli(plan);
}
