# Agent commands (Windows / PowerShell) — dot-sourced from your PowerShell
# $PROFILE. PowerShell equivalent of agents.bashrc.
#
# Lifecycle wrappers delegate to the copilot-env package via the PowerShell bin
# launcher (bin\copilot-api.ps1), which self-bootstraps on first invocation
# (installs node_modules into the per-user cache; no-op on subsequent runs when
# the lockfile is unchanged).

# Resolve this file's directory; the bin launchers live alongside it.
$script:AgentsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:CopilotApiPs1 = Join-Path $AgentsDir 'bin\copilot-api.ps1'
$script:CodexHomePs1 = Join-Path $AgentsDir 'bin\codex-home.ps1'

# Ensure bun is on PATH (its installer patches the user PATH, but a running
# session may predate that).
$BunDir = Join-Path $env:USERPROFILE '.bun\bin'
if ((Test-Path (Join-Path $BunDir 'bun.exe')) -and ($env:Path -notlike "*$BunDir*")) {
    $env:Path = "$BunDir;$env:Path"
}

# --- low-level helpers -----------------------------------------------------

# Invoke the copilot-api launcher with the given arguments.
function Invoke-CopilotApi {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:CopilotApiPs1 @args
}

# Apply the `env` output to the current session. Request PowerShell-native
# `$env:KEY = '...'` lines and evaluate them directly -- no manual parsing.
function Import-CopilotEnv {
    $lines = Invoke-CopilotApi env --format powershell 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($line in $lines) {
        if ($line -match '^\s*\$env:') { Invoke-Expression $line }
    }
}

# Refresh Codex's config.toml/.env so it routes through the local gateway. On
# Windows/macOS the config lives in the default ~/.codex (%USERPROFILE%\.codex),
# which codex reads natively -- so we never set CODEX_HOME. CODEX_HOME is only
# needed on Linux, and only when the per-host symlink farm is used (--symlink-farm).
# Called from copilot-start (after the gateway is up); non-fatal -- a failure
# here doesn't block gateway startup.
function Update-CodexConfig {
    if (-not (Test-Path $script:CodexHomePs1)) { return }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:CodexHomePs1 | Out-Null
}

# Return $true if the local copilot gateway is reachable, $false otherwise.
function Test-CopilotServer {
    $url = $env:ANTHROPIC_BASE_URL
    if (-not $url) { $url = ($env:OPENAI_BASE_URL -replace '/v1$', '') }
    if (-not $url) {
        $port = $env:COPILOT_API_PORT_DEFAULT; if (-not $port) { $port = '4141' }
        $url = "http://localhost:$port"
    }
    try {
        Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null
        return $true
    } catch {
        # Any HTTP response (even an error status) means the server is up.
        return ($null -ne $_.Exception.Response)
    }
}

function Assert-AgentCli {
    param([Parameter(Mandatory)][string]$Command)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    Write-Error "'$Command' is not installed. Rerun $script:AgentsDir\install.ps1."
    return $false
}

# --- lifecycle -------------------------------------------------------------

# Start the gateway and export its env into this session. Also refresh Codex's
# config so it points at the freshly-started gateway. Host profiles sourced
# after this file may redefine copilot-start to add host-specific wiring.
function copilot-start {
    Invoke-CopilotApi start @args
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    Import-CopilotEnv
    Update-CodexConfig
}

# Ping the gateway before launching an agent; if it's down, offer to start it.
function Confirm-CopilotServer {
    if (Test-CopilotServer) { return }
    $ans = Read-Host 'copilot gateway not running. Start it now? [Y/n]'
    switch -Regex ($ans) {
        '^(|y|Y|yes|Yes)$' { copilot-start }
        default { Write-Host 'Continuing without starting the gateway.' }
    }
}

# Unified user-facing entry point. `agent start` runs the full lifecycle wrapper
# (start + env export); every other subcommand passes straight through.
function agent {
    if ($args.Count -ge 1 -and $args[0] -eq 'start') {
        copilot-start @($args | Select-Object -Skip 1)
    } else {
        Invoke-CopilotApi @args
    }
}

# --- agent launchers -------------------------------------------------------

function cl {
    if (-not (Assert-AgentCli claude)) { return }
    Confirm-CopilotServer
    $env:CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
    $env:CLAUDE_CODE_NO_FLICKER = '1'
    & claude --permission-mode auto --enable-auto-mode @args
}

function co {
    if (-not (Assert-AgentCli copilot)) { return }
    & copilot --autopilot --enable-reasoning-summaries --experimental @args
}

function cx {
    if (-not (Assert-AgentCli codex)) { return }
    Confirm-CopilotServer
    & codex @args
}

# --- shell-startup side effects --------------------------------------------

# Eagerly export ANTHROPIC_/OPENAI_ env vars for the current shell.
Import-CopilotEnv
