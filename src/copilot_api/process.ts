// Process lifecycle helpers for finding, launching, and inspecting copilot-api.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import { pidAlive } from "../utils/pid.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { DAEMON_INTEGRATION_ID_ENV } from "./integration_identity.ts";
import { PROXY_PACKAGE_NAME } from "./version.ts";

/**
 * How the floated copilot-api is addressed on a deno command line. The two forms are
 * distinct shapes rather than one path plus a flag because `--cached-only` is only
 * meaningful for a package specifier -- a file override must never carry it.
 */
export type CopilotApiEntry =
  | { kind: "package"; specifier: string }
  | { kind: "file"; path: string };

/**
 * The entry deno runs for the proxy. deno.json's import map pins the proxy version, so
 * the bare package specifier IS the entry: deno resolves it through the frozen lock to
 * the installed release and runs its `copilot-api` bin. That keeps ONE source for the
 * version instead of restating it on every command line.
 */
export function resolveCopilotApiEntry(): CopilotApiEntry {
  // Escape hatch: an explicit entry path overrides the mapped package. CI uses this to
  // point `start` at a fake proxy so the daemon lifecycle can be exercised without
  // GitHub Copilot auth.
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) {
    return { kind: "file", path: override };
  }
  return { kind: "package", specifier: PROXY_PACKAGE_NAME };
}

/** The deno binary that runs the proxy. The one seam a packaged (sidecar) install
 *  re-points; every proxy spawn goes through it. */
export function resolveDenoBin(): string {
  return Deno.execPath();
}

/** The proxy's permission grants, rendered as a list rather than `-A` so the set stays
 *  visible: it reads and writes its daemon home, binds the loopback port, and reads env
 *  plus platform info. */
const PROXY_PERMISSIONS = [
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-sys",
] as const;

/**
 * The `deno run` argv that runs the floated copilot-api with `subArgs`, preceded by
 * `preloadFlags` (the daemon's `--preload` shim pairs; empty for a foreground run).
 *
 * `--config` pins THIS checkout's deno.json instead of letting deno discover one: a
 * package specifier has no directory to discover from, so discovery would fall back to
 * the caller's cwd and could pick up an unrelated project's import map -- which the
 * preload shims resolve their own imports through. The same file pins the proxy
 * version, which is why the package form needs no version string here, and
 * `--cached-only` then guarantees the launch never reaches the network.
 */
export function copilotApiArgv(
  subArgs: readonly string[],
  preloadFlags: readonly string[] = [],
): string[] {
  const entry = resolveCopilotApiEntry();
  return [
    "run",
    "--config",
    join(PROJECT_ROOT, "deno.json"),
    ...(entry.kind === "package" ? ["--cached-only"] : []),
    ...PROXY_PERMISSIONS,
    ...preloadFlags,
    entry.kind === "package" ? entry.specifier : entry.path,
    ...subArgs,
  ];
}

// The pid-liveness primitive lives in utils/pid.ts (the file-lock staleness check
// shares it); re-export it here so lifecycle callers keep their one import site.
export { pidAlive };

// THE daemon command-line signature (preserves the original `pgrep "copilot-api.*start"`
// shape): `copilot-api` must appear BEFORE `start`, and `start` is word-bounded so we
// don't match unrelated processes that merely mention "start" (or "restart") near a path
// containing "copilot-api". One source string: compiled below for the POSIX scan, and
// interpolated VERBATIM into the two single-quoted PowerShell `-match` scripts (the
// backslashes pass through argv unmangled; .NET regexes read `\b` the same way).
const DAEMON_CMDLINE_PATTERN = "copilot-api.*\\bstart\\b";
const DAEMON_CMDLINE_RE = new RegExp(DAEMON_CMDLINE_PATTERN);

/** How long an escalating teardown waits after SIGTERM before it SIGKILLs, shared by every
 *  path that must guarantee the daemon is gone. It also bounds the daemon's own drain:
 *  daemon_shutdown.ts keeps a separate literal (it loads in the daemon, which imports no CLI
 *  module) and test/daemon_spawn.test.ts pins the two in order. */
export const DAEMON_SIGKILL_GRACE_MS = 2_000;

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
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    "if (-not $p) { 'no' } " +
    "elseif ([string]::IsNullOrEmpty($p.CommandLine)) { 'unknown' } " +
    `elseif ($p.CommandLine -match '${DAEMON_CMDLINE_PATTERN}') { 'yes' } ` +
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

/** Process images that can host the daemon on Windows, where the command-line query
 *  filters by image name. `deno.exe` is what launchDaemon spawns today; `node.exe` and
 *  `bun.exe` exist only so an `agent update` from 3.5.6 or older (the last releases whose
 *  launcher ran the daemon under bun) can still find -- and stop -- the daemon that
 *  install left running. */
const WINDOWS_DAEMON_IMAGES = ["deno.exe", "node.exe", "bun.exe"] as const;

async function listCopilotApiPidsWindows(): Promise<number[]> {
  // Windows has no portable command-line column in `ps`, so match on the daemon's command
  // line via WMI: runtime processes whose CommandLine is the launch
  // (`<runtime> ... copilot-api ... start`). `wmic` is removed on newer Windows, so go
  // through PowerShell + Get-CimInstance. The signature is the shared
  // DAEMON_CMDLINE_PATTERN (same match as POSIX). Single quotes only, so the script
  // passes through argv quoting unmangled.
  //
  // Restrict to the CURRENT user's processes (GetOwner Domain+User == $env:USERDOMAIN/$env:USERNAME)
  // to mirror the POSIX `ps -U <uid>` (`pgrep -u me`): otherwise, from an elevated
  // shell, the scan would list OTHER users' daemons and the orphan sweep could kill them. Both
  // env vars (not `[WindowsIdentity]::GetCurrent()`, which is blocked under Constrained Language
  // Mode) keep this working everywhere, and matching Domain too avoids a same-username collision
  // across a local account and a domain account. A process whose owner can't be read (GetOwner
  // ReturnValue != 0) is excluded -- safer to skip an unconfirmed process than to signal another
  // user's.
  const nameTest = WINDOWS_DAEMON_IMAGES.map((image) => `$_.Name -eq '${image}'`).join(" -or ");
  const script = "Get-CimInstance Win32_Process | Where-Object { " +
    `(${nameTest}) ` +
    `-and $_.CommandLine -match '${DAEMON_CMDLINE_PATTERN}' ` +
    "} | Where-Object { " +
    "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue; " +
    "$o -and $o.ReturnValue -eq 0 -and $o.User -eq $env:USERNAME -and $o.Domain -eq $env:USERDOMAIN " +
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

/** One process as the POSIX scan reads it: its pid and full command line. */
export interface ProcessRow {
  pid: number;
  command: string;
}

/** Parse `ps -o pid=,args=` output: leading-blank-padded pid, one space, then the command
 *  line verbatim (which may itself contain runs of spaces, so only the pid is split off).
 *  Lines that are not pid-prefixed -- a header a future `ps` might emit, or a wrapped
 *  continuation -- are dropped rather than guessed at. */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number.parseInt(match[1] as string, 10), command: match[2] as string });
  }
  return rows;
}

/**
 * The current user's processes as (pid, command line) rows. `-U <uid>` restricts the scan
 * to OUR processes on both BSD (macOS) and procps (Linux) -- the orphan sweep SIGKILLs
 * what this returns, so an elevated shell must never see another user's daemons.
 * Best-effort, like the `pgrep` this descends from: any failure (including a user with no
 * processes, where `ps` exits non-zero) degrades to no rows rather than aborting.
 */
async function listUserProcesses(): Promise<ProcessRow[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  try {
    const { stdout } = await execa("ps", ["-U", String(uid), "-o", "pid=,args="]);
    return parseProcessRows(stdout);
  } catch {
    return [];
  }
}

async function listCopilotApiPidsPosix(): Promise<number[]> {
  const pids: number[] = [];
  for (const { pid, command } of await listUserProcesses()) {
    // The shared daemon signature (DAEMON_CMDLINE_PATTERN above).
    if (!DAEMON_CMDLINE_RE.test(command)) {
      continue;
    }
    if (command.includes("copilot-api.sh") || command.includes("copilot_api.py")) {
      continue;
    }
    pids.push(pid);
  }
  return pids;
}

/**
 * Env var carrying the provisioned GitHub token into the proxy daemon; the
 * token-argv preload (src/scripts/token_argv_preload.ts) reads it and splices it
 * onto process.argv as `--github-token`, keeping the secret off the
 * world-readable command line. The preload stays import-free, so it re-declares
 * this value as a literal -- test/daemon_env_keys.test.ts pins the two together.
 */
export const DAEMON_GH_TOKEN_ENV = "COPILOT_ENV_DAEMON_GH_TOKEN";

/**
 * The credential the daemon launches with, in the only three shapes that exist. A
 * passthrough credential ALWAYS carries its token -- the shim reads it back from argv,
 * so passthrough-without-a-token would load a shim that can do nothing -- which is why
 * `pat` is a variant rather than a boolean beside an optional token. It always carries an
 * `integrationId` too: resolvePassthroughIntegrationId falls back to the daemon's own
 * vscode-chat default rather than returning nothing, so "passthrough with no identity" is
 * a state the launch cannot produce.
 */
export type DaemonCredential =
  | { kind: "none" }
  | { kind: "token"; token: string }
  | { kind: "pat"; token: string; integrationId: string };

/** Everything the daemon spawn needs. The preload set and the credential environment are
 *  DERIVED from this (below), never passed alongside it, so no caller can hand over a
 *  combination the credential doesn't support. */
export interface DaemonSpec {
  port: number;
  logFile: string;
  /** Daemon-home / sqlite environment the launch pipeline assembles. */
  env: Record<string, string>;
  credential: DaemonCredential;
  /** Arm the in-daemon idle auto-stop watchdog (the `auto-start` config key). */
  idleWatchdog: boolean;
  /** Discard the proxy's handler-log writes (the `proxy-logs` config key). */
  muteProxyLogs: boolean;
}

const shimPath = (name: string): string => join(PROJECT_ROOT, "src", "scripts", name);

/**
 * The daemon's `--preload` pairs, in load order. Every shim is a RUNTIME shim that
 * touches none of copilot-api's files, so none of them pins the floated proxy version.
 *  - the token-argv shim FIRST, whenever a credential exists: it splices the token from
 *    an env var onto process.argv, and the PAT shim below reads it back from there.
 *  - the daemon-runtime shim, ALWAYS: it wraps Deno.serve to record inbound inference
 *    requests and to capture the server handle the shutdown path drains.
 *  - PAT passthrough, which fakes the editor token exchange so the token is used directly.
 *  - the idle watchdog, which stops the daemon once it has been idle past the timeout.
 *  - the log mute, which discards the daemon's handler-log writes under <home>/logs.
 */
function daemonPreloadFlags(spec: DaemonSpec): string[] {
  const shims: string[] = [];
  if (spec.credential.kind !== "none") shims.push(shimPath("token_argv_preload.ts"));
  shims.push(shimPath("daemon_runtime_preload.ts"));
  if (spec.credential.kind === "pat") shims.push(shimPath("pat_passthrough_preload.ts"));
  if (spec.idleWatchdog) shims.push(shimPath("idle_watchdog_preload.ts"));
  if (spec.muteProxyLogs) shims.push(shimPath("log_mute_preload.ts"));
  return shims.flatMap((shim) => ["--preload", shim]);
}

/**
 * Write the credential into the daemon's environment. Total over the union and always
 * set-OR-DELETE: the daemon starts from a copy of our own environment, so a value left
 * there by an earlier run would otherwise leak into a daemon whose credential does not
 * want it.
 *
 * The token travels through the ENVIRONMENT (owner-only: /proc/<pid>/environ is 0600 and
 * `ps e` shows only your own processes), never the argv -- the token-argv shim splices it
 * back onto process.argv in-process as `--github-token`, so the proxy uses it in-memory
 * (never writing its own github_token file, leaving a device-flow login untouched) while
 * the secret stays off the world-readable command line.
 */
function applyCredentialEnv(env: NodeJS.ProcessEnv, credential: DaemonCredential): void {
  if (credential.kind === "none") {
    delete env[DAEMON_GH_TOKEN_ENV];
  } else {
    env[DAEMON_GH_TOKEN_ENV] = credential.token;
  }
  if (credential.kind === "pat") {
    env[DAEMON_INTEGRATION_ID_ENV] = credential.integrationId;
    // The passthrough shim relies on copilot-api's DEFAULT path (which sends the
    // vscode-chat editor headers the token needs). An inherited
    // COPILOT_API_OAUTH_APP=opencode would put copilot-api in opencode mode and strip
    // those headers, so scrub it.
    delete env.COPILOT_API_OAUTH_APP;
  } else {
    delete env[DAEMON_INTEGRATION_ID_ENV];
  }
}

/** Loopback hosts that must never be routed through an outbound HTTP proxy: the daemon's
 *  own admin traffic and every local client's calls to it. Deno honours HTTP_PROXY for
 *  loopback too, so a corporate proxy environment would otherwise swallow them. */
const LOOPBACK_NO_PROXY = ["127.0.0.1", "::1", "localhost"] as const;

/** `current` with the loopback hosts appended -- the user's own entries are always kept,
 *  never replaced, and an entry already present is not duplicated. */
export function noProxyWithLoopback(current: string | undefined): string {
  const entries = (current ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  for (const host of LOOPBACK_NO_PROXY) {
    if (!entries.some((e) => e.toLowerCase() === host)) entries.push(host);
  }
  return entries.join(",");
}

/**
 * The daemon's full environment. `base` (our own) is inherited wholesale, so TLS and
 * outbound-proxy settings -- DENO_TLS_CA_STORE, NODE_EXTRA_CA_CERTS, HTTP_PROXY/HTTPS_PROXY
 * -- reach the daemon exactly as the user set them for us; the spec's home wiring, the
 * credential, and the loopback proxy exemption are layered on top. Pure, so the whole
 * environment contract is testable without spawning anything.
 */
export function daemonEnvironment(spec: DaemonSpec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...spec.env };
  applyCredentialEnv(env, spec.credential);
  // Read either spelling (a user may have set only one) and write BOTH, so the exemption
  // holds whichever name the HTTP client happens to consult first.
  const noProxy = noProxyWithLoopback(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  // A detached daemon must never stall on (or log) a release probe at startup.
  env.DENO_NO_UPDATE_CHECK = "1";
  return env;
}

/** The full `deno run` argv for the daemon spawn. Pure: what the daemon is launched with
 *  is inspectable without launching it. */
export function daemonArgv(spec: DaemonSpec): string[] {
  return copilotApiArgv(
    ["start", "--verbose", "--port", String(spec.port)],
    daemonPreloadFlags(spec),
  );
}

/** Launch copilot-api as a detached daemon per `spec`. Returns the PID. */
export function launchDaemon(spec: DaemonSpec): number {
  const logFd = openSync(spec.logFile, "w");
  const devnull = openSync(devNull, "r");
  const proc = spawn(resolveDenoBin(), daemonArgv(spec), {
    stdio: [devnull, logFd, logFd],
    detached: true,
    // No console window on Windows (defensive; redirected stdio already avoids one).
    windowsHide: true,
    env: daemonEnvironment(spec, process.env),
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
