# Opt-in agent launchers -- source this AFTER agents.bashrc to enable the
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
# Resolve the repo root from THIS file's location (it lives in shell/, so the
# checkout root is its parent -- bin/agent lives there). Always assigned, exactly
# like agents.bashrc: re-sourcing the launchers from a different checkout must
# repoint them (and the shared `agent` function), never keep a stale dir from a
# previously sourced integration. The ${(%):-%x} fallback is zsh's equivalent
# of $BASH_SOURCE.
# shellcheck disable=SC2296
_COPILOT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"

# Ensure the proxy is up before launching a proxy-backed agent. Delegates to the shared
# resolver (src/scripts/proxy-token.sh) WITHOUT `--yes`, so an unmanaged + down proxy
# prompts the user (the managed path starts it silently). stdout (the key) is discarded;
# only the prompt/start noise on stderr shows, and the exit code signals reachability -- so
# a caller that `|| return`s won't re-sync against a stale port or launch into a dead proxy.
function _copilot_ensure_server {
    "${_COPILOT_AGENTS_DIR}/src/scripts/proxy-token.sh" >/dev/null
}

# Error if an agent CLI is missing; installation is handled by install.sh.
function _copilot_require_cli {
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "'$1' is not installed. Run 'agent shell --clis' to install the agent CLIs." >&2
    return 1
}

# Sync the agent's provider wiring before launch. Reads the configured provider
# via `agent <name> --check` (no live probe -- provider auto-detection is done
# once by `agent init`, not on every launch). Exit-code contract
# (providerModeExitCode, src/{claude,codex}/config.ts): 0 = direct (the agent
# reads its own config), 2 = proxy/default (ensure the proxy + re-sync the
# port/token), else custom/foreign config we don't manage: don't touch it, just
# say so on stderr and let the caller launch with the user's own wiring.
# $1 = agent subcommand (claude|codex), $2 = launcher name for the message
# prefix (cl|cx), $3 = display name (Claude|Codex).
function _copilot_wire_provider {
    if "${_COPILOT_AGENTS_DIR}/bin/agent" "$1" --check >/dev/null 2>&1; then
        _copilot_provider_status=0
    else
        _copilot_provider_status=$?
    fi
    if [ "$_copilot_provider_status" -eq 2 ]; then
        unset _copilot_provider_status
        _copilot_ensure_server || return $?
        agent "$1" --proxy || return $?
    elif [ "$_copilot_provider_status" -eq 0 ]; then
        unset _copilot_provider_status
    else
        unset _copilot_provider_status
        echo "$2: $3 has a custom provider config (not managed by copilot-env); launching it as-is." >&2
    fi
}

# Prepare an EXPLICIT named profile for launch: never rewires it (the user picked it) --
# just ensures ITS proxy daemon when the profile is proxy-mode (exit 2 from `agent
# profile --check`, the store-driven probe; delegating to proxy-token.sh WITHOUT
# `--yes`, so a down daemon prompts like the default path). Exit 0 (direct) passes
# through; exit 1 (no such profile) aborts with the check's own message on stderr.
# $1 = profile name.
function _copilot_ensure_profile_server {
    if "${_COPILOT_AGENTS_DIR}/bin/agent" profile --check "$1" >/dev/null 2>&1; then
        _copilot_profile_status=0
    else
        _copilot_profile_status=$?
    fi
    if [ "$_copilot_profile_status" -eq 0 ]; then
        unset _copilot_profile_status
        return 0
    fi
    if [ "$_copilot_profile_status" -ne 2 ]; then
        unset _copilot_profile_status
        "${_COPILOT_AGENTS_DIR}/bin/agent" profile --check "$1" >&2
        return 1
    fi
    unset _copilot_profile_status
    "${_COPILOT_AGENTS_DIR}/src/scripts/proxy-token.sh" --profile "$1" >/dev/null
}

function cl {
    _copilot_require_cli claude || return 1
    # `cl --profile <name>` (leading args only): launch Claude under the named profile via
    # `claude --settings <profile file>`. The profile's wiring is honored as-is (no
    # auto-"fixing"); `agent profile --settings-for` re-syncs its baked proxy port and
    # prints the settings path. ANTHROPIC_BASE_URL is unset for the launch: the shell may
    # carry the DEFAULT proxy's URL (from `agent env`), which would override the profile's
    # own env block.
    if [ "${1-}" = "--profile" ] && [ -n "${2-}" ]; then
        _copilot_profile="$2"
        shift 2
        _copilot_ensure_profile_server "$_copilot_profile" || { unset _copilot_profile; return 1; }
        if ! _copilot_settings="$("${_COPILOT_AGENTS_DIR}/bin/agent" profile --settings-for "$_copilot_profile")"; then
            unset _copilot_profile _copilot_settings
            return 1
        fi
        unset _copilot_profile
        export CLAUDE_CODE_NO_FLICKER=1
        command env -u ANTHROPIC_BASE_URL claude --settings "$_copilot_settings" \
            --permission-mode auto --enable-auto-mode "$@"
        _copilot_status=$?
        unset _copilot_settings
        return "$_copilot_status"
    fi
    _copilot_wire_provider claude cl Claude || return $?
    export CLAUDE_CODE_NO_FLICKER=1
    command claude --permission-mode auto --enable-auto-mode "$@"
}

function co {
    _copilot_require_cli copilot || return 1
    command copilot --autopilot --enable-reasoning-summaries --experimental "$@"
}

function cx {
    _copilot_require_cli codex || return 1
    # `cx --profile <name>` (leading args only): launch Codex under its NATIVE profile.
    # Order matters: ensure the profile's daemon FIRST (a cold start may move its port),
    # THEN `agent profile --sync` so the baked base_url tracks the port the daemon
    # actually bound before codex launches.
    if [ "${1-}" = "--profile" ] && [ -n "${2-}" ]; then
        _copilot_profile="$2"
        shift 2
        _copilot_ensure_profile_server "$_copilot_profile" || { unset _copilot_profile; return 1; }
        if ! "${_COPILOT_AGENTS_DIR}/bin/agent" profile --sync >/dev/null 2>&1; then
            echo "cx: could not refresh the profile wiring; launching with the existing config (run 'agent profile --sync' to see why)." >&2
        fi
        _copilot_name="$_copilot_profile"
        unset _copilot_profile
        command codex --profile "$_copilot_name" "$@"
        _copilot_status=$?
        unset _copilot_name
        return "$_copilot_status"
    fi
    _copilot_wire_provider codex cx Codex || return $?
    command codex "$@"
}


# More-permissive variants: same provider wiring as cl/co/cx, plus each agent's
# most-relaxed flag (Claude skips permission prompts; Copilot allows all; Codex
# opens a full-access sandbox). Delegate to the base launcher so the
# proxy/provider logic lives in one place. A leading `--profile <name>` is
# hoisted back to the FRONT of the delegated call (the base launchers only
# recognize it there); the relaxed flag rides behind it.
# Run in a subshell so the IS_SANDBOX export is reliably visible to the child
# claude process in both bash and zsh (zsh doesn't export a function-prefix
# assignment to external commands) without leaking into the user's shell.
function clx {
    if [ "${1-}" = "--profile" ] && [ -n "${2-}" ]; then
        _copilot_p="$2"
        shift 2
        ( export IS_SANDBOX=1; cl --profile "$_copilot_p" --dangerously-skip-permissions "$@" )
        _copilot_s=$?
        unset _copilot_p
        return "$_copilot_s"
    fi
    ( export IS_SANDBOX=1; cl --dangerously-skip-permissions "$@" )
}
function cox { co --allow-all "$@"; }
function cxx {
    if [ "${1-}" = "--profile" ] && [ -n "${2-}" ]; then
        _copilot_p="$2"
        shift 2
        cx --profile "$_copilot_p" --sandbox danger-full-access "$@"
        _copilot_s=$?
        unset _copilot_p
        return "$_copilot_s"
    fi
    cx --sandbox danger-full-access "$@"
}
