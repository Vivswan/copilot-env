# Opt-in agent launchers (Windows / PowerShell) — dot-source this AFTER
# agents.ps1 to enable the short `cl` / `co` / `cx` launchers (plus the
# more-permissive `clx` / `cox` / `cxx` variants that add each agent's
# most-relaxed flag). PowerShell equivalent of agents.launchers.bashrc.
# They are intentionally NOT defined by the always-on integration so these short
# names never collide with a user's own aliases unless explicitly enabled. Add
# to your $PROFILE, after the copilot-env integration block:
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
    # Read the configured Claude provider (no live probe — provider auto-detection
    # is done once by `agent setup-clis`, not on every launch): exit 0 = direct
    # (Claude reads settings.json itself), 2 = proxy/default (ensure the gateway +
    # re-sync the port/token), else custom/error.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 claude --check *> $null
    $claudeProviderStatus = $LASTEXITCODE
    if ($claudeProviderStatus -eq 2) {
        Confirm-CopilotServer
        # Bail if the gateway is still down (declined / failed) — don't re-sync
        # proxy config against a stale port or launch into a dead gateway.
        if (-not (Test-CopilotServer)) { return }
        agent claude --proxy
        if ($LASTEXITCODE -ne 0) { return }
    } elseif ($claudeProviderStatus -ne 0) {
        # Custom/foreign config (exit 1) we don't manage: say so and launch as-is.
        Write-Host 'cl: Claude has a custom provider config (not managed by copilot-env); launching it as-is.'
    }
    $env:CLAUDE_CODE_NO_FLICKER = '1'
    & claude --permission-mode auto --enable-auto-mode @args
}

function co {
    if (-not (Assert-AgentCli copilot)) { return }
    & copilot --autopilot --enable-reasoning-summaries --experimental @args
}

function cx {
    if (-not (Assert-AgentCli codex)) { return }
    # Read the configured Codex provider (no live probe — provider auto-detection
    # is done once by `agent setup-clis`, not on every launch): exit 0 = direct
    # (Codex reads its own config), 2 = proxy/default (ensure the gateway + re-sync
    # the port/token), else custom/error.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 codex --check *> $null
    $codexProviderStatus = $LASTEXITCODE
    if ($codexProviderStatus -eq 2) {
        Confirm-CopilotServer
        # Bail if the gateway is still down (declined / failed) — don't re-sync
        # proxy config against a stale port or launch into a dead gateway.
        if (-not (Test-CopilotServer)) { return }
        agent codex --proxy
        if ($LASTEXITCODE -ne 0) { return }
    } elseif ($codexProviderStatus -ne 0) {
        # Custom/foreign config (exit 1) we don't manage: say so and launch as-is.
        Write-Host 'cx: Codex has a custom provider config (not managed by copilot-env); launching it as-is.'
    }
    & codex @args
}

# More-permissive variants: same provider wiring as cl/co/cx, plus each agent's
# most-relaxed flag (Claude skips permission prompts; Copilot allows all; Codex
# opens a full-access sandbox). Delegate to the base launcher so the
# gateway/provider logic lives in one place.
function clx { cl --dangerously-skip-permissions @args }
function cox { co --allow-all @args }
function cxx { cx --sandbox danger-full-access @args }
