import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
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
 * Three shapes rather than one string plus flags: only a package specifier can take `--cached-only`,
 * and only the floated form has a DENO_DIR to point the resolve at. Every form carries its
 * `configFile`, chosen at resolve time, so an installed binary (no checkout deno.json on disk) is
 * never handed a config that does not exist.
 */
export type CopilotApiEntry =
  /** The `COPILOT_API_ENTRY` override: run this file, resolve nothing. */
  | { readonly kind: "file"; readonly path: string; readonly configFile: string }
  /** An exact version in the cache the float pre-warmed, under the daemon config it wrote beside the record. */
  | {
    readonly kind: "floated";
    readonly specifier: string;
    readonly version: string;
    readonly denoDir: string;
    readonly configFile: string;
  }
  /** deno.json's mapped specifier: resolved through the frozen lock in a checkout,
   *  or through the generated daemon config on a compiled root. */
  | { readonly kind: "package"; readonly specifier: string; readonly configFile: string };

/** Regenerated on every call (the float rewrites the same content on every warm), so a stale or
 *  foreign file can never steer a compiled spawn, including the spawns before any float ran. */
function ensuredDaemonConfig(rootHome: string): string {
  writeDaemonConfig(rootHome);
  return daemonConfigFile(rootHome);
}

/**
 * A compiled root ALWAYS answers with the daemon config: an install root deliberately carries no
 * deno.json on disk (there it is a checkout marker). The preload shims resolve their own imports
 * through whichever config is passed, which is why every spawn passes one.
 */
function entryConfigFile(rootHome: string, mode: RootMode): string {
  if (mode.kind === "compiled") return ensuredDaemonConfig(rootHome);
  const daemonConfig = daemonConfigFile(rootHome);
  return existsSync(daemonConfig) ? daemonConfig : join(mode.root, "deno.json");
}

/**
 * `COPILOT_API_ENTRY` is the escape hatch: CI points `start` at a fake proxy so the daemon lifecycle
 * runs without GitHub Copilot auth. A compiled install where the float never ran is Direct-only.
 */
export function resolveCopilotApiEntry(mode: RootMode = rootMode()): CopilotApiEntry {
  const rootHome = resolveRootHome();
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) {
    return { kind: "file", path: override, configFile: entryConfigFile(rootHome, mode) };
  }
  const record = readResolvedVersionRecord(rootHome);
  if (record !== null) {
    // No regeneration here, unlike the other branches: a rewritten import map could be one the
    // recorded cache was never warmed for, and `--cached-only` would then fail. The float gate ahead
    // of every daemon start (proxyFloatVerifyStatus) regenerates where a re-warm can still follow.
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

/** Only the floated entry's version lives outside the default cache, so only it needs the resolve pointed
 *  at its DENO_DIR or `--cached-only` fails. */
export function copilotApiEnv(entry: CopilotApiEntry): Record<string, string> {
  return entry.kind === "floated" ? { DENO_DIR: entry.denoDir } : {};
}

/** Listed rather than `-A` so the grant set stays visible. */
const PROXY_PERMISSIONS = [
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-sys",
] as const;

/** `entry` is passed in by callers that also need copilotApiEnv for the SAME entry, so the argv and the
 *  environment can never be built from two different resolutions. */
export function copilotApiArgv(
  subArgs: readonly string[],
  preloadFlags: readonly string[] = [],
  entry: CopilotApiEntry = resolveCopilotApiEntry(),
): string[] {
  return [
    "run",
    // Always PINNED: a package specifier has no directory to discover a config from, so discovery would
    // fall back to the caller's cwd and could pick up an unrelated project's import map, which the
    // preload shims resolve their own imports through. A checkout's deno.json carries a frozen lock
    // that rejects a floated version outright, hence the float's generated config wherever it exists.
    "--config",
    entry.configFile,
    // Never reach the network: the float pre-warmed its cache for a floated entry and the frozen lock
    // pre-warmed node_modules for the mapped one; a compiled install has no node_modules at all.
    ...(entry.kind === "file" ? [] : ["--cached-only"]),
    ...(entry.kind === "floated" ? ["--node-modules-dir=none"] : []),
    ...PROXY_PERMISSIONS,
    // FIRST, on every spawn: the proxy's dependency tree probes /proc at module load, which deno's node
    // compat turns into a thrown NotCapable instead of node's documented `false`, so on Linux the proxy
    // never reaches its own entry point without it.
    "--preload",
    shimPath(NODE_COMPAT_SHIM),
    ...preloadFlags,
    entry.kind === "file" ? entry.path : entry.specifier,
    ...subArgs,
  ];
}

// Re-exported so lifecycle callers keep one import site; the file-lock staleness check shares the primitive.
export { pidAlive };

// THE daemon signature, pinned by test/daemon_spawn.test.ts. The sweep SIGKILLs what it matches, so every
// tolerance below biases against false positives: a substring match once killed an agent CLI whose prompt
// text mentioned copilot-api and start. A match needs a whole daemon-shaped invocation:
//   runtime (DAEMON_RUNTIMES)  -> from the process table, never argv text
//   MIDDLE_TOKEN*              -> every token up to the entry is invocation-shaped
//   ENTRY_TOKEN                -> a path segment starting with `copilot-api`
//   `start`                    -> the very next token
// Accepted residual: a runtime whose flag VALUE is a copilot-api-segment path followed by a literal `start`.

/** Both scans gate on the process table's executable name (ps `ucomm`, the WMI image Name) derived from
 *  this list, never on argv text, where a spaced executable path is indistinguishable from arguments.
 *    node, bun                                  -> only for daemons left running by pre-rewrite installs
 *    a renamed deno (COPILOT_ENV_SIDECAR_DENO)  -> unmatched, an accepted loss */
const DAEMON_RUNTIMES = ["deno", "node", "bun"] as const;
const RUNTIME_ALTERNATION = DAEMON_RUNTIMES.join("|");

// Each alternative consumes exactly one whitespace-delimited token and the classes are disjoint (a fragment
// may not start with a dash, or it would overlap the flag class), so middle parsing never backtracks
// combinatorially. A bare word breaks the match: every tolerance for bare words re-admits crafted impostor argv.
//   `/Users/John Smith/.deno/bin/deno`  -> two slash fragments, still matches
//   `/x/Deno Runtime Tools/deno`        -> the slash-less `Runtime` breaks it: accepted loss
const MIDDLE_TOKEN =
  `run|${RUNTIME_ALTERNATION}|-[^\\s"]*|(?:[^\\s"\\\\/-][^\\s"\\\\/]*)?[\\\\/][^\\s"]*`;
// A path segment STARTING with `copilot-api` (an npm specifier, a node_modules path, a COPILOT_API_ENTRY
// file), never the bare word. A POSIX entry whose own name contains a space is an accepted loss.
const ENTRY_TOKEN = '[^\\s"]*[\\\\/]copilot-api[^\\s"]*';

/** No quoted forms: ps output has shell quoting already stripped, so a literal quote character is
 *  prompt text and must not bridge bare words. */
const DAEMON_INVOCATION_RE = new RegExp(
  `^\\s*(?:(?:${MIDDLE_TOKEN})\\s+)*${ENTRY_TOKEN}\\s+start(?:\\s|$)`,
);

/** Windows CommandLine includes argv[0] and quotes paths with spaces (the OS's own convention), so quoted
 *  middle and entry forms are admitted here; the image NAME is gated separately in the PS scripts. The
 *  pattern is interpolated VERBATIM into single-quoted PowerShell `-match` scripts, and .NET reads it the
 *  same way, so DAEMON_CMDLINE_RE pins its semantics from here. */
const DAEMON_CMDLINE_PATTERN =
  `^\\s*(?:"[^"]*[\\\\/](?:${RUNTIME_ALTERNATION})(?:\\.exe)?"|(?:[^\\s"]*[\\\\/])?(?:${RUNTIME_ALTERNATION})(?:\\.exe)?)\\s+` +
  `(?:(?:${MIDDLE_TOKEN}|"[^"]*")\\s+)*` +
  `(?:"[^"]*[\\\\/]copilot-api[^"]*"|${ENTRY_TOKEN})\\s+start(?:\\s|$)`;
const DAEMON_CMDLINE_RE = new RegExp(DAEMON_CMDLINE_PATTERN);

/** Exported for the impostor/orphan fixtures in test/daemon_spawn.test.ts. */
export function isDaemonProcess(row: ProcessRow): boolean {
  if (!(DAEMON_RUNTIMES as readonly string[]).includes(row.ucomm)) return false;
  return DAEMON_INVOCATION_RE.test(row.command);
}

/** Mirrors the PowerShell `-match` scripts so test/daemon_spawn.test.ts pins the interpolated pattern's semantics. */
export function isDaemonCommandLine(command: string): boolean {
  return DAEMON_CMDLINE_RE.test(command);
}

/** Also bounds the daemon's own drain: daemon_shutdown.ts keeps a separate literal (it loads in the
 *  daemon, which imports no CLI module) and test/daemon_spawn.test.ts pins the two in order. */
export const DAEMON_SIGKILL_GRACE_MS = 2_000;

/** One arm per decision the escalation makes, so callers report what happened instead of guessing
 *  from a follow-up pidAlive read. */
export type TerminateVerdict =
  /** Nothing waited for or verified; a dead pid's ESRCH is swallowed, so this arm never claims a
   *  death it did not observe. */
  | "term-only"
  /** No longer alive at the KILL boundary (the TERM sufficed, or it was already gone). */
  | "died-in-grace"
  /** classify answered "yes", or the deliberate kill-on-"unknown" (same signal, same standing, so no
   *  separate arm). */
  | "killed"
  /** A confident "no" at the KILL boundary: OUR daemon died inside the grace and the OS recycled the
   *  pid onto a foreign process, which was spared. The tracked daemon is provably gone. */
  | "refused-reused-pid";

/**
 * The caller proves `pid` is OURS before calling, but that authorizes the SIGTERM only: the grace is
 * long enough for the OS to recycle a died-in-grace pid, so the KILL re-proves identity at its own
 * signal boundary (the rule stopLockHolder and the orphan sweep in launch.ts share). `classify` is
 * the test seam.
 */
export async function terminatePid(
  pid: number,
  graceMs: number,
  classify: (pid: number) => Promise<"yes" | "no" | "unknown"> = classifyDaemonPid,
): Promise<TerminateVerdict> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (!(graceMs > 0)) return "term-only"; // a NaN never escalates
  await sleep(graceMs);
  if (!pidAlive(pid)) return "died-in-grace";
  // Three-state on purpose: a boolean isCopilotApiPid re-check would read a FAILED scan as "not ours"
  // and strand the stop behind a flaky process table.
  const verdict = await classify(pid);
  if (verdict === "no") {
    consola.warn(
      `Not escalating pid ${pid} to SIGKILL: it no longer identifies as our copilot-api daemon, and the pid may now belong to a different process.`,
    );
    return "refused-reused-pid";
  }
  // "unknown" KILLs deliberately: every terminatePid caller gated its TERM on an identity read at least
  // as demanding as this gate, and refusing would strand every stop behind a transient scan failure,
  // permanently so where identity is never readable (a restricted token, e.g. Windows Constrained
  // Language Mode).
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return "killed";
}

/** "unproven" rides to the consumer (listUntrackedOrphans SAYS the sweep is skipped) instead of a
 *  broken process table silently reading as "no orphans". */
export function getOrphanPids(
  myPid: number,
  myPpid: number,
): Promise<number[] | "unproven"> {
  return scanCopilotApiPids().then((scan) =>
    scan === "unproven" ? scan : scan.filter((p) => p !== myPid && p !== myPpid)
  );
}

/** Gates a signal on a pid read from state, so a failed scan reads false: never signal what this
 *  host cannot prove. */
export async function isCopilotApiPid(pid: number): Promise<boolean> {
  return (await listCopilotApiPids()).includes(pid);
}

/**
 * proxyStatus needs the three states so "unknown" falls back to the port probe instead of reporting
 * a healthy proxy down; the pre-signal gates (isCopilotApiPid) stay boolean because they must never
 * act on an unconfirmed pid.
 *   yes      -> the command line confirms `copilot-api ... start`
 *   no       -> the pid is gone, or an identifiable different process
 *   unknown  -> the OS would not reveal the command line (a sandboxed caller like Codex's packaged app)
 */
export async function classifyDaemonPid(pid: number): Promise<"yes" | "no" | "unknown"> {
  if (process.platform === "win32") return classifyDaemonPidWindows(pid);
  return classifyPidFromRows(await listUserProcesses(), pid, process.pid);
}

/** `selfPid` is the scan's control: a readable `ps -U <uid>` always contains the calling process, so
 *  rows without it prove the scan FAILED (ps error, truncation), which is "unknown", never a confident
 *  "no" a broken `ps` could pass off as "definitely not a daemon". */
export function classifyPidFromRows(
  rows: ProcessRow[],
  pid: number,
  selfPid: number,
): "yes" | "no" | "unknown" {
  return classifyPidFromScan(daemonPidsFromRows(rows, selfPid), pid);
}

/** An "unproven" scan is "unknown", never a confident "no"; a COMPLETED scan without `pid` is exactly
 *  the confident "no" the kill gates exist to mint. Shared by the POSIX row judgment and the win32
 *  owner composition so the two cannot drift on how a failed look reads. */
export function classifyPidFromScan(
  scan: number[] | "unproven",
  pid: number,
): "yes" | "no" | "unknown" {
  if (scan === "unproven") return "unknown";
  return scan.includes(pid) ? "yes" : "no";
}

/**
 * On Windows classifyDaemonPidWindows judges only the command line, and the owner-filtered scan is what
 * keeps an elevated shell from signalling ANOTHER user's daemon after pid reuse, so a "yes" is re-checked
 * against it; POSIX needs no second scan (`ps -U` is already owner-filtered). A FAILED owner scan
 * composes to "unknown", so no owner-gated "yes" is ever minted from a scan that did not run.
 */
export async function classifyOwnedDaemonPid(pid: number): Promise<"yes" | "no" | "unknown"> {
  const cls = await classifyDaemonPid(pid);
  if (cls !== "yes" || process.platform !== "win32") return cls;
  return classifyPidFromScan(await scanCopilotApiPids(), pid);
}

async function classifyDaemonPidWindows(pid: number): Promise<"yes" | "no" | "unknown"> {
  // The SPECIFIC pid is queried so a different process (CommandLine present, no match) is told apart
  // from an unreadable one (CommandLine null: a restricted token); `pid` is our own integer, so inlining
  // it is safe. CIM errors are non-terminating (an empty $p and exit 0, which would flatten into "no"),
  // so the query is trapped to exit non-zero and read "unknown".
  const script = "$ErrorActionPreference = 'Stop'; " +
    `try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' } catch { exit 1 }; ` +
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

/** "unproven" when the scan itself failed: POSIX proves completion via the selfPid control
 *  (daemonPidsFromRows), Windows via the script's exit code. */
function scanCopilotApiPids(): Promise<number[] | "unproven"> {
  return process.platform === "win32"
    ? scanCopilotApiPidsWindows()
    : listUserProcesses().then((rows) => daemonPidsFromRows(rows, process.pid));
}

/** The failure arm flattens to "nobody", KEPT for isCopilotApiPid, whose boolean consumers gate signals
 *  and must read a failed scan as "not ours". Consumers that can report use scanCopilotApiPids. */
function listCopilotApiPids(): Promise<number[]> {
  return scanCopilotApiPids().then((scan) => (scan === "unproven" ? [] : scan));
}

/** `node.exe` and `bun.exe` exist only so an `agent update` from 3.5.6 or older (whose launcher ran the
 *  daemon under bun) can still find and stop the daemon that install left running. */
const WINDOWS_DAEMON_IMAGES = DAEMON_RUNTIMES.map((runtime) => `${runtime}.exe`);

async function scanCopilotApiPidsWindows(): Promise<number[] | "unproven"> {
  // WMI through Get-CimInstance: `ps` has no portable command-line column and `wmic` is removed on newer
  // Windows. Single quotes only, so the script passes through argv quoting unmangled.

  // Owner-filtered like the POSIX `ps -U <uid>`: from an elevated shell the orphan sweep would otherwise
  // kill OTHER users' daemons. The env vars, not `[WindowsIdentity]::GetCurrent()`, which Constrained
  // Language Mode blocks; Domain too, so a local and a domain account with one username do not collide.
  // A process whose owner cannot be read is skipped rather than signalled.
  const nameTest = WINDOWS_DAEMON_IMAGES.map((image) => `$_.Name -eq '${image}'`).join(" -or ");
  // Trapped to exit non-zero on a wholesale failure: CIM errors are non-terminating, so an untrapped
  // access-denied would exit 0 with no pids and read as an empty machine. The per-process GetOwner
  // SilentlyContinue stays (an explicit -ErrorAction overrides the Stop preference): skipping ONE
  // unattributable process is that filter's contract.
  const script = "$ErrorActionPreference = 'Stop'; try { " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    `(${nameTest}) ` +
    `-and $_.CommandLine -match '${DAEMON_CMDLINE_PATTERN}' ` +
    "} | Where-Object { " +
    "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue; " +
    "$o -and $o.ReturnValue -eq 0 -and $o.User -eq $env:USERNAME -and $o.Domain -eq $env:USERDOMAIN " +
    "} | ForEach-Object { $_.ProcessId } " +
    "} catch { exit 1 }";
  const { exitCode, stdout } = await runCaptured("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (exitCode !== 0) return "unproven";

  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isNaN(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

/** `ucomm` is the executable name as the process table reports it; the runtime gate reads THIS, never
 *  argv text. */
export interface ProcessRow {
  pid: number;
  ucomm: string;
  command: string;
}

/** Only the leading columns are split off: the command line may itself contain runs of spaces. Lines
 *  not pid-prefixed (a header, a wrapped continuation) are dropped rather than guessed at, and an
 *  executable named with spaces mis-splits and simply never reads as a runtime. */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number.parseInt(match[1] as string, 10),
      ucomm: match[2] as string,
      command: match[3] as string,
    });
  }
  return rows;
}

/**
 * `-U <uid>` restricts the scan to OUR processes on both BSD and procps: the orphan sweep SIGKILLs what
 * this feeds, so an elevated shell must never see another user's daemons. Any failure (including a
 * user with no processes, where `ps` exits non-zero) degrades to no rows, which the selfPid control
 * downstream reads as a FAILED scan; the raised maxBuffer keeps a process-heavy listing out of that path.
 */
async function listUserProcesses(): Promise<ProcessRow[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const { exitCode, stdout } = await runCaptured(
    "ps",
    ["-U", String(uid), "-o", "pid=,ucomm=,args="],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (exitCode !== 0) return [];
  return parseProcessRows(stdout);
}

/** The copilot-api.sh / copilot_api.py excludes are the pre-rewrite launcher wrappers, whose argv also
 *  carries the daemon shape. */
function posixDaemonPids(rows: ProcessRow[]): number[] {
  const pids: number[] = [];
  for (const row of rows) {
    if (!isDaemonProcess(row)) {
      continue;
    }
    if (row.command.includes("copilot-api.sh") || row.command.includes("copilot_api.py")) {
      continue;
    }
    pids.push(row.pid);
  }
  return pids;
}

/** Same control as classifyPidFromRows: rows without `selfPid` prove the scan FAILED, which is
 *  "unproven", never an empty list a broken `ps` could pass off as "no daemons anywhere". */
export function daemonPidsFromRows(
  rows: ProcessRow[],
  selfPid: number,
): number[] | "unproven" {
  if (!rows.some((row) => row.pid === selfPid)) return "unproven";
  return posixDaemonPids(rows);
}

/**
 * The token-argv preload (src/scripts/token_argv_preload.ts) reads this and splices the token onto
 * process.argv as `--github-token`, keeping the secret off the world-readable command line. The
 * preload is import-free and re-declares the value as a literal; test/daemon_env_keys.test.ts pins the two.
 */
export const DAEMON_GH_TOKEN_ENV = "COPILOT_ENV_DAEMON_GH_TOKEN";

/**
 * `pat` is a variant, not a boolean beside an optional token: the shim reads the token back from argv,
 * so passthrough-without-a-token would load a shim that can do nothing. It always carries an
 * `integrationId` too, since resolvePassthroughIntegrationId falls back to the daemon's own vscode-chat
 * default rather than returning nothing.
 */
export type DaemonCredential =
  | { kind: "none" }
  | { kind: "token"; token: string }
  | { kind: "pat"; token: string; integrationId: string };

/** The preload set and the credential environment are DERIVED from this, never passed alongside it,
 *  so no caller can hand over a combination the credential does not support. */
export interface DaemonSpec {
  port: number;
  logFile: string;
  /** Pinned into COPILOT_API_HOME on EVERY spawn: since the data-home rename the npm package's own
   *  default no longer matches ours, so an unpinned daemon would split its files from the wrapper's. */
  home: string;
  /** Extra daemon environment the launch pipeline assembles (sqlite path, root home). */
  env: Record<string, string>;
  credential: DaemonCredential;
  /** The `auto-start` config key. */
  idleWatchdog: boolean;
  /** The `proxy-logs` config key. */
  muteProxyLogs: boolean;
  /** Resolved ONCE per launch, so the argv and the environment derive from one answer and the
   *  bind-race relaunch reuses the identical entry rather than re-resolving mid-flight. */
  entry: CopilotApiEntry;
  /** Resolved ONCE beside `entry`: on a compiled install this is the provisioned sidecar, and the
   *  bind-race relaunch must spawn the identical binary. */
  denoBin: AbsolutePath;
}

/** Every shim is a RUNTIME shim touching none of copilot-api's files, so none of them pins the floated
 *  proxy version. */
function daemonPreloadFlags(spec: DaemonSpec): string[] {
  // FIRST, ALWAYS: the liveness lock (`<home>/daemon.lock`, src/scripts/daemon_lock.ts) must be held
  // before anything else touches the home.
  const shims: DaemonShimFile[] = ["daemon_lock_preload.ts"];
  // Must precede the PAT shim, which reads the spliced token back from argv.
  if (spec.credential.kind !== "none") shims.push("token_argv_preload.ts");
  shims.push("daemon_runtime_preload.ts");
  if (spec.credential.kind === "pat") shims.push("pat_passthrough_preload.ts");
  if (spec.idleWatchdog) shims.push("idle_watchdog_preload.ts");
  if (spec.muteProxyLogs) shims.push("log_mute_preload.ts");
  return shims.flatMap((shim) => ["--preload", shimPath(shim)]);
}

/**
 * Always set-OR-DELETE: the daemon starts from a copy of our own environment, so a value left by an
 * earlier run would leak into a daemon whose credential does not want it. The token travels through
 * the ENVIRONMENT (owner-only: /proc/<pid>/environ is 0600, `ps e` shows only your own processes),
 * never argv; the token-argv shim splices it back in-process, so the proxy uses it in memory and never
 * writes its own github_token file.
 */
function applyCredentialEnv(env: NodeJS.ProcessEnv, credential: DaemonCredential): void {
  if (credential.kind === "none") {
    delete env[DAEMON_GH_TOKEN_ENV];
  } else {
    env[DAEMON_GH_TOKEN_ENV] = credential.token;
  }
  if (credential.kind === "pat") {
    env[DAEMON_INTEGRATION_ID_ENV] = credential.integrationId;
    // The passthrough shim relies on copilot-api's DEFAULT path, which sends the vscode-chat editor
    // headers the token needs; an inherited COPILOT_API_OAUTH_APP=opencode would strip them.
    delete env.COPILOT_API_OAUTH_APP;
  } else {
    delete env[DAEMON_INTEGRATION_ID_ENV];
  }
}

/** Deno honours HTTP_PROXY for loopback too, so a corporate proxy would otherwise swallow the daemon's
 *  own admin traffic and every local client's calls to it. */
const LOOPBACK_NO_PROXY = ["127.0.0.1", "::1", "localhost"] as const;

export function noProxyWithLoopback(current: string | undefined): string {
  const entries = (current ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  for (const host of LOOPBACK_NO_PROXY) {
    if (!entries.some((e) => e.toLowerCase() === host)) entries.push(host);
  }
  return entries.join(",");
}

/** `base` is inherited wholesale so TLS and outbound-proxy settings (DENO_TLS_CA_STORE, NODE_EXTRA_CA_CERTS,
 *  HTTP_PROXY/HTTPS_PROXY) reach the daemon exactly as the user set them for us. */
export function daemonEnvironment(spec: DaemonSpec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...copilotApiEnv(spec.entry), ...spec.env };
  env.COPILOT_API_HOME = spec.home;
  applyCredentialEnv(env, spec.credential);
  // Both spellings are written so the exemption holds whichever name the HTTP client consults first.
  const noProxy = noProxyWithLoopback(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  // A detached daemon must never stall on (or log) a release probe at startup.
  env.DENO_NO_UPDATE_CHECK = "1";
  return env;
}

export function daemonArgv(spec: DaemonSpec): string[] {
  return copilotApiArgv(
    ["start", "--verbose", "--port", String(spec.port)],
    daemonPreloadFlags(spec),
    spec.entry,
  );
}

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
  try {
    const allLines = readFileSync(logfile, "utf-8").split("\n");
    const tail = allLines.slice(-lines).join("\n");
    // Raw, not line-by-line through consola.error: copilot-api already formats its lines, and a tagged
    // ERROR badge on each (blank stack-trace lines included) buried the real failure in padded gaps.
    process.stderr.write(`\n--- proxy log tail (${logfile}) ---\n${tail}\n`);
  } catch (_e) {
    // ignore
  }
}
