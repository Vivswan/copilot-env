# Self-bootstrapping launcher (Windows). Installs bun if missing, runs
# cache_setup.ts, then execs the TS entry from the per-user cache.
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

$BootstrapCommand = $args[0]
if ($args -contains '--dry-run' -or $args -contains '-h' -or $args -contains '--help') {
    $BootstrapCommand = $null
}
$Cache = & bun run (Join-Path $Snap 'src\cache_setup.ts') $Snap $BootstrapCommand
if ($LASTEXITCODE -ne 0 -or -not $Cache) {
    Write-Error 'copilot-env bootstrap failed.'
    exit 1
}
$Cache = $Cache.Trim()
& bun run (Join-Path $Cache 'src\server.ts') $args
exit $LASTEXITCODE
