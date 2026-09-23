// The file lists are DISCOVERED, never hand-maintained: an enumerated list stops covering a
// script the moment one is added. A missing tool is a no-op with a hint, so commits on machines
// without it still go through.
//
//   deno task lint:sh -> shellcheck
//   deno task lint:ps -> PSScriptAnalyzer; severity and rule exclusions live in
//                        PSScriptAnalyzerSettings.psd1
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkSync } from "@std/fs/walk";
import { escapeRegExp } from "../src/utils/regexp.ts";

export type LintKind = "sh" | "ps";

/** Directory names never linted, at any depth below the root (`.husky/_` is husky's
 *  generated runner), case-insensitively like the suffixes. */
const EXCLUDED_DIR_NAMES = ["node_modules", ".git", ".claude", ".husky/_"];

/** What each kind discovers: the suffixes, plus the extensionless scripts a suffix walk
 *  cannot see (the `bin/agent` launcher and the `.githooks/pre-commit` gate). */
const DISCOVERY: Record<LintKind, { suffixes: string[]; always: string[] }> = {
  sh: { suffixes: [".sh", ".bashrc"], always: ["bin/agent", ".githooks/pre-commit"] },
  ps: { suffixes: [".ps1"], always: [] },
};

/** The walk's `skip` pattern: a directory whose path below `root` ends in an excluded name,
 *  either separator (the walk spells Windows paths with backslashes). Anchored under the
 *  resolved root because the walk judges the root itself by the same pattern, and a checkout
 *  named `node_modules` must still be linted. */
function excludedDirs(root: string): RegExp {
  const sep = "[\\\\/]";
  const names = EXCLUDED_DIR_NAMES.map((name) => escapeRegExp(name).replace("/", sep)).join("|");
  return new RegExp(`^${escapeRegExp(root)}${sep}(.*${sep})?(${names})$`, "i");
}

/** Regular files (never symlinks, FIFOs or sockets) under `root` as sorted repo-relative posix
 *  paths. `skip` prunes excluded directories before the walk enters them (node's recursive
 *  readdir has no prune and walks node_modules whole; its glob skips dotfiles). Suffixes match
 *  case-insensitively, as Windows filesystems do. Exported for test/lint_shell.test.ts. */
export function discoverLintTargets(root: string, kind: LintKind): string[] {
  const { suffixes, always } = DISCOVERY[kind];
  // Resolved once: the walk spells entry paths from the root it is given, and the pattern must
  // match them, so a relative `.` or a forward-slash Windows root would otherwise never prune.
  const base = resolve(root);
  const walk = walkSync(base, {
    includeDirs: false,
    includeSymlinks: false,
    skip: [excludedDirs(base)],
  });
  const found = [...walk]
    .filter((entry) => entry.isFile && suffixes.some((s) => entry.name.toLowerCase().endsWith(s)))
    .map((entry) => relative(base, entry.path).replaceAll("\\", "/"));
  return [...found, ...always].sort();
}

/** The tool's exit code, or null when the tool is not installed (spawn NotFound). */
function runTool(command: string, args: string[], cwd: string): number | null {
  try {
    return new Deno.Command(command, { args, cwd, stdout: "inherit", stderr: "inherit" })
      .outputSync().code;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function lintShell(root: string): number {
  const targets = discoverLintTargets(root, "sh");
  const code = runTool("shellcheck", ["--severity=warning", ...targets], root);
  if (code === null) {
    console.error("shellcheck not installed -- skipping shell lint.");
    console.error("  Install: brew install shellcheck  |  apt-get install shellcheck");
    return 0;
  }
  if (code === 0) console.log("shellcheck: OK");
  return code;
}

/** A PowerShell single-quoted string literal: only `'` needs escaping (doubled). */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function lintPowerShell(root: string): number {
  const targets = discoverLintTargets(root, "ps");
  const script = [
    '$ErrorActionPreference = "Stop"',
    "if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {",
    '    Write-Host "PSScriptAnalyzer not installed -- skipping (Install-Module PSScriptAnalyzer -Scope CurrentUser)."',
    "    exit 0",
    "}",
    `$files = @(${targets.map(psQuote).join(", ")})`,
    "$issues = foreach ($f in $files) { Invoke-ScriptAnalyzer -Path $f -Settings PSScriptAnalyzerSettings.psd1 }",
    "if ($issues) { $issues | Format-Table -AutoSize | Out-String | Write-Host; exit 1 }",
    'Write-Host "PSScriptAnalyzer: OK ($($files.Count) files)"',
  ].join("\n");
  const code = runTool("pwsh", ["-NoProfile", "-Command", script], root);
  if (code === null) {
    console.error("pwsh not installed -- skipping PowerShell lint.");
    return 0;
  }
  return code;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const kind = Deno.args[0];
  if (kind === "sh") Deno.exit(lintShell(root));
  if (kind === "ps") Deno.exit(lintPowerShell(root));
  console.error("usage: lint_shell.ts sh|ps");
  Deno.exit(2);
}
