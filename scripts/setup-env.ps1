#!/usr/bin/env pwsh
# The Windows twin of scripts/setup-env.sh: the one env init. bun + deps only: it never
# installs the agent CLIs or starts the proxy.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

. (Join-Path $PSScriptRoot 'ensure-bun.ps1')
# Looked up BEFORE Install-CopilotEnvBun prepends its bin dir to this process's PATH: that
# prepend lives only as long as this session, so the note at the end tells the user what FUTURE
# shells need.
$callerHasBun = [bool](Get-Command bun -ErrorAction SilentlyContinue)
Install-CopilotEnvBun -Root $PWD

Write-Host 'Initializing copilot-env: bun install --frozen-lockfile ...'
& bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'bun install failed.' }

# A relative hooksPath resolves against each worktree's root.
& git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git hooks path setup failed.' }

Write-Host 'Done. Try: bun run typecheck; bun run lint; bun run test:unit'
if (-not $callerHasBun) {
    $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
    $bunBin = Join-Path $bunHome 'bin'
    Write-Host "Note: put $bunBin on PATH for new shells; this script does not edit the User PATH or your profile."
}
