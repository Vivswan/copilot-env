// The one implementation behind the cl/co/cx one-liners `agent env` emits on both platforms. The
// child env is composed here rather than inherited: the wiring step may have just moved a port or
// built the farm, and nothing refreshes the shell's env between wiring and exec inside one process.
//
// Neither deno nor node exposes an execve-style replacement, so the agent runs as a child with
// inherited stdio and its exit code (or 128+signal) passes through.
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import type { ManagedWrite } from "../agents/configure.ts";
import { recordDefaultModeFromWiring } from "../agents/configure_defaults.ts";
import { resolveAndPersistDirectIdentity, wireBothAgents } from "../agents/profile_wiring.ts";
import type { AgentProviderMode } from "../agents/provider_mode.ts";
import { readAgentModes } from "../agents/wiring.ts";
import { BASE_URL_ENV, claudeAdapter, runClaude } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { refreshCodexCatalogAndSync } from "../codex/catalog_reference.ts";
import { runCodex } from "../codex/config.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CopilotEnvState,
  partialSlotGap,
  type ProfileMode,
  type ProfileSlot,
} from "../copilot_api/env_state.ts";
import {
  parseProfileFlag,
  parseProfileName,
  type Profile,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { childEnvWithPath, findCommand, verbatimCliSpawn } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { deferWriteReports, flushWriteReports } from "../utils/report_write.ts";
import { managedClaudeBaseUrl, managedCodexHome, type ManagedEnvValue } from "./env.ts";
import {
  launchProxy,
  type ProxyTokenDeps,
  readStartAnswer,
  resolveProxyToken,
} from "./proxy_token.ts";

/** Each name is also the command spawned. */
const LAUNCH_CLIS = ["claude", "codex", "copilot"] as const;
type LaunchCliName = (typeof LAUNCH_CLIS)[number];

export interface LaunchFlags {
  cli: string;
  args: string[];
  profile?: string;
  relaxed?: boolean;
}

/** Copilot's arm carries no profile: profiles wire Codex and Claude, so a copilot profile launch is
 *  unrepresentable rather than silently ignored. */
export type LaunchAction =
  | { kind: "claude"; profile: Profile; relaxed: boolean; args: string[] }
  | { kind: "codex"; profile: Profile; relaxed: boolean; args: string[] }
  | { kind: "copilot"; relaxed: boolean; args: string[] };

export function parseLaunchAction(flags: LaunchFlags): LaunchAction {
  if (!(LAUNCH_CLIS as readonly string[]).includes(flags.cli)) {
    throw new Error(`unknown agent CLI '${flags.cli}' (expected claude | codex | copilot)`);
  }
  const cli = flags.cli as LaunchCliName;
  const relaxed = Boolean(flags.relaxed);
  let profile = parseProfileFlag(flags.profile);
  let args = [...flags.args];
  // The one-line wrappers cannot split `cl --profile work ...`, so a LEADING pair is hoisted here;
  // with an explicit --profile the pair rides through to the agent CLI untouched. co never hoists.
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

/** Pure data, so tests assert the composition without spawning an agent. */
export interface LaunchPlan {
  command: LaunchCliName;
  args: string[];
  env: Record<string, string>;
  /** Canonical UPPER-CASE names. */
  scrub: string[];
}

export interface LaunchDeps {
  /** The CONFIGURED provider, no live probe. */
  agentMode(agent: "claude" | "codex"): AgentProviderMode;
  /** False = the launch must abort. */
  ensureProxy(profile: Profile): Promise<boolean>;
  wireProxyDefault(agent: "claude" | "codex"): Promise<void>;
  /** For a DIRECT default launch; the proxy launch refreshes inside ensureProxy's token step. */
  refreshCodexCatalog(): Promise<void>;
  profileSlot(name: ProfileName): ProfileSlot;
  /** Returns the absolute path `claude --settings` gets. */
  writeClaudeProfileSettings(name: ProfileName, mode: ProfileMode): Promise<string>;
  syncProfileWiring(name: ProfileName, mode: ProfileMode): Promise<void>;
  managedClaudeBaseUrl(profile: Profile): ManagedEnvValue;
  managedCodexHome(): ManagedEnvValue;
  /** stderr: stdout belongs to the launched agent. */
  notify(line: string): void;
}

const CLAUDE_MANAGED_FLAGS = ["--permission-mode", "auto", "--enable-auto-mode"] as const;

function applyManagedEnv(plan: LaunchPlan, key: string, value: ManagedEnvValue): void {
  if (value === null) return;
  if ("unset" in value) plan.scrub.push(key);
  else plan.env[key] = value.value;
}

/** Null = the resolver said no and already explained itself on stderr. */
async function ensureProfileReady(
  name: ProfileName,
  deps: LaunchDeps,
): Promise<ProfileMode | null> {
  const slot = deps.profileSlot(name);
  // A partial slot reports its gap, exactly `agent profile --check`'s contract.
  if (slot.kind === "partial") {
    throw new Error(partialSlotGap(name, slot));
  }
  if (slot.mode === "proxy" && !(await deps.ensureProxy(name))) return null;
  return slot.mode;
}

/** The proxy is ensured THEN the wiring re-synced, because a cold start may have moved the port.
 *  "other" is not ours to touch. Null = abort. */
async function wireDefaultProvider(
  agent: "claude" | "codex",
  display: string,
  deps: LaunchDeps,
): Promise<AgentProviderMode | null> {
  const mode = deps.agentMode(agent);
  if (mode === "proxy" || mode === "none") {
    if (!(await deps.ensureProxy(null))) return null;
    await deps.wireProxyDefault(agent);
  } else if (mode === "other") {
    deps.notify(
      `agent launch: ${display} has a custom or unrecognized provider config ` +
        "(not managed by copilot-env); launching it as-is.",
    );
  }
  return mode;
}

/** Null = abort with exit 1; the failing step already narrated on stderr. */
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
      // IS_SANDBOX tells Claude it runs sandboxed, so skipping permission prompts is acceptable.
      if (relaxed) plan.env.IS_SANDBOX = "1";
      const flags = [
        ...CLAUDE_MANAGED_FLAGS,
        ...(relaxed ? ["--dangerously-skip-permissions"] : []),
      ];
      if (action.profile !== null) {
        const mode = await ensureProfileReady(action.profile, deps);
        if (mode === null) return null;
        const settings = await deps.writeClaudeProfileSettings(action.profile, mode);
        // The shell may carry the DEFAULT proxy's URL (from `agent env`), which would override the
        // profile's own env block.
        plan.scrub.push(BASE_URL_ENV);
        plan.args = ["--settings", settings, ...flags, ...action.args];
        return plan;
      }
      if ((await wireDefaultProvider("claude", "Claude", deps)) === null) return null;
      // Read AFTER the wiring step so a fresh proxy port is what gets exported.
      applyManagedEnv(plan, BASE_URL_ENV, deps.managedClaudeBaseUrl(null));
      plan.args = [...flags, ...action.args];
      return plan;
    }
    case "codex": {
      const plan: LaunchPlan = { command: "codex", args: [], env: {}, scrub: [] };
      const flags = relaxed ? ["--sandbox", "danger-full-access"] : [];
      if (action.profile !== null) {
        const mode = await ensureProfileReady(action.profile, deps);
        if (mode === null) return null;
        // After the daemon was ensured (a cold start may move its port), so this refresh bakes the
        // port the daemon actually bound. A failed refresh warns and launches with the existing
        // config.
        try {
          await deps.syncProfileWiring(action.profile, mode);
        } catch (e) {
          deps.notify(
            "agent launch: could not refresh the profile wiring; launching with the " +
              `existing config (${errMessage(e)}).`,
          );
        }
        // Read AFTER the sync: its write into the farm home may have just made it wired.
        applyManagedEnv(plan, "CODEX_HOME", deps.managedCodexHome());
        plan.args = ["--profile", action.profile, ...flags, ...action.args];
        return plan;
      }
      const mode = await wireDefaultProvider("codex", "Codex", deps);
      if (mode === null) return null;
      // Read AFTER the wiring step: a proxy re-wire may have just built the farm.
      applyManagedEnv(plan, "CODEX_HOME", deps.managedCodexHome());
      // Codex parses `model_catalog_json` at startup, BEFORE the auth refresh that would regenerate
      // a catalog an upgraded codex rejects, so a direct launch refreshes here first.
      if (mode === "direct") await deps.refreshCodexCatalog();
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

/** The shared resolver matrix (resolveProxyToken) without `--yes`, so a down unmanaged proxy
 *  prompts. The print step emits no key (launch needs reachability, not the credential) but keeps
 *  runPrintProxyToken's other duty, the Codex catalog refresh, for the default profile only, like
 *  every catalog write. */
async function ensureProxyUp(profile: Profile): Promise<boolean> {
  const deps: ProxyTokenDeps = {
    proxyUp: async (p) => (await proxyStatus(p)).up,
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    launchProxy,
    readAnswer: readStartAnswer,
    recordHeartbeat,
    printProxyToken: async (p) => {
      if (p !== null) return;
      await refreshCodexCatalogAndSync("proxy");
    },
    notify: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
  return (await resolveProxyToken({ assumeYes: false, profile }, deps)) === 0;
}

/** Exported for its tests. */
export function commandDeps(): LaunchDeps {
  return {
    agentMode: (agent) => readAgentModes()[agent],
    ensureProxy: ensureProxyUp,
    wireProxyDefault: async (agent) => {
      await (agent === "claude"
        ? runClaude({ kind: "configure", mode: "proxy" })
        : runCodex({ kind: "configure", mode: "proxy" }));
      // The same success-only step the `agent codex`/`agent claude` configure arms run;
      // non-throwing, so it can never abort the launch.
      recordDefaultModeFromWiring();
    },
    refreshCodexCatalog: () => refreshCodexCatalogAndSync("direct"),
    profileSlot: (name) => new CopilotEnvState().readProfileSlot(name),
    writeClaudeProfileSettings: async (name, mode) => {
      const write: ManagedWrite = mode === "direct"
        ? { mode, directIntegrationId: await resolveAndPersistDirectIdentity(name) }
        : { mode };
      // Through the adapter so the profile's Desktop entry follows the `claude-desktop` key, like
      // `--settings-for`.
      await claudeAdapter().configureProfile(name, write, { quiet: true });
      return settingsPathFor(resolveClaudeHome(), name);
    },
    syncProfileWiring: (name, mode) => wireBothAgents(name, mode, true),
    managedClaudeBaseUrl,
    managedCodexHome,
    notify: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

function spawnAgentCli(plan: LaunchPlan): number {
  const spawn = verbatimCliSpawn(plan.command, plan.args);
  // Deno's node:child_process MERGES the `env` option over the parent environment (node replaces),
  // so a scrubbed key must also be cleared from the parent for the child's span, then restored.
  const scrubbed: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && plan.scrub.includes(key.toUpperCase())) {
      scrubbed.push([key, value]);
      delete process.env[key];
    }
  }
  try {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
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

/** process.exitCode, never process.exit, so pending stderr writes flush. */
export async function runLaunch(
  action: LaunchAction,
  deps: LaunchDeps = commandDeps(),
): Promise<void> {
  // The wiring writes are named AFTER the agent hands the terminal back, not into a screen it is
  // about to clear. A signal that kills this process while the agent runs loses them: a signal
  // listener would keep the launcher alive past a signal aimed at it alone for as long as the agent
  // ignores the same signal.
  deferWriteReports();
  try {
    const cliLook = findCommand(action.kind);
    if (cliLook.path === null) {
      if (cliLook.launchFailed) {
        // A failed look must not read "not installed": the probe never completed, which proves
        // nothing about the CLI. The launch below is the honest test; its own spawn error names the
        // real problem.
        process.stderr.write(
          `could not check whether '${action.kind}' is installed (the command probe failed to run); launching anyway\n`,
        );
      } else {
        throw new Error(
          `'${action.kind}' is not installed. Run 'agent shell --clis' to install the agent CLIs.`,
        );
      }
    }
    const plan = await prepareLaunch(action, deps);
    if (plan === null) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = spawnAgentCli(plan);
  } finally {
    flushWriteReports();
  }
}
