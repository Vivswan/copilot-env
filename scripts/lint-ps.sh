#!/usr/bin/env bash
# Lint the project's PowerShell scripts with PSScriptAnalyzer. No-op (with a
# hint) when pwsh or the module is unavailable, so machines without it (e.g.
# most macOS/Linux boxes) can still commit. Severity + intentional rule
# exclusions live in PSScriptAnalyzerSettings.psd1.
#
# The file list is DISCOVERED, never hand-maintained: an enumerated list silently
# stops covering a script the moment someone adds one (it did -- ensure-deno.ps1
# went unlinted). Mirrors lint-sh.sh.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v pwsh >/dev/null 2>&1; then
    echo "pwsh not installed -- skipping PowerShell lint." >&2
    exit 0
fi

pwsh -NoProfile -Command '
$ErrorActionPreference = "Stop"
if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {
    Write-Host "PSScriptAnalyzer not installed -- skipping (Install-Module PSScriptAnalyzer -Scope CurrentUser)."
    exit 0
}
$files = Get-ChildItem -Path . -Recurse -File -Filter *.ps1 |
    Where-Object { $_.FullName -notmatch "[\\/](node_modules|\.git|\.claude|\.husky._)[\\/]" }
$issues = foreach ($f in $files) { Invoke-ScriptAnalyzer -Path $f.FullName -Settings PSScriptAnalyzerSettings.psd1 }
if ($issues) { $issues | Format-Table -AutoSize | Out-String | Write-Host; exit 1 }
Write-Host "PSScriptAnalyzer: OK ($($files.Count) files)"
'
