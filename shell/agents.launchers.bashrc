# Opt-in agent launchers — source this AFTER agents.bashrc to enable the
# short `cl` / `co` / `cx` launchers (plus the more-permissive `clx` / `cox` /
# `cxx` variants that add each agent's most-relaxed flag). They are intentionally
# NOT defined by the always-on integration so these short names never collide
# with a user's own aliases unless explicitly enabled. Add to your shell rc,
# after the copilot-env integration block:
#
#     source /path/to/agents.launchers.bashrc
#
# Must be compatible with both bash and zsh (POSIX constructs only). Relies on
# the `agent` function and proxy env that agents.bashrc sets up.

# shellcheck shell=bash
# Resolve the repo root if agents.bashrc hasn't already (this file lives in
# shell/, so the checkout root is its parent — bin/agent lives there). The
# ${(%):-%x} fallback is zsh's equivalent of $BASH_SOURCE.
# shellcheck disable=SC2296
: "${_COPILOT_AGENTS_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)}"

# Check the proxy before launching a proxy-backed agent; if it's down, offer to
# start it. Returns SUCCESS only if the proxy is reachable afterward — so a
# caller that `|| return`s won't re-sync proxy config against a stale port or
# launch into a dead proxy when the user declines. `agent start` runs in the
# current shell so its env exports propagate to the agent we launch next.
function _copilot_ensure_server {
    if "${_COPILOT_AGENTS_DIR}/bin/agent" health --scope runtime >/dev/null 2>&1; then
        return 0
    fi

    printf 'copilot proxy not running. Start it now? [Y/n] ' >&2
    read -r _ans
    case "$_ans" in
        ''|y|Y|yes|Yes) agent start ;;
        *) echo "Continuing without the proxy; proxy-backed agents need it (run 'agent start')." >&2 ;;
    esac
    # Success only if the proxy is reachable now (declined / failed start => non-zero).
    "${_COPILOT_AGENTS_DIR}/bin/agent" health --scope runtime >/dev/null 2>&1
}

# Error if an agent CLI is missing; installation is handled by install.sh.
function _copilot_require_cli {
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "'$1' is not installed. Run 'agent shell --clis' to install the agent CLIs." >&2
    return 1
}

function cl {
    _copilot_require_cli claude || return 1
    # Read the configured Claude provider (no live probe — provider auto-detection
    # is done once by `agent init`, not on every launch): exit 0 = direct
    # (Claude reads settings.json itself), 2 = proxy/default (ensure the proxy +
    # re-sync the port/token), else custom/error.
    if "${_COPILOT_AGENTS_DIR}/bin/agent" claude --check >/dev/null 2>&1; then
        _claude_provider_status=0
    else
        _claude_provider_status=$?
    fi
    if [ "$_claude_provider_status" -eq 2 ]; then
        unset _claude_provider_status
        _copilot_ensure_server || return $?
        agent claude --proxy || return $?
    elif [ "$_claude_provider_status" -eq 0 ]; then
        unset _claude_provider_status
    else
        # Custom/foreign config (exit 1) we don't manage: don't touch it, just say
        # so and launch Claude with the user's own wiring.
        unset _claude_provider_status
        echo "cl: Claude has a custom provider config (not managed by copilot-env); launching it as-is." >&2
    fi
    export CLAUDE_CODE_NO_FLICKER=1
    command claude --permission-mode auto --enable-auto-mode "$@"
}

function co {
    _copilot_require_cli copilot || return 1
    command copilot --autopilot --enable-reasoning-summaries --experimental "$@"
}

function cx {
    _copilot_require_cli codex || return 1
    # Read the configured Codex provider (no live probe — provider auto-detection
    # is done once by `agent init`, not on every launch): exit 0 = direct
    # (Codex reads its own config), 2 = proxy/default (ensure the proxy + re-sync
    # the port/token), else custom/error.
    if "${_COPILOT_AGENTS_DIR}/bin/agent" codex --check >/dev/null 2>&1; then
        _codex_provider_status=0
    else
        _codex_provider_status=$?
    fi
    if [ "$_codex_provider_status" -eq 2 ]; then
        unset _codex_provider_status
        _copilot_ensure_server || return $?
        agent codex --proxy || return $?
    elif [ "$_codex_provider_status" -eq 0 ]; then
        unset _codex_provider_status
    else
        # Custom/foreign config (exit 1) we don't manage: don't touch it, just say
        # so and launch Codex with the user's own wiring.
        unset _codex_provider_status
        echo "cx: Codex has a custom provider config (not managed by copilot-env); launching it as-is." >&2
    fi
    command codex "$@"
}


# More-permissive variants: same provider wiring as cl/co/cx, plus each agent's
# most-relaxed flag (Claude skips permission prompts; Copilot allows all; Codex
# opens a full-access sandbox). Delegate to the base launcher so the
# proxy/provider logic lives in one place.
function clx { cl --dangerously-skip-permissions "$@"; }
function cox { co --allow-all "$@"; }
function cxx { cx --sandbox danger-full-access "$@"; }
