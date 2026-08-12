#!/usr/bin/env pwsh
# Windows parity of scripts/setup-env.sh: initialize a copilot-env environment (or
# a freshly-created git worktree) by installing the pinned deno toolchain (version
# from .dvmrc) and the locked project dependencies so deno task typecheck /
# deno task test / deno task lint work immediately. Idempotent. deno + deps
# only -- it does NOT install the agent CLIs or start the proxy.
$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of where we're invoked (e.g. a worktree).
Set-Location (Join-Path $PSScriptRoot '..')

$denoVersion = (Get-Content .dvmrc -Raw).Trim()
$env:DENO_NO_UPDATE_CHECK = '1'

if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    Write-Host "deno not found -- installing v$denoVersion via the official install script ..."
    $installer = Join-Path ([IO.Path]::GetTempPath()) 'deno-install.ps1'
    Invoke-RestMethod https://deno.land/install.ps1 -OutFile $installer
    & $installer "v$denoVersion"
    $denoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
    $env:Path = (Join-Path $denoHome 'bin') + [IO.Path]::PathSeparator + $env:Path
}

Write-Host 'Initializing copilot-env: deno install --frozen ...'
& deno install --frozen
if ($LASTEXITCODE -ne 0) { throw 'deno install failed.' }

# `deno install` does not run package.json lifecycle scripts, so wire the git
# hooks path explicitly; husky's bin needs node (skip-if-absent, like CI).
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path 'node_modules/husky/bin.js')) {
    & node node_modules/husky/bin.js
    if ($LASTEXITCODE -ne 0) { throw 'husky hook setup failed.' }
}

Write-Host 'Done. Try: deno task typecheck; deno task lint; deno task test'
