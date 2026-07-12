# copilot-env installer (Windows).
#
# Bootstrap only: ensure Bun, download/extract the selected copilot-env GitHub
# release source archive, then hand off to the release-bundled TypeScript
# installer. Optional CLIs and launchers are managed after install with
# `agent shell --clis --launchers`.

[CmdletBinding()]
param(
    [switch]$AllHosts,
    [string]$InstallDir = '',
    [switch]$NoShellIntegration,
    [switch]$NoExecShell
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }
$ResolverUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts'
$VerifierUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts'
$AuthHeaders = @{ 'User-Agent' = 'copilot-env' }
$AuthToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
if ($AuthToken) {
    $AuthHeaders['Authorization'] = "Bearer $AuthToken"
}
$AssetHeaders = @{}
foreach ($key in $AuthHeaders.Keys) {
    $AssetHeaders[$key] = $AuthHeaders[$key]
}
$AssetHeaders['Accept'] = 'application/octet-stream'
$PublicAssetHeaders = @{ 'User-Agent' = 'copilot-env'; 'Accept' = 'application/octet-stream' }
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}

$SelfDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }

function Update-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($machinePath -split ';') + @($userPath -split ';') + @($env:Path -split ';')
    $env:Path = ($entries | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Add-UserPath {
    param([Parameter(Mandatory)][string]$Directory)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if ($entries -notcontains $Directory) {
        [Environment]::SetEnvironmentVariable('Path', (($entries + $Directory) -join ';'), 'User')
    }
    Update-ProcessPath
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][scriptblock]$Script
    )

    for ($try = 1; $try -le 3; $try++) {
        try {
            & $Script
            return
        } catch {
            if ($try -ge 3) { throw }
            Write-Warning "$Label failed; retrying ($try/3): $($_.Exception.Message)"
            Start-Sleep -Seconds ($try * 2)
        }
    }
}

function Test-ExternalCommand {
    param([Parameter(Mandatory)][string]$Command)

    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
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
        throw "Refusing to replace install directory '$InstallDir': could not resolve its physical path."
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
        throw "Refusing to replace unsafe install directory '$InstallDir' (contains wildcard characters)."
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
        throw "Refusing to replace unsafe install directory '$InstallDir'."
    }
    return $normResolved
}

function Resolve-ReleaseTarget {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-resolve-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $resolver = Join-Path $tmp 'resolve-release.ts'
        Invoke-WithRetry 'Download release resolver' {
            Invoke-WebRequest -Uri $ResolverUrl -OutFile $resolver -UseBasicParsing -Headers $AuthHeaders
        }
        $resolverArgs = @($resolver, '--json')
        if ($InstallRef -ne 'latest') {
            $resolverArgs += @('--tag', $InstallRef)
        }
        $json = (& bun @resolverArgs)
        if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
        $target = ($json | Select-Object -First 1) | ConvertFrom-Json
        if (-not $target.tarballUrl -or -not $target.sourceSha) { return $null }
        return $target
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Resolve-AssetHeaderSet {
    param([Parameter(Mandatory)][string]$Url)

    if ($Url.StartsWith('https://api.github.com/')) {
        return $AssetHeaders
    }
    return $PublicAssetHeaders
}

Update-ProcessPath

$BunExe = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Test-ExternalCommand bun) -and -not (Test-Path $BunExe)) {
    Write-Host 'Installing Bun ...'
    Invoke-WithRetry 'Bun install' {
        & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Bun installation failed.' }
    }
}
if (Test-Path $BunExe) {
    Add-UserPath (Split-Path $BunExe -Parent)
}
if (-not (Test-ExternalCommand bun)) {
    throw 'Bun was installed but is still unavailable. Open a new PowerShell window and rerun install.ps1.'
}

if ($SelfDir -and (Test-Path (Join-Path $SelfDir 'shell\agents.ps1'))) {
    $RepoDir = $SelfDir
    Write-Host "Using existing checkout at $RepoDir"
} else {
    $InstallDir = Resolve-SafeInstallDir
    Write-Host 'Resolving the copilot-env release ...'
    $target = Resolve-ReleaseTarget
    if (-not $target) { throw 'No copilot-env release found (or the GitHub API is unreachable).' }

    $url = $target.tarballUrl
    $ref = ($url -split '/')[-1]
    Write-Host "Downloading copilot-env $ref into $InstallDir ..."
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-dl-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $tgz = Join-Path $tmp 'release.tgz'
        $verifier = Join-Path $tmp 'verify-source-archive.ts'
        Invoke-WithRetry 'Download archive verifier' {
            Invoke-WebRequest -Uri $VerifierUrl -OutFile $verifier -UseBasicParsing -Headers $AuthHeaders
        }
        Invoke-WithRetry 'Download copilot-env release' {
            Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -Headers (Resolve-AssetHeaderSet $url)
        }
        $verifyArgs = @($verifier, $tgz, $target.sourceSha)
        if ($target.sourceSha256) {
            $verifyArgs += $target.sourceSha256
        }
        & bun @verifyArgs
        if ($LASTEXITCODE -ne 0) { throw 'release archive verification failed.' }
        # Preserve opt-in autoupdate state and the user's local .env overrides across the
        # destructive replace below (both gitignored, so a release tree never ships them).
        $autoupdateBackup = Join-Path $tmp '.autoupdate-backup'
        if (Test-Path (Join-Path $InstallDir '.autoupdate')) {
            Copy-Item -Recurse -Force (Join-Path $InstallDir '.autoupdate') $autoupdateBackup
        }
        $envBackup = Join-Path $tmp '.env-backup'
        if (Test-Path (Join-Path $InstallDir '.env')) {
            Copy-Item -Force (Join-Path $InstallDir '.env') $envBackup
        }
        if (Test-Path -LiteralPath $InstallDir) {
            Write-Host "Removing previous copilot-env install at $InstallDir ..."
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        # tar.exe cannot create symlinks without Developer Mode/admin, so it errors and aborts
        # the whole extract on the three doc links (CLAUDE.md, .github/*.md -> AGENTS.md).
        # Exclude them, then materialize them as plain copies of AGENTS.md below.
        & tar -xzf $tgz --strip-components=1 -C $InstallDir --exclude='*/CLAUDE.md' --exclude='*/.github/copilot-instructions.md' --exclude='*/.github/agents.md'
        if ($LASTEXITCODE -ne 0) { throw 'tar extraction of the release archive failed.' }
        $agentsDoc = Join-Path $InstallDir 'AGENTS.md'
        foreach ($link in @('CLAUDE.md', '.github\copilot-instructions.md', '.github\agents.md')) {
            $dest = Join-Path $InstallDir $link
            if ((Test-Path $agentsDoc) -and -not (Test-Path $dest)) {
                Copy-Item -Force $agentsDoc $dest
            }
        }
        # Restore preserved autoupdate state. The release never ships .autoupdate
        # (gitignored), so the fresh tree has none — copy the backup into place.
        if (Test-Path $autoupdateBackup) {
            Copy-Item -Recurse -Force $autoupdateBackup (Join-Path $InstallDir '.autoupdate')
        }
        # Restore the preserved .env (the documented supply-chain pin / env overrides).
        if (Test-Path $envBackup) {
            Copy-Item -Force $envBackup (Join-Path $InstallDir '.env')
        }
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    $RepoDir = $InstallDir
}

$Installer = Join-Path $RepoDir 'src\install\installer.ts'
if (-not (Test-Path $Installer)) { throw "Could not find bundled installer at $Installer" }

$installerArgs = @('install')
if ($NoShellIntegration) { $installerArgs += '--no-shell-integration' }
if ($AllHosts) { $installerArgs += '--all-hosts' }

& bun $Installer @installerArgs
if ($LASTEXITCODE -ne 0) { throw 'copilot-env installer failed.' }

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
