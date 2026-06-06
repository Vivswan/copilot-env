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
# Options:
#   -InstallDir DIR
#       Clone target when fetching fresh (default %USERPROFILE%\.copilot-env).
#       Takes precedence over $COPILOT_ENV_DIR. Ignored when run from an existing
#       checkout (that checkout is reused).
#   -Cooldown [-CooldownDays N]
#       Supply-chain cooldown for the agent CLIs (claude / copilot / codex):
#       install the newest release public for at least N days (default 7,
#       matching bunfig.toml) instead of npm's `latest`, so a compromised
#       just-published version has time to be caught and yanked before adoption.
#   -NoPrereqs
#       Do not install any prerequisites (Git, Node, Bun) or the agent CLIs --
#       only verify them. A missing *necessary* tool (bun; git when a clone is
#       needed) is a fatal error; a missing *optional* tool (Node/npm, the agent
#       CLIs) is a warning. The repo clone/update and profile wiring still run;
#       the dependency bootstrap is skipped (deps install on first `agent` run).
#   -LocalInstall
#       Install prerequisites only via user-local methods (bun's irm installer,
#       npm); never use winget. Bun and the agent CLIs install as usual; Git and
#       Node can only come from winget, so a missing Git is a fatal error when a
#       clone is needed and a missing Node/npm (with the agent CLIs) is a warning.
#       Mutually exclusive with -NoPrereqs.
#   -NoShellIntegration
#       Do everything except wire the shell integration into your PowerShell
#       profile ($PROFILE). The repo, prerequisites, and agent CLIs still
#       install; you dot-source agents.ps1 yourself. Useful for CI or a
#       hand-managed profile. The execution-policy relaxation is skipped too
#       (it exists only so the profile can load agents.ps1).
#
# Env:
#   COPILOT_ENV_DIR   clone target when fetching fresh (default %USERPROFILE%\.copilot-env);
#                     the -InstallDir parameter takes precedence over it.

[CmdletBinding()]
param(
    # Target the CurrentUserAllHosts profile instead of the current host's profile.
    [switch]$AllHosts,

    # Clone target when fetching fresh (default %USERPROFILE%\.copilot-env). Takes
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

    # Do not install any prerequisites (Git, Node, Bun) or the agent CLIs -- only
    # verify them. A missing necessary tool (bun; git when a clone is needed) is a
    # fatal error; a missing optional tool (Node/npm, the agent CLIs) is a warning.
    [switch]$NoPrereqs,

    # Install prerequisites only via user-local methods (bun's irm installer, npm);
    # never use winget. Git/Node can only come from winget, so a missing Git is
    # fatal when a clone is needed and a missing Node/npm (+ agent CLIs) is a warning.
    [switch]$LocalInstall,

    # Do everything except wire the shell integration into the PowerShell profile
    # ($PROFILE). The repo, prerequisites, and agent CLIs still install; you
    # dot-source agents.ps1 yourself. The execution-policy relaxation is skipped
    # too (it exists only so the profile can load agents.ps1).
    [switch]$NoShellIntegration
)

$ErrorActionPreference = 'Stop'
# Keep native (git/npm/bun) non-zero exits flowing to our explicit $LASTEXITCODE
# checks instead of throwing -- PowerShell 7.4+ defaults this to $true, which would
# turn an *expected* non-zero (e.g. `git merge-base --is-ancestor`, exit 1 = "no")
# into a terminating error. No-op on Windows PowerShell 5.1 (variable unused).
$PSNativeCommandUseErrorActionPreference = $false

if ($Cooldown -and $CooldownDays -lt 0) {
    throw "-CooldownDays must be a non-negative whole number of days (got $CooldownDays)."
}
if ($NoPrereqs -and $LocalInstall) {
    throw '-NoPrereqs and -LocalInstall are mutually exclusive.'
}

$RepoUrl = 'https://github.com/Vivswan/copilot-env.git'
# Precedence: -InstallDir parameter > $COPILOT_ENV_DIR > default.
if (-not $InstallDir) {
    $InstallDir = if ($env:COPILOT_ENV_DIR) { $env:COPILOT_ENV_DIR } else { Join-Path $env:USERPROFILE '.copilot-env' }
}
$CooldownRepoMinSha = ''
$CooldownRepoMaxSha = ''
$CooldownRepoSha = $null   # set when -Cooldown rolls the repo back to an aged commit

# If the install fails after the cooldown commit is resolved, still roll the
# managed clone back to it -- never leave it running on fresh origin/main under
# -Cooldown -- then re-raise so the failure stays visible. The clean-finish
# rollback is done explicitly near the end; this trap covers mid-install failures
# and interrupts. (No-op until $CooldownRepoSha is set.)
trap {
    if ($CooldownRepoSha) {
        Write-Host "Cooldown: pinning copilot-env to $CooldownRepoSha after failure ..."
        & git -C $RepoDir reset --hard $CooldownRepoSha 2>$null
    }
    break
}

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

function Import-ProjectConfig {
    param([Parameter(Mandatory)][string]$RepoPath)

    $configPath = Join-Path $RepoPath 'copilot-env.config'
    if (-not (Test-Path $configPath)) { throw "Missing project config at $configPath." }

    $script:CooldownRepoMinSha = ''
    $script:CooldownRepoMaxSha = ''
    foreach ($line in Get-Content -Path $configPath) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }

        $equals = $trimmed.IndexOf('=')
        if ($equals -lt 0) { throw "$configPath must use KEY=value lines." }

        $key = $trimmed.Substring(0, $equals).Trim()
        $value = $trimmed.Substring($equals + 1).Trim()
        switch ($key) {
            'CooldownRepoMinSha' { $script:CooldownRepoMinSha = $value }
            'CooldownRepoMaxSha' { $script:CooldownRepoMaxSha = $value }
            'GATEWAY_MIN_VERSION' { }
            'GATEWAY_MAX_VERSION' { }
        }
    }

    if ($script:CooldownRepoMaxSha -eq 'null') { $script:CooldownRepoMaxSha = '' }
    if (-not $script:CooldownRepoMinSha) { throw "CooldownRepoMinSha is required in $configPath." }
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
# verbatim with install.sh, and unit-tested) and runs under the bun winget just
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

Update-ProcessPath
if ($NoPrereqs -or $LocalInstall) {
    # git can only be installed via winget, which neither -NoPrereqs nor
    # -LocalInstall may use. It is necessary only when a fresh clone/update is
    # needed (checked at the fetch site below); a reused checkout doesn't need it.
    if (-not (Test-ExternalCommand git)) {
        Write-Host 'Note: git not found; required only to clone/update copilot-env.'
    }
} else {
    Install-WingetPackage -Command git -Name 'Git' -Id 'Git.Git'
}

# Resolve the copilot-env commit to pin under -Cooldown: the newest commit on
# origin/main that is >= $Days old, clamped to the config [MIN, MAX] window. A
# MAX ceiling limits the search to its ancestors;
# if nothing past the floor has aged in yet, we pin MIN exactly (cooldown bypassed
# for the floor). Mirrors install.sh's resolve_aged_commit + floatGateway. NOTE:
# --before filters on the commit date (advisory / can be backdated, unlike npm's
# registry publish time), so the manually-vetted MIN floor is the hard anchor.
# Assumes a linear main (squash-only merges + required_linear_history).
function Resolve-AgedCommit {
    param(
        [Parameter(Mandatory)][string]$RepoPath,
        [Parameter(Mandatory)][int]$Days
    )

    $upper = 'origin/main'
    if ($CooldownRepoMaxSha) {
        & git -C $RepoPath merge-base --is-ancestor $CooldownRepoMinSha $CooldownRepoMaxSha
        if ($LASTEXITCODE -ne 0) { throw 'CooldownRepoMinSha is not an ancestor of CooldownRepoMaxSha.' }
        $upper = $CooldownRepoMaxSha
    }

    $aged = (& git -C $RepoPath rev-list -1 "--before=$Days days ago" $upper | Select-Object -First 1)
    $useFloor = -not $aged
    if ($aged) {
        & git -C $RepoPath merge-base --is-ancestor $CooldownRepoMinSha $aged
        if ($LASTEXITCODE -ne 0) { $useFloor = $true } # aged is older than the floor
    }
    if ($useFloor) {
        $aged = (& git -C $RepoPath rev-parse --verify --quiet "$CooldownRepoMinSha^{commit}" | Select-Object -First 1)
        if (-not $aged) { throw "CooldownRepoMinSha ($CooldownRepoMinSha) not found in copilot-env history." }
    }
    return $aged.Trim()
}

# Locate an existing checkout, or clone/update one to $InstallDir.
if ($SelfDir -and (Test-Path (Join-Path $SelfDir 'agents.ps1'))) {
    $RepoDir = $SelfDir
    Write-Host "Using existing checkout at $RepoDir"
    Import-ProjectConfig -RepoPath $RepoDir
} else {
    if (-not (Test-ExternalCommand git)) {
        throw "git is required to clone/update copilot-env into $InstallDir, but it is not installed (and -NoPrereqs / -LocalInstall may not install it). Install git, or run from an existing checkout."
    }
    if (Test-Path (Join-Path $InstallDir '.git')) {
        Write-Host "Updating copilot-env in $InstallDir ..."
        if ($Cooldown) {
            # -Cooldown resolves an aged commit by walking history, so it needs a
            # full clone; deepen a previously-shallow checkout, else a plain fetch.
            if (Test-Path (Join-Path $InstallDir '.git\shallow')) {
                & git -C $InstallDir fetch --unshallow origin main
            } else {
                & git -C $InstallDir fetch origin main
            }
        } else {
            & git -C $InstallDir fetch --depth 1 origin main
        }
        if ($LASTEXITCODE -ne 0) { throw 'git fetch origin main failed.' }
        & git -C $InstallDir reset --hard origin/main
    } else {
        Write-Host "Cloning copilot-env into $InstallDir ..."
        # Shallow clone for a fast one-liner install; -Cooldown needs full history
        # to resolve an aged commit (Resolve-AgedCommit), so clone fully for it.
        if ($Cooldown) {
            & git clone $RepoUrl $InstallDir
        } else {
            & git clone --depth 1 $RepoUrl $InstallDir
        }
    }
    if ($LASTEXITCODE -ne 0) { throw 'git clone/pull failed.' }
    $RepoDir = $InstallDir
    Import-ProjectConfig -RepoPath $RepoDir
    # With -Cooldown, hold the copilot-env checkout itself back to the newest
    # commit on main that is >= CooldownDays old (clamped to [MIN, MAX]) -- the
    # same supply-chain delay we apply to npm packages, here defending against a
    # compromised just-pushed commit to this very repo. Resolve the SHA now (off
    # the fresh origin/main) but defer the rollback to the end: the steps below
    # run from this checkout (e.g. the agent-CLI cooldown resolver) and need not
    # exist in that commit.
    if ($Cooldown) {
        $CooldownRepoSha = Resolve-AgedCommit -RepoPath $InstallDir -Days $CooldownDays
    }
}
$AgentsPs1 = Join-Path $RepoDir 'agents.ps1'
if (-not (Test-Path $AgentsPs1)) { Write-Error "Could not find agents.ps1 at $AgentsPs1"; exit 1 }

if ($NoPrereqs -or $LocalInstall) {
    # Node/npm only come from winget (forbidden by both flags) and are optional --
    # they only power the agent CLIs; the gateway runs on bun. Warn if absent.
    Write-MissingPrereq -Command npm.cmd -Name 'Node.js LTS and npm'
} else {
    Install-WingetPackage -Command npm.cmd -Name 'Node.js LTS and npm' -Id 'OpenJS.NodeJS.LTS'
}

if ($NoPrereqs) {
    # bun is the gateway runtime -- necessary. Fail loudly if it is absent.
    if (-not (Test-ExternalCommand bun)) {
        throw 'bun is required to run copilot-env, but it is not installed (-NoPrereqs). Install bun (https://bun.sh) and rerun.'
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

if ($NoShellIntegration) {
    Write-Host 'Skipping profile wiring (-NoShellIntegration).'
} else {
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
}

# Clean-finish repo-cooldown rollback: roll the managed clone back to the aged
# commit now (before "Done"), so its output doesn't trail the final message. Null
# out $CooldownRepoSha first so the failure trap is disarmed -- if this reset
# throws it won't re-enter the trap and reset twice. The trap still covers any
# earlier mid-install failure.
if ($CooldownRepoSha) {
    $sha = $CooldownRepoSha
    $CooldownRepoSha = $null
    Write-Host "Cooldown: pinning copilot-env to $sha (>=${CooldownDays}d old) ..."
    & git -C $RepoDir reset --hard $sha
    if ($LASTEXITCODE -ne 0) { throw 'git reset to the cooldown commit failed.' }
}

Write-Host ''
if ($NoShellIntegration) {
    Write-Host 'Done. Profile wiring was skipped (-NoShellIntegration). To enable it, add to your $PROFILE:'
    Write-Host "  `$AgentsPs1 = `"$AgentsPs1`""
    Write-Host '  if (Test-Path $AgentsPs1) { . $AgentsPs1 }'
} else {
    Write-Host "Done. Restart PowerShell or run:  . `$PROFILE"
}
Write-Host "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
