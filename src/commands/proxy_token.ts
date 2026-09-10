// `agent proxy-token`: the proxy-mode credential resolver -- ensure the local
// copilot-api proxy for the addressed profile is up (per the managed-lifecycle rules
// below), then print its API key on stdout. It is what the proxy-mode Codex
// `auth.command` and Claude `apiKeyHelper` run (headless, `--yes`), what the cl/cx
// launchers run before a proxy-backed launch (interactive, no `--yes`), and equally
// usable by hand or from a script that needs the key.
//
// Stdout is sacred: the ONLY stdout write in any branch is the key line inside
// runPrintProxyToken -- callers eval/cache the output as a credential, and Claude
// Code hard-fails an apiKeyHelper whose stdout is anything but the single
// credential line. Everything else (the prompt, start noise, failure pointers)
// goes to stderr. Exit 0 with the key, exit 1 with an empty stdout otherwise.
//
// The LAUNCH stays a child `agent start` process on purpose: the daemon launch
// pipeline narrates freely to ITS stdout, and running it in-process would put that
// narration on OUR stdout. A child with stdout suppressed (managed branch) or
// redirected to our stderr (interactive branch) preserves the purity structurally.
// Both branches forward the child's stderr: that is where it names every file it
// writes, and a start that touches the disk unseen would be the one hidden write.
// The managed branch also ignores the child's stdin (the `</dev/null` shape): with
// no stored credential `agent start` would otherwise render an auth prompt whose
// output is suppressed here -- an invisible hang.
import { spawnSync } from "node:child_process";
import { proxyStatus, recordHeartbeat } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { runPrintProxyToken } from "./auth.ts";

/** Raw `agent proxy-token` flags, parsed at the CLI boundary into a ProxyTokenAction. */
export interface ProxyTokenFlags {
  /** `--yes`: the headless path -- never prompt (and never auto-start when unmanaged). */
  yes?: boolean;
  /** `--profile <name>`: address the named profile's isolated daemon. */
  profile?: string;
}

/** One resolver run: headless or interactive, addressed at `profile`'s daemon. */
export interface ProxyTokenAction {
  assumeYes: boolean;
  profile: Profile;
}

/** How the launched `agent start` child's output is handled: `suppressed` (the managed
 *  auto-start -- stdin and stdout ignored, stderr forwarded to ours) or `visible` (the
 *  interactive confirm -- stdin and stderr inherited, the child's stdout redirected to
 *  OUR stderr so start progress shows while our stdout stays clean for the key). */
export type LaunchOutput = "suppressed" | "visible";

/**
 * The resolver's effects, injectable so the decision matrix in resolveProxyToken is
 * unit-testable without daemons, TTYs, or child processes (the seam mirrors
 * launch.ts's LaunchCredentialDeps). Every member is daemon-scoped by `profile`
 * except the auto-start gate, which is the one account-wide preference.
 */
export interface ProxyTokenDeps {
  proxyUp(profile: Profile): Promise<boolean>;
  autoStartEnabled(): boolean;
  launchProxy(profile: Profile, output: LaunchOutput): void;
  /** Show `query` on stderr and read one answer line from stdin (EOF resolves ""). */
  readAnswer(query: string): Promise<string>;
  recordHeartbeat(profile: Profile): void;
  /** The step run once the proxy is confirmed up -- runPrintProxyToken in
   *  production (the key line, the sole stdout write). `agent launch` injects a
   *  keyless variant that keeps only its catalog-freshness side effect: launch
   *  needs reachability, not the credential. */
  printProxyToken(profile: Profile): Promise<void>;
  /** A human-facing stderr line (never stdout). */
  notify(line: string): void;
}

/** Launch `agent start [--profile <name>]` as a child (see LaunchOutput). Through
 *  bin/agent (agentLauncherCommand), NOT in-process: deno + deps get bootstrapped in a
 *  dev checkout, and the child's stdio placement keeps the caller's stdout untouched
 *  (key-only here, the launched agent's terminal in `agent launch`). The exit
 *  status is deliberately unread -- the follow-up proxyUp probe is the verdict.
 *  Exported as `agent launch`'s launchProxy dependency too, so the child-start
 *  shape is stated once. */
export function launchProxy(profile: Profile, output: LaunchOutput): void {
  const { command, args } = agentLauncherCommand(
    profile === null ? ["start"] : ["start", "--profile", profile],
  );
  spawnSync(command, args, {
    // `2` = our stderr fd: the visible child's start progress must show WITHOUT
    // touching our stdout (the .sh twin's `>&2`).
    stdio: output === "suppressed" ? ["ignore", "ignore", "inherit"] : ["inherit", 2, "inherit"],
    windowsHide: true,
  });
}

/**
 * Show `query` on stderr and read one raw answer line from stdin. Raw stdin data events,
 * NOT node:readline's question(): with stdin already CLOSED and no line ever arriving (the
 * redirected/headless shape) rl.question never settles, and EOF-resolves-to-"" is
 * load-bearing (EOF means START, the apiKeyHelper case). Piped lines DO deliver, so testing
 * only that case would not show the hang. Readline's prompt (and consola.prompt) also
 * write to stdout, which must stay key-only. Like the shells' `read -r`: a canonical-mode
 * TTY delivers a full echoed line, EOF with no line resolves "", and Ctrl-C stays the
 * terminal's SIGINT. Exported for the spawn-level EOF/answer test.
 */
export function readStartAnswer(query: string): Promise<string> {
  process.stderr.write(query);
  return new Promise((resolve) => {
    // String chunks split on character boundaries: per-chunk Buffer.toString could
    // mangle a multi-byte UTF-8 sequence straddling a chunk boundary.
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
    // EOF before a newline: whatever arrived (usually "") is the answer.
    const onEnd = (): void => finish(buf);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/** The confirm prompt's accepted "start it" answers: empty (the [Y/n] default -- EOF
 *  included) and y/yes in any letter case, the same answer set the shell resolvers took. */
function answerMeansStart(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

/**
 * The resolver decision matrix (pure orchestration over `deps`):
 * 1. Proxy down + managed lifecycle on -> auto-start silently (no prompt, even
 *    interactive: the opt-in is honored on every path).
 * 2. Proxy down + unmanaged + interactive -> offer to start; declining continues without.
 * 3. Proxy down + unmanaged + --yes -> never auto-start (headless callers opted out of the
 *    managed lifecycle; starting here would un-opt them).
 * Then always: heartbeat, re-probe, print the key ONLY if the proxy is actually up. Returns
 * 0 (key printed) or 1 (proxy down, with a stderr pointer when a silent auto-start hid it).
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
      // Remember we tried with the child's stdout (its narration) hidden, to point at a
      // hard failure below.
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

/** The production dependency set (see ProxyTokenDeps). */
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

/** `agent proxy-token`: parse the flags at the boundary and run the resolver.
 *  process.exitCode (never process.exit) so pending stderr writes flush. */
export async function runProxyToken(flags: ProxyTokenFlags): Promise<void> {
  const action: ProxyTokenAction = {
    assumeYes: Boolean(flags.yes),
    profile: parseProfileFlag(flags.profile),
  };
  process.exitCode = await resolveProxyToken(action, commandDeps());
}
