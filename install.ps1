# copilot-env installer (Windows).
#
# Bootstrap only: download the compiled Windows agent binary from the selected
# copilot-env GitHub release, verify its SHA256 against the release's
# checksums.txt, install it as <install-dir>\bin\agent-bin.exe, then hand off
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
param(
    [switch]$AllHosts,
    [string]$InstallDir = '',
    [string]$Version = '',
    [switch]$NoShellIntegration,
    [switch]$NoExecShell
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# The next line is rewritten to the release tag by .github/scripts/release-assets.ts
# (byte-exact needle; test/installer_pinning.test.ts guards the match).
$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }
$Repo = 'Vivswan/copilot-env'
$BinaryName = 'agent-bin.exe'
# The Authorization header goes only to api.github.com (tag resolution);
# release-asset downloads ride the public URL with anonymous headers.
$AuthHeaders = @{ 'User-Agent' = 'copilot-env'; 'Accept' = 'application/vnd.github+json' }
$AuthToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
if ($AuthToken) {
    $AuthHeaders['Authorization'] = "Bearer $AuthToken"
}
$PublicHeaders = @{ 'User-Agent' = 'copilot-env' }
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}

# Bun-era artifacts an old source-tree install leaves in the install root; the
# binary install has no runtime bootstrap, so they are removed outright
# (mirrors LEGACY_ARTIFACTS in src/install/installer.ts).
$LegacyArtifacts = @('node_modules', 'bun.lock', 'bunfig.toml')

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

function Resolve-PhysicalPath {
    param([string]$Path)
    # A non-existent path cannot be a reparse/8.3 alias of an existing directory and is never
    # the target of Remove-Item, so its lexical full path is sufficient.
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full)) { return $full }
    # Existing path (the only kind Remove-Item can delete): resolve the TRUE physical path --
    # ALL reparse points including INTERMEDIATE junctions, plus 8.3 short names -- via Win32
    # GetFinalPathNameByHandle. That is the only PS 5.1-compatible way to canonicalize
    # intermediate components. If the resolver can't be loaded or the call fails, FAIL CLOSED:
    # refuse to delete a directory we cannot prove is not the profile. (A machine locked down
    # enough to block Add-Type also blocks the [System.IO.Path] static calls this script relies
    # on elsewhere, so there is no weaker-but-working fallback to prefer.)
    if (-not ('Ce_PathResolver' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class Ce_PathResolver {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint len, uint flags);
    public static string Resolve(string path) {
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000; // required to open a directory handle
        const uint OPEN_EXISTING = 3;
        const uint SHARE_ALL = 0x07;
        using (var h = CreateFileW(path, 0, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
            if (h.IsInvalid) return null;
            var sb = new StringBuilder(1024);
            uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
            if (n == 0) return null;
            if (n > sb.Capacity) { sb = new StringBuilder((int)n); n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); if (n == 0) return null; }
            var s = sb.ToString();
            if (s.StartsWith(@"\\?\UNC\")) return @"\\" + s.Substring(8);
            if (s.StartsWith(@"\\?\")) return s.Substring(4);
            return s;
        }
    }
}
'@
    }
    $physical = [Ce_PathResolver]::Resolve($full)
    if (-not $physical) {
        throw "Refusing to use install directory '$InstallDir': could not resolve its physical path."
    }
    return $physical
}

function Resolve-SafeInstallDir {
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $alt = [System.IO.Path]::AltDirectorySeparatorChar
    # Reject wildcard characters up front: PowerShell's Remove-Item/Test-Path expand them,
    # so an input like 'C:\Users\*' would otherwise pass the guard and then delete every
    # match. (The POSIX twin is safe here because it quotes every use of the path.)
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($InstallDir)) {
        throw "Refusing to use unsafe install directory '$InstallDir' (contains wildcard characters)."
    }
    # Resolve physically (all reparse points + 8.3 short names) so an alias of the profile
    # directory cannot slip past the home guard, then trim trailing separators (never past
    # the path root) on both sides so 'C:\Users\me\' -ieq 'C:\Users\me'.
    $resolved = Resolve-PhysicalPath $InstallDir
    $root = [System.IO.Path]::GetPathRoot($resolved)
    $normResolved = if ($resolved.Length -gt $root.Length) { $resolved.TrimEnd($sep, $alt) } else { $resolved }
    $userHome = Resolve-PhysicalPath $env:USERPROFILE
    $homeRoot = [System.IO.Path]::GetPathRoot($userHome)
    $normHome = if ($userHome.Length -gt $homeRoot.Length) { $userHome.TrimEnd($sep, $alt) } else { $userHome }
    if (-not $normResolved -or $normResolved -eq $root -or $normResolved -ieq $normHome) {
        throw "Refusing to use unsafe install directory '$InstallDir'."
    }
    return $normResolved
}

# The Windows entry of the platform -> release-target mapping (install.sh
# carries the Linux/macOS entries; scripts/compile.sh owns the target list).
function Resolve-Target {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ("$arch") {
        'X64' { return 'x86_64-pc-windows-msvc' }
        default { throw "No prebuilt copilot-env binary for Windows/$arch." }
    }
}

function Resolve-ReleaseTag {
    if ($Version) { return $Version }
    if ($InstallRef -ne 'latest') { return $InstallRef }
    $release = Invoke-WithRetry 'Resolve latest release' {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $AuthHeaders
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
        Copy-Item -LiteralPath (Join-Path $DownloadDir $Name) $Destination -Force
    } else {
        Invoke-WithRetry "Download $Name" {
            Invoke-WebRequest -Uri "$DownloadUrlBase/$Name" -OutFile $Destination -UseBasicParsing -Headers $PublicHeaders
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
$Target = Resolve-Target
$AssetName = "agent-$Target.exe"

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

foreach ($legacy in $LegacyArtifacts) {
    $legacyPath = Join-Path $InstallDir $legacy
    if (Test-Path -LiteralPath $legacyPath) {
        Write-Host "Removing legacy $legacy from $InstallDir ..."
        Remove-Item -LiteralPath $legacyPath -Recurse -Force
    }
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
