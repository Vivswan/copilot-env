# First-time install: install Windows prerequisites (Node, Bun) and the agent CLIs,
# download the latest copilot-env *release* tarball over HTTP (no git), then wire the
# PowerShell profile by running `agent shell-integration`. Updates are NOT done here --
# use `agent update`. Runs two ways:
#
#   # one-liner -- no local checkout needed:
#   irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
#
#   # from an existing checkout:
#   powershell -ExecutionPolicy Bypass -File install.ps1            # current-host profile
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AllHosts  # all-hosts profile
#
# Options:
#   -InstallDir DIR
#       Install target (default %USERPROFILE%\.copilot-env). Takes precedence over
#       $COPILOT_ENV_DIR. Ignored when run from an existing checkout.
#   -Cooldown [-CooldownDays N]
#       Supply-chain delay: install the newest copilot-env release AND the newest
#       agent-CLI (claude / copilot / codex) releases public for at least N days
#       (default 7, matching bunfig.toml), so a compromised just-published version
#       has time to be caught before adoption.
#   -NoPrereqs
#       Do not install any prerequisites (Node, Bun) or the agent CLIs -- only verify
#       them. A missing *necessary* tool (bun) is a fatal error; a missing *optional*
#       tool (Node/npm, the agent CLIs) is a warning. The repo download and profile
#       wiring still run.
#   -LocalInstall
#       Install prerequisites only via user-local methods (bun's irm installer,
#       npm); never use winget. Bun and the agent CLIs install as usual; Node can
#       only come from winget, so a missing Node/npm (with the agent CLIs) is a
#       warning. Mutually exclusive with -NoPrereqs.
#   -NoShellIntegration
#       Do everything except run `agent shell-integration` (which wires $PROFILE).
#       The repo, prerequisites, and agent CLIs still install; run
#       `agent shell-integration` yourself later. Useful for CI or a hand-managed
#       profile.
#
# Env:
#   COPILOT_ENV_DIR   install target (default %USERPROFILE%\.copilot-env);
#                     the -InstallDir parameter takes precedence over it.

[CmdletBinding()]
param(
    # Target the CurrentUserAllHosts profile instead of the current host's profile.
    [switch]$AllHosts,

    # Install target when fetching fresh (default %USERPROFILE%\.copilot-env). Takes
    # precedence over $COPILOT_ENV_DIR. Ignored when run from an existing checkout.
    [string]$InstallDir = '',

    # Supply-chain cooldown for the agent CLIs (claude / copilot / codex): install
    # the newest release that has been public for at least -CooldownDays days
    # instead of npm's `latest`, so a compromised just-published version has time
    # to be caught and yanked before any user adopts it. Mirrors the cooldown
    # bunfig.toml already gives the gateway's own dependencies.
    [switch]$Cooldown,

    # Cooldown window in days (only used with -Cooldown). Default 7, matching
    # bunfig.toml install.minimumReleaseAge (604800s).
    [int]$CooldownDays = 7,

    # Do not install any prerequisites (Node, Bun) or the agent CLIs -- only verify
    # them. A missing necessary tool (bun) is a fatal error; a missing optional tool
    # (Node/npm, the agent CLIs) is a warning.
    [switch]$NoPrereqs,

    # Install prerequisites only via user-local methods (bun's irm installer, npm);
    # never use winget. Node can only come from winget, so a missing Node/npm (+ agent
    # CLIs) is a warning. Mutually exclusive with -NoPrereqs.
    [switch]$LocalInstall,

    # Do everything except wire the shell integration into the PowerShell profile
    # ($PROFILE). The repo, prerequisites, and agent CLIs still install; you
    # dot-source agents.ps1 yourself. The execution-policy relaxation is skipped
    # too (it exists only so the profile can load agents.ps1).
    [switch]$NoShellIntegration
)

$ErrorActionPreference = 'Stop'
# Keep native (npm/bun/tar) non-zero exits flowing to our explicit $LASTEXITCODE
# checks instead of throwing -- PowerShell 7.4+ defaults this to $true, which would
# turn an *expected* non-zero into a terminating error. No-op on Windows PowerShell
# 5.1 (variable unused).
$PSNativeCommandUseErrorActionPreference = $false

if ($Cooldown -and $CooldownDays -lt 0) {
    throw "-CooldownDays must be a non-negative whole number of days (got $CooldownDays)."
}
if ($NoPrereqs -and $LocalInstall) {
    throw '-NoPrereqs and -LocalInstall are mutually exclusive.'
}

# Standalone release resolver (same module src/commands/update.ts imports): the
# installer downloads THIS one file and runs it with bun to pick the release tarball
# URL, so the release-pick logic lives in exactly one place.
$ResolverUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts'
# Precedence: -InstallDir parameter > $COPILOT_ENV_DIR > default.
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}

# When run via `irm ... | iex` there is no script file; $PSCommandPath is null, so we
# download the release tarball. When run as -File install.ps1 from a checkout, reuse it.
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

# -NoPrereqs / -LocalInstall: warn about an absent *optional* tool we won't install.
function Write-MissingPrereq {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$Name
    )
    if (-not (Test-ExternalCommand $Command)) {
        Write-Warning "$Name ('$Command') is not installed; skipping. Install it yourself to use it."
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

# With -Cooldown, resolve the newest published release of $Package that is at
# least $Days old (excluding prereleases) and pin to it, instead of trusting
# npm's `latest` tag -- the same supply-chain delay bunfig.toml gives the
# gateway's deps. The resolution lives in src/install/aged-version.ts (shared
# verbatim with install.sh, and unit-tested) and runs under the bun we just
# installed; here we only feed it `npm view <pkg> time`.
function Resolve-AgedVersion {
    param(
        [Parameter(Mandatory)][string]$Package,
        [Parameter(Mandatory)][int]$Days
    )

    $resolver = Join-Path $RepoDir 'src/install/aged-version.ts'
    $version = (& npm.cmd view $Package time --json 2>$null | & bun $resolver --days $Days)
    if ($LASTEXITCODE -ne 0 -or -not $version) { return $null }
    return ($version | Select-Object -First 1).Trim()
}

function Install-AgentCli {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Package,
        # >= 0 enables the cooldown (that many days); -1 disables it.
        [int]$CooldownDays = -1
    )

    # -Cooldown governs FRESH installs only: an already-present CLI is left as-is
    # (we never downgrade a CLI the user installed themselves). Uninstall + rerun,
    # or `npm i -g <pkg>@<version>` manually, to change a pinned one.
    if (Test-ExternalCommand $Command) {
        Write-Host "$Name already installed."
        return
    }

    $spec = $Package
    if ($CooldownDays -ge 0) {
        $version = Resolve-AgedVersion -Package $Package -Days $CooldownDays
        if (-not $version) {
            throw "No release of $Package is >=$CooldownDays days old (or npm/registry unreachable)."
        }
        $spec = "$Package@$version"
        Write-Host "Installing $Name ($spec, cooled down >=${CooldownDays}d) ..."
    } else {
        Write-Host "Installing $Name ..."
    }
    & npm.cmd install -g $spec
    if ($LASTEXITCODE -ne 0) { throw "$Name installation failed." }
    Update-ProcessPath
    if (-not (Test-ExternalCommand $Command)) {
        throw "$Name was installed but '$Command' is still unavailable. Open a new PowerShell window and rerun install.ps1."
    }
}

# Resolve the release tarball URL by downloading the shared resolver and running it
# with bun (the same module `agent update` imports). $Days >= 0 applies the cooldown.
function Resolve-ReleaseTarball {
    param([int]$Days = -1)

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-resolve-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $resolver = Join-Path $tmp 'resolve-release.ts'
        Invoke-WebRequest -Uri $ResolverUrl -OutFile $resolver -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-env' }
        if ($Days -ge 0) {
            $url = (& bun $resolver --cooldown-days $Days)
        } else {
            $url = (& bun $resolver)
        }
        if ($LASTEXITCODE -ne 0 -or -not $url) { return $null }
        return ($url | Select-Object -First 1).Trim()
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Update-ProcessPath

# --- bun (gateway runtime AND powers the release resolver) ----------------
# Ensured up front -- before anything is downloaded -- so the resolver can run.
if ($NoPrereqs) {
    # bun is necessary. Accept it on PATH or at the default user-local path (parity
    # with install.sh); fail loudly only if truly absent.
    if (-not (Test-ExternalCommand bun)) {
        $bunExe = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
        if (Test-Path $bunExe) {
            Add-UserPath (Split-Path $bunExe -Parent)
            Update-ProcessPath
        } else {
            throw 'bun is required to run copilot-env, but it is not installed (-NoPrereqs). Install bun (https://bun.sh) and rerun.'
        }
    }
} elseif ($LocalInstall) {
    # No winget under -LocalInstall: install bun via its user-local installer.
    if (Test-ExternalCommand bun) {
        Write-Host 'Bun already installed.'
    } else {
        Write-Host 'Installing Bun (user-local, via bun.sh) ...'
        & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Bun installation (irm bun.sh/install.ps1) failed.' }
        $bunBin = Join-Path $env:USERPROFILE '.bun\bin'
        if (Test-Path $bunBin) { Add-UserPath $bunBin }
        Update-ProcessPath
        if (-not (Test-ExternalCommand bun)) {
            throw 'Bun was installed but is still unavailable. Open a new PowerShell window and rerun install.ps1.'
        }
    }
} else {
    Install-WingetPackage -Command bun -Name 'Bun' -Id 'Oven-sh.Bun'
}

# --- locate an existing checkout, or download the latest release ----------
# An existing install is detected by its agents.ps1 marker (there is no .git --
# installs are tarballs now, not clones).
if ($SelfDir -and (Test-Path (Join-Path $SelfDir 'agents.ps1'))) {
    $RepoDir = $SelfDir
    Write-Host "Using existing checkout at $RepoDir"
} elseif (Test-Path (Join-Path $InstallDir 'agents.ps1')) {
    # Reuse (don't re-download) an existing install: completes/repairs a half-finished
    # one, idempotent for a finished one. Updates are `agent update`'s job.
    $RepoDir = $InstallDir
    Write-Host "Found existing copilot-env at $RepoDir; completing/repairing it (run 'agent update' to move to a newer release)."
} else {
    # Fresh install: download the release source tarball over HTTP -- no git. The
    # release is picked by the shared resolver (src/install/resolve-release.ts),
    # downloaded standalone and run with bun -- the same logic `agent update` uses.
    $cooldownWindow = if ($Cooldown) { $CooldownDays } else { -1 }
    Write-Host 'Resolving the copilot-env release ...'
    $url = Resolve-ReleaseTarball -Days $cooldownWindow
    if (-not $url) { throw 'No copilot-env release found (or the GitHub API is unreachable).' }

    Write-Host "Downloading copilot-env into $InstallDir ..."
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ce-dl-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $tgz = Join-Path $tmp 'release.tgz'
        Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-env' }
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        # --strip-components=1 drops the GitHub `Vivswan-copilot-env-<sha>/` wrapper.
        & tar -xzf $tgz --strip-components=1 -C $InstallDir
        if ($LASTEXITCODE -ne 0) { throw 'tar extraction of the release tarball failed.' }
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    $RepoDir = $InstallDir
}
$AgentsPs1 = Join-Path $RepoDir 'agents.ps1'
if (-not (Test-Path $AgentsPs1)) { Write-Error "Could not find agents.ps1 at $AgentsPs1"; exit 1 }

# --- Node.js (needed only for the agent CLIs) -----------------------------
if ($NoPrereqs -or $LocalInstall) {
    # Node/npm only come from winget (forbidden by both flags) and are optional --
    # they only power the agent CLIs; the gateway runs on bun. Warn if absent.
    Write-MissingPrereq -Command npm.cmd -Name 'Node.js LTS and npm'
} else {
    Install-WingetPackage -Command npm.cmd -Name 'Node.js LTS and npm' -Id 'OpenJS.NodeJS.LTS'
}

# Put npm's global bin on PATH so the agent CLIs resolve -- only when npm is present
# (under -NoPrereqs/-LocalInstall it may be absent, in which case the CLIs are skipped too).
if (Test-ExternalCommand npm.cmd) {
    $npmGlobalBin = (& npm.cmd prefix -g).Trim()
    if (-not $npmGlobalBin) { throw 'Could not determine the npm global executable directory.' }
    Add-UserPath $npmGlobalBin
}

if ($NoPrereqs) {
    Write-Host 'Skipping dependency bootstrap (-NoPrereqs); copilot-env installs its deps on the first agent run.'
} else {
    Write-Host 'Bootstrapping copilot-env dependencies ...'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoDir 'bin\agent.ps1') env | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'copilot-env dependency bootstrap failed.' }
}

if ($NoPrereqs -or ($LocalInstall -and -not (Test-ExternalCommand npm.cmd))) {
    # Either verifying only (-NoPrereqs), or -LocalInstall without npm (npm comes
    # from winget, which -LocalInstall may not use). The agent CLIs are optional --
    # warn for each missing one, never install.
    Write-MissingPrereq -Command claude -Name 'Claude Code CLI'
    Write-MissingPrereq -Command copilot -Name 'GitHub Copilot CLI'
    Write-MissingPrereq -Command codex -Name 'Codex CLI'
} else {
    $cooldownWindow = if ($Cooldown) { $CooldownDays } else { -1 }
    Install-AgentCli -Command claude -Name 'Claude Code CLI' -Package '@anthropic-ai/claude-code' -CooldownDays $cooldownWindow
    Install-AgentCli -Command copilot -Name 'GitHub Copilot CLI' -Package '@github/copilot' -CooldownDays $cooldownWindow
    Install-AgentCli -Command codex -Name 'Codex CLI' -Package '@openai/codex' -CooldownDays $cooldownWindow
}

# Wire the profile via the `agent shell-integration` command (the wiring logic
# lives there now, in src/commands/shell_integration.ts). Run agent.ps1 under a
# Bypass policy since it (and agents.ps1) are unsigned.
if ($NoShellIntegration) {
    Write-Host 'Skipping profile wiring (-NoShellIntegration).'
} else {
    $siArgs = @('shell-integration')
    if ($AllHosts) { $siArgs += '--all-hosts' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoDir 'bin\agent.ps1') @siArgs
    if ($LASTEXITCODE -ne 0) { throw 'agent shell-integration failed.' }
}

Write-Host ''
if ($NoShellIntegration) {
    Write-Host "Done. Profile wiring was skipped (-NoShellIntegration); run 'agent shell-integration' to enable it."
} else {
    Write-Host 'Done. Restart PowerShell to load the integration.'
}
Write-Host "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
