// Cross-platform shell/profile integration writer for agent wrappers and launchers.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

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
    const files = windows ? windowsProfilePaths(Boolean(args.allHosts)) : rcFiles(true);
    const restartHint = windows ? "Restart PowerShell." : "Restart your shell.";
    const removed = remove ? removeFrom(files) : removeLaunchersFrom(files);
    if (removed) consola.info(restartHint);
    return;
  }
  const launchers = Boolean(args.launchers);
  const existingOnly = Boolean(args.existingOnly);
  if (windows) {
    const wired = wireBlocks(
      windowsProfilePaths(Boolean(args.allHosts)),
      windowsBlock(join(PROJECT_ROOT, "shell", "agents.ps1")),
      windowsLaunchersBlock(join(PROJECT_ROOT, "shell", "agents.launchers.ps1")),
      launchers,
      existingOnly,
    );
    // Only relax execution policy when integration is actually present -- never for an
    // opted-out user whose `existingOnly` migration found no owned block to refresh.
    if (wired) relaxWindowsExecutionPolicy();
    consola.info("Restart PowerShell or run: . $PROFILE");
  } else {
    wireBlocks(
      rcFiles(false),
      posixBlock(join(PROJECT_ROOT, "shell", "agents.bashrc")),
      posixLaunchersBlock(join(PROJECT_ROOT, "shell", "agents.launchers.bashrc")),
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

export function posixBlock(agentsBashrc: string): string {
  return `\n${MARKER}\nAGENTS_BASHRC=${quotePosix(agentsBashrc)}\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
}

/** Opt-in launchers block; sourced after posixBlock so the `agent` wrapper exists. */
export function posixLaunchersBlock(launchersBashrc: string): string {
  return `\n${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS=${quotePosix(launchersBashrc)}\n[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"\n`;
}

export function windowsBlock(agentsPs1: string): string {
  // -LiteralPath so a path with PowerShell wildcard chars ([ ] * ?) isn't treated
  // as a pattern (the quoting handles spaces/quotes, not wildcard semantics).
  return `\n${MARKER}\n$AgentsPs1 = ${quotePowerShell(agentsPs1)}\nif (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n`;
}

/** Opt-in launchers block; dot-sourced after windowsBlock so the `agent` wrapper exists. */
export function windowsLaunchersBlock(launchersPs1: string): string {
  return `\n${LAUNCHERS_MARKER}\n$AgentsLaunchers = ${quotePowerShell(launchersPs1)}\nif (Test-Path -LiteralPath $AgentsLaunchers) { . $AgentsLaunchers }\n`;
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

// --- POSIX target files -------------------------------------------------------

/** Existing ~/.bashrc + ~/.zshrc; for wiring, fall back to one named for $SHELL. */
export function rcFiles(remove: boolean): string[] {
  const existing = [".bashrc", ".zshrc"]
    .map((f) => join(homedir(), f))
    .filter((p) => existsSync(p));
  if (existing.length > 0 || remove) return existing;
  const shell = basename(process.env.SHELL ?? "/bin/bash");
  return [join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc")];
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
  return [...new Set([...windowsProfilePaths(false), ...windowsProfilePaths(true)])];
}

// --- Windows (file ops in TS; PS only for what it must) ------------------------

function windowsProfilePaths(allHosts: boolean): string[] {
  const documents = psEval("[Environment]::GetFolderPath('MyDocuments')");
  if (!documents) throw new Error("could not resolve the Documents folder via PowerShell");
  const name = allHosts ? "profile.ps1" : "Microsoft.PowerShell_profile.ps1";
  return [
    ...new Set([join(documents, "WindowsPowerShell", name), join(documents, "PowerShell", name)]),
  ];
}

function psEval(command: string): string {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? `exit ${result.status}: ${(result.stderr ?? "").toString().trim()}`;
    throw new Error(`powershell command failed (${detail}). Is PowerShell on PATH?`);
  }
  return (result.stdout ?? "").toString().trim();
}

// The profile dot-sources the unsigned agents.ps1; under Restricted/AllSigned the
// profile would silently refuse to load it. Relax CurrentUser to RemoteSigned. CurrentUser
// policy keys are per-edition, so run it in each installed edition (5.1 + pwsh 7).
function relaxWindowsExecutionPolicy(): void {
  const command = windowsExecutionPolicyCommand();
  for (const exe of ["powershell", "pwsh"]) {
    const result = spawnSync(exe, ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    // Edition not installed (pwsh-only or 5.1-only machine): nothing to relax there.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
    if (result.error || result.status !== 0) {
      consola.warn(
        `Could not relax the ${exe} execution policy; the profile may not load agents.ps1. ` +
          `Run: ${exe} -Command "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"`,
      );
    }
  }
}
