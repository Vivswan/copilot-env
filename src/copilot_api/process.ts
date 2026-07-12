// Process lifecycle helpers for finding, launching, and inspecting copilot-api.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import psList from "ps-list";
import { errMessage } from "../utils/error.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

// Resolve the bundled copilot-api entry by anchoring node's module resolution at
// the in-place checkout where bootstrap installs the pinned dep. An explicit path
// anchor (not import.meta) so node walks up from a
// stable directory looking for node_modules/.
const rootRequire = createRequire(join(PROJECT_ROOT, "_anchor.js"));

export function resolveCopilotApiEntry(): string {
  // Escape hatch: an explicit entry path overrides module resolution. CI uses
  // this to point `start` at a fake proxy so the daemon lifecycle can be
  // exercised without GitHub Copilot auth.
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) {
    return override;
  }
  try {
    return rootRequire.resolve("@jeffreycao/copilot-api/dist/main.js");
  } catch (e) {
    throw new Error(
      `the proxy is not installed under ${PROJECT_ROOT}; run \`bun install --frozen-lockfile\` (or re-run the agent launcher) to install dependencies: ${errMessage(
        e,
      )}`,
    );
  }
}

export function pidAlive(pid: number): boolean {
  /** Check if a process is alive. */
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process EXISTS but this (restricted/sandboxed) token can't signal it --
    // e.g. Codex's packaged app spawning our probe. That is still "alive"; only ESRCH is dead.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminate `pid`: SIGTERM, then -- when `graceMs > 0` -- wait that long and SIGKILL
 * if it's still alive. Signal errors (e.g. ESRCH on an already-gone pid) are
 * swallowed. The caller must confirm `pid` is OURS (PID-reuse guard) before calling.
 * `graceMs: 0` sends a single SIGTERM with no force-kill escalation.
 */
export async function terminatePid(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (graceMs > 0) {
    await sleep(graceMs);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export function getOrphanPids(myPid: number, myPpid: number): Promise<number[]> {
  /** Find orphaned copilot-api daemon processes (excluding us + our parent). */
  return listCopilotApiPids().then((pids) => pids.filter((p) => p !== myPid && p !== myPpid));
}

/**
 * True if `pid` is *currently* a running copilot-api daemon. Used before
 * signalling a pid read from state, so PID reuse (the OS recycling a stale pid
 * onto an unrelated process) can't make us SIGTERM something that isn't ours.
 * Best-effort: a failed scan returns false (treat as "not ours / gone").
 */
export async function isCopilotApiPid(pid: number): Promise<boolean> {
  return (await listCopilotApiPids()).includes(pid);
}

/**
 * Liveness-grade identity of `pid`: is it OUR copilot-api daemon, definitely some OTHER process
 * (PID reuse), or UNKNOWABLE because the caller's token can't read its identity?
 *   - "yes":     the command line confirms `copilot-api ... start`
 *   - "no":      the pid is gone, or a different, identifiable process
 *   - "unknown": the OS would not reveal the pid's command line -- a restricted/sandboxed caller
 *                like Codex's packaged app, where WMI can't read other processes' command lines
 *
 * proxyStatus uses this so "unknown" falls back to the port probe instead of false-reporting a
 * healthy proxy as down. isCopilotApiPid stays a plain boolean for the terminate/orphan paths,
 * which must NOT act on an unconfirmed pid (a failed scan there correctly reads as "not ours").
 */
export async function classifyDaemonPid(pid: number): Promise<"yes" | "no" | "unknown"> {
  if (process.platform === "win32") return classifyDaemonPidWindows(pid);
  return (await listCopilotApiPidsPosix()).includes(pid) ? "yes" : "no";
}

async function classifyDaemonPidWindows(pid: number): Promise<"yes" | "no" | "unknown"> {
  // Query the SPECIFIC pid so we can tell a "different process" (CommandLine present, no match)
  // from "unreadable" (CommandLine null -- a restricted token). `pid` is our own integer from
  // state, so inlining it is safe. A wholesale CIM failure (access denied) also reads "unknown".
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    "if (-not $p) { 'no' } " +
    "elseif ([string]::IsNullOrEmpty($p.CommandLine)) { 'unknown' } " +
    "elseif ($p.CommandLine -match 'copilot-api.*\\bstart\\b') { 'yes' } " +
    "else { 'no' }";
  let stdout: string;
  try {
    ({ stdout } = await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]));
  } catch {
    return "unknown";
  }
  const verdict = stdout.trim();
  return verdict === "yes" || verdict === "no" ? verdict : "unknown";
}

/** All copilot-api daemon pids of the current user (best-effort, no exclusions). */
function listCopilotApiPids(): Promise<number[]> {
  return process.platform === "win32" ? listCopilotApiPidsWindows() : listCopilotApiPidsPosix();
}

async function listCopilotApiPidsWindows(): Promise<number[]> {
  // ps-list can't see command lines on Windows (fastlist returns name/pid/ppid
  // only), so match on the daemon's command line via WMI: node/bun processes
  // whose CommandLine is the launch (`<runtime> .../copilot-api/.../main.js start`).
  // `wmic` is removed on newer Windows, so go through PowerShell + Get-CimInstance.
  // The `copilot-api.*start` pattern (copilot-api before a word-bounded start)
  // mirrors the POSIX match. Single quotes only, so the script passes through
  // argv quoting unmangled.
  const script =
    "Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -eq 'node.exe' -or $_.Name -eq 'bun.exe') " +
    "-and $_.CommandLine -match 'copilot-api.*\\bstart\\b' " +
    "} | ForEach-Object { $_.ProcessId }";
  let stdout: string;
  try {
    ({ stdout } = await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]));
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isNaN(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

async function listCopilotApiPidsPosix(): Promise<number[]> {
  // Best-effort, like the old `pgrep`: a failed scan degrades to none rather
  // than aborting. `all: false` restricts to the current user's processes
  // (mirrors `pgrep -u me`).
  const procs = await psList({ all: false }).catch(() => []);
  const pids: number[] = [];
  for (const proc of procs) {
    const cmd = proc.cmd ?? "";
    // Preserve the original `pgrep "copilot-api.*start"` shape: `copilot-api`
    // must appear BEFORE `start`, and `start` is word-bounded so we don't match
    // unrelated processes that merely mention "start" (or "restart") near a path
    // containing "copilot-api".
    if (!/copilot-api.*\bstart\b/.test(cmd)) {
      continue;
    }
    if (cmd.includes("copilot-api.sh") || cmd.includes("copilot_api.py")) {
      continue;
    }
    pids.push(proc.pid);
  }
  return pids;
}

export function launchDaemon(
  port: number,
  logfile: string,
  extraEnv?: Record<string, string>,
  githubToken?: string,
  patPassthrough?: boolean,
  idleWatchdog?: boolean,
  muteProxyLogs?: boolean,
): number {
  /** Launch copilot-api as a detached daemon. Returns the PID. */
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  const logFd = openSync(logfile, "w");
  const devnull = openSync(devNull, "r");
  const entry = resolveCopilotApiEntry();
  // bun flags go BEFORE the entry script, as `--preload <shim>` pairs (runtime shims
  // that touch none of copilot-api's files, so neither pins the floated proxy version):
  //  - the inference-activity observer (ALWAYS loaded) wraps Bun.serve so inbound inference
  //    POSTs are recorded for the idle watchdog and `agent health` (see inference_activity.ts).
  //  - PAT passthrough wraps the daemon's globalThis.fetch to fake the editor token
  //    exchange so a PAT is used directly (see pat_passthrough_preload.ts).
  //  - the idle watchdog arms an in-daemon timer that exits the process when idle, so the
  //    server and its watchdog are one unit (see idle_watchdog.ts).
  //  - the log mute discards the daemon's handler-log writes under <home>/logs
  //    (see log_mute_preload.ts).
  const bunFlags: string[] = [
    "--preload",
    join(PROJECT_ROOT, "src/scripts/inference_activity_preload.ts"),
  ];
  if (patPassthrough) {
    bunFlags.push("--preload", join(PROJECT_ROOT, "src/scripts/pat_passthrough_preload.ts"));
  }
  if (idleWatchdog) {
    bunFlags.push("--preload", join(PROJECT_ROOT, "src/scripts/idle_watchdog_preload.ts"));
  }
  if (muteProxyLogs) {
    bunFlags.push("--preload", join(PROJECT_ROOT, "src/scripts/log_mute_preload.ts"));
  }
  if (patPassthrough) {
    // The shim relies on copilot-api's DEFAULT path (which sends the vscode-chat editor
    // headers the token needs). An inherited COPILOT_API_OAUTH_APP=opencode would put
    // copilot-api in opencode mode and strip those headers, so scrub it.
    delete env.COPILOT_API_OAUTH_APP;
  }
  const args = [...bunFlags, entry, "start", "--verbose", "--port", String(port)];
  // A token provisioned via `agent auth` (stored in our state) is handed to the
  // daemon as `--github-token`: copilot-api uses it in-memory and does NOT write it
  // to its own github_token file, so an existing device-flow login is untouched. The
  // preload shim above also reads the PAT from this flag.
  if (githubToken) {
    args.push("--github-token", githubToken);
  }
  const proc = spawn(process.execPath, args, {
    stdio: [devnull, logFd, logFd],
    detached: true,
    // No console window on Windows (defensive; redirected stdio already avoids one).
    windowsHide: true,
    env,
  });
  proc.unref();
  closeSync(devnull);
  closeSync(logFd);
  if (proc.pid === undefined) {
    throw new Error("Failed to start the proxy; check `agent health` and retry `agent start`");
  }
  return proc.pid;
}

export function printLogTail(logfile: string, lines: number): void {
  /** Print the last N lines of a log file to stderr. */
  try {
    const allLines = readFileSync(logfile, "utf-8").split("\n");
    const tail = allLines.slice(-lines).join("\n");
    // Write the daemon's own log verbatim to stderr -- NOT line-by-line through
    // consola.error. copilot-api already formats its lines, and routing each one
    // through a tagged ERROR badge (including the blank lines inside its stack
    // traces) produced large padded gaps that buried the real failure. The header is
    // written raw too, so it doesn't carry a mismatched consola ERROR badge.
    process.stderr.write(`\n--- proxy log tail (${logfile}) ---\n${tail}\n`);
  } catch (_e) {
    // ignore
  }
}
