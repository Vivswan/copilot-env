// The file lists are DISCOVERED, never hand-maintained: an enumerated list stops covering a
// script the moment one is added. A missing tool is a no-op with a hint, so commits on machines
// without it still go through.
//
//   deno task lint:sh -> shellcheck
//   deno task lint:ps -> PSScriptAnalyzer; severity and rule exclusions live in
//                        PSScriptAnalyzerSettings.psd1
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type LintKind = "sh" | "ps";

/** Directories never linted, matched at any depth by their repo-relative posix path,
 *  case-insensitively like the suffixes (`.husky/_` is husky's generated runner). */
const EXCLUDED_DIRS = /(^|\/)(node_modules|\.git|\.claude|\.husky\/_)$/i;

/** What each kind discovers: the suffixes, plus the extensionless scripts a suffix walk
 *  cannot see (the `bin/agent` launcher and the `.githooks/pre-commit` gate). */
const DISCOVERY: Record<LintKind, { suffixes: string[]; always: string[] }> = {
  sh: { suffixes: [".sh", ".bashrc"], always: ["bin/agent", ".githooks/pre-commit"] },
  ps: { suffixes: [".ps1"], always: [] },
};

/** Regular files (never symlinks) under `root` as sorted repo-relative posix paths,
 *  pruning EXCLUDED_DIRS. Suffixes match case-insensitively, as Windows filesystems do.
 *  Exported for test/lint_shell.test.ts. */
export function discoverLintTargets(root: string, kind: LintKind): string[] {
  const { suffixes, always } = DISCOVERY[kind];
  const found: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of Deno.readDirSync(join(root, relativeDir))) {
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory) {
        if (!EXCLUDED_DIRS.test(relative)) walk(relative);
      } else if (entry.isFile && suffixes.some((s) => entry.name.toLowerCase().endsWith(s))) {
        found.push(relative);
      }
    }
  };
  walk("");
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
