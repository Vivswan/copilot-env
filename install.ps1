# copilot-env installer (Windows); install.sh is the POSIX twin.
# Bootstrap only: fetch and verify the release binary, then hand off to its own `install`
# subcommand, which owns everything after that.

<#
.SYNOPSIS
Installs copilot-env (Windows twin of install.sh).

.DESCRIPTION
Installs copilot-env into $env:USERPROFILE\.copilot-env by downloading the
compiled agent binary from the selected GitHub release, verifying its SHA256,
and wiring shell integration by default. Optional agent CLIs and launchers are
configured after install:

  agent shell --clis [--cooldown[=DAYS]] [--no-sudo] [--no-prereqs]
  agent config set shell.launchers true

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

.PARAMETER Yes
Reload your shell at the end without asking.

.PARAMETER No
Do not reload your shell at the end, and do not ask. The offer is also skipped
when non-interactive or under CI, or when $env:COPILOT_ENV_NO_EXEC_SHELL is set.

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
    [switch]$Yes,
    [switch]$No
)

$ErrorActionPreference = 'Stop'
if ($Yes -and $No) { throw '-Yes and -No conflict; pass one.' }
$PSNativeCommandUseErrorActionPreference = $false

# 5.1 spawned from pwsh inherits pwsh's PSModulePath, whose PowerShell 7 directories shadow
# its own: Get-FileHash, ConvertFrom-Json, and Invoke-WebRequest then autoload Core modules 5.1
# cannot load. The same defense as src/shell/integration.ts's execution-policy command.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    $MachineModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
    # No cmdlet in the fallback: it runs exactly when autoload cannot be trusted.
    if (-not $MachineModulePath) { $MachineModulePath = "$PSHOME\Modules" }
    $env:PSModulePath = $MachineModulePath
}

# The next line is rewritten to the release tag by .github/scripts/release-assets.ts
# (byte-exact needle; test/install/installer_pinning.e2e.test.ts guards the match).
$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }
$Repo = 'Vivswan/copilot-env'
$BinaryName = 'copilot-env.exe'
$UserAgent = 'copilot-env'
# The Authorization header goes only to api.github.com (tag resolution);
# release-asset downloads ride the public URL anonymously.
$AuthToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}

# curl.exe runs install.sh's exact exchanges where PATH has one; the web cmdlets every PowerShell
# ships stand in where it does not, so a box without curl.exe installs the same way.
$UseCurl = [bool](Get-Command curl.exe -ErrorAction SilentlyContinue)
if (-not $UseCurl -and $PSVersionTable.PSVersion.Major -lt 6) {
    # Windows PowerShell 5.1 inherits .NET Framework's protocol default, which can exclude the
    # TLS 1.2 GitHub requires; -bor keeps anything newer. pwsh's HttpClient ignores this property.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

# install.sh's retry(): a launch failure and a failed exchange both spend a try.
function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][scriptblock]$Attempt
    )

    for ($try = 1; $try -le 3; $try++) {
        try {
            return & $Attempt
        } catch {
            $failure = $_.Exception.Message
        }
        if ($try -ge 3) { throw $failure }
        Write-Warning "$Label failed; retrying ($try/3): $failure"
        Start-Sleep -Seconds ($try * 2)
    }
}

# Headers never enter argv, which the process list shows while curl.exe runs: curl reads them
# from a scratch file, the cmdlet takes them in-process.
function Invoke-Fetch {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers = @{},
        [string]$OutFile = '',
        [switch]$FinalUri
    )

    if ($UseCurl) {
        $hdr = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
        $lines = @("User-Agent: $UserAgent") + @($Headers.Keys | ForEach-Object { "${_}: $($Headers[$_])" })
        [System.IO.File]::WriteAllLines($hdr, [string[]]$lines)
        $curlArgs = @('-fsSL', '-H', "@$hdr")
        if ($OutFile) { $curlArgs += @('-o', $OutFile) }
        elseif ($FinalUri) { $curlArgs += @('-o', 'NUL', '-w', '%{url_effective}') }
        $curlArgs += $Uri
        try {
            return Invoke-WithRetry $Label {
                $out = & curl.exe @curlArgs
                if ($LASTEXITCODE -ne 0) { throw "curl.exe exited $LASTEXITCODE." }
                $out -join "`n"
            }
        } finally {
            Remove-Item -LiteralPath $hdr -Force -ErrorAction SilentlyContinue
        }
    }

    # 5.1's Invoke-WebRequest redraws its progress bar per buffer, slowing large downloads by
    # orders of magnitude; the installer has no other progress UI. Function scope, so a session
    # that ran the one-liner through iex keeps its own setting.
    $ProgressPreference = 'SilentlyContinue'
    $request = @{ Uri = $Uri; Headers = $Headers; UserAgent = $UserAgent; UseBasicParsing = $true }
    if ($OutFile) { $request.OutFile = $OutFile }
    $response = Invoke-WithRetry $Label { Invoke-WebRequest @request }
    if ($FinalUri) {
        # Windows PowerShell's HttpWebResponse knows the URI it ended on; pwsh's HttpResponseMessage
        # knows only the request the redirects rewrote.
        $final = $response.BaseResponse.ResponseUri
        if (-not $final) { $final = $response.BaseResponse.RequestMessage.RequestUri }
        return [string]$final
    }
    if (-not $OutFile) { return [string]$response.Content }
}

# Purely lexical on purpose: the binary's `install` re-checks the CANONICAL path (reparse
# points and 8.3 short names resolved) in src/install/installer.ts; this only keeps the
# bootstrap's writes away from the worst targets. Twin: resolve_safe_install_dir in install.sh.
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
    # Either lookup, once its retries run out, dies with install.sh's message, not the raw failure.
    if ($AuthToken) {
        # A token raises the API rate limit and sees private repos, so resolve `latest` through
        # the API when one is available.
        try {
            $json = Invoke-Fetch 'Resolve latest release' "https://api.github.com/repos/$Repo/releases/latest" -Headers @{
                Accept        = 'application/vnd.github+json'
                Authorization = "Bearer $AuthToken"
            }
        } catch { throw 'Could not resolve the latest copilot-env release.' }
        $tag = [string](ConvertFrom-Json $json).tag_name
    } else {
        # Tokenless: follow the /releases/latest redirect to the tag page instead of burning the
        # 60/hour unauthenticated API quota.
        try {
            $url = Invoke-Fetch 'Resolve latest release' "https://github.com/$Repo/releases/latest" -FinalUri
        } catch { throw 'Could not resolve the latest copilot-env release.' }
        $tag = ([System.Uri]$url).Segments[-1].TrimEnd('/')
    }
    if ($tag -notmatch '^v[0-9]') { throw "Could not resolve a release tag (got '$tag')." }
    return $tag
}

function Get-ReleaseFile {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Destination
    )

    if ($DownloadDir) {
        Copy-Item -LiteralPath (Join-Path $DownloadDir $Name) -Destination $Destination -Force
    } else {
        Invoke-Fetch "Download $Name" "$DownloadUrlBase/$Name" -OutFile $Destination | Out-Null
    }
}

# A leading "*" marks binary mode in shasum output, so both forms match.
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

# Mirrors the binary's plan-time refusal (CHECKOUT_MARKERS in src/install/installer.ts)
# before the bin write touches the root; a worktree's .git is a file, so no -PathType.
# Markers without .git are not a checkout, so the install proceeds.
if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
    foreach ($marker in @('package.json', 'bun.lock')) {
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

    # The binary names every write it makes outside its own homes, but the root is created before it exists: report
    # in its shape ("created -> <path>" on stderr), outermost first.
    $missing = @()
    $probe = $InstallDir
    while ($probe -and -not (Test-Path -LiteralPath $probe)) {
        $missing = , $probe + $missing
        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    if ($missing.Count -gt 0) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        foreach ($made in $missing) { [Console]::Error.WriteLine("created -> $made") }
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

# UserInteractive plus an unredirected stdin is the PowerShell form of install.sh's tty gate.
# PowerShell has no `exec`, so the reload is a nested interactive shell: it loads the $PROFILE
# the integration now lives in, and control returns here when the user exits it.
# The answer to the offer: an explicit switch wins over the environment.
$reloadShell = if ($Yes) { 'yes' }
elseif ($No -or $env:COPILOT_ENV_NO_EXEC_SHELL) { 'no' }
else { 'ask' }
$canPrompt = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
if (-not $NoShellIntegration -and $reloadShell -ne 'no' -and -not $env:CI -and $canPrompt) {
    if ($reloadShell -eq 'yes') {
        $answer = 'y'
    } else {
        # Read-Host can still fail on hosts with no real console; skip the offer rather than
        # abort a successful install if it does.
        try {
            $answer = Read-Host 'Reload your shell now to activate copilot-env? [Y/n]'
        } catch {
            $answer = 'n'
        }
    }
    if ($answer -notmatch '^[Nn]') {
        $shellExe = (Get-Process -Id $PID).Path
        if (-not $shellExe) { $shellExe = 'powershell' }
        Write-Host "Reloading $shellExe ..."
        & $shellExe -NoLogo
    }
} elseif ($reloadShell -eq 'yes') {
    [Console]::Error.WriteLine('-Yes: nothing to reload (no shell integration, CI, or no terminal).')
}
