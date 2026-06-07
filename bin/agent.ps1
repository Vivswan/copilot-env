# Single self-bootstrapping entry point (Windows) for copilot-env. Mirror of
# bin/agent: installs bun if missing, installs node_modules in-place in the
# checkout only when a read-only `gateway_float.ts --verify` says it's needed
# (stale float / missing or out-of-sync node_modules), then runs the cli.ts
# dispatcher (start / stop / env / cost / codex-config / host-codex). The
# `agent` function in agents.ps1 turns `agent env` output into session state.
#
# No cache: node_modules lives directly in the checkout and cli.ts runs from there.
$ErrorActionPreference = 'Stop'
# PowerShell 7.4+ can surface native stderr as terminating errors when
# $ErrorActionPreference='Stop', even if the native command exits 0. The
# gateway verify path intentionally writes status to stderr, so keep native
# stderr non-terminating and rely on explicit $LASTEXITCODE checks.
$PSNativeCommandUseErrorActionPreference = $false

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Snap = (Resolve-Path (Join-Path $Here '..')).Path

$BunExe = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and -not (Test-Path $BunExe)) {
    Write-Host '==> Installing bun (one-time) ...' -ForegroundColor Yellow
    powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' | Out-Null
}
if (Test-Path $BunExe) {
    $env:Path = "$(Split-Path $BunExe -Parent);$env:Path"
}

# Install node_modules in-place in the checkout, but only when needed: a read-only
# `gateway_float.ts --verify` checks whether this call can skip install. Normal
# no-env verify reads npm publish-time metadata, computes the cooldown-aged target,
# and compares it to the installed gateway; missing/stale node_modules still force
# install. HUSKY=0 keeps husky's `prepare` from reinstalling git hooks each time.
# Discard bun's stdout (its install summary) so it can't be captured into the
# `agent env` output the profile function evals -- PowerShell can't merge stdout
# into stderr (`1>&2` is reserved). bun's progress/errors and the float's messages
# go to stderr (the caller silences with `2>$null`); the verify's own output is
# discarded for the same reason.
$needInstall = -not (Test-Path (Join-Path $Snap 'node_modules'))
if (-not $needInstall) {
    $GatewayFloat = Join-Path $Snap 'src\gateway_float.ts'
    $priorErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & bun $GatewayFloat --verify 1>$null 2>$null
    } finally {
        $ErrorActionPreference = $priorErrorActionPreference
    }
    if ($LASTEXITCODE -ne 0) { $needInstall = $true }
}
if ($needInstall) {
    $env:HUSKY = '0'
    Push-Location $Snap
    try {
        & bun install --frozen-lockfile > $null
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'copilot-env bootstrap failed.'
        exit 1
    }
    # Mark node_modules as freshly installed so the bun.lock-vs-node_modules mtime
    # check can't loop: a frozen no-op install needn't bump the dir's mtime.
    (Get-Item (Join-Path $Snap 'node_modules')).LastWriteTime = Get-Date
}

$Cli = Join-Path $Snap 'src\cli.ts'
& bun $Cli @args
exit $LASTEXITCODE
