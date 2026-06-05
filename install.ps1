# Clone (or update) copilot-env, install its Windows prerequisites (Git, Node,
# Bun) and the agent CLIs, then add a dot-source block to your PowerShell
# profile ($PROFILE). Runs two ways:
#
#   # one-liner -- no local checkout needed:
#   irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
#
#   # from an existing checkout:
#   powershell -ExecutionPolicy Bypass -File install.ps1            # current-host profile
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AllHosts  # all-hosts profile
#
# Env:
#   COPILOT_ENV_DIR   clone target when fetching fresh (default %USERPROFILE%\.copilot-env)

[CmdletBinding()]
param(
    # Target the CurrentUserAllHosts profile instead of the current host's profile.
    [switch]$AllHosts
)

$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/Vivswan/copilot-env.git'
$InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }

# When run via `irm ... | iex` there is no script file; $PSCommandPath is null,
# so we clone. When run as -File install.ps1 from a checkout, reuse it.
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

    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $false }
    try {
        & $resolved.Source --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Id
    )

    if (Test-ExternalCommand $Command) {
        Write-Host "$Name already installed."
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Cannot install $Name because winget is unavailable. Install App Installer from Microsoft Store, then rerun install.ps1."
    }

    Write-Host "Installing $Name ..."
    & winget install --id $Id --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$Name installation failed." }
    Update-ProcessPath
    if (-not (Test-ExternalCommand $Command)) {
        throw "$Name was installed but '$Command' is still unavailable. Open a new PowerShell window and rerun install.ps1."
    }
}

function Install-AgentCli {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Package
    )

    if (Test-ExternalCommand $Command) {
        Write-Host "$Name already installed."
        return
    }

    Write-Host "Installing $Name ..."
    & npm.cmd install -g $Package
    if ($LASTEXITCODE -ne 0) { throw "$Name installation failed." }
    Update-ProcessPath
    if (-not (Test-ExternalCommand $Command)) {
        throw "$Name was installed but '$Command' is still unavailable. Open a new PowerShell window and rerun install.ps1."
    }
}

Update-ProcessPath
Install-WingetPackage -Command git -Name 'Git' -Id 'Git.Git'

# Locate an existing checkout, or clone/update one to $InstallDir.
if ($SelfDir -and (Test-Path (Join-Path $SelfDir 'agents.ps1'))) {
    $RepoDir = $SelfDir
    Write-Host "Using existing checkout at $RepoDir"
} else {
    if (Test-Path (Join-Path $InstallDir '.git')) {
        Write-Host "Updating copilot-env in $InstallDir ..."
        & git -C $InstallDir fetch origin main
        & git -C $InstallDir reset --hard origin/main
    } else {
        Write-Host "Cloning copilot-env into $InstallDir ..."
        & git clone $RepoUrl $InstallDir
    }
    if ($LASTEXITCODE -ne 0) { throw 'git clone/pull failed.' }
    $RepoDir = $InstallDir
}
$AgentsPs1 = Join-Path $RepoDir 'agents.ps1'
if (-not (Test-Path $AgentsPs1)) { Write-Error "Could not find agents.ps1 at $AgentsPs1"; exit 1 }

Install-WingetPackage -Command npm.cmd -Name 'Node.js LTS and npm' -Id 'OpenJS.NodeJS.LTS'
Install-WingetPackage -Command bun -Name 'Bun' -Id 'Oven-sh.Bun'

$npmGlobalBin = (& npm.cmd prefix -g).Trim()
if (-not $npmGlobalBin) { throw 'Could not determine the npm global executable directory.' }
Add-UserPath $npmGlobalBin

Write-Host 'Bootstrapping copilot-env dependencies ...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoDir 'bin\agent.ps1') env | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'copilot-env dependency bootstrap failed.' }

Install-AgentCli -Command claude -Name 'Claude Code CLI' -Package '@anthropic-ai/claude-code'
Install-AgentCli -Command copilot -Name 'GitHub Copilot CLI' -Package '@github/copilot'
Install-AgentCli -Command codex -Name 'Codex CLI' -Package '@openai/codex'

$profileName = if ($AllHosts) { 'profile.ps1' } else { 'Microsoft.PowerShell_profile.ps1' }
$documents = [Environment]::GetFolderPath('MyDocuments')
$ProfilePaths = @(
    (Join-Path $documents "WindowsPowerShell\$profileName")
    (Join-Path $documents "PowerShell\$profileName")
) | Select-Object -Unique

$Marker = 'agents.ps1'
$SourceBlock = @"

# copilot-env shell integration
`$AgentsPs1 = "$AgentsPs1"
if (Test-Path `$AgentsPs1) { . `$AgentsPs1 }
"@

foreach ($ProfilePath in $ProfilePaths) {
    if ((Test-Path $ProfilePath) -and (Select-String -Path $ProfilePath -SimpleMatch $Marker -Quiet)) {
        Write-Host "Already installed in $ProfilePath -- skipping."
    } else {
        $ProfileDir = Split-Path -Parent $ProfilePath
        if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }
        Add-Content -Path $ProfilePath -Value $SourceBlock
        Write-Host "Installed to $ProfilePath"
    }
}

# The profile block dot-sources the unsigned agents.ps1. Under the client-Windows
# default (Restricted) -- or AllSigned/Undefined -- the profile would silently
# refuse to load it, disabling the whole integration. Relax the CurrentUser
# policy to RemoteSigned (local unsigned scripts allowed) if needed.
$effectivePolicy = Get-ExecutionPolicy
if ($effectivePolicy -in @('Restricted', 'AllSigned', 'Undefined')) {
    try {
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
        Write-Host "Set CurrentUser execution policy to RemoteSigned (was '$effectivePolicy') so the profile can load agents.ps1."
    } catch {
        Write-Warning "Execution policy is '$effectivePolicy' and could not be changed (likely Group Policy). The profile may not load agents.ps1 until you run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
    }
}

Write-Host ''
Write-Host "Done. Restart PowerShell or run:  . `$PROFILE"
Write-Host "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
