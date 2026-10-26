// Codex's `auth.command` and Claude's `apiKeyHelper` run this headless (`--yes`); the cl/cx
// launchers run it interactively. Claude Code hard-fails an apiKeyHelper whose stdout is anything
// but the single credential line, so the only stdout write in any branch is the key line inside
// runPrintProxyToken.
//
// The launch stays a child `agent start` on purpose: the launch pipeline narrates to its own
// stdout, and in-process that would land on ours.
//
//   child stderr  -> always forwarded: that is where it names every file it writes
//   child stdin   -> ignored on the managed branch: nothing in `agent start` reads it (with no stored
//                    credential the child refuses and names `agent auth`; nothing prompts)
import { spawnSync } from "node:child_process";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig, configSetCommand } from "../copilot_api/env_config.ts";
import {
  agentAuthCommand,
  agentStartCommand,
  type Profile,
  parseProfileFlag,
} from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { withPowershellChildEnv } from "../utils/command.ts";
import { promptRefusedInDryRun } from "../utils/dry_run.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { caught, printWrappedToStderr, type ScannableMessage } from "../utils/message.ts";
import { prompt } from "../utils/prompt.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { runDryRun } from "./dry_run.ts";
import { runStart } from "./start.ts";

interface ProxyTokenFlags {
  /** Never prompt: a down unmanaged proxy exits 1 rather than offering a start. */
  yes?: boolean;

  /** The daemon whose key is printed; unset is the default profile. */
  profile?: string;

  /** Print the daemon start and the store writes (minted key redacted) and do none; no key is printed, none stored. */
  dryRun?: boolean;
}

interface ProxyTokenAction {
  assumeYes: boolean;
  profile: Profile;
}

export type LaunchOutput = "suppressed" | "visible";

/** Every daemon-touching member is scoped by `profile`; autoStartEnabled is the one account-wide
 *  preference. */
export interface ProxyTokenDeps {
  proxyUp(profile: Profile): Promise<boolean>;

  autoStartEnabled(): boolean;

  /** In a dry run, the start's own preview (`agent start --dry-run`, in process): the same port
   *  resolution and refusals the child would make. */
  launchProxy(profile: Profile, output: LaunchOutput): void | Promise<void>;

  /** Asks on stderr; yes, or a closed stdin, means start. */
  confirmStart(question: string): Promise<boolean>;

  recordHeartbeat(profile: Profile): void;

  /** runPrintProxyToken in production. `agent profile launch` injects a keyless variant that runs the
   *  Codex catalog refresh instead: launch needs reachability, not the credential. */
  printProxyToken(profile: Profile): Promise<void>;

  /** stderr, never stdout. */
  notify(line: string | ScannableMessage): void;
}

/** Through bin/agent rather than in-process, so a dev checkout bootstraps its dependencies there.
 *   the child's stdio  -> placed so the caller's stdout stays untouched
 *   the exit status    -> unread; the follow-up proxyUp probe is the verdict
 *   `agent profile launch`     -> injects this as its own launchProxy dependency */
export function launchProxy(profile: Profile, output: LaunchOutput): void | Promise<void> {
  if (dryRunActive()) {
    return runStart({ kind: "launch", dryRun: true, force: false, port: undefined, profile });
  }
  const launcher = agentLauncherCommand(
    profile === null ? ["start"] : ["profile", profile, "start"],
  );
  const spawn = (env?: Record<string, string>) =>
    // biome-ignore lint/plugin/no_unbounded_child_spawn: the proxy start runs for the user, its progress on the terminal
    spawnSync(launcher.command, launcher.args, {
      // `2` is our stderr fd: the visible child's start progress must show without touching our
      // stdout.
      stdio: output === "suppressed" ? ["ignore", "ignore", "inherit"] : ["inherit", 2, "inherit"],
      windowsHide: true,
      env,
    });
  switch (launcher.kind) {
    case "powershell":
      withPowershellChildEnv(launcher.command, spawn);
      break;
    case "direct":
      spawn();
      break;
    default:
      assertNever(launcher);
  }
}

/** The key line is the ENTIRE stdout contract; like `agent auth --get`, it writes no agent file. */
export function runPrintProxyToken(profile: Profile): void {
  const key = CopilotApiConfig.forProfile(profile).ensureApiKey();
  // codeql[js/clear-text-logging] -- emitting the proxy key on stdout IS this command's
  // contract (the proxy-mode agents' auth.command / apiKeyHelper consume it). A dry run minted a
  // key its recorded store write never lands, so it prints none: the plan is the stdout.
  if (!dryRunActive()) process.stdout.write(`${key}\n`);
}

/** What a down proxy's start did. A `suppressed` start is the managed one, silent, so its failure
 *  needs the pointer that surfaces the hidden error. A `planned` start is a dry run's: the start's
 *  own preview (launchProxy under a dry run), whose refusals stand; past it the resolve proceeds
 *  as if the daemon came up, since the writes that follow are the plan. */
interface DownProxyStart {
  suppressed: boolean;
  planned: boolean;
}

/** Runs the start; whether it counts as planned (a dry run's start that was not refused). */
async function launchOrPlan(
  profile: Profile,
  output: LaunchOutput,
  deps: ProxyTokenDeps,
): Promise<boolean> {
  try {
    await deps.launchProxy(profile, output);
  } catch (e) {
    // The real start is a child whose refusal is its own stderr and exit status (unread here):
    // the in-process preview's refusal is said the same way, and the resolve reaches the same
    // failed-start arm.
    if (!dryRunActive()) throw e;
    deps.notify(caught(e, (message) => `the proxy start would refuse: ${message}`));
    return false;
  }
  return dryRunActive();
}

/** A down proxy's start, by the matrix above resolveProxyToken: managed starts silently,
 *  unmanaged asks (a dry run cannot, and --yes never starts). */
async function startDownProxy(
  action: ProxyTokenAction,
  deps: ProxyTokenDeps,
): Promise<DownProxyStart> {
  const { profile } = action;
  if (deps.autoStartEnabled()) {
    const planned = await launchOrPlan(profile, "suppressed", deps);
    return { suppressed: true, planned };
  }
  if (action.assumeYes) return { suppressed: false, planned: false };
  if (dryRunActive()) {
    const yesHint = `agent profile ${profile === null ? "" : `${profile} `}proxy-token --yes`;
    throw promptRefusedInDryRun(
      `start the proxy? \`${yesHint}\` answers it, and ` +
        `\`${configSetCommand("daemon.auto-start", "true")}\` starts it for every launcher`,
    );
  }
  if (await deps.confirmStart("copilot proxy not running. Start it now?")) {
    const planned = await launchOrPlan(profile, "visible", deps);
    return { suppressed: false, planned };
  }
  // Human-facing hints must name the profile's daemon, or they'd point at the default one.
  const startHint = agentStartCommand(profile);
  deps.notify(`Continuing without the proxy; proxy-backed agents need it (run '${startHint}').`);
  return { suppressed: false, planned: false };
}

/**
 * The key is printed only if the proxy is actually up after the re-probe.
 *   down, managed lifecycle on   -> silent auto-start, even interactive: the opt-in holds anywhere
 *   down, unmanaged, interactive -> offer to start; declining continues without
 *   down, unmanaged, --yes       -> never auto-start: a headless caller opted out of the lifecycle
 */
export async function resolveProxyToken(
  action: ProxyTokenAction,
  deps: ProxyTokenDeps,
): Promise<0 | 1> {
  const { profile } = action;
  let start: DownProxyStart = { suppressed: false, planned: false };
  if (!(await deps.proxyUp(profile))) {
    start = await startDownProxy(action, deps);
  }
  deps.recordHeartbeat(profile);
  if (start.planned || (await deps.proxyUp(profile))) {
    await deps.printProxyToken(profile);
    return 0;
  }
  if (start.suppressed) {
    // Human-facing hints must name the profile's daemon, or they'd point at the default one.
    const startHint = agentStartCommand(profile);
    const authHint = agentAuthCommand(profile);
    deps.notify(
      `copilot proxy failed to start (run '${startHint}' to see the error; no credential stored? run '${authHint}').`,
    );
  }
  return 1;
}

/** The production members. `printProxyToken` is the one a caller substitutes: `agent profile
 *  launch` runs the Codex catalog refresh in its place, since a launch needs reachability, not the
 *  credential. */
export function proxyTokenDeps(
  printProxyToken: ProxyTokenDeps["printProxyToken"] = (profile) => {
    runPrintProxyToken(profile);
    return Promise.resolve();
  },
): ProxyTokenDeps {
  return {
    proxyUp: async (profile) => (await proxyStatus(profile)).up,
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    launchProxy,
    confirmStart: async (question) =>
      (await prompt(
        question,
        { type: "confirm", initial: true, cancel: "undefined" },
        "default",
      )) === true,
    recordHeartbeat,
    printProxyToken,
    notify: (line) => {
      printWrappedToStderr(line);
    },
  };
}

/** process.exitCode, never process.exit, so pending stderr writes flush. */
export async function runProxyToken(flags: ProxyTokenFlags): Promise<void> {
  const action: ProxyTokenAction = {
    assumeYes: Boolean(flags.yes),
    profile: parseProfileFlag(flags.profile),
  };
  const run = async (): Promise<void> => {
    process.exitCode = await resolveProxyToken(action, proxyTokenDeps());
  };
  if (flags.dryRun) {
    await runDryRun(run);
    return;
  }
  await run();
}
