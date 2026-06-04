# Agent commands — source this from your shell rc (~/.bashrc / ~/.zshrc).
# Must be compatible with both bash and zsh (POSIX constructs only).
#
# Pure runtime wiring: defines the lifecycle wrappers and agent launchers and
# exports the gateway env. Prerequisites and the agent CLIs are installed by
# install.sh — this file never installs anything.

# shellcheck shell=bash
# Resolve this file's directory (bash and zsh compatible). Kept in the shell
# environment because the functions below reference it at call time. The
# ${(%):-%x} fallback is zsh's equivalent of $BASH_SOURCE.
# shellcheck disable=SC2296
_COPILOT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

# Ensure bun is on PATH (its installer only patches ~/.zshrc by default).
[ -x "$HOME/.bun/bin/bun" ] && case ":$PATH:" in *":$HOME/.bun/bin:"*) ;; *) export PATH="$HOME/.bun/bin:$PATH" ;; esac

# Unified user-facing entry point.
#   agent start             launch the gateway + export its env into this shell
#   agent codex             (re)write the default ~/.codex so Codex routes through
#                           the local gateway (codex-home resolves url/key itself)
#   agent start_with_codex  agent start, then agent codex
#   agent <subcommand>      everything else (stop, env, cost, ...) passes straight
#                           through to the copilot-api bin
function agent {
    case "$1" in
        start)
            shift
            "${_COPILOT_AGENTS_DIR}/bin/copilot-api" start "$@" \
                && eval "$("${_COPILOT_AGENTS_DIR}/bin/copilot-api" env)" \
                || return $?
            ;;
        codex)
            shift
            "${_COPILOT_AGENTS_DIR}/bin/codex-home" "$@"
            ;;
        start_with_codex)
            shift
            agent start "$@" || return $?
            agent codex
            ;;
        *)
            "${_COPILOT_AGENTS_DIR}/bin/copilot-api" "$@"
            ;;
    esac
}

# Eagerly export ANTHROPIC_/OPENAI_ env vars for the current shell. Silence
# stderr so the bootstrap's informational output ("Installing copilot-env
# node_modules ...") doesn't break Powerlevel10k's instant-prompt guard on
# first source. If env resolution fails, the next cl/co/cx call will surface
# the error.
eval "$("${_COPILOT_AGENTS_DIR}/bin/copilot-api" env "$@" 2>/dev/null)"

# Ping the gateway before launching an agent; if it's down, offer to start it.
# The base URL is exported as ANTHROPIC_BASE_URL/OPENAI_BASE_URL at shell start
# (it encodes the resolved port even when the daemon is down); fall back to the
# default port if neither is set. Without curl we can't probe, so assume up and
# don't block. `agent start` runs in the current shell, so its env exports
# propagate to the agent we launch next.
function _copilot_ensure_server {
    _url="${ANTHROPIC_BASE_URL:-}"
    [ -n "$_url" ] || { _url="${OPENAI_BASE_URL:-}"; _url="${_url%/v1}"; }
    [ -n "$_url" ] || _url="http://localhost:${COPILOT_API_PORT_DEFAULT:-4141}"

    # Probe: cap connect + total time at 2s so a stalled socket can't hang the
    # launch. 7 = connection refused, 28 = timeout -> down; any other result
    # (including no curl available) -> treat as up and don't block.
    if command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null --connect-timeout 2 --max-time 2 "$_url"
        case "$?" in
            7|28) ;;
            *) return 0 ;;
        esac
    else
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
    export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
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
    command codex "$@"
}
