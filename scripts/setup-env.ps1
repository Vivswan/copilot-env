#!/usr/bin/env pwsh
# Windows parity of scripts/setup-env.sh: initialize a copilot-env environment (or
# a freshly-created git worktree) by installing the pinned project dependencies so
# bun run typecheck / bun test / biome work immediately. Idempotent. bun + deps
# only -- it does NOT install the agent CLIs or start the proxy.
$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of where we're invoked (e.g. a worktree).
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is required but not found. Install it from https://bun.sh, then re-run scripts/setup-env.ps1.'
}

Write-Host 'Initializing copilot-env: bun install --frozen-lockfile ...'
& bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'bun install failed.' }
Write-Host 'Done. Try: bun run typecheck; bun run lint; bun test'
