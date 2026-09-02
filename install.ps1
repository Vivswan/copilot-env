# copilot-env installer (Windows).
#
# Bootstrap only: download the compiled Windows agent binary from the selected
# copilot-env GitHub release, verify its SHA256 against the release's
# checksums.txt, install it as <install-dir>\bin\copilot-env.exe, then hand off
# to the binary's own `install` subcommand (it materializes the runtime
# assets, the bin\agent launcher shims, and the shell integration). Optional
# CLIs and launchers are managed after install with
# `agent shell --clis --launchers`.

<#
.SYNOPSIS
Installs copilot-env (Windows twin of install.sh).

.DESCRIPTION
Installs copilot-env into $env:USERPROFILE\.copilot-env by downloading the
compiled agent binary from the selected GitHub release, verifying its SHA256,
and wiring shell integration by default. Optional agent CLIs and launchers are
configured after install:

  agent shell --clis [--cooldown[=DAYS]] [--no-sudo] [--no-prereqs] [--launchers]

The main-branch installer resolves the latest release; release assets are
pinned to their release tag. $env:COPILOT_ENV_DOWNLOAD_BASE (a directory or a
base URL holding the agent binary and checksums.txt) overrides the release
download source; CI uses it to smoke draft releases.

.PARAMETER InstallDir
Install target (default $env:USERPROFILE\.copilot-env). Takes precedence over
$env:COPILOT_ENV_DIR.

.PARAMETER Version
Install a specific release tag (e.g. v3.5.6) instead of the default. Takes
precedence over $env:COPILOT_ENV_INSTALL_REF.

.PARAMETER NoShellIntegration
Do not wire the PowerShell $PROFILE. Run `agent shell` later to enable it.

.PARAMETER NoExecShell
Do not offer to reload your shell at the end. The offer is also skipped when
non-interactive or under CI, or when $env:COPILOT_ENV_NO_EXEC_SHELL is set.

.PARAMETER AllHosts
Wire the shell integration into the CurrentUserAllHosts PowerShell profile
instead of the current host's profile.
#>

[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'Version',
    Justification = 'Read by the nested Resolve-ReleaseTag; the rule does not follow a script-scope param into function bodies.')]
param(
    [switch]$AllHosts,
    [string]$InstallDir = '',
    [string]$Version = '',
    [switch]$NoShellIntegration,
    [switch]$NoExecShell
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Windows PowerShell 5.1 (the shell the README one-liner runs) inherits .NET
# Framework's protocol default, which can exclude TLS 1.2 on older machines;
# GitHub requires TLS 1.2+. -bor preserves anything newer the machine already
# negotiates. pwsh needs no floor, and its HttpClient ignores this property.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
# 5.1's Invoke-WebRequest redraws its progress bar per buffer, slowing large
# downloads by orders of magnitude; the installer has no other progress UI.
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 spawned from pwsh (the README one-liner run inside a
# pwsh session) inherits pwsh's PSModulePath, whose prepended PowerShell 7
# module directories shadow 5.1's own: in-box cmdlets (Invoke-WebRequest,
# Get-FileHash) then autoload Core-edition modules 5.1 cannot load. Reset the
# Desktop edition to its native machine module path -- the same defense as
# src/shell/integration.ts's execution-policy command. pwsh resolves its own
# modules fine, so it is left alone.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    $MachineModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
    # No cmdlet in the fallback: it runs exactly when autoload cannot be trusted.
    if (-not $MachineModulePath) { $MachineModulePath = "$PSHOME\Modules" }
    $env:PSModulePath = $MachineModulePath
}

# The next line is rewritten to the release tag by .github/scripts/release-assets.ts
# (byte-exact needle; test/installer_pinning.test.ts guards the match).
$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }
$Repo = 'Vivswan/copilot-env'
$BinaryName = 'copilot-env.exe'
# The Authorization header goes only to api.github.com (tag resolution);
# release-asset downloads ride the public URL anonymously. User-Agent rides
# every call's dedicated -UserAgent parameter: Windows PowerShell 5.1's
# -Headers cannot carry it (a restricted header on .NET Framework).
$UserAgent = 'copilot-env'
$AuthHeaders = @{ 'Accept' = 'application/vnd.github+json' }
$AuthToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
if ($AuthToken) {
    $AuthHeaders['Authorization'] = "Bearer $AuthToken"
}
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][scriptblock]$Script
    )

    for ($try = 1; $try -le 3; $try++) {
        try {
            return & $Script
        } catch {
            if ($try -ge 3) { throw }
            Write-Warning "$Label failed; retrying ($try/3): $($_.Exception.Message)"
            Start-Sleep -Seconds ($try * 2)
        }
    }
}

# Lexically absolutize and normalize $InstallDir and refuse the obviously
# unsafe targets (wildcards, any filesystem root, the user's home).
# Deliberately minimal and purely lexical: the binary's own `install`
# re-checks the CANONICAL path (reparse points and 8.3 short names resolved)
# when it plans the install (src/install/installer.ts); this pre-check only
# keeps the bootstrap's writes away from the worst targets. Mirrors
# resolve_safe_install_dir in install.sh.
function Resolve-SafeInstallDir {
    # Reject wildcard characters up front: PowerShell's file cmdlets expand
    # them, so an input like 'C:\Users\*' would otherwise act on every match.
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($InstallDir)) {
        throw "Refusing to use unsafe install directory '$InstallDir' (contains wildcard characters)."
    }
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $alt = [System.IO.Path]::AltDirectorySeparatorChar
    # GetFullPath is lexical (absolutize, collapse '.'/'..'); trim trailing
    # separators (never past the path root) so 'C:\Users\me\' -ieq 'C:\Users\me'.
    $full = [System.IO.Path]::GetFullPath($InstallDir)
    $root = [System.IO.Path]::GetPathRoot($full)
    $normResolved = if ($full.Length -gt $root.Length) { $full.TrimEnd($sep, $alt) } else { $full }
    $userHome = [System.IO.Path]::GetFullPath($env:USERPROFILE)
    $homeRoot = [System.IO.Path]::GetPathRoot($userHome)
    $normHome = if ($userHome.Length -gt $homeRoot.Length) { $userHome.TrimEnd($sep, $alt) } else { $userHome }
    if (-not $normResolved -or $normResolved -eq $root -or $normResolved -ieq $normHome) {
        throw "Refusing to use unsafe install directory '$InstallDir'."
    }
    return $normResolved
}

# The Windows entry of the platform -> release-target mapping (install.sh
# carries the Linux/macOS entries; src/install/targets.ts owns the target list).
function Resolve-Target {
    # Not [RuntimeInformation]::OSArchitecture: that type is unresolvable on stock Windows
    # PowerShell 5.1, the shell the README one-liner runs. PROCESSOR_ARCHITEW6432 carries
    # the native architecture when a 32-bit process runs on a 64-bit OS.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { return 'x86_64-pc-windows-msvc' }
        default { throw "No prebuilt copilot-env binary for Windows/$arch." }
    }
}

function Resolve-ReleaseTag {
    if ($Version) { return $Version }
    if ($InstallRef -ne 'latest') { return $InstallRef }
    $release = Invoke-WithRetry 'Resolve latest release' {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $AuthHeaders -UserAgent $UserAgent
    }
    $tag = [string]$release.tag_name
    if ($tag -notmatch '^v[0-9]') { throw "Could not resolve a release tag (got '$tag')." }
    return $tag
}

# Fetch one release file into $Destination: from the override directory
# (pwsh's Invoke-WebRequest cannot fetch file:// URIs, hence directory mode),
# the override URL, or the resolved GitHub release download URL.
function Get-ReleaseFile {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Destination
    )

    if ($DownloadDir) {
        Copy-Item -LiteralPath (Join-Path $DownloadDir $Name) -Destination $Destination -Force
    } else {
        Invoke-WithRetry "Download $Name" {
            Invoke-WebRequest -Uri "$DownloadUrlBase/$Name" -OutFile $Destination -UseBasicParsing -UserAgent $UserAgent
        } | Out-Null
    }
}

# The one checksums.txt line for $AssetName, parsed to its lowercase SHA256 (a
# leading "*" marks binary mode in shasum output; accept both forms).
function Get-ExpectedSha256 {
    param(
        [Parameter(Mandatory)][string]$ChecksumsPath,
        [Parameter(Mandatory)][string]$AssetName
    )

    foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -lt 2) { continue }
        if ($parts[1].TrimStart('*') -eq $AssetName) { return $parts[0].ToLowerInvariant() }
    }
    throw "checksums.txt has no entry for $AssetName."
}

$InstallDir = Resolve-SafeInstallDir

# A source checkout must never be an install target: checkout markers plus .git
# (a directory, or a file in a worktree) mirrors the binary's own plan-time
# refusal (CHECKOUT_MARKERS in src/install/installer.ts), before the bin write
# touches the root. Markers without .git are a legacy source install, whose
# superseded artifacts the binary sweeps.
if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
    foreach ($marker in @('package.json', 'deno.json')) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $marker)) {
            throw "Refusing to install into ${InstallDir}: it holds $marker and .git, so it is a source checkout; choose another target with -InstallDir or `$env:COPILOT_ENV_DIR."
        }
    }
}

$Target = Resolve-Target
$AssetName = "copilot-env-$Target.exe"

$DownloadDir = ''
$DownloadUrlBase = ''
if ($env:COPILOT_ENV_DOWNLOAD_BASE) {
    if (Test-Path -LiteralPath $env:COPILOT_ENV_DOWNLOAD_BASE -PathType Container) {
        $DownloadDir = $env:COPILOT_ENV_DOWNLOAD_BASE
    } else {
        $DownloadUrlBase = $env:COPILOT_ENV_DOWNLOAD_BASE
    }
    Write-Host "Downloading copilot-env ($AssetName) from $($env:COPILOT_ENV_DOWNLOAD_BASE) into $InstallDir ..."
} else {
    Write-Host 'Resolving the copilot-env release ...'
    $Tag = Resolve-ReleaseTag
    $DownloadUrlBase = "https://github.com/$Repo/releases/download/$Tag"
    Write-Host "Downloading copilot-env $Tag ($AssetName) into $InstallDir ..."
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-dl-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $binTmp = Join-Path $tmp $AssetName
    $checksums = Join-Path $tmp 'checksums.txt'
    Get-ReleaseFile -Name $AssetName -Destination $binTmp
    Get-ReleaseFile -Name 'checksums.txt' -Destination $checksums

    $expected = Get-ExpectedSha256 -ChecksumsPath $checksums -AssetName $AssetName
    $actual = (Get-FileHash -LiteralPath $binTmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA256 verification failed for ${AssetName}: expected $expected, got $actual."
    }

    $binDir = Join-Path $InstallDir 'bin'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    Move-Item -LiteralPath $binTmp -Destination (Join-Path $binDir $BinaryName) -Force
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$installerArgs = @('install')
if ($NoShellIntegration) { $installerArgs += '--no-shell-integration' }
if ($AllHosts) { $installerArgs += '--all-hosts' }

& (Join-Path (Join-Path $InstallDir 'bin') $BinaryName) @installerArgs
if ($LASTEXITCODE -ne 0) { throw 'copilot-env install failed.' }

# Offer to reload the shell so the freshly-wired integration takes effect without the
# user opening a new window. Only when integration was wired, we can actually prompt on
# a console (UserInteractive AND stdin not redirected -- the PowerShell equivalent of
# the POSIX tty gate, so `pwsh -NonInteractive` / piped runs are skipped), not under CI,
# and the caller did not opt out ($COPILOT_ENV_NO_EXEC_SHELL or -NoExecShell). PowerShell
# has no `exec`, so the POSIX-matched behavior is a nested interactive shell: launching a
# fresh PowerShell loads $PROFILE (where the integration now lives); when the user exits
# it, control returns here.
$execShell = -not $NoExecShell -and -not $env:COPILOT_ENV_NO_EXEC_SHELL
$canPrompt = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
if (-not $NoShellIntegration -and $execShell -and -not $env:CI -and $canPrompt) {
    # Read-Host can still fail on hosts with no real console; skip the offer rather than
    # abort a successful install if it does.
    try {
        $answer = Read-Host 'Reload your shell now to activate copilot-env? [Y/n]'
    } catch {
        $answer = 'n'
    }
    if ($answer -notmatch '^[Nn]') {
        $shellExe = (Get-Process -Id $PID).Path
        if (-not $shellExe) { $shellExe = 'powershell' }
        Write-Host "Reloading $shellExe ..."
        & $shellExe -NoLogo
    }
}
