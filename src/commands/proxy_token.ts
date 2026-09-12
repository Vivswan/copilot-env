// Codex's `auth.command` and Claude's `apiKeyHelper` run this headless (`--yes`); the cl/cx
// launchers run it interactively. Claude Code hard-fails an apiKeyHelper whose stdout is anything
// but the single credential line, so the only stdout write in any branch is the key line inside
// runPrintProxyToken.
//
// The launch stays a child `agent start` on purpose: the launch pipeline narrates to its own
// stdout, and in-process that would land on ours.
//
//   child stderr  -> always forwarded: that is where it names every file it writes
//   child stdin   -> ignored on the managed branch: with no stored credential `agent start` would
//                    render an auth prompt whose output is suppressed here, an invisible hang
import { spawnSync } from "node:child_process";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { runPrintProxyToken } from "./auth.ts";

export interface ProxyTokenFlags {
  yes?: boolean;
  profile?: string;
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
  launchProxy(profile: Profile, output: LaunchOutput): void;
  /** Prompts on stderr; EOF resolves "". */
  readAnswer(query: string): Promise<string>;
  recordHeartbeat(profile: Profile): void;
  /** runPrintProxyToken in production. `agent launch` injects a keyless variant that keeps only the
   *  catalog-freshness side effect: launch needs reachability, not the credential. */
  printProxyToken(profile: Profile): Promise<void>;
  /** stderr, never stdout. */
  notify(line: string): void;
}

/** Through bin/agent rather than in-process, so a dev checkout bootstraps deno and deps there.
 *   the child's stdio  -> placed so the caller's stdout stays untouched
 *   the exit status    -> unread; the follow-up proxyUp probe is the verdict
 *   `agent launch`     -> injects this as its own launchProxy dependency */
export function launchProxy(profile: Profile, output: LaunchOutput): void {
  const { command, args } = agentLauncherCommand(
    profile === null ? ["start"] : ["start", "--profile", profile],
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
  process.stderr.write(query);
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
  const startHint = profile === null ? "agent start" : `agent start --profile ${profile}`;
  let suppressedStart = false;
  if (!(await deps.proxyUp(profile))) {
    if (deps.autoStartEnabled()) {
      deps.launchProxy(profile, "suppressed");
      suppressedStart = true;
    } else if (!action.assumeYes) {
      if (
        answerMeansStart(await deps.readAnswer("copilot proxy not running. Start it now? [Y/n] "))
      ) {
        deps.launchProxy(profile, "visible");
      } else {
        deps.notify(
          `Continuing without the proxy; proxy-backed agents need it (run '${startHint}').`,
        );
      }
    }
  }
  deps.recordHeartbeat(profile);
  if (await deps.proxyUp(profile)) {
    await deps.printProxyToken(profile);
    return 0;
  }
  if (suppressedStart) {
    deps.notify(`copilot proxy failed to start (run '${startHint}' to see the error).`);
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
    printProxyToken: (profile) => runPrintProxyToken(profile),
    notify: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** process.exitCode, never process.exit, so pending stderr writes flush. */
export async function runProxyToken(flags: ProxyTokenFlags): Promise<void> {
  const action: ProxyTokenAction = {
    assumeYes: Boolean(flags.yes),
    profile: parseProfileFlag(flags.profile),
  };
  process.exitCode = await resolveProxyToken(action, commandDeps());
}
