# Agent commands (Windows / PowerShell) -- dot-sourced from your PowerShell
# $PROFILE. PowerShell equivalent of agents.bashrc.
#
# Thin wrapper over bin\agent.ps1 (which self-bootstraps bun, installs
# node_modules in-place in the checkout, and dispatches). This file only adds what
# a subprocess can't do for the session: eval the proxy env into the current
# shell after `start`.

# Resolve the repo root; this file lives in shell/, so the checkout root is its
# parent and bin\agent.ps1 lives there.
$script:AgentsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
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

# Apply the `env` output to the current session. It emits PowerShell-native
# `$env:KEY = '...'` assignments AND `Remove-Item Env:KEY` clears; evaluate both.
function Import-CopilotEnv {
    $lines = Invoke-Agent env --format powershell 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($line in $lines) {
        if ($line -match '^\s*(\$env:|Remove-Item )') { Invoke-Expression $line }
    }
}

# Uniform wrapper over bin\agent.ps1 (mirrors the POSIX agents.bashrc `agent`):
# run the requested command, then re-apply the full session env from the single
# source of truth -- `agent env`, which prints `$env:KEY = ...` / `Remove-Item
# Env:KEY` lines (CODEX_HOME + the proxy ANTHROPIC_BASE_URL, set or cleared). No
# per-subcommand logic; we only ever eval the dedicated, contract-stable `env` output.
function agent {
    Invoke-Agent @args
    if ($LASTEXITCODE -ne 0) { return }
    Import-CopilotEnv
}

# --- shell-startup side effects --------------------------------------------

# Eagerly apply the managed env (CODEX_HOME + proxy ANTHROPIC_BASE_URL) for the current shell.
Import-CopilotEnv
