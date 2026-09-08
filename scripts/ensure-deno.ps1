# The deno bootstrap, DOT-SOURCED (never executed) by scripts/setup-env.ps1 and
# bin/agent.ps1 so the two cannot drift on which deno they install or where they look for
# it. Windows parity of scripts/ensure-deno.sh.
#
# Every message goes to stderr: bin/agent.ps1's stdout is the `$env:... = ...` text the
# `agent env` profile function evals, and one stray line there breaks the caller's session.
#
# Install-Deno -Root <repo-root>: make `deno` resolve to the .dvmrc-pinned copy under
# $env:DENO_INSTALL (default ~\.deno), installing it there when it is missing or at another
# version -- an unpinned local toolchain would otherwise silently diverge from CI. Only the
# pinned copy is ever version-checked: a scoop/choco deno earlier on PATH is not a reason to
# reinstall, it is a reason to put the pinned copy ahead of it. Throws when `deno` still
# does not resolve to the pin afterwards.

# The version of the deno executable $Exe ("deno 2.9.5 (stable, ...)" -> "2.9.5"), or
# $null when it does not run.
function Get-CopilotEnvDenoVersion {
    param([Parameter(Mandatory = $true)][string]$Exe)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    $line = & $Exe --version 2>$null | Select-Object -First 1
    if ($line -match '^deno\s+(\S+)') { return $Matches[1] }
    return $null
}

function Install-Deno {
    param([Parameter(Mandatory = $true)][string]$Root)

    $env:DENO_NO_UPDATE_CHECK = '1'
    $want = (Get-Content (Join-Path $Root '.dvmrc') -Raw).Trim()
    # Where the official installer puts deno, and where an existing install already is.
    $denoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
    $denoBin = Join-Path $denoHome 'bin'
    $pinned = Join-Path $denoBin 'deno.exe'

    $have = Get-CopilotEnvDenoVersion $pinned
    if ($have -ne $want) {
        if ($have) {
            [Console]::Error.WriteLine("==> deno $have at $pinned does not match the .dvmrc pin; installing v$want ...")
        } else {
            [Console]::Error.WriteLine("==> Installing deno v$want (one-time) ...")
        }
        # A private scratch directory for the download: a fixed name under the shared temp
        # root can be pre-created by another local user, who would then have written the
        # script we are about to execute. New-Item without -Force fails rather than reusing a
        # directory we did not make.
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
        New-Item $scratch -ItemType Directory | Out-Null
        try {
            $installer = Join-Path $scratch 'deno-install.ps1'
            Invoke-RestMethod https://deno.land/install.ps1 -OutFile $installer
            & $installer "v$want" | ForEach-Object { [Console]::Error.WriteLine($_) }
        } finally {
            Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
        }
        # One attempt, then verify the pinned file itself: a botched install fails loudly
        # here rather than letting the caller run on whatever version it happens to find.
        $have = Get-CopilotEnvDenoVersion $pinned
        if ($have -ne $want) {
            $found = if ($have) { "v$have" } else { 'nothing' }
            throw "deno v$want was requested but $pinned is $found."
        }
    }

    # Prepend, not "add if absent": the pinned copy must WIN, and PATH may already list its
    # directory behind another deno (the installer itself only ever appends it).
    $resolved = Get-Command deno -ErrorAction SilentlyContinue
    if (-not $resolved -or $resolved.Source -ne $pinned) { $env:Path = "$denoBin;$env:Path" }
}
