# Agent commands — source this from your shell rc (~/.bashrc / ~/.zshrc).
# Must be compatible with both bash and zsh (POSIX constructs only).
#
# Lifecycle wrappers delegate to the copilot-env Node package. The bin shims
# self-bootstrap on first invocation (install node_modules into
# ~/.cache/copilot-env; no-op on subsequent runs when the lockfile is
# unchanged).

# Resolve this file's directory (bash and zsh compatible).
_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

# Ensure bun is on PATH (its installer only patches ~/.zshrc by default).
[ -x "$HOME/.bun/bin/bun" ] && case ":$PATH:" in *":$HOME/.bun/bin:"*) ;; *) export PATH="$HOME/.bun/bin:$PATH" ;; esac

# copilot-api lifecycle wrapper — invoke tsx via the local bin shims. Starts the
# gateway and exports its env. Host rc files sourced after this file may redefine
# copilot-start to add host-specific wiring (e.g. Codex CODEX_HOME).
eval "function copilot-start {
    \"${_AGENTS_DIR}/bin/copilot-api\" start \"\$@\" && \
    eval \"\$(\"${_AGENTS_DIR}/bin/copilot-api\" env)\" || return \$?
}"

# Unified user-facing entry point. `agent start` runs the full lifecycle wrapper
# (start + env export); every other subcommand (stop, env, cost, ...) passes
# straight through to the copilot-api bin.
eval "function agent {
    if [ \"\$1\" = start ]; then
        shift
        copilot-start \"\$@\"
    else
        \"${_AGENTS_DIR}/bin/copilot-api\" \"\$@\"
    fi
}"

# Eagerly export ANTHROPIC_/OPENAI_ env vars for the current shell. Silence
# stderr so the bootstrap's informational output ("Installing copilot-env
# node_modules ...") doesn't break Powerlevel10k's instant-prompt guard on
# first source. If env resolution fails, the next cl/co/cx call will surface
# the error.
eval "$("${_AGENTS_DIR}/bin/copilot-api" env "$@" 2>/dev/null)"

unset _AGENTS_DIR

# Return 0 if the local copilot gateway is reachable, 1 otherwise. The base
# URL is exported as ANTHROPIC_BASE_URL/OPENAI_BASE_URL at shell start (it
# encodes the resolved port even when the daemon is down); fall back to the
# default port if neither is set. Without curl we can't probe, so don't block.
# Pass --benchmark to print the probe state, URL, elapsed time, and curl exit.
function _copilot_server_running {
    _url="${ANTHROPIC_BASE_URL:-}"
    [ -n "$_url" ] || _url="${OPENAI_BASE_URL%/v1}"
    [ -n "$_url" ] || _url="http://localhost:${COPILOT_API_PORT_DEFAULT:-4141}"
    command -v curl >/dev/null 2>&1 || return 0
    # Localhost probe: cap connect + total time at 2s so a stalled socket can't
    # hang the agent launch. Connection-refused (exit 7) returns instantly.
    if [ "$1" = --benchmark ]; then
        _t="$(curl -s -o /dev/null -w '%{time_total}' --connect-timeout 2 --max-time 2 "$_url")"
        _rc=$?
        case "$_rc" in
            7|28) _state=down ;;
            *) _state=up ;;
        esac
        printf 'copilot gateway %s (%s) probe: %ss (curl exit %s)\n' "$_state" "$_url" "$_t" "$_rc" >&2
        [ "$_state" = up ]
        return $?
    fi
    curl -s -o /dev/null --connect-timeout 2 --max-time 2 "$_url"
    # 7 = connection refused, 28 = timeout -> down. Any HTTP response -> up.
    case "$?" in
        7|28) return 1 ;;
        *) return 0 ;;
    esac
}

# Ping the gateway before launching an agent; if it's down, offer to start it.
# copilot-start runs in the current shell, so its env exports propagate to the
# agent we launch next.
function _copilot_ensure_server {
    _copilot_server_running && return 0
    printf 'copilot gateway not running. Start it now? [Y/n] ' >&2
    read -r _ans
    case "$_ans" in
        ''|y|Y|yes|Yes) copilot-start ;;
        *) echo "Continuing without starting the gateway." >&2 ;;
    esac
}

function cl {
    if ! command -v claude >/dev/null 2>&1; then
        echo "Installing Claude Code CLI ..."
        npm install -g @anthropic-ai/claude-code
    fi
    _copilot_ensure_server
    export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
    export CLAUDE_CODE_NO_FLICKER=1
    command claude --permission-mode auto --enable-auto-mode "$@"
}

function co {
    if ! command -v copilot >/dev/null 2>&1; then
        echo "Installing GitHub Copilot CLI ..."
        npm install -g @github/copilot
    fi
    command copilot --autopilot --enable-reasoning-summaries --experimental "$@"
}

function cx {
    if ! command -v codex >/dev/null 2>&1; then
        echo "Installing Codex CLI ..."
        npm install -g @openai/codex
    fi
    _copilot_ensure_server
    command codex "$@"
}
