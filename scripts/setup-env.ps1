#!/usr/bin/env pwsh
# Windows parity of scripts/setup-env.sh: initialize a copilot-env environment (or
# a freshly-created git worktree) by installing the pinned deno toolchain (version
# from .dvmrc) and the locked project dependencies so deno task typecheck /
# deno task test / deno task lint work immediately. Idempotent. deno + deps
# only -- it does NOT install the agent CLIs or start the proxy.
$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of where we're invoked (e.g. a worktree).
Set-Location (Join-Path $PSScriptRoot '..')

# The deno bootstrap is shared with bin/agent.ps1 so the two can't drift.
. (Join-Path $PSScriptRoot 'ensure-deno.ps1')
Install-Deno -Root $PWD

Write-Host 'Initializing copilot-env: deno install --frozen ...'
& deno install --frozen
if ($LASTEXITCODE -ne 0) { throw 'deno install failed.' }

# Wire the checked-in git hooks (.githooks/pre-commit, the deno-native gate).
# Idempotent; a relative hooksPath resolves against each worktree's root.
& git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git hooks path setup failed.' }

Write-Host 'Done. Try: deno task typecheck; deno task lint; deno task test'
