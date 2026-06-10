// Process lifecycle helpers for finding, launching, and inspecting copilot-api.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { join } from "node:path";
import { consola } from "consola";
import { execa } from "execa";
import psList from "ps-list";
import { PROJECT_ROOT } from "../utils/root.ts";

const logger = consola;

// Resolve the bundled copilot-api entry by anchoring node's module resolution at
// the in-place checkout where bootstrap installs the pinned dep + applies
// patches. An explicit path anchor (not import.meta) so node walks up from a
// stable directory looking for node_modules/.
const rootRequire = createRequire(join(PROJECT_ROOT, "_anchor.js"));

function resolveCopilotApiEntry(): string {
  // Escape hatch: an explicit entry path overrides module resolution. CI uses
  // this to point `start` at a fake gateway so the daemon lifecycle can be
  // exercised without GitHub Copilot auth.
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) {
    return override;
  }
  try {
    return rootRequire.resolve("@jeffreycao/copilot-api/dist/main.js");
  } catch (e) {
    throw new Error(
      `copilot-api not installed under ${PROJECT_ROOT}; run \`bun install --frozen-lockfile\` (or re-run the agent launcher) to install dependencies: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export function pidAlive(pid: number): boolean {
  /** Check if a process is alive. */
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
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

export function killProc(proc: ChildProcess): void {
  /** Kill a subprocess, ignoring errors. */
  try {
    proc.kill("SIGKILL");
  } catch (_e) {
    // ignore
  }
  // Best-effort wait; Node has no synchronous wait-with-timeout on a spawned child.
  // The Python `wait(timeout=2)` is mirrored by allowing the kill signal to propagate.
}

export function launchDaemon(
  port: number,
  logfile: string,
  extraEnv?: Record<string, string>,
): number {
  /** Launch copilot-api as a detached daemon. Returns the PID. */
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  const logFd = openSync(logfile, "w");
  const devnull = openSync(devNull, "r");
  const entry = resolveCopilotApiEntry();
  const proc = spawn(process.execPath, [entry, "start", "--verbose", "--port", String(port)], {
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
    throw new Error("Failed to spawn copilot-api daemon");
  }
  return proc.pid;
}

export function printLogTail(logfile: string, lines: number): void {
  /** Print the last N lines of a log file to stderr. */
  try {
    const allLines = readFileSync(logfile, "utf-8").split("\n");
    for (const line of allLines.slice(-lines)) {
      logger.error(line);
    }
  } catch (_e) {
    // ignore
  }
}
