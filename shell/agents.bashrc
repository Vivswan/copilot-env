# Sourced from ~/.bashrc or ~/.zshrc, so every construct here must work in both bash and zsh.
# Runtime wiring only: install.sh owns installation, and this file never installs anything.

# shellcheck shell=bash
# Not unset afterwards: the functions below read it at call time. `${(%):-%x}` is zsh's
# $BASH_SOURCE.
# shellcheck disable=SC2296
_COPILOT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"

# DENO_INSTALL is the same override scripts/ensure-deno.sh honors, so every entry point
# looks in one place.
_COPILOT_DENO_BIN="${DENO_INSTALL:-$HOME/.deno}/bin"
if [ -x "${_COPILOT_DENO_BIN}/deno" ] && ! command -v deno > /dev/null 2>&1; then
    export PATH="${_COPILOT_DENO_BIN}:$PATH"
fi
unset _COPILOT_DENO_BIN

# `agent env` is the ONLY output this file ever evals (src/commands/env.ts owns what it
# prints), so a new subcommand never touches this wrapper.
function agent {
    "${_COPILOT_AGENTS_DIR}/bin/agent" "$@" || return $?
    # stderr stays unsilenced so a failed refresh is visible; the `&&` keeps it non-fatal.
    _env="$("${_COPILOT_AGENTS_DIR}/bin/agent" env)" && eval "${_env}"
    unset _env
}

# stderr is silenced here: bootstrap output on first source would trip Powerlevel10k's
# instant-prompt guard. A failed resolution surfaces on the next `agent` call instead.
eval "$("${_COPILOT_AGENTS_DIR}/bin/agent" env 2>/dev/null)"
