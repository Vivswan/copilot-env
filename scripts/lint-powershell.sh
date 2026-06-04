#!/usr/bin/env bash
# Lint the project's PowerShell scripts with PSScriptAnalyzer. No-op (with a
# hint) when pwsh or the module is unavailable, so machines without it (e.g.
# most macOS/Linux boxes) can still commit. Gates only on Warning+Error.
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
$files = "install.ps1","agents.ps1","bin/copilot-api.ps1","bin/codex-home.ps1"
$issues = foreach ($f in $files) { Invoke-ScriptAnalyzer -Path $f -Severity Warning,Error }
if ($issues) { $issues | Format-Table -AutoSize | Out-String | Write-Host; exit 1 }
Write-Host "PSScriptAnalyzer: OK"
'
