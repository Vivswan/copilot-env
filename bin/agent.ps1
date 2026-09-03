# Single self-bootstrapping entry point (Windows) for copilot-env. Mirror of
# bin/agent: installs deno if missing (the .dvmrc pin, via the shared
# scripts/ensure-deno.ps1 that scripts/setup-env.ps1 uses too), installs dependencies
# in-place in the checkout only when the lockfile has moved ahead of them, then runs the
# cli.ts dispatcher (cli.ts owns the subcommand list; see `agent --help`).
# The `agent` function in agents.ps1 turns `agent env` output into session state.
#
# No cache: node_modules lives directly in the checkout and cli.ts runs from there.
#
# EVERY line this script emits goes to stderr -- stdout belongs to `agent env`, whose
# output the profile function evals. `[Console]::Error.WriteLine` is the PowerShell-valid
# equivalent of the POSIX twin's `>&2` (a literal `1>&2` is reserved).
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Snap = (Resolve-Path (Join-Path $Here '..')).Path

. (Join-Path $Snap 'scripts\ensure-deno.ps1')
Install-Deno -Root $Snap

# Install dependencies in-place in the checkout, but only when needed: a missing
# node_modules, or a deno.lock that has moved ahead of it (the lockfile is the source of
# truth for what should be installed, and every dependency change updates it).
# Deps are PROVEN current only when both freshness reads succeed AND the lockfile is not
# newer: a failed read must reinstall (the self-healing direction), never read as
# "deps current" and run stale node_modules.
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

# Opt-in autoupdate preflight: ONLY on `agent start`, run before cli.ts loads so a
# swapped release is what dispatches. preflight.ts gates on the state file's
# `enabled` flag and the once-per-day cadence; the file-exists test just keeps the
# no-spawn fast path for users who never opted in. Non-fatal; output to stderr.
# `-P=cli` scopes net to the CLI's real outbound hosts; fs/run stay broad because
# permission sets take literal paths and every path we touch is HOME-relative.
$Sub = if ($args.Count -gt 0) { $args[0] } else { '' }
$AuState = Join-Path $Snap '.autoupdate\state.json'
if ($Sub -eq 'start' -and (Test-Path $AuState -PathType Leaf)) {
    # Non-fatal: write the failure to stderr and continue. Not Write-Error --
    # $ErrorActionPreference is 'Stop', which would re-throw.
    try { & deno run -P=cli (Join-Path $Snap 'src\autoupdate\preflight.ts') | ForEach-Object { [Console]::Error.WriteLine($_) } }
    catch { [Console]::Error.WriteLine("autoupdate preflight failed: $_") }
}

$Cli = Join-Path $Snap 'src\cli.ts'
& deno run -P=cli $Cli @args
exit $LASTEXITCODE
