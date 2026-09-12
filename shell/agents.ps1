# Dot-sourced from the PowerShell $PROFILE; the twin of shell/agents.bashrc.
# It adds only what a subprocess cannot do: eval `agent env` into the current session.

$script:AgentsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:AgentPs1 = Join-Path $AgentsDir 'bin\agent.ps1'

# DENO_INSTALL is the same override scripts/ensure-deno.ps1 honors, so every entry point
# looks in one place.
$DenoHome = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $HOME '.deno' }
$DenoDir = Join-Path $DenoHome 'bin'
$DenoExe = Join-Path $DenoDir 'deno.exe'
if ((Test-Path $DenoExe) -and (-not (Get-Command deno -ErrorAction SilentlyContinue))) {
    $env:Path = "$DenoDir;$env:Path"
}

# --- low-level helpers -----------------------------------------------------

function Invoke-Agent {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 @args
}

# `agent env` stdout carries only shell directives (src/commands/env.ts), so every line is
# safe to Invoke-Expression. -Quiet drops stderr for the eager startup call alone, matching
# agents.bashrc: the wrapper's refresh stays audible, the first-source call is silent.
function Import-CopilotEnv {
    param([switch]$Quiet)
    $lines = if ($Quiet) { Invoke-Agent env --format powershell 2>$null } else { Invoke-Agent env --format powershell }
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($line in $lines) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { Invoke-Expression $line }
    }
}

# `agent env` is the ONLY output this file ever evals, so a new subcommand never touches
# this wrapper. The refresh is not -Quiet: a failed refresh should be visible.
function agent {
    Invoke-Agent @args
    if ($LASTEXITCODE -ne 0) { return }
    Import-CopilotEnv
}

# --- shell-startup side effects --------------------------------------------

# -Quiet: bootstrap output on first source would disrupt the prompt; a failed resolution
# surfaces on the next `agent` call instead.
Import-CopilotEnv -Quiet
