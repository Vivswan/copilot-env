# The deno bootstrap, DOT-SOURCED (never executed) by scripts/setup-env.ps1 and
# bin/agent.ps1 so the two cannot drift on which deno they use or where they install one.
# Windows parity of scripts/ensure-deno.sh.
#
# Every message goes to stderr: bin/agent.ps1's stdout is the `$env:... = ...` text the
# `agent env` profile function evals, and one stray line there breaks the caller's session.
#
# Install-Deno -Root <repo-root>: a deno already on PATH always wins. When it is older
# than the tested version in .dvmrc it gets ONE warning and is used anyway -- upgrading is
# the user's job, and CI stays pinned via .dvmrc either way. Only a machine with no deno
# at all installs one: the LATEST release, once, into $env:DENO_INSTALL (default ~\.deno).
# Throws only when no deno resolves afterwards.

# The version of the deno executable $Exe ("deno 2.9.5 (stable, ...)" -> "2.9.5"), or
# $null when it does not run.
function Get-CopilotEnvDenoVersion {
    param([Parameter(Mandatory = $true)][string]$Exe)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    $line = & $Exe --version 2>$null | Select-Object -First 1
    if ($line -match '^deno\s+(\S+)') { return $Matches[1] }
    return $null
}

# True only when version $Have is strictly older than $Want, both x.y.z. An unparseable
# version never compares, so it never warns.
function Test-CopilotEnvDenoOlder {
    param([string]$Have, [string]$Want)
    if ($Have -notmatch '^\d+\.\d+\.\d+$' -or $Want -notmatch '^\d+\.\d+\.\d+$') { return $false }
    try { return [version]$Have -lt [version]$Want } catch { return $false }
}

function Install-Deno {
    param([Parameter(Mandatory = $true)][string]$Root)

    $env:DENO_NO_UPDATE_CHECK = '1'
    $denoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
    $denoBin = Join-Path $denoHome 'bin'
    $installed = Join-Path $denoBin 'deno.exe'

    $found = Get-Command deno -ErrorAction SilentlyContinue
    if (-not $found -and (Test-Path $installed)) {
        # An earlier one-time install the caller's PATH lost: put it back on.
        $env:Path = "$denoBin;$env:Path"
        $found = Get-Command deno -ErrorAction SilentlyContinue
    }
    if ($found) {
        $have = Get-CopilotEnvDenoVersion $found.Source
        $want = (Get-Content (Join-Path $Root '.dvmrc') -Raw).Trim()
        if ($have -and (Test-CopilotEnvDenoOlder $have $want)) {
            [Console]::Error.WriteLine("==> deno $have is older than the tested $want - continuing")
        }
        return
    }

    [Console]::Error.WriteLine('==> Installing the latest deno (one-time; none found on PATH) ...')
    # A private scratch directory for the download: a fixed name under the shared temp
    # root can be pre-created by another local user, who would then have written the
    # script we are about to execute. New-Item without -Force fails rather than reusing a
    # directory we did not make. No version argument: the official installer defaults to
    # the latest release.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    New-Item $scratch -ItemType Directory | Out-Null
    try {
        $installer = Join-Path $scratch 'deno-install.ps1'
        Invoke-RestMethod https://deno.land/install.ps1 -OutFile $installer
        & $installer | ForEach-Object { [Console]::Error.WriteLine($_) }
    } finally {
        Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
    # One attempt, then verify the installed file itself runs (the exact version is
    # whatever "latest" was): a botched install fails loudly here.
    if (-not (Get-CopilotEnvDenoVersion $installed)) {
        throw "the deno install did not produce a runnable $installed."
    }
    $env:Path = "$denoBin;$env:Path"
}
