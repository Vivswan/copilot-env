// Process lifecycle helpers for finding, launching, and inspecting copilot-api.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { daemonConfigFile, readResolvedVersionRecord, writeDaemonConfig } from "../proxy_float.ts";
import { runCaptured } from "../utils/command.ts";
import { pidAlive } from "../utils/pid.ts";
import { type RootMode, rootMode } from "../utils/root.ts";
import { DAEMON_INTEGRATION_ID_ENV } from "./integration_identity.ts";
import { resolveRootHome } from "./paths.ts";
import { type DaemonShimFile, NODE_COMPAT_SHIM, shimPath } from "./shims.ts";
import type { AbsolutePath } from "./sidecar.ts";
import { PROXY_PACKAGE_NAME } from "./version.ts";

/**
 * How the floated copilot-api is addressed on a deno command line. The three forms are
 * distinct shapes rather than one string plus flags because each carries something the
 * others cannot: only a package specifier can take `--cached-only`, and only the floated
 * form has a DENO_DIR to point the resolve at.
 *
 * Every form carries the `configFile` it resolves under, chosen at resolve time so the
 * argv builder never has to guess -- and so an installed binary, which has no checkout
 * deno.json on disk, can never be handed one that does not exist.
 */
export type CopilotApiEntry =
  /** The `COPILOT_API_ENTRY` override: run this file, resolve nothing. */
  | { kind: "file"; path: string; configFile: string }
  /** The float's recorded resolution: an exact version in the cache it pre-warmed,
   *  resolved under the daemon config the float wrote beside the record. */
  | { kind: "floated"; specifier: string; version: string; denoDir: string; configFile: string }
  /** deno.json's mapped specifier: resolved through the frozen lock in a checkout,
   *  or through the generated daemon config on a compiled root. */
  | { kind: "package"; specifier: string; configFile: string };

/** The daemon config under `rootHome`, (re)generated from the embedded import map. The
 *  float rewrites this file with the same content on every warm, so regenerating here
 *  too costs nothing and means a stale or foreign file can never steer a compiled
 *  spawn. Covers the spawns that come BEFORE any float on a compiled install (a
 *  `COPILOT_API_ENTRY` override, the mapped fallback), where no other config can exist. */
function ensuredDaemonConfig(rootHome: string): string {
  writeDaemonConfig(rootHome);
  return daemonConfigFile(rootHome);
}

/**
 * The config a proxy spawn resolves under. A compiled root ALWAYS answers with the
 * daemon config, regenerated from the embedded assets -- an install root deliberately
 * carries no deno.json on disk (there it is a checkout marker), so it is the only
 * config that can exist. A checkout prefers the float's generated config and falls
 * back to its own deno.json. The preload shims resolve their own imports through
 * whichever it is, which is why every spawn passes one.
 */
function entryConfigFile(rootHome: string, mode: RootMode): string {
  if (mode.kind === "compiled") return ensuredDaemonConfig(rootHome);
  const daemonConfig = daemonConfigFile(rootHome);
  return existsSync(daemonConfig) ? daemonConfig : join(mode.root, "deno.json");
}

/**
 * The entry deno runs for the proxy, in precedence order:
 *
 * 1. `COPILOT_API_ENTRY` -- the explicit escape hatch. CI points `start` at a fake proxy
 *    so the daemon lifecycle runs without GitHub Copilot auth.
 * 2. The proxy float's resolved-version record: an exact version, run out of the DENO_DIR
 *    the float pre-warmed. This is the runtime answer on any install the float has run on.
 * 3. deno.json's import map -- resolved through the frozen lock in a checkout (the dev
 *    baseline), or through the generated daemon config on a compiled install where the
 *    float never ran (a Direct-only install).
 *
 * Both package forms keep `--cached-only`: the float pre-warms its cache and the lock
 * pre-warms node_modules, so neither launch has any business reaching the network.
 *
 * `mode` is injectable so tests can exercise the compiled split; the default is the
 * process's own RootMode, resolved once at startup.
 */
export function resolveCopilotApiEntry(mode: RootMode = rootMode()): CopilotApiEntry {
  const rootHome = resolveRootHome();
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) {
    return { kind: "file", path: override, configFile: entryConfigFile(rootHome, mode) };
  }
  const record = readResolvedVersionRecord(rootHome);
  if (record !== null) {
    // DELIBERATELY no regeneration here, unlike the other branches: rewriting at
    // resolve time could hand `--cached-only` an import map the recorded cache was
    // never warmed for. The verify/float gate ahead of every daemon start
    // (proxyFloatVerifyStatus) regenerates a stale build's config where a cache miss
    // can still trigger a re-warm; foreground runs keep the config that matches the
    // cache until then.
    return {
      kind: "floated",
      specifier: `npm:${PROXY_PACKAGE_NAME}@${record.version}`,
      version: record.version,
      denoDir: record.denoDir,
      configFile: daemonConfigFile(rootHome),
    };
  }
  return {
    kind: "package",
    specifier: PROXY_PACKAGE_NAME,
    configFile: mode.kind === "compiled"
      ? ensuredDaemonConfig(rootHome)
      : join(mode.root, "deno.json"),
  };
}

/**
 * The environment overlay `entry` needs on top of the caller's own. Only the floated
 * entry has one: its exact version lives in the float's DENO_DIR, not the default cache,
 * so the resolve must be pointed there or `--cached-only` would fail.
 */
export function copilotApiEnv(entry: CopilotApiEntry): Record<string, string> {
  return entry.kind === "floated" ? { DENO_DIR: entry.denoDir } : {};
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
 * `entry` is passed in by callers that also need `copilotApiEnv` for the SAME entry, so
 * the argv and the environment can never be built from two different resolutions.
 *
 * `--config` is always PINNED, never discovered: a package specifier has no directory to
 * discover from, so discovery would fall back to the caller's cwd and could pick up an
 * unrelated project's import map -- which the preload shims resolve their own imports
 * through. The entry already chose WHICH config (see entryConfigFile): the float's
 * generated one wherever it exists -- a compiled root generates it from the embedded
 * assets on demand, having no deno.json on disk at all -- because the checkout's
 * deno.json carries a frozen lock that rejects a floated version outright.
 *
 * `--cached-only` then guarantees the launch never reaches the network: the float
 * pre-warmed its own cache (proxy AND shims) for a floated entry, and the frozen lock
 * pre-warmed node_modules for the mapped one. `--node-modules-dir=none` on the floated
 * path keeps resolution inside that cache -- a compiled install has no node_modules.
 */
export function copilotApiArgv(
  subArgs: readonly string[],
  preloadFlags: readonly string[] = [],
  entry: CopilotApiEntry = resolveCopilotApiEntry(),
): string[] {
  return [
    "run",
    "--config",
    entry.configFile,
    ...(entry.kind === "file" ? [] : ["--cached-only"]),
    ...(entry.kind === "floated" ? ["--node-modules-dir=none"] : []),
    ...PROXY_PERMISSIONS,
    // FIRST, on every spawn: the proxy's dependency tree probes /proc at module load,
    // which deno's node compat turns into a thrown NotCapable instead of node's
    // documented `false`. Without this the proxy never reaches its own entry point on
    // Linux -- daemon or foreground `auth login` alike.
    "--preload",
    shimPath(NODE_COMPAT_SHIM),
    ...preloadFlags,
    entry.kind === "file" ? entry.path : entry.specifier,
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
  const { exitCode, stdout } = await runCaptured("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (exitCode !== 0) return "unknown";
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
  const { exitCode, stdout } = await runCaptured("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (exitCode !== 0) return [];

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
 * processes, where `ps` exits non-zero) degrades to no rows rather than aborting. The
 * raised maxBuffer keeps a process-heavy machine's listing from overflowing into that
 * degrade path and silently weakening the orphan scan.
 */
async function listUserProcesses(): Promise<ProcessRow[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const { exitCode, stdout } = await runCaptured("ps", ["-U", String(uid), "-o", "pid=,args="], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (exitCode !== 0) return [];
  return parseProcessRows(stdout);
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
  /** The daemon's home dir, pinned into COPILOT_API_HOME on EVERY spawn: since the
   *  data-home rename, the npm package's own default no longer matches ours, so an
   *  unpinned daemon would split its files from the wrapper's. */
  home: string;
  /** Extra daemon environment the launch pipeline assembles (sqlite path, root home). */
  env: Record<string, string>;
  credential: DaemonCredential;
  /** Arm the in-daemon idle auto-stop watchdog (the `auto-start` config key). */
  idleWatchdog: boolean;
  /** Discard the proxy's handler-log writes (the `proxy-logs` config key). */
  muteProxyLogs: boolean;
  /** What deno runs the proxy from. Resolved ONCE per launch and carried here so the
   *  argv and the environment derive from the same answer -- and so the bind-race
   *  relaunch reuses the identical entry rather than re-resolving mid-flight. */
  entry: CopilotApiEntry;
  /** The deno binary that runs the proxy. Resolved ONCE per launch beside `entry`, for
   *  the same reason: on a compiled install this is the provisioned sidecar, and the
   *  bind-race relaunch must spawn the identical binary rather than re-derive it. */
  denoBin: AbsolutePath;
}

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
  const shims: DaemonShimFile[] = [];
  if (spec.credential.kind !== "none") shims.push("token_argv_preload.ts");
  shims.push("daemon_runtime_preload.ts");
  if (spec.credential.kind === "pat") shims.push("pat_passthrough_preload.ts");
  if (spec.idleWatchdog) shims.push("idle_watchdog_preload.ts");
  if (spec.muteProxyLogs) shims.push("log_mute_preload.ts");
  return shims.flatMap((shim) => ["--preload", shimPath(shim)]);
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
  const env: NodeJS.ProcessEnv = { ...base, ...copilotApiEnv(spec.entry), ...spec.env };
  env.COPILOT_API_HOME = spec.home;
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
    spec.entry,
  );
}

/** Launch copilot-api as a detached daemon per `spec`. Returns the PID. */
export function launchDaemon(spec: DaemonSpec): number {
  const logFd = openSync(spec.logFile, "w");
  const devnull = openSync(devNull, "r");
  const proc = spawn(spec.denoBin, daemonArgv(spec), {
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
