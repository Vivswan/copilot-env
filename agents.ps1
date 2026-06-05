# Agent commands (Windows / PowerShell) — dot-sourced from your PowerShell
# $PROFILE. PowerShell equivalent of agents.bashrc.
#
# Thin wrapper over bin\agent.ps1 (which self-bootstraps bun, builds the per-user
# cache, and dispatches). This file only adds what a subprocess can't do for the
# session: eval the gateway env into the current shell after `start`.

# Resolve this file's directory; bin\agent.ps1 lives alongside it.
$script:AgentsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AgentPs1 = Join-Path $AgentsDir 'bin\agent.ps1'

# Ensure bun is on PATH (its installer patches the user PATH, but a running
# session may predate that).
$BunDir = Join-Path $env:USERPROFILE '.bun\bin'
if ((Test-Path (Join-Path $BunDir 'bun.exe')) -and ($env:Path -notlike "*$BunDir*")) {
    $env:Path = "$BunDir;$env:Path"
}

# --- low-level helpers -----------------------------------------------------

# Invoke bin\agent.ps1 with the given arguments.
function Invoke-Agent {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 @args
}

# Apply the `env` output to the current session. Request PowerShell-native
# `$env:KEY = '...'` lines and evaluate them directly -- no manual parsing.
function Import-CopilotEnv {
    $lines = Invoke-Agent env --format powershell 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($line in $lines) {
        if ($line -match '^\s*\$env:') { Invoke-Expression $line }
    }
}

# Return $true if the local copilot gateway is reachable, $false otherwise.
# Uses `agent health` (HTTP-probes the gateway, exit 0 = up).
function Test-CopilotServer {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 health *> $null
    return ($LASTEXITCODE -eq 0)
}

function Assert-AgentCli {
    param([Parameter(Mandatory)][string]$Command)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    Write-Error "'$Command' is not installed. Rerun $script:AgentsDir\install.ps1."
    return $false
}

# --- lifecycle -------------------------------------------------------------

# Ping the gateway before launching an agent; if it's down, offer to start it.
function Confirm-CopilotServer {
    if (Test-CopilotServer) { return }
    $ans = Read-Host 'copilot gateway not running. Start it now? [Y/n]'
    switch -Regex ($ans) {
        '^(|y|Y|yes|Yes)$' { agent start }
        default { Write-Host 'Continuing without starting the gateway.' }
    }
}

# Uniform wrapper over bin\agent.ps1 (mirrors the POSIX agents.bashrc `agent`):
# run the requested command, then re-apply the full session env from the single
# source of truth — `agent env`, which prints only `$env:KEY = ...` lines
# (gateway vars, plus CODEX_HOME when a host farm is active). No per-subcommand
# logic; we only ever eval the dedicated, contract-stable `env` output.
function agent {
    Invoke-Agent @args
    if ($LASTEXITCODE -ne 0) { return }
    Import-CopilotEnv
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
