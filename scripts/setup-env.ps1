#!/usr/bin/env pwsh
# The Windows twin of scripts/setup-env.sh: the one env init. deno + deps only: it never
# installs the agent CLIs or starts the proxy.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

. (Join-Path $PSScriptRoot 'ensure-deno.ps1')
# Looked up BEFORE Install-Deno, which prepends its bin dir to this process's PATH: the note at
# the end is for the CALLER's shells, which never saw that prepend.
$callerHasDeno = [bool](Get-Command deno -ErrorAction SilentlyContinue)
Install-Deno -Root $PWD

Write-Host 'Initializing copilot-env: deno install --frozen ...'
& deno install --frozen
if ($LASTEXITCODE -ne 0) { throw 'deno install failed.' }

# A relative hooksPath resolves against each worktree's root.
& git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git hooks path setup failed.' }

Write-Host 'Done. Try: deno task typecheck; deno task lint; deno task test'
if (-not $callerHasDeno) {
    $denoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
    $denoBin = Join-Path $denoHome 'bin'
    Write-Host "Note: put $denoBin on PATH for new shells; this script does not edit the User PATH or your profile."
}
