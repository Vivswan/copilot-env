# Opt-in agent launchers (Windows / PowerShell) -- dot-source this AFTER
# agents.ps1 to enable the short `cl` / `co` / `cx` launchers (plus the
# more-permissive `clx` / `cox` / `cxx` variants that add each agent's
# most-relaxed flag). PowerShell equivalent of agents.launchers.bashrc.
# They are intentionally NOT defined by the always-on integration so these short
# names never collide with a user's own aliases unless explicitly enabled. Add
# to your $PROFILE, after the copilot-env integration block:
#
#     . C:\path\to\agents.launchers.ps1
#
# Relies on the `agent` function and proxy env that agents.ps1 sets up.

# Resolve the repo root if agents.ps1 hasn't already; this file lives in shell/,
# so the checkout root is its parent and bin\agent.ps1 lives there.
if (-not $script:AgentsDir) {
    $script:AgentsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
if (-not $script:AgentPs1) {
    $script:AgentPs1 = Join-Path $script:AgentsDir 'bin\agent.ps1'
}

# Return $true if the local copilot proxy is reachable, $false otherwise.
# Uses `agent start --check` (fast TCP-connect probe of OUR proxy, exit 0 = up).
function Test-CopilotServer {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 start --check *> $null
    return ($LASTEXITCODE -eq 0)
}

function Assert-AgentCli {
    param([Parameter(Mandatory)][string]$Command)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    Write-Error "'$Command' is not installed. Run 'agent shell --clis' to install the agent CLIs."
    return $false
}

# Ensure the proxy is up before launching a proxy-backed agent. Delegates to the shared
# resolver (src/scripts/proxy-token.ps1) WITHOUT `--yes`, so an unmanaged + down proxy
# prompts the user (the managed path starts it silently). stdout (the key) is discarded;
# only the prompt/start noise shows.
function Confirm-CopilotServer {
    $resolver = Join-Path $script:AgentsDir 'src\scripts\proxy-token.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $resolver 1> $null
}

# --- agent launchers -------------------------------------------------------

# Sync the agent's provider wiring before launch. Reads the configured provider
# via `agent <name> --check` (no live probe -- provider auto-detection is done
# once by `agent init`, not on every launch). Exit-code contract
# (providerModeExitCode, src/{claude,codex}/config.ts): 0 = direct (the agent
# reads its own config), 2 = proxy/default (ensure the proxy + re-sync the
# port/token), else custom/foreign config we don't manage: don't touch it, just
# say so and let the caller launch with the user's own wiring. Returns $true to
# launch, $false to abort; the `agent --proxy` output pipes to Out-Host so the
# bool return value doesn't capture it.
function Sync-AgentProvider {
    param(
        [Parameter(Mandatory)][string]$Agent,
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][string]$Display
    )
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 $Agent --check *> $null
    $status = $LASTEXITCODE
    if ($status -eq 2) {
        Confirm-CopilotServer
        # Bail if the proxy is still down (declined / failed) -- don't re-sync
        # proxy config against a stale port or launch into a dead proxy.
        if (-not (Test-CopilotServer)) { return $false }
        agent $Agent --proxy | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
    } elseif ($status -ne 0) {
        Write-Host "$($Launcher): $Display has a custom provider config (not managed by copilot-env); launching it as-is."
    }
    return $true
}

function cl {
    if (-not (Assert-AgentCli claude)) { return }
    if (-not (Sync-AgentProvider -Agent claude -Launcher cl -Display Claude)) { return }
    $env:CLAUDE_CODE_NO_FLICKER = '1'
    & claude --permission-mode auto --enable-auto-mode @args
}

function co {
    if (-not (Assert-AgentCli copilot)) { return }
    & copilot --autopilot --enable-reasoning-summaries --experimental @args
}

function cx {
    if (-not (Assert-AgentCli codex)) { return }
    if (-not (Sync-AgentProvider -Agent codex -Launcher cx -Display Codex)) { return }
    & codex @args
}

# More-permissive variants: same provider wiring as cl/co/cx, plus each agent's
# most-relaxed flag (Claude skips permission prompts; Copilot allows all; Codex
# opens a full-access sandbox). Delegate to the base launcher so the
# proxy/provider logic lives in one place.
# Scope IS_SANDBOX to the launch only (mirrors the POSIX subshell) so it doesn't
# leak into the user's session: set it, then restore the prior value in finally.
function clx {
    $prev = $env:IS_SANDBOX
    $env:IS_SANDBOX = '1'
    try { cl --dangerously-skip-permissions @args }
    finally {
        if ($null -eq $prev) { Remove-Item Env:IS_SANDBOX -ErrorAction SilentlyContinue }
        else { $env:IS_SANDBOX = $prev }
    }
}
function cox { co --allow-all @args }
function cxx { cx --sandbox danger-full-access @args }
