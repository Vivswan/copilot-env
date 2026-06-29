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
    [switch]$NoShellIntegration
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

function Resolve-SafeInstallDir {
    $resolved = [System.IO.Path]::GetFullPath($InstallDir)
    $userHome = [System.IO.Path]::GetFullPath($env:USERPROFILE)
    $root = [System.IO.Path]::GetPathRoot($resolved)
    if (-not $resolved -or $resolved -eq $root -or $resolved -eq $userHome) {
        throw "Refusing to replace unsafe install directory '$InstallDir'."
    }
    return $resolved
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
        # Preserve opt-in autoupdate state across the destructive replace below.
        $autoupdateBackup = Join-Path $tmp '.autoupdate-backup'
        if (Test-Path (Join-Path $InstallDir '.autoupdate')) {
            Copy-Item -Recurse -Force (Join-Path $InstallDir '.autoupdate') $autoupdateBackup
        }
        if (Test-Path $InstallDir) {
            Write-Host "Removing previous copilot-env install at $InstallDir ..."
            Remove-Item -Recurse -Force $InstallDir
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
