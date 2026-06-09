# Opt-in agent launchers (Windows / PowerShell) — dot-source this AFTER
# agents.ps1 to enable the short `cl` / `co` / `cx` launchers. PowerShell
# equivalent of agents.launchers.bashrc. They are intentionally NOT defined by
# the always-on integration so these two-letter names never collide with a
# user's own aliases unless explicitly enabled. Add to your $PROFILE, after the
# copilot-env integration block:
#
#     . C:\path\to\agents.launchers.ps1
#
# Relies on the `agent` function and gateway env that agents.ps1 sets up.

# Resolve the repo root if agents.ps1 hasn't already; this file lives in shell/,
# so the checkout root is its parent and bin\agent.ps1 lives there.
if (-not $script:AgentsDir) {
    $script:AgentsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
if (-not $script:AgentPs1) {
    $script:AgentPs1 = Join-Path $script:AgentsDir 'bin\agent.ps1'
}

# Return $true if the local copilot gateway is reachable, $false otherwise.
# Uses `agent health --scope runtime` (fast HTTP probe of the gateway, exit 0 = up).
function Test-CopilotServer {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 health --scope runtime *> $null
    return ($LASTEXITCODE -eq 0)
}

function Assert-AgentCli {
    param([Parameter(Mandatory)][string]$Command)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    Write-Error "'$Command' is not installed. Rerun $script:AgentsDir\install.ps1."
    return $false
}

# Ping the gateway before launching an agent; if it's down, offer to start it.
function Confirm-CopilotServer {
    if (Test-CopilotServer) { return }
    $ans = Read-Host 'copilot gateway not running. Start it now? [Y/n]'
    switch -Regex ($ans) {
        '^(|y|Y|yes|Yes)$' { agent start }
        default { Write-Host 'Continuing without starting the gateway.' }
    }
}

# --- agent launchers -------------------------------------------------------

function cl {
    if (-not (Assert-AgentCli claude)) { return }
    Confirm-CopilotServer
    $env:CLAUDE_CODE_NO_FLICKER = '1'
    & claude --permission-mode auto --enable-auto-mode @args
}

function co {
    if (-not (Assert-AgentCli copilot)) { return }
    & copilot --autopilot --enable-reasoning-summaries --experimental @args
}

function cx {
    if (-not (Assert-AgentCli codex)) { return }
    # Refresh the effective CODEX_HOME. Existing direct config stays as-is;
    # proxy config is refreshed; missing/custom configs become direct.
    agent setup-codex-config
    if ($LASTEXITCODE -ne 0) { return }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 setup-codex-config --check *> $null
    $codexProviderStatus = $LASTEXITCODE
    if ($codexProviderStatus -eq 2) {
        Confirm-CopilotServer
    } elseif ($codexProviderStatus -ne 0) {
        return
    }
    & codex @args
}
