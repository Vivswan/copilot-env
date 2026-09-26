// The one implementation behind the cl/co/cx one-liners `agent profile env` emits on both
// platforms. The child env is composed here rather than inherited: the wiring step may have just
// moved a port or built the farm, and nothing refreshes the shell's env between wiring and exec
// inside one process.
//
// Neither deno nor node exposes an execve-style replacement, so the agent runs as a child with
// inherited stdio and its exit code (or 128+signal) passes through.
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { wireBothAgents } from "../agents/profile_wiring.ts";
import { runClaude, runCodex } from "../agents/configure_defaults.ts";
import { BASE_URL_ENV, managedClaudeBaseUrl } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { refreshCodexCatalogAndSync } from "../codex/catalog_reference.ts";
import { narrateCodexHome, resolveCodexHome } from "../codex/host.ts";
import { CopilotEnvState, partialSlotGap, type ProfileMode } from "../copilot_api/env_state.ts";
import {
  parseProfileFlag,
  parseProfileName,
  type Profile,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { childEnvWithPath, findCommand, verbatimCliSpawn } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { deferWriteReports, flushWriteReports } from "../utils/report_write.ts";
import type { ManagedEnvValue } from "../utils/shell_quote.ts";
import { runDryRun } from "./dry_run.ts";
import { proxyTokenDeps, resolveProxyToken } from "./proxy_token.ts";
import { printWrappedToStderr } from "../utils/table.ts";

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
  // The one-line wrappers cannot split `cl --profile work ...`, so a LEADING pair is hoisted here
  // into the named profile; under a named verb the pair rides through to the agent CLI untouched.
  // co never hoists.
  if (cli !== "copilot" && profile === null && args[0] === "--profile" && args[1]) {
    profile = parseProfileName(args[1]);
    args = args.slice(2);
  }
  if (cli === "copilot") {
    if (profile !== null) {
      throw new Error("copilot takes no profile (profiles wire Codex and Claude)");
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

const CLAUDE_MANAGED_FLAGS = ["--permission-mode", "auto", "--enable-auto-mode"] as const;

/** Every inherited casing is scrubbed first: on Windows `Codex_Home` and `CODEX_HOME` would both
 *  reach the child and which one it reads is undefined (childEnvWithPath). The home is read AFTER
 *  the wiring step (resolveCodexHome): a proxy re-wire may have just built the farm, and a shell
 *  CODEX_HOME can never send Codex to a config other than the one copilot-env wrote. */
function pinCodexHome(plan: LaunchPlan): void {
  plan.scrub.push("CODEX_HOME");
  plan.env.CODEX_HOME = narrateCodexHome(resolveCodexHome());
}

function applyManagedEnv(plan: LaunchPlan, key: string, value: ManagedEnvValue): void {
  if (value === null) return;
  if ("unset" in value) plan.scrub.push(key);
  else plan.env[key] = value.value;
}

/** The shared resolver matrix (resolveProxyToken) without `--yes`, so a down unmanaged proxy
 *  prompts. The print step emits no key (launch needs reachability, not the credential) and runs
 *  the Codex catalog refresh instead: a launch is where a stale catalog is felt, and the
 *  token-returning commands never write agent files. Default profile only, like every catalog
 *  write. False = the launch must abort; the resolver already explained itself on stderr. */
async function ensureProxyUp(profile: Profile): Promise<boolean> {
  const deps = proxyTokenDeps(async (p) => {
    if (p !== null) return;
    await refreshCodexCatalogAndSync("proxy");
  });
  return (await resolveProxyToken({ assumeYes: false, profile }, deps)) === 0;
}

/** Null = the resolver said no and already explained itself on stderr. */
async function ensureProfileReady(name: ProfileName): Promise<ProfileMode | null> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  // A partial slot reports its gap, exactly `agent profile <name> check`'s contract.
  if (slot.kind === "partial") {
    throw new Error(partialSlotGap(name, slot));
  }
  if (slot.mode === "proxy" && !(await ensureProxyUp(name))) return null;
  return slot.mode;
}

/** The default slot's recorded mode is the truth for both agents; the agent files are outputs. On a
 *  proxy or unrecorded default the proxy is ensured THEN the wiring re-synced, because a cold start
 *  may have moved the port: a fresh default (no recorded mode) lands BOTH agents (runAgentConfig's
 *  null-record rule), a recorded proxy re-renders the launching agent alone. Null = abort. */
async function wireDefaultProvider(
  agent: "claude" | "codex",
): Promise<ProfileMode | "none" | null> {
  const mode = new CopilotEnvState().readProfileSlot(null).mode ?? "none";
  if (mode === "proxy" || mode === "none") {
    if (!(await ensureProxyUp(null))) return null;
    await (agent === "claude"
      ? runClaude({ kind: "configure", mode: "proxy" })
      : runCodex({ kind: "configure", mode: "proxy" }));
  }
  return mode;
}

/** The `cl --profile <name>` hook, run after the profile's daemon was ensured: both agents are
 *  re-rendered from the slot's pair (a Claude-only write could leave the two disagreeing), then the
 *  absolute path `claude --settings` gets. */
export async function writeProfileSettings(name: ProfileName, mode: ProfileMode): Promise<string> {
  await wireBothAgents(name, mode, true, "stored");
  return settingsPathFor(resolveClaudeHome(), name);
}

/** Null = abort with exit 1; the failing step already narrated on stderr. */
export async function prepareLaunch(action: LaunchAction): Promise<LaunchPlan | null> {
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
        const mode = await ensureProfileReady(action.profile);
        if (mode === null) return null;
        const settings = await writeProfileSettings(action.profile, mode);
        // The shell may carry the DEFAULT proxy's URL (from `agent profile env`), which would
        // override the profile's own env block.
        plan.scrub.push(BASE_URL_ENV);
        plan.args = ["--settings", settings, ...flags, ...action.args];
        return plan;
      }
      if ((await wireDefaultProvider("claude")) === null) return null;
      // Read AFTER the wiring step so a fresh proxy port is what gets exported.
      applyManagedEnv(plan, BASE_URL_ENV, managedClaudeBaseUrl(null));
      plan.args = [...flags, ...action.args];
      return plan;
    }
    case "codex": {
      const plan: LaunchPlan = { command: "codex", args: [], env: {}, scrub: [] };
      const flags = relaxed
        ? ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]
        : [];
      if (action.profile !== null) {
        const mode = await ensureProfileReady(action.profile);
        if (mode === null) return null;
        // After the daemon was ensured (a cold start may move its port), so this refresh bakes the
        // port the daemon actually bound. A failed refresh warns and launches with the existing
        // config.
        try {
          await wireBothAgents(action.profile, mode, true, "stored");
        } catch (e) {
          printWrappedToStderr(
            "agent profile launch: could not refresh the profile wiring; launching with the " +
              `existing config (${errMessage(e)}).`,
          );
        }
        // Read AFTER the sync: the home its write resolved is the one the child must open.
        pinCodexHome(plan);
        plan.args = ["--profile", action.profile, ...flags, ...action.args];
        return plan;
      }
      const mode = await wireDefaultProvider("codex");
      if (mode === null) return null;
      // Read AFTER the wiring step: a proxy re-wire may have just built the farm.
      pinCodexHome(plan);
      // Codex parses `model_catalog_json` at startup, so a catalog an upgraded codex rejects must be
      // regenerated BEFORE it starts: a direct launch refreshes here first. The proxy launch
      // refreshed inside ensureProxyUp's print step.
      if (mode === "direct") await refreshCodexCatalogAndSync("direct");
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

/** The refusal every launch, real or dry, gives before preparing anything. A failed look must not
 *  read "not installed": the probe never completed, which proves nothing about the CLI. The launch
 *  itself is then the honest test; its own spawn error names the real problem. */
function rejectMissingCli(cli: LaunchAction["kind"]): void {
  const cliLook = findCommand(cli);
  if (cliLook.path !== null) return;
  if (cliLook.launchFailed) {
    printWrappedToStderr(
      `could not check whether '${cli}' is installed (the command probe failed to run); launching anyway`,
    );
    return;
  }
  throw new Error(`'${cli}' is not installed. Run 'agent shell --clis' to install the agent CLIs.`);
}

/** process.exitCode, never process.exit, so pending stderr writes flush. A dry run prepares the
 *  launch (the wiring it lands is the plan) and says what it would spawn instead of spawning it. */
export async function runLaunch(action: LaunchAction, dryRun = false): Promise<void> {
  // The one preparation (the refusal, the wiring, the plan); only what happens to the plan differs.
  const prepare = async (): Promise<LaunchPlan | null> => {
    rejectMissingCli(action.kind);
    const plan = await prepareLaunch(action);
    if (plan === null) process.exitCode = 1;
    return plan;
  };
  if (dryRun) {
    await runDryRun(async () => {
      const plan = await prepare();
      if (plan === null) return;
      printWrappedToStderr(
        `Would launch ${[plan.command, ...plan.args].join(" ")} with ${
          Object.keys(plan.env).length
        } managed env var(s) set and ${plan.scrub.length} scrubbed.`,
      );
    });
    return;
  }
  // The wiring writes are named AFTER the agent hands the terminal back, not into a screen it is
  // about to clear. A signal that kills this process while the agent runs loses them: a signal
  // listener would keep the launcher alive past a signal aimed at it alone for as long as the agent
  // ignores the same signal.
  deferWriteReports();
  try {
    const plan = await prepare();
    if (plan === null) return;
    process.exitCode = spawnAgentCli(plan);
  } finally {
    flushWriteReports();
  }
}
