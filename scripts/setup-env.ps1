#!/usr/bin/env pwsh
# The Windows twin of scripts/setup-env.sh: the one env init. deno + deps only: it never
# installs the agent CLIs or starts the proxy.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

. (Join-Path $PSScriptRoot 'ensure-deno.ps1')
Install-Deno -Root $PWD

Write-Host 'Initializing copilot-env: deno install --frozen ...'
& deno install --frozen
if ($LASTEXITCODE -ne 0) { throw 'deno install failed.' }

# A relative hooksPath resolves against each worktree's root.
& git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git hooks path setup failed.' }

Write-Host 'Done. Try: deno task typecheck; deno task lint; deno task test'
