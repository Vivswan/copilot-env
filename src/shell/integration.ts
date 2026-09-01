// Cross-platform shell/profile integration writer for agent wrappers and launchers.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { consola } from "consola";

import { isEnoent } from "../utils/fs.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

// `agent shell` owns wiring the copilot-env integration into the
// user's shell startup -- the logic install.sh / install.ps1 used to duplicate.
// File wiring is done here in TS for BOTH platforms; we only shell out to tiny
// `powershell -Command` one-liners for the two Windows-only needs TS can't cover
// (resolve the (OneDrive-redirectable) Documents folder, toggle execution policy).
// The marker is a comment in both bash and PowerShell, so the wire/remove core is
// shared; only the block body and the target files differ per OS.

export const MARKER = "# copilot-env shell integration";
export const LAUNCHERS_MARKER = "# copilot-env launchers";
const ALL_MARKERS = [MARKER, LAUNCHERS_MARKER];

/** The opt-in cl/co/cx launchers file for each platform flavor -- the single owner of
 *  the two file names, shared with `agent env`'s one-shot launchers `source` line. */
export function launchersFile(powershell: boolean): string {
  return join(
    PROJECT_ROOT,
    "shell",
    powershell ? "agents.launchers.ps1" : "agents.launchers.bashrc",
  );
}

export interface ShellIntegrationArgs {
  remove?: boolean;
  removeLaunchers?: boolean;
  allHosts?: boolean;
  launchers?: boolean;
  existingOnly?: boolean;
}

/** A line equals the given marker ignoring a trailing CR (rc/profile files may be CRLF). */
const lineIs = (line: string, marker: string): boolean => line.replace(/\r$/, "") === marker;

export function runShellIntegration(args: ShellIntegrationArgs): void {
  const remove = Boolean(args.remove);
  const removeLaunchers = Boolean(args.removeLaunchers);
  const windows = process.platform === "win32";

  if (remove || removeLaunchers) {
    const files = windows ? windowsProfileTarget(Boolean(args.allHosts)).paths : rcFiles(true);
    const restartHint = windows ? "Restart PowerShell." : "Restart your shell.";
    const removed = remove ? removeFrom(files) : removeLaunchersFrom(files);
    if (removed) consola.info(restartHint);
    return;
  }
  const launchers = Boolean(args.launchers);
  const existingOnly = Boolean(args.existingOnly);
  if (windows) {
    const target = windowsProfileTarget(Boolean(args.allHosts));
    const wired = wireBlocks(
      target.paths,
      windowsBlock(join(PROJECT_ROOT, "shell", "agents.ps1")),
      windowsLaunchersBlock(launchersFile(true)),
      launchers,
      existingOnly,
    );
    // Only relax execution policy when integration is actually present -- never for an
    // opted-out user whose `existingOnly` migration found no owned block to refresh, and
    // never for a redirected run, which owns no machine state (the type enforces it).
    if (wired && target.source === "system") relaxWindowsExecutionPolicy(target);
    consola.info("Restart PowerShell or run: . $PROFILE");
  } else {
    wireBlocks(
      rcFiles(false),
      posixBlock(join(PROJECT_ROOT, "shell", "agents.bashrc")),
      posixLaunchersBlock(launchersFile(false)),
      launchers,
      existingOnly,
    );
    consola.info("Restart your shell or run: source ~/.bashrc (or ~/.zshrc)");
  }
}

// --- shared wire/remove core --------------------------------------------------

/**
 * Strip owned blocks from rc/profile content. Each
 * block is its marker line + the two lines after it, plus the blank line the block
 * prepends (only when that preceding line is actually empty). Both block types share
 * this 3-line shape.
 */
function stripBlocks(content: string, markers: string[]): string {
  const lines = content.split("\n");
  const skip = new Set<number>();
  lines.forEach((line, idx) => {
    if (!markers.some((marker) => lineIs(line, marker))) return;
    if (idx > 0 && (lines[idx - 1] ?? "").replace(/\r$/, "") === "") skip.add(idx - 1);
    skip
      .add(idx)
      .add(idx + 1)
      .add(idx + 2);
  });
  if (skip.size === 0) return content;
  return lines.filter((_, idx) => !skip.has(idx)).join("\n");
}

/** True if any line of `content` is exactly `marker` (CR-tolerant). */
export function hasMarker(content: string, marker: string): boolean {
  return content.split("\n").some((l) => lineIs(l, marker));
}

/**
 * Insert or refresh ONE owned block, IN PLACE. If `marker` is already present, its
 * existing block (marker line + the two body lines, plus a preceding blank when there
 * is one) is replaced where it sits -- so a stale path migrates without moving the
 * block or reordering anything around it, and an already-current block reproduces the
 * file byte-for-byte. If absent, the block is appended at EOF (it leads with a blank).
 */
function upsertBlock(content: string, marker: string, block: string): string {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => lineIs(l, marker));
  if (idx === -1) return content + block;
  const start = idx > 0 && (lines[idx - 1] ?? "").replace(/\r$/, "") === "" ? idx - 1 : idx;
  const end = idx + 2; // marker + its two body lines
  let blockLines = block.split("\n");
  if (blockLines[blockLines.length - 1] === "") blockLines = blockLines.slice(0, -1); // trailing newline
  if (start === idx && blockLines[0] === "") blockLines = blockLines.slice(1); // no preceding blank to keep
  return [...lines.slice(0, start), ...blockLines, ...lines.slice(end + 1)].join("\n");
}

/**
 * Wire (or refresh) the owned blocks. Each block is upserted IN PLACE, so re-running is
 * byte-idempotent and a stale (pre-`shell/`-move) path migrates without moving the block
 * or reordering the rest of the file. The launchers block is included when requested OR
 * already present, so a plain re-run never silently drops a user's launchers. With
 * `existingOnly`, a file that has no owned block is left untouched -- used by the update
 * migration so it never newly-wires a user who opted out of shell integration.
 *
 * Returns true if any target file has an owned block afterwards (i.e. integration is
 * active for this user) -- the caller uses this to decide whether Windows-side execution
 * policy relaxation is warranted, so an opted-out `existingOnly` run touches nothing.
 */
function wireBlocks(
  files: string[],
  mainBlock: string,
  launchersBlock: string,
  wantLaunchers: boolean,
  existingOnly = false,
): boolean {
  let active = false;
  for (const file of files) {
    const original = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const hadMain = hasMarker(original, MARKER);
    const hadLaunchers = hasMarker(original, LAUNCHERS_MARKER);
    if (existingOnly && !hadMain && !hadLaunchers) continue;
    active = true; // this file has, or will have, an owned block
    let next = upsertBlock(original, MARKER, mainBlock);
    if (wantLaunchers || hadLaunchers) next = upsertBlock(next, LAUNCHERS_MARKER, launchersBlock);
    if (next === original) {
      consola.info(`Shell integration already wired in ${file} -- skipping.`);
      continue;
    }
    // OneDrive-backed Documents folders are reparse points; Node's recursive mkdir throws
    // EEXIST on an existing reparse point instead of no-op'ing, so skip when it already exists.
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
    consola.success(`Wired shell integration into ${file}`);
  }
  return active;
}

function removeBlocksFrom(
  files: string[],
  markers: string[],
  removedMessage: (file: string) => string,
  missingMessage: string,
): boolean {
  let removedAny = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf-8");
    const stripped = stripBlocks(content, markers);
    if (stripped === content) continue; // no owned block present
    writeFileSync(file, stripped);
    consola.success(removedMessage(file));
    removedAny = true;
  }
  if (!removedAny) consola.info(missingMessage);
  return removedAny;
}

function removeFrom(files: string[]): boolean {
  return removeBlocksFrom(
    files,
    ALL_MARKERS,
    (file) => `Removed shell integration from ${file}`,
    "No copilot-env shell integration found to remove.",
  );
}

function removeLaunchersFrom(files: string[]): boolean {
  return removeBlocksFrom(
    files,
    [LAUNCHERS_MARKER],
    (file) => `Removed copilot-env launchers from ${file}`,
    "No copilot-env launchers found to remove.",
  );
}

// --- block builders (path-quoted; quote helpers re-exported for tests) --------

// Re-exported so test/shell_integration.test.ts can import them from here.
export { quotePosix, quotePowerShell };

/** The `$HOME` tail of `path` when it lives under the user's home directory, else null.
 *  Anchoring the written block at `$HOME` keeps a synced rc/profile file working across
 *  machines and usernames; a path outside home (e.g. a dev checkout) stays literal.
 *  relative() rather than a lexical prefix test: it normalizes separators and compares
 *  the way the platform does (case-insensitive on Windows), so a differently-cased home
 *  still anchors; outside-home walks up ("..") or lands on another drive (absolute). */
function homeTail(path: string): string | null {
  const tail = relative(homedir(), path);
  if (tail === "" || tail.startsWith("..") || isAbsolute(tail)) return null;
  return sep + tail;
}

/** Tails that stay literal inside a double-quoted string (no $, backtick, ", \\,
 *  or newline in POSIX; no $, backtick, or " in PowerShell) -- every real install.
 *  `!` is also excluded on the POSIX side: sourced rc files skip history expansion,
 *  but a user pasting the line into an interactive bash would not. Anything else
 *  falls back to the concatenated form below. */
const POSIX_DQ_SAFE = /^[^$`"\\\n!]*$/;
const PS_DQ_SAFE = /^[^$`"\n]*$/;

/** Quote `path` for a POSIX assignment, `$HOME`-anchored when possible: the readable
 *  `"$HOME/tail"` when the tail needs no escaping, else `"$HOME"'<tail>'` so only
 *  `$HOME` expands and the tail's metacharacters remain literal. */
function quotePosixHomeAnchored(path: string): string {
  const tail = homeTail(path);
  if (tail === null) return quotePosix(path);
  if (POSIX_DQ_SAFE.test(tail)) return `"$HOME${tail}"`;
  return `"$HOME"${quotePosix(tail)}`;
}

/** PowerShell twin of quotePosixHomeAnchored: `"$HOME\tail"` when safe (`\` ends the
 *  variable name, so nothing else expands), else `$HOME + '<tail>'`. */
function quotePowerShellHomeAnchored(path: string): string {
  const tail = homeTail(path);
  if (tail === null) return quotePowerShell(path);
  if (PS_DQ_SAFE.test(tail)) return `"$HOME${tail}"`;
  return `$HOME + ${quotePowerShell(tail)}`;
}

export function posixBlock(agentsBashrc: string): string {
  return `\n${MARKER}\nAGENTS_BASHRC=${
    quotePosixHomeAnchored(agentsBashrc)
  }\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
}

/** Opt-in launchers block; sourced after posixBlock so the `agent` wrapper exists. */
export function posixLaunchersBlock(launchersBashrc: string): string {
  return `\n${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS=${
    quotePosixHomeAnchored(launchersBashrc)
  }\n[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"\n`;
}

export function windowsBlock(agentsPs1: string): string {
  // -LiteralPath so a path with PowerShell wildcard chars ([ ] * ?) isn't treated
  // as a pattern (the quoting handles spaces/quotes, not wildcard semantics).
  return `\n${MARKER}\n$AgentsPs1 = ${
    quotePowerShellHomeAnchored(agentsPs1)
  }\nif (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n`;
}

/** Opt-in launchers block; dot-sourced after windowsBlock so the `agent` wrapper exists. */
export function windowsLaunchersBlock(launchersPs1: string): string {
  return `\n${LAUNCHERS_MARKER}\n$AgentsLaunchers = ${
    quotePowerShellHomeAnchored(launchersPs1)
  }\nif (Test-Path -LiteralPath $AgentsLaunchers) { . $AgentsLaunchers }\n`;
}

export function windowsExecutionPolicyCommand(): string {
  return (
    "$ErrorActionPreference='Stop'; " +
    // When Windows PowerShell 5.1 is spawned as a child of pwsh 7 (the usual case -- the
    // user runs `agent` from pwsh), it inherits pwsh's PSModulePath, loads pwsh's
    // Microsoft.PowerShell.Security, and the policy cmdlets fail to autoload. Reset the
    // Desktop edition to its own machine module path so the cmdlets resolve. Core (pwsh)
    // resolves them fine, so leave its path alone.
    "if ($PSVersionTable.PSEdition -eq 'Desktop') { " +
    "$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath','Machine') }; " +
    "try { " +
    "Get-Command Get-ExecutionPolicy -ErrorAction Stop | Out-Null; " +
    "Get-Command Set-ExecutionPolicy -ErrorAction Stop | Out-Null " +
    "} catch { " +
    "Write-Host 'Execution policy cmdlets unavailable; skipping execution policy update.'; exit 0 " +
    "}; " +
    "if ((Get-ExecutionPolicy) -in 'Restricted','AllSigned','Undefined') { " +
    "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; " +
    "Write-Host 'Set CurrentUser execution policy to RemoteSigned so the profile can load agents.ps1.' }"
  );
}

// --- test/CI seams ------------------------------------------------------------
//
// One override per platform family for WHERE this module writes. They exist for different
// reasons: the Windows $PROFILE location comes from a Windows API call that no environment
// variable can move, while the POSIX rc lookup does follow $HOME -- but only if every test
// remembers to set it, which is exactly what a structural isolation floor must not depend
// on. Set them ONLY from tests, like the other COPILOT_ENV_CI_* variables.

/** The Documents FOLDER the Windows `$PROFILE` resolvers build on -- the parent of the
 *  per-edition `WindowsPowerShell/` and `PowerShell/` directories, not a profile dir. */
export const CI_PS_DOCUMENTS_DIR_ENV = "COPILOT_ENV_CI_PS_DOCUMENTS_DIR";

/** The directory the POSIX rc files (`.bashrc` / `.zshrc`) resolve under, in place of
 *  `homedir()`. Takes precedence over `$HOME`. */
export const CI_RC_DIR_ENV = "COPILOT_ENV_CI_RC_DIR";

/**
 * Read one seam. Absolute paths only, and set-but-unusable is a hard ERROR for both: an
 * empty value is an unexpanded interpolation and a relative one resolves against whatever
 * cwd the CLI ran from. Quietly falling back to the machine's real startup file is the one
 * outcome a seam whose entire job is isolation must never have. The ONE place they are read.
 */
function absolutePathEnv(name: string): string | null {
  const dir = process.env[name];
  if (dir === undefined) return null;
  if (!isAbsolute(dir)) throw new Error(`${name} must be an absolute path (got: ${dir})`);
  return dir;
}

// --- POSIX target files -------------------------------------------------------

/** Existing ~/.bashrc + ~/.zshrc; for wiring, fall back to one named for $SHELL. */
export function rcFiles(remove: boolean): string[] {
  const home = absolutePathEnv(CI_RC_DIR_ENV) ?? homedir();
  const existing = [".bashrc", ".zshrc"]
    .map((f) => join(home, f))
    .filter((p) => existsSync(p));
  if (existing.length > 0 || remove) return existing;
  const shell = basename(process.env.SHELL ?? "/bin/bash");
  return [join(home, shell === "zsh" ? ".zshrc" : ".bashrc")];
}

/**
 * Shell rc/profile files to INSPECT for owned blocks (read-only) on this platform:
 * existing POSIX rc files, or the Windows `$PROFILE` candidates (both the
 * current-host and all-hosts profiles, so a `--all-hosts` wiring is still seen).
 * Used by `agent health` to report shell-integration / launcher wiring without
 * mutating anything.
 */
export function shellTargetFiles(): string[] {
  if (process.platform !== "win32") return rcFiles(true);
  return [
    ...new Set([...windowsProfileTarget(false).paths, ...windowsProfileTarget(true).paths]),
  ];
}

/**
 * Best-effort: are the opt-in launchers wired into this user's shell startup? Used
 * by `agent env` (a hot path, run after every `agent` command and at shell startup)
 * to decide whether to emit a one-shot directive that sources the launchers into the
 * CURRENT shell right after `agent shell --launchers`, so cl/co/cx work without a
 * restart. Deliberately CHEAP: on Windows it resolves the profile directory from env
 * vars (USERPROFILE / OneDrive) rather than spawning PowerShell like
 * shellTargetFiles(), so a Documents folder relocated somewhere it does not guess may
 * be missed -- in which case the auto-source simply doesn't fire and the printed
 * "restart" hint still applies.
 * Any READ error resolves to false (no emission), never a throw into `agent env`. The
 * candidates are resolved outside that catch on purpose: a set-but-unusable seam is a
 * mistake everywhere, not a quiet "not wired" here.
 */
export function launchersWired(): boolean {
  const files = process.platform === "win32" ? cheapWindowsProfilePaths() : rcFiles(true);
  try {
    return files.some(
      (file) => existsSync(file) && hasMarker(readFileSync(file, "utf-8"), LAUNCHERS_MARKER),
    );
  } catch {
    return false;
  }
}

// --- Windows $PROFILE vocabulary ------------------------------------------------
//
// The names BOTH profile-path resolvers share: the per-edition dirs under Documents
// (5.1 vs pwsh 7) and the current-host / all-hosts profile filenames. Only HOW the
// Documents folder is found differs between the resolvers (cheap env-var guess vs
// authoritative PowerShell GetFolderPath) -- that dual implementation is deliberate;
// the four literals are not allowed to drift. The CI redirect short-circuits both, so
// a redirected run cannot wire one tree and inspect another.
const PS_PROFILE_DIRS = ["WindowsPowerShell", "PowerShell"] as const;
const PS_PROFILE_CURRENT_HOST = "Microsoft.PowerShell_profile.ps1";
const PS_PROFILE_ALL_HOSTS = "profile.ps1";
/** The two PowerShell editions, in the order to try them: 5.1, then 7. Index-for-index
 *  with PS_PROFILE_DIRS above (WindowsPowerShell = 5.1, PowerShell = 7). */
const PS_EXES = ["powershell", "pwsh"] as const;

/** Every `<root>/<edition>/<name>` profile path, deduped -- the one spelling of the
 *  layout both resolvers produce. */
function profilePathsUnder(documentRoots: string[], names: string[]): string[] {
  const paths: string[] = [];
  for (const root of documentRoots) {
    for (const sub of PS_PROFILE_DIRS) {
      for (const name of names) paths.push(join(root, sub, name));
    }
  }
  return [...new Set(paths)];
}

/**
 * PowerShell `$PROFILE` candidates resolved WITHOUT shelling out (see launchersWired).
 * Covers the current-host and all-hosts profiles under the default Documents folder
 * and its common OneDrive redirections. Exported so a test can pin it against
 * windowsProfileTarget: under the seam the two must resolve the same tree, or a
 * redirected run would wire one place and inspect another.
 */
export function cheapWindowsProfilePaths(): string[] {
  const override = absolutePathEnv(CI_PS_DOCUMENTS_DIR_ENV);
  const home = process.env.USERPROFILE ?? homedir();
  const docRoots = override ? [override] : [
    join(home, "Documents"),
    process.env.OneDrive ? join(process.env.OneDrive, "Documents") : "",
    process.env.OneDriveConsumer ? join(process.env.OneDriveConsumer, "Documents") : "",
  ].filter(Boolean);
  return profilePathsUnder(docRoots, [PS_PROFILE_CURRENT_HOST, PS_PROFILE_ALL_HOSTS]);
}

// --- Windows (file ops in TS; PS only for what it must) ------------------------

/** The Windows `$PROFILE` files to act on. `source` is the proof of whose profile these
 *  are: only a "system" target owns the machine's execution policy, and
 *  relaxWindowsExecutionPolicy accepts nothing else -- so a redirected run cannot relax
 *  it even by mistake. `paths` is ONE filename (current-host or all-hosts) under BOTH
 *  edition directories, present or not: wireBlocks creates the one that is missing. */
export type WindowsProfileTarget =
  | { paths: string[]; source: "system" }
  | { paths: string[]; source: "redirected" };

/** Resolve this run's `$PROFILE` target: the machine's own, or the seam's throwaway tree. */
export function windowsProfileTarget(allHosts: boolean): WindowsProfileTarget {
  const override = absolutePathEnv(CI_PS_DOCUMENTS_DIR_ENV);
  const name = allHosts ? PS_PROFILE_ALL_HOSTS : PS_PROFILE_CURRENT_HOST;
  if (override !== null) {
    return { paths: profilePathsUnder([override], [name]), source: "redirected" };
  }
  // Off Windows the lookup answers for $HOME: plausible-looking nonsense, not a profile.
  if (process.platform !== "win32") {
    throw new Error("the Windows $PROFILE target is only resolvable on Windows");
  }
  // DoNotVerify: the one-argument call verifies the folder and answers with an empty
  // string when it was never created. We create it on write, so the unverified answer
  // is the useful one.
  const documents = psEval("[Environment]::GetFolderPath('MyDocuments','DoNotVerify')");
  if (!documents) throw new Error("could not resolve the Documents folder via PowerShell");
  return { paths: profilePathsUnder([documents], [name]), source: "system" };
}

/** Ask PowerShell for one value, from whichever edition answers. The query is read-only
 *  and both editions return the same thing, so a missing OR broken 5.1 falls through to
 *  pwsh rather than failing the command. */
function psEval(command: string): string {
  const failures: string[] = [];
  for (const exe of PS_EXES) {
    const result = spawnSync(exe, ["-NoProfile", "-Command", command], { encoding: "utf-8" });
    if (isEnoent(result.error)) {
      failures.push(`${exe}: not on PATH`);
      continue;
    }
    if (result.error || result.status !== 0) {
      failures.push(`${exe}: ${
        result.error?.message ??
          `exit ${result.status}: ${(result.stderr ?? "").toString().trim()}`
      }`);
      continue;
    }
    return (result.stdout ?? "").toString().trim();
  }
  throw new Error(`no PowerShell edition could run the command (${failures.join("; ")})`);
}

// The profile dot-sources the unsigned agents.ps1; under Restricted/AllSigned the
// profile would silently refuse to load it. Relax CurrentUser to RemoteSigned. CurrentUser
// policy keys are per-edition, so run it in each installed edition (5.1 + pwsh 7).
// Takes the system target as proof this run owns the policy it is about to change.
function relaxWindowsExecutionPolicy(_target: { source: "system" }): void {
  const command = windowsExecutionPolicyCommand();
  for (const exe of PS_EXES) {
    const result = spawnSync(exe, ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    // Edition not installed (pwsh-only or 5.1-only machine): nothing to relax there.
    if (isEnoent(result.error)) continue;
    if (result.error || result.status !== 0) {
      consola.warn(
        `Could not relax the ${exe} execution policy; the profile may not load agents.ps1. ` +
          `Run: ${exe} -Command "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"`,
      );
    }
  }
}
