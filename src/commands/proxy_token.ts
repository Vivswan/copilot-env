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
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { agentStartCommand, parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { printWrappedToStderr, terminalWidth, wrapMessage } from "../utils/table.ts";
import { promptRefusedInDryRun } from "../utils/dry_run.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { runDryRun } from "./dry_run.ts";
import { runStart } from "./start.ts";

export interface ProxyTokenFlags {
  yes?: boolean;
  profile?: string;
  /** Print the daemon start and the store writes the resolve would make (the minted API key
   *  redacted) and do none of them; the key is not printed, since none is stored. */
  dryRun?: boolean;
}

export interface ProxyTokenAction {
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
  /** Prompts on stderr; EOF resolves "". */
  readAnswer(query: string): Promise<string>;
  recordHeartbeat(profile: Profile): void;
  /** runPrintProxyToken in production. `agent profile launch` injects a keyless variant that runs the
   *  Codex catalog refresh instead: launch needs reachability, not the credential. */
  printProxyToken(profile: Profile): Promise<void>;
  /** stderr, never stdout. */
  notify(line: string): void;
}

/** Through bin/agent rather than in-process, so a dev checkout bootstraps deno and deps there.
 *   the child's stdio  -> placed so the caller's stdout stays untouched
 *   the exit status    -> unread; the follow-up proxyUp probe is the verdict
 *   `agent profile launch`     -> injects this as its own launchProxy dependency */
export function launchProxy(profile: Profile, output: LaunchOutput): void | Promise<void> {
  if (dryRunActive()) {
    return runStart({ kind: "launch", dryRun: true, force: false, port: undefined, profile });
  }
  const { command, args } = agentLauncherCommand(
    profile === null ? ["start"] : ["profile", profile, "start"],
  );
  spawnSync(command, args, {
    // `2` is our stderr fd: the visible child's start progress must show without touching our
    // stdout.
    stdio: output === "suppressed" ? ["ignore", "ignore", "inherit"] : ["inherit", 2, "inherit"],
    windowsHide: true,
  });
}

/**
 * Raw stdin events, not readline's question(): the query goes to stderr, since stdout stays
 * key-only and both readline's prompt and consola.prompt write to stdout.
 *   stdin already closed, no line coming  -> rl.question never settles, the `end` event does
 *   EOF                                   -> "", which means START (the apiKeyHelper case)
 */
export function readStartAnswer(query: string): Promise<string> {
  process.stderr.write(wrapMessage(query, terminalWidth(process.stderr)));
  return new Promise((resolve) => {
    // String chunks split on character boundaries; per-chunk Buffer.toString could mangle a
    // straddling UTF-8 sequence.
    process.stdin.setEncoding("utf8");
    let buf = "";
    const finish = (answer: string): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause(); // release the event loop; the process must be able to exit
      resolve(answer);
    };
    const onData = (chunk: string): void => {
      buf += chunk;
      const newline = buf.indexOf("\n");
      if (newline !== -1) finish(buf.slice(0, newline).replace(/\r$/, ""));
    };
    const onEnd = (): void => finish(buf);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/** The key line is the ENTIRE stdout contract; like `agent auth --get`, it writes no agent file. */
export function runPrintProxyToken(profile: Profile): void {
  const key = CopilotApiConfig.forProfile(profile).ensureApiKey();
  // codeql[js/clear-text-logging] -- emitting the proxy key on stdout IS this command's
  // contract (the proxy-mode agents' auth.command / apiKeyHelper consume it). A dry run minted a
  // key its recorded store write never lands, so it prints none: the plan is the stdout.
  if (!dryRunActive()) process.stdout.write(`${key}\n`);
}

function answerMeansStart(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
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
  // Human-facing hints must name the profile's daemon, or they'd point at the default one.
  const startHint = agentStartCommand(profile);
  // A named profile never falls back to the default credential, so its hint names its own slot.
  const authHint = profile === null ? "agent auth" : `agent profile ${profile} auth`;
  const yesHint = `agent profile ${profile === null ? "" : `${profile} `}proxy-token --yes`;
  let suppressedStart = false;
  // A dry run asks nothing, and its start is the start's own preview (launchProxy under a dry
  // run), whose refusals stand; past it the resolve proceeds as if the daemon came up, since the
  // writes that follow are the plan.
  let plannedStart = false;
  const launch = async (output: LaunchOutput): Promise<void> => {
    try {
      await deps.launchProxy(profile, output);
    } catch (e) {
      // The real start is a child whose refusal is its own stderr and exit status (unread here):
      // the in-process preview's refusal is said the same way, and the resolve reaches the same
      // failed-start arm.
      if (!dryRunActive()) throw e;
      deps.notify(`the proxy start would refuse: ${errMessage(e)}`);
      return;
    }
    plannedStart = dryRunActive();
  };
  if (!(await deps.proxyUp(profile))) {
    if (deps.autoStartEnabled()) {
      await launch("suppressed");
      suppressedStart = true;
    } else if (!action.assumeYes) {
      if (dryRunActive()) {
        throw promptRefusedInDryRun(
          `start the proxy? \`${yesHint}\` answers it, and ` +
            `\`${configSetCommand("daemon.auto-start", "true")}\` starts it for every launcher`,
        );
      }
      if (
        answerMeansStart(await deps.readAnswer("copilot proxy not running. Start it now? [Y/n] "))
      ) {
        await launch("visible");
      } else {
        deps.notify(
          `Continuing without the proxy; proxy-backed agents need it (run '${startHint}').`,
        );
      }
    }
  }
  deps.recordHeartbeat(profile);
  if (plannedStart || await deps.proxyUp(profile)) {
    await deps.printProxyToken(profile);
    return 0;
  }
  if (suppressedStart) {
    deps.notify(
      `copilot proxy failed to start (run '${startHint}' to see the error; no credential stored? run '${authHint}').`,
    );
  }
  return 1;
}

function commandDeps(): ProxyTokenDeps {
  return {
    proxyUp: async (profile) => (await proxyStatus(profile)).up,
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    launchProxy,
    readAnswer: readStartAnswer,
    recordHeartbeat,
    printProxyToken: (profile) => {
      runPrintProxyToken(profile);
      return Promise.resolve();
    },
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
    process.exitCode = await resolveProxyToken(action, commandDeps());
  };
  if (flags.dryRun) {
    await runDryRun(run);
    return;
  }
  await run();
}
