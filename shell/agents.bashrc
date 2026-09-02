# Agent commands -- source this from your shell rc (~/.bashrc / ~/.zshrc).
# Must be compatible with both bash and zsh (only constructs both shells
# support; this is not plain POSIX sh).
#
# Pure runtime wiring: defines the `agent` lifecycle wrapper and exports the
# proxy env. Prerequisites and the agent CLIs are installed by install.sh --
# this file never installs anything.

# shellcheck shell=bash
# Resolve the repo root (this file lives in shell/, so the checkout root is its
# parent -- bin/agent lives there). Kept in the shell environment because the
# functions below reference it at call time. Both bash and zsh compatible; the
# ${(%):-%x} fallback is zsh's equivalent of $BASH_SOURCE.
# shellcheck disable=SC2296
_COPILOT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"

# Ensure deno is on PATH (its installer only patches ~/.zshrc by default). DENO_INSTALL is
# the same override scripts/ensure-deno.sh honors, so every entry point looks in one place.
_COPILOT_DENO_BIN="${DENO_INSTALL:-$HOME/.deno}/bin"
[ -x "${_COPILOT_DENO_BIN}/deno" ] && case ":$PATH:" in *":${_COPILOT_DENO_BIN}:"*) ;; *) export PATH="${_COPILOT_DENO_BIN}:$PATH" ;; esac
unset _COPILOT_DENO_BIN

# Uniform wrapper over bin/agent: run the requested command, then re-apply the
# full session env from the single source of truth -- `agent env`, which prints
# `export KEY=val` and `unset KEY` lines (CODEX_HOME + the proxy ANTHROPIC_BASE_URL,
# set or cleared) plus, when the `launchers` config key is on, the one-line
# cl/co/cx launcher functions (each delegating to `agent launch`). There is no
# per-subcommand logic: adding a bin/agent subcommand never touches this, and we
# only ever eval the dedicated, contract-stable `env` output (never a command's
# incidental stdout).
function agent {
    "${_COPILOT_AGENTS_DIR}/bin/agent" "$@" || return $?
    # Best-effort env refresh from the dedicated `env` command. Its stderr is NOT
    # silenced so a genuine failure is visible (it stays non-fatal: the `&&`
    # skips eval and the command's own exit status already returned above).
    _env="$("${_COPILOT_AGENTS_DIR}/bin/agent" env)" && eval "${_env}"
    unset _env
}

# Eagerly apply the managed env (CODEX_HOME + proxy ANTHROPIC_BASE_URL) for the
# current shell. Silence stderr so the bootstrap's informational output
# ("Installing copilot-env node_modules ...") doesn't break Powerlevel10k's
# instant-prompt guard on first source. If env resolution fails, a later
# `agent`/launcher call will surface the error. No arguments are forwarded --
# `env` takes none, and the ps1 twin's eager call passes none either.
eval "$("${_COPILOT_AGENTS_DIR}/bin/agent" env 2>/dev/null)"
