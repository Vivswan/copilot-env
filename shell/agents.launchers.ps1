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

# Resolve the repo root from THIS file's location (it lives in shell\, so the
# checkout root is its parent and bin\agent.ps1 lives there). Always assigned,
# exactly like agents.ps1: re-dot-sourcing the launchers from a different
# checkout must repoint them, never keep a stale dir from a previously sourced
# integration.
$script:AgentsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:AgentPs1 = Join-Path $script:AgentsDir 'bin\agent.ps1'

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

# Prepare an EXPLICIT named profile for launch: never rewires it (the user picked it) --
# just ensures ITS proxy daemon when the profile is proxy-mode (exit 2 from `agent
# profile --check`, the store-driven probe; delegating to proxy-token.ps1 WITHOUT
# `--yes`, so a down daemon prompts like the default path). Exit 0 (direct) passes
# through; exit 1 (no such profile) aborts, replaying the check's own message.
# Returns $true to continue, $false to abort.
function Confirm-CopilotProfileServer {
    param(
        [Parameter(Mandatory)][string]$ProfileName
    )
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 profile --check $ProfileName *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($LASTEXITCODE -ne 2) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 profile --check $ProfileName | Out-Host
        return $false
    }
    $resolver = Join-Path $script:AgentsDir 'src\scripts\proxy-token.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $resolver --profile $ProfileName 1> $null
    return ($LASTEXITCODE -eq 0)
}

function cl {
    if (-not (Assert-AgentCli claude)) { return }
    # `cl --profile <name>` (leading args only): launch Claude under the named profile via
    # `claude --settings <profile file>`. The profile's wiring is honored as-is (no
    # auto-"fixing"); `agent profile --settings-for` re-syncs its baked proxy port and
    # prints the settings path. ANTHROPIC_BASE_URL is cleared for the launch (restored
    # after): the shell may carry the DEFAULT proxy's URL (from `agent env`), which would
    # override the profile's own env block.
    if ($args.Count -ge 2 -and $args[0] -eq '--profile' -and "$($args[1])" -ne '') {
        $name = $args[1]
        $rest = @($args | Select-Object -Skip 2)
        if (-not (Confirm-CopilotProfileServer -ProfileName $name)) { return }
        $settings = (& powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 profile --settings-for $name | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $settings -eq '') { return }
        $env:CLAUDE_CODE_NO_FLICKER = '1'
        $prevBase = $env:ANTHROPIC_BASE_URL
        Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
        try { & claude --settings $settings --permission-mode auto --enable-auto-mode @rest }
        finally {
            if ($null -ne $prevBase) { $env:ANTHROPIC_BASE_URL = $prevBase }
        }
        return
    }
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
    # `cx --profile <name>` (leading args only): launch Codex under its NATIVE profile.
    # Order matters: ensure the profile's daemon FIRST (a cold start may move its port),
    # THEN `agent profile --sync` so the baked base_url tracks the port the daemon
    # actually bound before codex launches.
    if ($args.Count -ge 2 -and $args[0] -eq '--profile' -and "$($args[1])" -ne '') {
        $name = $args[1]
        $rest = @($args | Select-Object -Skip 2)
        if (-not (Confirm-CopilotProfileServer -ProfileName $name)) { return }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script:AgentPs1 profile --sync *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "cx: could not refresh the profile wiring; launching with the existing config (run 'agent profile --sync' to see why)."
        }
        & codex --profile $name @rest
        return
    }
    if (-not (Sync-AgentProvider -Agent codex -Launcher cx -Display Codex)) { return }
    & codex @args
}

# More-permissive variants: same provider wiring as cl/co/cx, plus each agent's
# most-relaxed flag (Claude skips permission prompts; Copilot allows all; Codex
# opens a full-access sandbox). Delegate to the base launcher so the
# proxy/provider logic lives in one place. A leading `--profile <name>` is
# hoisted back to the FRONT of the delegated call (the base launchers only
# recognize it there); the relaxed flag rides behind it.
# Scope IS_SANDBOX to the launch only (mirrors the POSIX subshell) so it doesn't
# leak into the user's session: set it, then restore the prior value in finally.
function clx {
    $prev = $env:IS_SANDBOX
    $env:IS_SANDBOX = '1'
    try {
        if ($args.Count -ge 2 -and $args[0] -eq '--profile' -and "$($args[1])" -ne '') {
            $rest = @($args | Select-Object -Skip 2)
            cl --profile $args[1] --dangerously-skip-permissions @rest
        } else {
            cl --dangerously-skip-permissions @args
        }
    }
    finally {
        if ($null -eq $prev) { Remove-Item Env:IS_SANDBOX -ErrorAction SilentlyContinue }
        else { $env:IS_SANDBOX = $prev }
    }
}
function cox { co --allow-all @args }
function cxx {
    if ($args.Count -ge 2 -and $args[0] -eq '--profile' -and "$($args[1])" -ne '') {
        $rest = @($args | Select-Object -Skip 2)
        cx --profile $args[1] --sandbox danger-full-access @rest
    } else {
        cx --sandbox danger-full-access @args
    }
}
