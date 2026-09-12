# Dot-sourced (never executed) by scripts/setup-env.ps1 and bin/agent.ps1, so the two cannot
# drift on which deno they use; the Windows parity of scripts/ensure-deno.sh. Every message
# goes to stderr; bin/agent.ps1's stdout is the text the `agent env` profile function evals.
#
# Install-Deno -Root <repo-root> [-Quiet]
#   deno on PATH, older than .dvmrc  -> one warning, used anyway (upgrading is the user's job)
#   -Quiet                           -> no warning: the profile function re-runs bin/agent.ps1
#                                       for every `agent env` refresh and must not repeat it
#   no deno at all                   -> the latest release, once, into $env:DENO_INSTALL

# The version of the deno executable $Exe ("deno 2.9.5 (stable, ...)" -> "2.9.5"), or
# $null when it does not run.
function Get-CopilotEnvDenoVersion {
    param([Parameter(Mandatory = $true)][string]$Exe)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    $line = & $Exe --version 2>$null | Select-Object -First 1
    if ($line -match '^deno\s+(\S+)') { return $Matches[1] }
    return $null
}

# An unparseable version never compares, so it never warns.
function Test-CopilotEnvDenoOlder {
    param([string]$Have, [string]$Want)
    if ($Have -notmatch '^\d+\.\d+\.\d+$' -or $Want -notmatch '^\d+\.\d+\.\d+$') { return $false }
    try { return [version]$Have -lt [version]$Want } catch { return $false }
}

function Install-Deno {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$Quiet
    )

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
        if (-not $Quiet) {
            $have = Get-CopilotEnvDenoVersion $found.Source
            $want = (Get-Content (Join-Path $Root '.dvmrc') -Raw).Trim()
            if ($have -and (Test-CopilotEnvDenoOlder $have $want)) {
                [Console]::Error.WriteLine("==> deno $have is older than the tested $want - continuing")
            }
        }
        return
    }

    [Console]::Error.WriteLine('==> Installing the latest deno (one-time; none found on PATH) ...')
    # A random scratch name, and New-Item without -Force: a fixed name under the shared temp
    # root could be pre-created by another local user, who would then own the script run next.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    New-Item $scratch -ItemType Directory | Out-Null
    try {
        $installer = Join-Path $scratch 'deno-install.ps1'
        Invoke-RestMethod https://deno.land/install.ps1 -OutFile $installer
        & $installer | ForEach-Object { [Console]::Error.WriteLine($_) }
    } finally {
        Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
    # The installed file must itself run: a botched install fails loudly here.
    if (-not (Get-CopilotEnvDenoVersion $installed)) {
        throw "the deno install did not produce a runnable $installed."
    }
    $env:Path = "$denoBin;$env:Path"
}
