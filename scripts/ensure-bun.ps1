# Dot-sourced (never executed) by scripts/setup-env.ps1 and bin/agent.ps1, so the two cannot
# drift on which bun they use; the Windows parity of scripts/ensure-bun.sh. Every message
# goes to stderr; bin/agent.ps1's stdout is the text the `agent profile env` profile function evals.
#
# Install-CopilotEnvBun -Root <repo-root> [-Quiet]
#   bun on PATH, older than .bun-version -> one warning, used anyway (upgrading is the user's job)
#   -Quiet                               -> no warning: the profile function re-runs bin/agent.ps1
#                                           for every `agent profile env` refresh and must not repeat it
#   no bun at all                        -> the .bun-version release (the latest when the file is
#                                           absent), once, into $env:BUN_INSTALL\bin\bun.exe

# The version of the bun executable $Exe ("1.4.2" -> "1.4.2"), or $null when it does not run.
function Get-CopilotEnvBunVersion {
    param([Parameter(Mandatory = $true)][string]$Exe)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    $line = & $Exe --version 2>$null | Select-Object -First 1
    if ($line -match '^(\d+\.\d+\.\d+)') { return $Matches[1] }
    return $null
}

# An unparseable version never compares, so it never warns.
function Test-CopilotEnvBunOlder {
    param([string]$Have, [string]$Want)
    if ($Have -notmatch '^\d+\.\d+\.\d+$' -or $Want -notmatch '^\d+\.\d+\.\d+$') { return $false }
    try { return [version]$Have -lt [version]$Want } catch { return $false }
}

function Install-CopilotEnvBun {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$Quiet
    )

    $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
    $bunBin = Join-Path $bunHome 'bin'
    $installed = Join-Path $bunBin 'bun.exe'
    # Absent on a checkout the platform sync has not written it to: no pin, the latest installs.
    $pinFile = Join-Path $Root '.bun-version'
    $want = if (Test-Path $pinFile) { (Get-Content $pinFile -Raw).Trim() } else { '' }

    $found = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $found -and (Test-Path $installed)) {
        # An earlier one-time install the caller's PATH lost: put it back on.
        $env:Path = "$bunBin;$env:Path"
        $found = Get-Command bun -ErrorAction SilentlyContinue
    }
    if ($found) {
        if (-not $Quiet -and $want) {
            $have = Get-CopilotEnvBunVersion $found.Source
            if ($have -and (Test-CopilotEnvBunOlder $have $want)) {
                [Console]::Error.WriteLine("==> bun $have is older than the tested $want - continuing")
            }
        }
        return
    }

    $label = if ($want) { $want } else { '(latest)' }
    [Console]::Error.WriteLine("==> Installing bun $label (one-time; none found on PATH) into $installed ...")
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        throw 'curl.exe is required to install bun and was not found on PATH.'
    }
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    New-Item $scratch -ItemType Directory | Out-Null
    try {
        $script = Join-Path $scratch 'install.ps1'
        & curl.exe -fsSL -o $script https://bun.sh/install.ps1
        if ($LASTEXITCODE -ne 0) { throw 'could not download the bun installer.' }
        # The official installer with its side effects switched off: PATH is bin/agent.ps1's and
        # shell/agents.ps1's job, and it registers no uninstaller and installs no completions. It
        # writes only under $bunHome. Its failures are printed, not exit codes, so the installed
        # file is checked below.
        $installArgs = @('-NoPathUpdate', '-NoRegisterInstallation', '-NoCompletions')
        if ($want) { $installArgs += @('-Version', $want) }
        & $script @installArgs | ForEach-Object { [Console]::Error.WriteLine($_) }
    } finally {
        Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
    # The installed file must itself run: a botched install fails loudly here.
    if (-not (Get-CopilotEnvBunVersion $installed)) {
        throw "the bun install did not produce a runnable $installed."
    }
    [Console]::Error.WriteLine("bun $label was installed to $installed")
    $env:Path = "$bunBin;$env:Path"
}
