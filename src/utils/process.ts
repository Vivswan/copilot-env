import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { join } from "node:path";
import { consola } from "consola";
import { execa } from "execa";
import psList from "ps-list";
import { cacheDir } from "./cache.ts";

const logger = consola;

// Resolve the bundled copilot-api entry by anchoring node's module
// resolution at the per-user cache (where bootstrap installs the pinned
// dep + applies patches). Node walks up from the anchor looking for
// node_modules/.
const cacheRequire = createRequire(join(cacheDir(), "_anchor.js"));

function resolveCopilotApiEntry(): string {
  try {
    return cacheRequire.resolve("@jeffreycao/copilot-api/dist/main.js");
  } catch (e) {
    throw new Error(
      `copilot-api not installed under ${cacheDir()}; run the bootstrap step: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** Read the installed gateway version from its package.json, or null if unresolved. */
export function copilotApiVersion(): string | null {
  try {
    const pkgPath = cacheRequire.resolve("@jeffreycao/copilot-api/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
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
  /** Find orphaned copilot-api daemon processes. */
  if (process.platform === "win32") {
    return getOrphanPidsWindows(myPid, myPpid);
  }
  return getOrphanPidsPosix(myPid, myPpid);
}

async function getOrphanPidsWindows(myPid: number, myPpid: number): Promise<number[]> {
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
    if (Number.isNaN(pid)) {
      continue;
    }
    if (pid === myPid || pid === myPpid) {
      continue;
    }
    pids.push(pid);
  }
  return pids;
}

async function getOrphanPidsPosix(myPid: number, myPpid: number): Promise<number[]> {
  // Best-effort, like the old `pgrep`: a failed scan degrades to no orphans
  // rather than aborting `start`. `all: false` restricts to the current user's
  // processes (mirrors `pgrep -u me`).
  const procs = await psList({ all: false }).catch(() => []);
  const pids: number[] = [];
  for (const proc of procs) {
    const cmd = proc.cmd ?? "";
    // Preserve the original `pgrep "copilot-api.*start"` shape: `copilot-api`
    // must appear BEFORE `start`, and `start` is word-bounded so we don't kill
    // unrelated processes that merely mention "start" (or "restart") near a path
    // containing "copilot-api".
    if (!/copilot-api.*\bstart\b/.test(cmd)) {
      continue;
    }
    if (cmd.includes("copilot-api.sh") || cmd.includes("copilot_api.py")) {
      continue;
    }
    if (proc.pid === myPid || proc.pid === myPpid) {
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
