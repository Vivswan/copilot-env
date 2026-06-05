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

# Uniform wrapper over bin/agent: run the requested command, then re-apply the
# full session env from the single source of truth — `agent env`, which prints
# ONLY `export KEY=val` lines (gateway vars, plus CODEX_HOME when a host farm is
# active). There is no per-subcommand logic: adding a bin/agent subcommand never
# touches this, and we only ever eval the dedicated, contract-stable `env`
# output (never a command's incidental stdout).
function agent {
    "${_COPILOT_AGENTS_DIR}/bin/agent" "$@" || return $?
    # Best-effort env refresh from the dedicated `env` command. Its stderr is NOT
    # silenced so a genuine failure is visible (it stays non-fatal: the `&&`
    # skips eval and the command's own exit status already returned above).
    _env="$("${_COPILOT_AGENTS_DIR}/bin/agent" env)" && eval "${_env}"
    unset _env
}

# Eagerly export ANTHROPIC_/OPENAI_ env vars for the current shell. Silence
# stderr so the bootstrap's informational output ("Installing copilot-env
# node_modules ...") doesn't break Powerlevel10k's instant-prompt guard on
# first source. If env resolution fails, the next cl/co/cx call will surface
# the error.
eval "$("${_COPILOT_AGENTS_DIR}/bin/agent" env "$@" 2>/dev/null)"

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
