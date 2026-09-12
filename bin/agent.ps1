# Self-bootstrapping entry point (Windows); the mirror of bin/agent.
#   stdout                        -> the CLI's own, forwarded as is; `agent env` is the text the `agent` profile function in shell/agents.ps1 evals
#   `[Console]::Error.WriteLine`  -> every other line; the POSIX twin's `>&2` (a literal `1>&2` is reserved)
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Snap = (Resolve-Path (Join-Path $Here '..')).Path

. (Join-Path $Snap 'scripts\ensure-deno.ps1')
# `agent env` is the profile function's automatic refresh after every command: its
# bootstrap runs quiet so an old PATH deno warns once per command, not twice.
Install-Deno -Root $Snap -Quiet:($args.Count -ge 1 -and $args[0] -eq 'env')

# A failed freshness read reinstalls (the self-healing direction) rather than reading as
# "deps current" and running stale node_modules.
$NodeModules = Join-Path $Snap 'node_modules'
$needInstall = $true
if (Test-Path $NodeModules) {
    $lock = Get-Item (Join-Path $Snap 'deno.lock') -ErrorAction SilentlyContinue
    $mods = Get-Item $NodeModules -ErrorAction SilentlyContinue
    if ($lock -and $mods -and $lock.LastWriteTime -le $mods.LastWriteTime) { $needInstall = $false }
}
if ($needInstall) {
    Push-Location $Snap
    try {
        & deno install --frozen | ForEach-Object { [Console]::Error.WriteLine($_) }
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('copilot-env bootstrap failed: deno install did not complete -- check network/deno, then re-run.')
        exit 1
    }
    # Mark node_modules as freshly installed so the deno.lock-vs-node_modules mtime
    # check can't loop: a no-op frozen install needn't bump the dir's mtime.
    (Get-Item $NodeModules).LastWriteTime = Get-Date
}

$Cli = Join-Path $Snap 'src\cli.ts'
& deno run -P=cli $Cli @args
exit $LASTEXITCODE
