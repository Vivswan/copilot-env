# Single self-bootstrapping entry point (Windows) for copilot-env. Mirror of
# bin/agent: installs bun if missing, installs node_modules in-place in the
# checkout (`bun install`, whose postinstall floats the gateway), then execs the
# cli.ts dispatcher (start / stop / env / cost / codex_config / host_codex). The
# `agent` function in agents.ps1 turns `agent env` output into session state.
#
# No cache: node_modules lives directly in the checkout and cli.ts runs from there.
$ErrorActionPreference = 'Stop'

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

# Install node_modules in-place in the checkout. Scripts stay enabled so bun
# install's postinstall gateway float (src/gateway_float.ts) fires every call;
# HUSKY=0 keeps husky's `prepare` from reinstalling git hooks each time. Discard
# bun's stdout (its install summary) so it can't be captured into the `agent env`
# output the profile function evals — PowerShell can't merge stdout into stderr
# (`1>&2` is reserved). bun's progress/errors and the float's messages go to
# stderr, which stays visible (and the caller silences with `2>$null`).
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

& bun run (Join-Path $Snap 'src\cli.ts') @args
exit $LASTEXITCODE
