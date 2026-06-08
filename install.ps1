# copilot-env installer (Windows).
#
# Bootstrap only: ensure Bun, download/extract the selected copilot-env GitHub
# release source archive, then hand off to the release-bundled TypeScript
# installer. Optional CLIs and launchers are managed after install with
# `agent setup clis --launchers`.

[CmdletBinding()]
param(
    [switch]$AllHosts,
    [string]$InstallDir = '',
    [switch]$NoShellIntegration
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$ResolverUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts'
$VerifierUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts'
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

function Test-ExternalCommand {
    param([Parameter(Mandatory)][string]$Command)

    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Resolve-SafeInstallDir {
    $resolved = [System.IO.Path]::GetFullPath($InstallDir)
    $home = [System.IO.Path]::GetFullPath($env:USERPROFILE)
    $root = [System.IO.Path]::GetPathRoot($resolved)
    if (-not $resolved -or $resolved -eq $root -or $resolved -eq $home) {
        throw "Refusing to replace unsafe install directory '$InstallDir'."
    }
    return $resolved
}

function Resolve-ReleaseTarget {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-resolve-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $resolver = Join-Path $tmp 'resolve-release.ts'
        Invoke-WebRequest -Uri $ResolverUrl -OutFile $resolver -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-env' }
        $json = (& bun $resolver --json)
        if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
        $target = ($json | Select-Object -First 1) | ConvertFrom-Json
        if (-not $target.tarballUrl -or -not $target.sourceSha) { return $null }
        return $target
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Update-ProcessPath

$BunExe = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Test-ExternalCommand bun) -and -not (Test-Path $BunExe)) {
    Write-Host 'Installing Bun ...'
    & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bun installation failed.' }
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
        Invoke-WebRequest -Uri $VerifierUrl -OutFile $verifier -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-env' }
        Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-env' }
        & bun $verifier $tgz $target.sourceSha
        if ($LASTEXITCODE -ne 0) { throw 'release archive checksum verification failed.' }
        if (Test-Path $InstallDir) {
            Write-Host "Removing previous copilot-env install at $InstallDir ..."
            Remove-Item -Recurse -Force $InstallDir
        }
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        & tar -xzf $tgz --strip-components=1 -C $InstallDir
        if ($LASTEXITCODE -ne 0) { throw 'tar extraction of the release tarball failed.' }
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
