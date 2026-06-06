import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { PROJECT_ROOT } from "../utils/root.ts";

// `agent shell-integration` owns wiring the copilot-env integration into the
// user's shell startup -- the logic install.sh / install.ps1 used to duplicate.
// File wiring is done here in TS for BOTH platforms; we only shell out to tiny
// `powershell -Command` one-liners for the two Windows-only needs TS can't cover
// (resolve the (OneDrive-redirectable) Documents folder, toggle execution policy).
// The marker is a comment in both bash and PowerShell, so the wire/remove core is
// shared; only the block body and the target files differ per OS.

const MARKER = "# copilot-env shell integration";

/** A line equals the marker ignoring a trailing CR (rc/profile files may be CRLF). */
const isMarker = (line: string): boolean => line.replace(/\r$/, "") === MARKER;

export function runShellIntegration(args: { remove?: boolean; "all-hosts"?: boolean }): void {
  const remove = Boolean(args.remove);
  const windows = process.platform === "win32";

  if (remove) {
    const removed = removeFrom(
      windows ? windowsProfilePaths(Boolean(args["all-hosts"])) : rcFiles(true),
    );
    if (removed) consola.info(windows ? "Restart PowerShell." : "Restart your shell.");
    return;
  }
  if (windows) {
    wireInto(
      windowsProfilePaths(Boolean(args["all-hosts"])),
      windowsBlock(join(PROJECT_ROOT, "agents.ps1")),
    );
    relaxWindowsExecutionPolicy();
    consola.info("Restart PowerShell or run:  . $PROFILE");
  } else {
    wireInto(rcFiles(false), posixBlock(join(PROJECT_ROOT, "agents.bashrc")));
    consola.info("Restart your shell or run: source ~/.bashrc  (or ~/.zshrc)");
  }
}

// --- shared wire/remove core --------------------------------------------------

function wireInto(files: string[], block: string): void {
  for (const file of files) {
    // Exact-line marker check (matches removeFrom), so a stray mention of the
    // marker text in an unrelated line never makes wiring think it's already done.
    if (existsSync(file) && readFileSync(file, "utf-8").split("\n").some(isMarker)) {
      consola.info(`Already wired in ${file} -- skipping.`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, block);
    consola.success(`Wired shell integration into ${file}`);
  }
}

function removeFrom(files: string[]): boolean {
  let removedAny = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n");
    // Drop the marker line + the two block lines after it, plus the blank line the
    // block prepends (only when that preceding line is actually empty).
    const skip = new Set<number>();
    lines.forEach((line, idx) => {
      if (!isMarker(line)) return;
      if (idx > 0 && (lines[idx - 1] ?? "").replace(/\r$/, "") === "") skip.add(idx - 1);
      skip
        .add(idx)
        .add(idx + 1)
        .add(idx + 2);
    });
    if (skip.size === 0) continue; // marker matched as a substring but no real block
    writeFileSync(file, lines.filter((_, idx) => !skip.has(idx)).join("\n"));
    consola.success(`Removed shell integration from ${file}`);
    removedAny = true;
  }
  if (!removedAny) consola.info("No copilot-env shell integration found to remove.");
  return removedAny;
}

// --- block builders (path-quoted; exported for tests) -------------------------

/** POSIX single-quote: only `'` is special inside single quotes -> close/escape/reopen. */
export function quotePosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quote: literal (no interpolation); escape `'` by doubling it. */
export function quotePowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function posixBlock(agentsBashrc: string): string {
  return `\n${MARKER}\nAGENTS_BASHRC=${quotePosix(agentsBashrc)}\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
}

export function windowsBlock(agentsPs1: string): string {
  // -LiteralPath so a path with PowerShell wildcard chars ([ ] * ?) isn't treated
  // as a pattern (the quoting handles spaces/quotes, not wildcard semantics).
  return `\n${MARKER}\n$AgentsPs1 = ${quotePowerShell(agentsPs1)}\nif (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n`;
}

// --- POSIX target files -------------------------------------------------------

/** Existing ~/.bashrc + ~/.zshrc; for wiring, fall back to one named for $SHELL. */
function rcFiles(remove: boolean): string[] {
  const existing = [".bashrc", ".zshrc"]
    .map((f) => join(homedir(), f))
    .filter((p) => existsSync(p));
  if (existing.length > 0 || remove) return existing;
  const shell = basename(process.env.SHELL ?? "/bin/bash");
  return [join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc")];
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
// profile would silently refuse to load it. Relax CurrentUser to RemoteSigned.
function relaxWindowsExecutionPolicy(): void {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "if ((Get-ExecutionPolicy) -in 'Restricted','AllSigned','Undefined') { " +
        "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; " +
        "Write-Host 'Set CurrentUser execution policy to RemoteSigned so the profile can load agents.ps1.' }",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error || result.status !== 0) {
    consola.warn(
      "Could not relax the execution policy; the profile may not load agents.ps1. " +
        "Run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
    );
  }
}
