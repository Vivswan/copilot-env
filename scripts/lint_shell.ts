// The file lists are DISCOVERED, never hand-maintained: an enumerated list stops covering a
// script the moment one is added. A missing tool is a no-op with a hint, so commits on machines
// without it still go through.
//
//   bun run lint:sh -> shellcheck
//   bun run lint:ps -> PSScriptAnalyzer; severity and rule exclusions live in
//                      PSScriptAnalyzerSettings.psd1
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Whether the directory at the root-relative posix path `rel` is excluded: its path ends in
 *  one of the names. Judged below the root only, so a checkout named `node_modules` is still
 *  linted. */
function excludedDir(rel: string): boolean {
  const lower = rel.toLowerCase();
  return EXCLUDED_DIR_NAMES.some((name) => lower === name || lower.endsWith(`/${name}`));
}

/** Regular files (never symlinks, FIFOs or sockets) under `root` as sorted repo-relative posix
 *  paths. Excluded directories are pruned before the walk enters them (node's recursive readdir
 *  has no prune and walks node_modules whole; the glob APIs skip dot directories, and
 *  `.husky/pre-commit.sh` is linted). An unreadable directory throws: a skipped one would read as
 *  "nothing there". Suffixes match case-insensitively, as Windows filesystems do. Exported for
 *  test/shell/lint_shell.test.ts. */
export function discoverLintTargets(root: string, kind: LintKind): string[] {
  const { suffixes, always } = DISCOVERY[kind];
  const base = resolve(root);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (!excludedDir(rel)) walk(path);
      } else if (entry.isFile() && suffixes.some((s) => entry.name.toLowerCase().endsWith(s))) {
        found.push(rel);
      }
    }
  };
  walk(base);
  return [...found, ...always].sort();
}

/** The tool's exit code, or null when the tool is not installed (spawn ENOENT). */
function runTool(command: string, args: string[], cwd: string): number | null {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw result.error;
  }
  return result.status ?? 1;
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
  const kind = process.argv[2];
  if (kind === "sh") process.exit(lintShell(root));
  if (kind === "ps") process.exit(lintPowerShell(root));
  console.error("usage: lint_shell.ts sh|ps");
  process.exit(2);
}
