import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { consola } from "consola";
import { floatedProxyEntry, proxyHome, proxyInstallDir } from "../proxy_float.ts";
import { runPowershell } from "../utils/app_scan.ts";
import { runCaptured } from "../utils/command.ts";
import * as fs from "../utils/fs_facade.ts";
import { pidAlive } from "../utils/pid.ts";
import { escapeRegExp } from "../utils/regexp.ts";
import { terminalWidth, wrapMessage } from "../utils/table.ts";
import { clearDeadDaemonLock } from "./daemon_lock.ts";
import {
  DAEMON_CLIENT_HEADERS_ENV,
  DAEMON_COPILOT_HOST_ENV,
  type DaemonClientHeaders,
} from "./integration_identity.ts";
import { resolveRootHome } from "./paths.ts";
import { type DaemonShimFile, shimPath } from "./shims.ts";
import { installedProxyPackage, PROXY_PACKAGE_NAME } from "./version.ts";

/**
 * Every form carries what the spawn derives from the same resolution as the entry: `proxyHome`,
 * the daemon's cwd, and `nodeModules`, where NODE_PATH points the preload shims' imports (the
 * install tree src/proxy_float.ts verified and swapped in), so the argv and the environment can
 * never come from two resolutions.
 */
interface EntryHome {
  readonly proxyHome: string;
  readonly nodeModules: string;
}

export type CopilotApiEntry =
  /** The `COPILOT_API_ENTRY` override: run this file, resolve nothing. */
  | ({ readonly kind: "file"; readonly path: string } & EntryHome)
  /** The float's recorded version, installed complete in the proxy home. */
  | ({ readonly kind: "floated"; readonly version: string; readonly path: string } & EntryHome)
  /** The checkout's own node_modules copy (bun install puts it there), with no float record to
   *  pin a version; a compiled install has no such copy. */
  | ({ readonly kind: "package"; readonly path: string } & EntryHome)
  /** Nothing to run: no record whose install is present, no checkout copy. The floor gate
   *  (judgeProxyFloor in launch.ts) refuses it before any spawn. */
  | ({ readonly kind: "unresolved" } & EntryHome);

/** An entry the daemon can run: what the floor gate hands to the spawn. */
export type RunnableEntry = Exclude<CopilotApiEntry, { kind: "unresolved" }>;

/**
 * `COPILOT_API_ENTRY` is the escape hatch: CI points `start` at a fake proxy so the daemon lifecycle
 * runs without GitHub Copilot auth. A record whose install is gone falls through to the checkout
 * copy rather than naming a file that is not there: the float gate ahead of every daemon start
 * (proxyFloatVerifyStatus) is what reinstalls it.
 */
export function resolveCopilotApiEntry(): CopilotApiEntry {
  const rootHome = resolveRootHome();
  const home: EntryHome = {
    proxyHome: proxyHome(rootHome),
    nodeModules: join(proxyInstallDir(rootHome), "node_modules"),
  };
  // Resolved against the CALLER's cwd here: the daemon's own cwd is the proxy home.
  const override = process.env.COPILOT_API_ENTRY?.trim();
  if (override) return { kind: "file", path: resolve(override), ...home };
  const floated = floatedProxyEntry(rootHome);
  if (floated !== null) {
    return { kind: "floated", version: floated.version, path: floated.entry, ...home };
  }
  const checkout = installedProxyPackage();
  if (checkout !== null) return { kind: "package", path: checkout.entry, ...home };
  return { kind: "unresolved", ...home };
}

/** `run` first, the runtime flags after it (bun reads them nowhere before `run`). `--no-env-file`
 *  keeps a `.env` out of the daemon's environment and `--no-install` keeps a missing import a
 *  launch failure instead of a download: the proxy home's install is the one source of modules. */
export function copilotApiArgv(
  subArgs: readonly string[],
  preloadFlags: readonly string[],
  entry: RunnableEntry,
): string[] {
  return ["run", "--no-env-file", "--no-install", ...preloadFlags, entry.path, ...subArgs];
}

// THE daemon signature, pinned by test/copilot_api/daemon_spawn.e2e.test.ts. The sweep SIGKILLs what it matches, so every
// tolerance below biases against false positives: a substring match once killed an agent CLI whose prompt
// text mentioned copilot-api and start. A match needs a whole daemon-shaped invocation:
//   runtime (DAEMON_RUNTIMES)  -> from the process table, never argv text
//   MIDDLE_TOKEN*              -> every token up to the entry is invocation-shaped
//   ENTRY_TOKEN                -> a path segment starting with `copilot-api`
//   `start`                    -> the very next token
// Accepted residual: a runtime whose flag VALUE is a copilot-api-segment path followed by a literal `start`.

/** Both scans gate on the process table's executable name (ps `ucomm`, the WMI image Name) derived from
 *  this list, never on argv text, where a spaced executable path is indistinguishable from arguments.
 *  The daemon is `process.execPath` run as a bun CLI: bun itself in a checkout, the installed binary
 *  (INSTALLED_BINARY_POSIX in src/utils/targets.ts, which this layer does not import; the test
 *  pins the two) under a release. A binary copied under another name goes unmatched: an accepted
 *  loss. */
export const DAEMON_RUNTIMES = ["bun", "copilot-env"] as const;
const RUNTIME_ALTERNATION = DAEMON_RUNTIMES.join("|");

// Each alternative consumes exactly one whitespace-delimited token and the classes are disjoint (a fragment
// may not start with a dash, or it would overlap the flag class), so middle parsing never backtracks
// combinatorially. A bare word breaks the match: every tolerance for bare words re-admits crafted impostor argv.
//   `/Users/John Smith/.bun/bin/bun`  -> two slash fragments, still matches
//   `/x/Bun Runtime Tools/bun`        -> the slash-less `Runtime` breaks it: accepted loss
const MIDDLE_TOKEN = `run|${RUNTIME_ALTERNATION}|-[^\\s"]*|(?:[^\\s"\\\\/-][^\\s"\\\\/]*)?[\\\\/][^\\s"]*`;
// A path segment STARTING with `copilot-api` (the installed package's directory, a COPILOT_API_ENTRY
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
/** Case-insensitive like PowerShell's `-match` and the filesystem it describes, so a path spelled
 *  `COPILOT-API` on disk is judged here as it was prefiltered there. */
const DAEMON_CMDLINE_RE = new RegExp(DAEMON_CMDLINE_PATTERN, "i");

/** What only OUR spawn puts on a daemon's command line, and only for THIS root home: any tool may
 *  run the same package from its own node_modules, and every test suite's scratch root home shares
 *  one checkout, so neither the shape nor a shim path under the checkout tells this root home's
 *  daemon from a sibling suite's decoy or a developer's real one.
 *    preloadRoots -> the one `--preload` the spawn passes is the preload file it wrote under this
 *                    root home's proxy home (daemonPreloadFile), whatever the entry kind
 *    entryRoots   -> the entry is the package's own directory in this proxy home's install */
export interface DaemonOwnership {
  preloadRoots: readonly string[];
  entryRoots: readonly string[];
}

/** Resolved per scan, never at module load: the proxy home follows COPILOT_API_HOME. */
function daemonOwnership(): DaemonOwnership {
  const rootHome = resolveRootHome();
  const packageDir = ["node_modules", ...PROXY_PACKAGE_NAME.split("/")];
  return {
    preloadRoots: [proxyHome(rootHome)],
    entryRoots: [join(proxyInstallDir(rootHome), ...packageDir)],
  };
}

/** The process table's own spelling for a path comparison: separators either way, case-insensitive
 *  on Windows, no trailing separator. */
function pathSpelling(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * On a command line the signature already matched, read as text rather than tokens: ps flattens a
 * spaced path into several tokens, and the roots are the one thing known to be verbatim in it.
 *   `--preload <root>/...`            -> the preload file under this root home's proxy home, which
 *                                        only our spawn writes and passes
 *   `<entryRoot>/<no space>  start`   -> the entry under this proxy home's install
 * A double quote may open either path (the Windows CommandLine form).
 */
function isOwnedInvocation(command: string, owned: DaemonOwnership): boolean {
  const line = pathSpelling(command);
  const preloaded = owned.preloadRoots.some((root) =>
    new RegExp(`--preload[= ]"?${escapeRegExp(pathSpelling(root))}/`).test(line),
  );
  if (preloaded) return true;
  return owned.entryRoots.some((root) =>
    new RegExp(`(?:^|[\\s"])${escapeRegExp(pathSpelling(root))}/[^\\s"]*"?\\s+start(?:\\s|$)`).test(
      line,
    ),
  );
}

/** Exported for the impostor/orphan fixtures in test/copilot_api/daemon_spawn.e2e.test.ts. */
export function isDaemonProcess(
  row: ProcessRow,
  owned: DaemonOwnership = daemonOwnership(),
): boolean {
  if (!(DAEMON_RUNTIMES as readonly string[]).includes(row.ucomm)) return false;
  return DAEMON_INVOCATION_RE.test(row.command) && isOwnedInvocation(row.command, owned);
}

/** The Windows judgment: the PS scripts prefilter on the interpolated pattern, and the command lines
 *  they return are judged HERE, ownership included, so both platforms share one rule
 *  (test/copilot_api/daemon_spawn.e2e.test.ts pins the pattern's semantics). */
export function isDaemonCommandLine(
  command: string,
  owned: DaemonOwnership = daemonOwnership(),
): boolean {
  return DAEMON_CMDLINE_RE.test(command) && isOwnedInvocation(command, owned);
}

/** Also bounds the daemon's own drain: daemon_shutdown.ts keeps a separate literal (it loads in the
 *  daemon, which imports no CLI module) and test/copilot_api/daemon_spawn.e2e.test.ts pins the two in order. */
export const DAEMON_SIGKILL_GRACE_MS = 2_000;

/** The launch pipeline's one-second wait: after the cleanup sweep, after a spawn before the pid is
 *  judged, and per readiness tick, whose budget counts these in seconds. */
export const LAUNCH_SETTLE_MS = 1_000;

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
 * signal boundary (the rule stopLockHolder and the orphan sweep in launch_cleanup.ts share).
 * `classify` is the test seam.
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
export function getOrphanPids(myPid: number, myPpid: number): Promise<number[] | "unproven"> {
  return scanCopilotApiPids().then((scan) =>
    scan === "unproven" ? scan : scan.filter((p) => p !== myPid && p !== myPpid),
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
function classifyPidFromRows(
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
  // The SPECIFIC pid is queried so a different process (CommandLine present, judged here) is told
  // apart from an unreadable one (CommandLine null: a restricted token); `pid` is our own integer,
  // so inlining it is safe. CIM errors are non-terminating (an empty $p and exit 0, which would
  // flatten into "no"), so the query is trapped to exit non-zero and read "unknown".
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    `try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' } catch { exit 1 }; ` +
    "if (-not $p) { 'no' } " +
    "elseif ([string]::IsNullOrEmpty($p.CommandLine)) { 'unknown' } " +
    `else { 'cmd:' + ${base64CommandLine("$p")} }`;
  const { exitCode, stdout } = await runPowershell(script);
  if (exitCode !== 0) return "unknown";
  const answer = stdout.trim();
  if (answer === "no") return "no";
  if (answer.startsWith("cmd:")) {
    return isDaemonCommandLine(decodeCommandLine(answer.slice(4))) ? "yes" : "no";
  }
  return "unknown";
}

/** A command line crosses the PowerShell boundary base64-encoded: an argument may itself carry a
 *  newline or a tab, which would otherwise split one record into two and lend a pid to text. */
function base64CommandLine(variable: string): string {
  return `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${variable}.CommandLine))`;
}

function decodeCommandLine(base64: string): string {
  return Buffer.from(base64.trim(), "base64").toString("utf8");
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
  const script =
    "$ErrorActionPreference = 'Stop'; try { " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    `(${nameTest}) ` +
    `-and $_.CommandLine -match '${DAEMON_CMDLINE_PATTERN}' ` +
    "} | Where-Object { " +
    "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue; " +
    "$o -and $o.ReturnValue -eq 0 -and $o.User -eq $env:USERNAME -and $o.Domain -eq $env:USERDOMAIN " +
    `} | ForEach-Object { "$($_.ProcessId) " + ${base64CommandLine("$_")} } ` +
    "} catch { exit 1 }";
  const { exitCode, stdout } = await runPowershell(script);
  if (exitCode !== 0) return "unproven";

  // The pattern prefiltered in PowerShell; ownership is judged here, like the POSIX rows. One
  // record per line by construction: a pid, a space, base64.
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const record = /^\s*(\d+) ([A-Za-z0-9+/=]+)\s*$/.exec(line);
    if (record === null) continue;
    const pid = Number.parseInt(record[1] as string, 10);
    if (isDaemonCommandLine(decodeCommandLine(record[2] as string))) pids.push(pid);
  }
  return pids;
}

/** `ucomm` is the executable name as the process table reports it; the runtime gate reads THIS, never
 *  argv text. */
interface ProcessRow {
  pid: number;
  ucomm: string;
  command: string;
}

/** Only the leading columns are split off: the command line may itself contain runs of spaces. Lines
 *  not pid-prefixed (a header, a wrapped continuation) are dropped rather than guessed at, and an
 *  executable named with spaces splits wrong and simply never reads as a runtime. */
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

/** The ownership roots are resolved once per scan, not per row. */
function posixDaemonPids(rows: ProcessRow[]): number[] {
  const owned = daemonOwnership();
  return rows.filter((row) => isDaemonProcess(row, owned)).map((row) => row.pid);
}

/** Same control as classifyPidFromRows: rows without `selfPid` prove the scan FAILED, which is
 *  "unproven", never an empty list a broken `ps` could pass off as "no daemons anywhere". */
export function daemonPidsFromRows(rows: ProcessRow[], selfPid: number): number[] | "unproven" {
  if (!rows.some((row) => row.pid === selfPid)) return "unproven";
  return posixDaemonPids(rows);
}

/**
 * The token-argv preload (src/scripts/token_argv_preload.ts) reads this and splices the token onto
 * process.argv as `--github-token`, keeping the secret off the world-readable command line. The
 * preload is import-free and re-declares the value as a literal; test/copilot_api/daemon_env_keys.test.ts pins the two.
 */
export const DAEMON_GH_TOKEN_ENV = "COPILOT_ENV_DAEMON_GH_TOKEN";

/**
 * `pat` is a variant, not a boolean beside an optional token: the passthrough shim reads the token
 * back from argv, so passthrough-without-a-token would load a shim that can do nothing. Every
 * credential carries the `clientHeaders` the client-headers preload applies upstream (the one
 * identity resolved for it, daemonClientHeaders): a daemon never runs under the proxy's own.
 */
export type DaemonCredential =
  | { kind: "token"; token: string; clientHeaders: DaemonClientHeaders }
  | { kind: "pat"; token: string; clientHeaders: DaemonClientHeaders };

/** The preload set and the credential environment are DERIVED from this, never passed alongside it,
 *  so no caller can hand over a combination the credential does not support. */
export interface DaemonSpec {
  port: number;
  logFile: string;
  /** Pinned into COPILOT_API_HOME on EVERY spawn: the npm package's own default home is not ours, so
   *  an unpinned daemon would split its files from the wrapper's. */
  home: string;
  /** Extra daemon environment the launch pipeline assembles (sqlite path, root home). */
  env: Record<string, string>;
  credential: DaemonCredential;
  /** The Copilot host the daemon is pinned to (`host`, resolveLaunchCredential in launch.ts); the
   *  copilot-host preload rewrites the `endpoints.api` GitHub names. */
  copilotHost: string;
  /** The `daemon.auto-start` config key. */
  idleWatchdog: boolean;
  /** The `daemon.logs` config key. */
  muteProxyLogs: boolean;
  /** Resolved ONCE per launch, so the argv and the environment derive from one answer and the
   *  bind-race relaunch reuses the identical entry rather than re-resolving mid-flight. */
  entry: RunnableEntry;
}

/**
 * The daemon's one `--preload`: a file in the proxy home that imports this build's shims. The argv
 * then names the root home for every entry kind, which is the mark daemonOwnership reads (a shim
 * path under the checkout would name every scratch root home's daemon alike), while the shim set
 * still derives from the spec. launchDaemon writes it before each spawn; the start lock covers the
 * spawn through readiness, so no second start rewrites it under a daemon still booting.
 */
export function daemonPreloadFile(proxyHome: string): string {
  return join(proxyHome, "daemon_preload.ts");
}

/** Every shim is a RUNTIME shim touching none of copilot-api's files, so none of them pins the floated
 *  proxy version. One line of imports: a module's imports evaluate in order, so this IS the preload
 *  order; file URLs, the one spelling an import accepts on every platform. */
export function renderDaemonPreload(spec: DaemonSpec): string {
  // FIRST, ALWAYS: the liveness lock (`<home>/daemon.lock`, src/copilot_api/daemon_lock.ts) must be held
  // before anything else touches the home.
  const shims: DaemonShimFile[] = ["daemon_lock_preload.ts"];
  // Must precede the PAT shim, which reads the spliced token back from argv.
  shims.push("token_argv_preload.ts");
  shims.push("daemon_runtime_preload.ts");
  shims.push("copilot_host_preload.ts");
  // Every credential runs under its resolved client identity; only passthrough fakes the exchange.
  shims.push("client_headers_preload.ts");
  if (spec.credential.kind === "pat") shims.push("pat_passthrough_preload.ts");
  if (spec.idleWatchdog) shims.push("idle_watchdog_preload.ts");
  if (spec.muteProxyLogs) shims.push("log_mute_preload.ts");
  const imports = shims.map(
    (shim) => `import ${JSON.stringify(pathToFileURL(shimPath(shim)).href)};`,
  );
  return `${imports.join(" ")}\n`;
}

/**
 * The token travels through the ENVIRONMENT (owner-only: /proc/<pid>/environ is 0600, `ps e` shows
 * only your own processes), never argv; the token-argv shim splices it back in-process, so the proxy
 * uses it in memory and never writes its own github_token file. Every daemon carries one: a launch
 * without a credential is refused before the spawn (readLaunchToken).
 */
function applyCredentialEnv(env: NodeJS.ProcessEnv, credential: DaemonCredential): void {
  env[DAEMON_GH_TOKEN_ENV] = credential.token;
  env[DAEMON_CLIENT_HEADERS_ENV] = JSON.stringify(credential.clientHeaders);
  // The client-headers preload rewrites copilot-api's DEFAULT upstream path; an inherited
  // COPILOT_API_OAUTH_APP=opencode would route around it with another header set entirely.
  delete env.COPILOT_API_OAUTH_APP;
}

/** A corporate HTTP_PROXY would otherwise swallow the daemon's own admin traffic and every local
 *  client's calls to it. */
const LOOPBACK_NO_PROXY = ["127.0.0.1", "::1", "localhost"] as const;

export function noProxyWithLoopback(current: string | undefined): string {
  const entries = (current ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  for (const host of LOOPBACK_NO_PROXY) {
    if (!entries.some((e) => e.toLowerCase() === host)) entries.push(host);
  }
  return entries.join(",");
}

/**
 * The bun-CLI environment a compiled binary needs to run anything but its own entry: without
 * BUN_BE_BUN a spawn of process.execPath re-runs the CLI (a fork bomb). The runtime flags live in
 * copilotApiArgv; test/copilot_api/daemon_spawn.e2e.test.ts pins the pair.
 */
export const BUN_CLI_ENV = { BUN_BE_BUN: "1" } as const;

/** `base` is inherited wholesale so TLS and outbound-proxy settings (NODE_EXTRA_CA_CERTS,
 *  HTTP_PROXY/HTTPS_PROXY) reach the daemon exactly as the user set them for us. */
export function daemonEnvironment(spec: DaemonSpec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...BUN_CLI_ENV, ...spec.env };
  // The preload shims sit beside the binary, where no node_modules is: their imports resolve from
  // the proxy home's install. Set, never appended: an inherited NODE_PATH could shadow it.
  env.NODE_PATH = spec.entry.nodeModules;
  env.COPILOT_API_HOME = spec.home;
  applyCredentialEnv(env, spec.credential);
  // copilot-api's own host selectors (COPILOT_API_ENTERPRISE_URL, COPILOT_API_OAUTH_APP=opencode)
  // answer before the rewritten state, so a pinned daemon never inherits either.
  env[DAEMON_COPILOT_HOST_ENV] = spec.copilotHost;
  delete env.COPILOT_API_ENTERPRISE_URL;
  delete env.COPILOT_API_OAUTH_APP;
  // Both spellings are written so the exemption holds whichever name the HTTP client consults first.
  const noProxy = noProxyWithLoopback(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

export function daemonArgv(spec: DaemonSpec): string[] {
  return copilotApiArgv(
    ["start", "--verbose", "--port", String(spec.port)],
    ["--preload", daemonPreloadFile(spec.entry.proxyHome)],
    spec.entry,
  );
}

export function launchDaemon(spec: DaemonSpec): number {
  // A dead predecessor's marker would otherwise refuse the new daemon's acquire for its whole
  // budget: the daemon cannot signal the pid, this process can.
  clearDeadDaemonLock(spec.home);
  const logFd = fs.openWriteFd(spec.logFile);
  // The disk's `/dev/null` in every mode, a dry run included: the raw open the fs lint exempts.
  const devnull = openSync(devNull, "r");
  // The daemon's cwd is the proxy home, whatever the caller's was: bun's own discovery (bunfig,
  // package.json) then lands on the float's files, and a directory the user later deletes cannot
  // take a running daemon's cwd with it. Created here because the file entry may run before any
  // float made it.
  fs.mkdir(spec.entry.proxyHome);
  fs.writeText(daemonPreloadFile(spec.entry.proxyHome), renderDaemonPreload(spec), {
    secretKeys: [],
  });
  const proc = spawn(process.execPath, daemonArgv(spec), {
    cwd: spec.entry.proxyHome,
    stdio: [devnull, logFd, logFd],
    detached: true,
    // Defensive: redirected stdio already avoids a console window on Windows.
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
    const allLines = fs.readText(logfile).split("\n");
    const tail = allLines.slice(-lines).join("\n");
    // Raw, not line-by-line through consola.error: copilot-api already formats its lines, and a tagged
    // ERROR badge on each (blank stack-trace lines included) buried the real failure in padded gaps.
    const heading = wrapMessage(
      `--- proxy log tail (${logfile}) ---`,
      terminalWidth(process.stderr),
    );
    process.stderr.write(`\n${heading}\n${tail}\n`);
  } catch (_e) {
    // ignore
  }
}
