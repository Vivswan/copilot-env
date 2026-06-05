# Single self-bootstrapping entry point (Windows) for copilot-env. Mirror of
# bin/agent: installs bun if missing, prepares node_modules via user_cache.ts,
# then execs the cli.ts dispatcher (start / stop / env / cost / codex_config /
# host_codex). The `agent` function in agents.ps1 turns `agent env` output into
# session state.
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

# Prepare node_modules and return the dir cli.ts runs from. Optional flags pick
# the mirror mode (--local-cache => copy cache on Windows).
function Build-Cache {
    param([string[]]$Flags = @())
    $c = & bun run (Join-Path $Snap 'src\user_cache.ts') $Snap @Flags
    if ($LASTEXITCODE -ne 0 -or -not $c) {
        Write-Error 'copilot-env bootstrap failed.'
        exit 1
    }
    return ($c | Select-Object -Last 1).Trim()
}

# `local_cache_start` is `start`, but first builds a separate per-user cache
# (--local-cache => copy mirror on Windows) and runs from it. Everything else
# runs in-place from the checkout; cli.ts dispatches either way.
if (($args.Count -ge 1) -and ($args[0] -eq 'local_cache_start')) {
    $cache = Build-Cache @('--local-cache')
    $rest = @($args | Select-Object -Skip 1)
    # Tell cli.ts where node_modules actually is so the gateway resolves.
    $env:COPILOT_ENV_ROOT = $cache
    & bun run (Join-Path $cache 'src\cli.ts') start @rest
} else {
    $cache = Build-Cache
    $env:COPILOT_ENV_ROOT = $cache
    & bun run (Join-Path $cache 'src\cli.ts') @args
}
exit $LASTEXITCODE
