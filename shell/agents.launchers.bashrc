# Opt-in agent launchers — source this AFTER agents.bashrc to enable the
# short `cl` / `co` / `cx` launchers. They are intentionally NOT defined by the
# always-on integration so these two-letter names never collide with a user's
# own aliases unless explicitly enabled. Add to your shell rc, after the
# copilot-env integration block:
#
#     source /path/to/agents.launchers.bashrc
#
# Must be compatible with both bash and zsh (POSIX constructs only). Relies on
# the `agent` function and gateway env that agents.bashrc sets up.

# shellcheck shell=bash
# Resolve the repo root if agents.bashrc hasn't already (this file lives in
# shell/, so the checkout root is its parent — bin/agent lives there). The
# ${(%):-%x} fallback is zsh's equivalent of $BASH_SOURCE.
# shellcheck disable=SC2296
: "${_COPILOT_AGENTS_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)}"

# Check the gateway before launching an agent; if it's down, offer to start it.
# Uses `agent health` (HTTP-probes the gateway, exit 0 = up). `agent start` runs
# in the current shell, so its env exports propagate to the agent we launch next.
function _copilot_ensure_server {
    if "${_COPILOT_AGENTS_DIR}/bin/agent" health >/dev/null 2>&1; then
        return 0
    fi

    printf 'copilot gateway not running. Start it now? [Y/n] ' >&2
    read -r _ans
    case "$_ans" in
        ''|y|Y|yes|Yes) agent start ;;
        *) echo "Continuing without starting the gateway." >&2 ;;
    esac
}

# Error if an agent CLI is missing; installation is handled by install.sh.
function _copilot_require_cli {
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "'$1' is not installed. Run install.sh to install the agent CLIs." >&2
    return 1
}

function cl {
    _copilot_require_cli claude || return 1
    _copilot_ensure_server || return $?
    export CLAUDE_CODE_NO_FLICKER=1
    command claude --permission-mode auto --enable-auto-mode "$@"
}

function co {
    _copilot_require_cli copilot || return 1
    command copilot --autopilot --enable-reasoning-summaries --experimental "$@"
}

function cx {
    _copilot_require_cli codex || return 1
    _copilot_ensure_server || return $?
    # Re-wire ~/.codex to the local gateway before launching (via the `agent`
    # wrapper so the env refresh runs too).
    agent codex-config || return $?
    command codex "$@"
}
