# Self-bootstrapping entry point (Windows); the mirror of bin/agent.
#   stdout                        -> the CLI's own, forwarded as is; `agent profile env` is the text the `agent` profile function in shell/agents.ps1 evals
#   `[Console]::Error.WriteLine`  -> every other line; the POSIX twin's `>&2` (a literal `1>&2` is reserved)
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Snap = (Resolve-Path (Join-Path $Here '..')).Path

. (Join-Path $Snap 'scripts\ensure-bun.ps1')
# `agent profile env` is the profile function's automatic refresh after every command: its
# bootstrap runs quiet so an old PATH bun warns once per command, not twice.
Install-CopilotEnvBun -Root $Snap -Quiet:($args.Count -ge 2 -and $args[0] -eq 'profile' -and $args[1] -eq 'env')

# A failed freshness read reinstalls (the self-healing direction) rather than reading as
# "deps current" and running stale node_modules.
$NodeModules = Join-Path $Snap 'node_modules'
$needInstall = $true
if (Test-Path $NodeModules) {
    $lock = Get-Item (Join-Path $Snap 'bun.lock') -ErrorAction SilentlyContinue
    $mods = Get-Item $NodeModules -ErrorAction SilentlyContinue
    if ($lock -and $mods -and $lock.LastWriteTime -le $mods.LastWriteTime) { $needInstall = $false }
}
if ($needInstall) {
    Push-Location $Snap
    try {
        & bun install --frozen-lockfile | ForEach-Object { [Console]::Error.WriteLine($_) }
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('copilot-env bootstrap failed: bun install did not complete -- check network/bun, then re-run.')
        exit 1
    }
    # Mark node_modules as freshly installed so the bun.lock-vs-node_modules mtime
    # check can't loop: a no-op frozen install needn't bump the dir's mtime.
    (Get-Item $NodeModules).LastWriteTime = Get-Date
}

$Cli = Join-Path $Snap 'src\cli.ts'
# --no-env-file: bun otherwise loads a `.env` from the cwd into the CLI's environment, which
# the compiled binary never does.
& bun --no-env-file run $Cli @args
exit $LASTEXITCODE
