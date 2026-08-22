# The deno bootstrap, DOT-SOURCED (never executed) by scripts/setup-env.ps1 and
# bin/agent.ps1 so the two cannot drift on which deno they install or where they look for
# it. Windows parity of scripts/ensure-deno.sh.
#
# Every message goes to stderr: bin/agent.ps1's stdout is the `$env:... = ...` text the
# `agent env` profile function evals, and one stray line there breaks the caller's session.
#
# Install-Deno -Root <repo-root>: put the .dvmrc-pinned deno on PATH, installing it when it
# is missing OR when the deno already on PATH is a DIFFERENT version -- an unpinned local
# toolchain would otherwise silently diverge from CI. Throws when `deno` still does not
# resolve to the pin afterwards.

# The version of the `deno` currently on PATH ("deno 2.9.5 (stable, ...)" -> "2.9.5"),
# or $null when there is none.
function Get-CopilotEnvDenoVersion {
    if (-not (Get-Command deno -ErrorAction SilentlyContinue)) { return $null }
    $line = & deno --version 2>$null | Select-Object -First 1
    if ($line -match '^deno\s+(\S+)') { return $Matches[1] }
    return $null
}

function Install-Deno {
    param([Parameter(Mandatory = $true)][string]$Root)

    $env:DENO_NO_UPDATE_CHECK = '1'
    $want = (Get-Content (Join-Path $Root '.dvmrc') -Raw).Trim()
    # Where the official installer puts deno, and where an existing install already is.
    # Prepending it is what lets our pinned copy win over a system deno at another version.
    # Exact segment match on ';' -- a substring test would false-positive on a longer sibling.
    $denoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
    $denoBin = Join-Path $denoHome 'bin'
    if ((Test-Path (Join-Path $denoBin 'deno.exe')) -and (($env:Path -split ';') -notcontains $denoBin)) {
        $env:Path = "$denoBin;$env:Path"
    }

    $have = Get-CopilotEnvDenoVersion
    if ($have -eq $want) { return }
    if ($have) {
        [Console]::Error.WriteLine("==> deno $have does not match the .dvmrc pin; installing v$want ...")
    } else {
        [Console]::Error.WriteLine("==> Installing deno v$want (one-time) ...")
    }
    $installer = Join-Path ([IO.Path]::GetTempPath()) 'deno-install.ps1'
    Invoke-RestMethod https://deno.land/install.ps1 -OutFile $installer
    & $installer "v$want" | ForEach-Object { [Console]::Error.WriteLine($_) }
    if (($env:Path -split ';') -notcontains $denoBin) { $env:Path = "$denoBin;$env:Path" }
    # One attempt, then verify: a botched install fails loudly here rather than letting the
    # caller run on whatever version it happens to find.
    $have = Get-CopilotEnvDenoVersion
    if ($have -ne $want) {
        $found = if ($have) { "v$have" } else { 'nothing' }
        throw "deno v$want was requested but 'deno' resolves to $found (looked in $denoBin)."
    }
}
