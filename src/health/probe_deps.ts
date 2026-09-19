// The injectable I/O surface behind `agent health`'s fact gathering (probe.ts): the spawns (gh,
// the pid scan, the agent CLIs, PowerShell's shell-target discovery, `command -v`), the network,
// the clock, and the two agent homes. Every store, config, and file read is a direct call in
// probe.ts against the isolated home the tests seed, so nothing else is faked. Tests hand
// gatherFacts a partial override of this record.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { jsonOutputReason, PROBE_TIMEOUT_MS, probeOutputLines } from "../agents/live_probe.ts";
import { resolveClaudeHome } from "../claude/paths.ts";
import { effectiveCodexHome } from "../codex/host.ts";
import {
  ghAccountsLookFromSpawn,
  ghAuthTokenLookAsync,
  type GhTokenLook,
  runGhSpecAsync,
} from "../copilot_api/credential.ts";
import { activeGhLogin, ghAuthStatusSpawnSpec } from "../copilot_api/gh_cli.ts";
import { classifyOwnedDaemonPid } from "../copilot_api/process.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { shellTargetFiles } from "../shell/integration.ts";
import {
  childEnvWithPath,
  cliSpawn,
  type CommandLook,
  findCommand,
  resolveCommand,
} from "../utils/command.ts";
import type { CodexDirectAuthFacts, LiveProbeFacts } from "./facts.ts";
import { claudeLiveLaunch, codexLiveLaunch, type LiveLaunch } from "./live_launch.ts";

export interface ProbeDeps {
  reach(url: string, timeoutMs: number): Promise<boolean>;
  /** Whether the responder at `url` carries copilot-api's x-trace-id identity header. */
  proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null>;
  /** Three-state identity of the tracked pid (classifyDaemonPid): "unknown" means the scan
   *  FAILED and must render as "could not verify", never as a confident "not tracked"; the
   *  boolean flatten this replaced read a broken scan as an orphan. */
  classifyTrackedPid(pid: number): Promise<"yes" | "no" | "unknown">;
  /** The clock the idle watchdog is judged against. */
  now(): number;
  /** Failure arm kept (see CommandLook): the CLI/tool census rows render "not installed"
   *  verdicts, so an unproven look must stay marked instead of flattening into "absent". */
  commandLook(command: string): CommandLook;
  shellTargets(): string[];
  codexHome(): string;
  claudeHome(): string;
  /** One `gh auth token` probe, pinned to `ghUser`'s account (null = gh's active). */
  codexDirectAuth(ghUser: string | null): Promise<CodexDirectAuthFacts>;
  /** The github.com login an auto gh-cli slot follows right now, or null. */
  ghActiveLogin(): Promise<string | null>;
  /** `--live` end-to-end prompts against the configured Codex/Claude homes;
   *  `profile` selects a named profile's wiring. */
  codexLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
  claudeLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
}

/** Probe the URL: any HTTP response (even an error status) means "reachable". */
async function reachUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** copilot-api stamps every response with an `x-trace-id` header: a cheap, unauthenticated
 *  identity marker. true when present, false when the responder answered without it (a foreign
 *  service on the port), null when nothing answered. */
async function proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.headers.has("x-trace-id");
  } catch {
    return null;
  }
}

/** A look's `unproven` (a spawn error, the timeout kill) marks the facts instead of flattening
 *  into a confident authenticated:false. `ghUser` records which pinned account the probe asked
 *  about; `ghCommand` the call that served a found token. */
function directAuthFromLook(
  command: string,
  look: GhTokenLook,
  ghUser: string | null,
): CodexDirectAuthFacts {
  const pinned = ghUser === null ? {} : { ghUser };
  const why = look.detail === undefined ? {} : { ghDetail: look.detail };
  if (look.unproven) {
    return { command, authenticated: false, unproven: true, ...pinned, ...why };
  }
  const served = look.command === undefined ? {} : { ghCommand: look.command };
  return { command, authenticated: look.token !== null, ...pinned, ...served, ...why };
}

/** Null when gh is absent, has no account, or the look never completed: naming only, never a
 *  verdict, so the flatten is safe. Async like codexDirectAuth so the status spawn overlaps the
 *  other probes; runGhSpecAsync captures both streams (older gh wrote the status to stderr) and a
 *  timeout kill reads as unproven, so a truncated list can never name the wrong account. */
async function ghActiveLoginProbe(): Promise<string | null> {
  const look = findCommand("gh");
  if (look.path === null) return null;
  const listing = ghAccountsLookFromSpawn(await runGhSpecAsync(ghAuthStatusSpawnSpec(look.path)));
  return listing.unproven ? null : activeGhLogin(listing.accounts);
}

async function codexDirectAuth(ghUser: string | null): Promise<CodexDirectAuthFacts> {
  // The failure arm is kept: this fact renders auth VERDICTS ("GitHub CLI not found", "not
  // authenticated"), so a look that never ran must arrive marked, not as a proven absence.
  const look = findCommand("gh");
  if (look.path === null) {
    return {
      command: null,
      authenticated: false,
      ...(look.launchFailed ? { unproven: true as const } : {}),
      ...(ghUser === null ? {} : { ghUser }),
    };
  }
  // The SAME recipe `agent auth` and every resolve run (ghAuthTokenSpawnSpec: ONE gh call, the
  // pinned `--user` form or the active account's), off the event loop so it overlaps the other
  // probes under gatherFacts' Promise.all. The token is read into memory with the rest of gh's
  // output and only the verdict and the serving call are kept.
  return directAuthFromLook(look.path, await ghAuthTokenLookAsync(ghUser, look.path), ghUser);
}

/** The CLI's output, line for line, so `agent health --live` shows the complete error: a JSON
 *  event that reports an error stands in as its reason text (jsonOutputReason), every other line
 *  is verbatim (the Direct-detect probe keeps one line instead: summarizeProbeFailure). With no
 *  output (a timeout kill: code null + signal) the bare exit/timeout status keeps the detail from
 *  being blank. */
function formatLiveFailure(
  code: number | null,
  signal: string | null,
  errorMessage: string | undefined,
  stdout: string,
  stderr: string,
): string {
  const lines = probeOutputLines(stdout, stderr).map((l) => jsonOutputReason(l.trim()) ?? l);
  if (lines.length) return lines.join("\n");
  if (errorMessage) return errorMessage;
  if (code === null && signal) {
    return `no response within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s (killed by ${signal})`;
  }
  return `exit ${code ?? "?"}`;
}

/**
 * Unlike the init probe, the environment is NOT sanitized (`--live` tests the real, fully
 * resolved setup), except `launch.omitEnv` (upper-case names): the narrow scrub a NAMED profile
 * needs so a shell export of the DEFAULT wiring cannot override the profile's own and
 * misattribute the answer. Spawns the RESOLVED path so the nvm fallback is not defeated. Exported
 * for the scrub's test.
 */
export function runLiveCli(
  launch: LiveLaunch,
  find: (command: string) => CommandLook = findCommand,
): Promise<LiveProbeFacts> {
  // `find` is a test seam; the real look keeps its failure arm (see CommandLook) because the
  // skip renders a "CLI not installed" verdict.
  const look = find(launch.cli);
  if (look.path === null) {
    return Promise.resolve(
      look.launchFailed ? { kind: "skipped", lookFailed: true } : { kind: "skipped" },
    );
  }
  const resolved = look.path;
  const ghPath = resolveCommand("gh");
  return new Promise((resolve) => {
    const s = cliSpawn(resolved, launch.args);
    // Output is captured so a failure reports the FULL reason. The 64 MB cap is effectively
    // unbounded (a smoke prompt's output is tiny) and only guards a pathologically chatty CLI.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    const child = spawn(s.file, s.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: s.shell,
      // The resolved CLI's and gh's bin dirs lead the child PATH so an nvm-only toolchain (a
      // node-shim CLI, the config's bare `gh` call) is reachable even when the parent never
      // sourced nvm.
      env: childEnvWithPath([dirname(resolved), ghPath ? dirname(ghPath) : null], {
        extra: launch.env,
        omit: (upper) => launch.omitEnv.includes(upper),
      }),
    });
    const CAP = 64 * 1024 * 1024;
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < CAP) out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < CAP) err += d.toString();
    });
    child.on("error", (e: Error) =>
      resolve({
        kind: "failed",
        cli: resolved,
        detail: formatLiveFailure(null, null, e.message, out, err),
      }));
    child.on("close", (code, signal) => {
      if (code === 0 && launch.answered(out)) {
        resolve({ kind: "ok", cli: resolved });
      } else {
        const reason = formatLiveFailure(code, signal, undefined, out, err);
        resolve({
          kind: "failed",
          cli: resolved,
          detail: code === 0 ? `exit 0 without a model answer\n${reason}` : reason,
        });
      }
    });
  });
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    reach: reachUrl,
    proxyIdentity,
    // The owner-gated three-state, not bare classifyDaemonPid: the boolean scan this replaced
    // was owner-filtered, so an elevated Windows health run must not start claiming another
    // user's daemon as our tracked pid.
    classifyTrackedPid: classifyOwnedDaemonPid,
    now: () => Date.now(),
    commandLook: findCommand,
    shellTargets: shellTargetFiles,
    codexHome: effectiveCodexHome,
    claudeHome: () => resolveClaudeHome(),
    codexDirectAuth,
    ghActiveLogin: ghActiveLoginProbe,
    codexLive: (home, profile) => runLiveCli(codexLiveLaunch(home, profile)),
    claudeLive: (home, profile) => runLiveCli(claudeLiveLaunch(home, profile)),
  };
}
