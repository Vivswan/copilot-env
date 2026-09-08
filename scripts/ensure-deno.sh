#!/bin/sh
# The deno bootstrap, SOURCED (never executed) by scripts/setup-env.sh and bin/agent so
# the two cannot drift on which deno they install or where they look for it. Plain POSIX
# sh, because bin/agent is `#!/bin/sh`.
#
# Every message goes to stderr: bin/agent's stdout is the `export ...` text the `agent env`
# shell wrapper evals, and one stray line there breaks the caller's shell.
#
# ensure_deno <repo-root>: make `deno` resolve to the .dvmrc-pinned copy under
# $DENO_INSTALL (default ~/.deno), installing it there when it is missing or at another
# version -- an unpinned local toolchain would otherwise silently diverge from CI. Only the
# pinned copy is ever version-checked: a homebrew/scoop deno earlier on PATH is not a
# reason to reinstall, it is a reason to put the pinned copy ahead of it. Returns non-zero
# when `deno` still does not resolve to the pin afterwards.

# The version of the deno executable $1 ("deno 2.9.5 (stable, ...)" -> "2.9.5"), or empty
# when it does not run.
_copilot_env_deno_version() {
    "$1" --version 2>/dev/null | awk 'NR == 1 { print $2; exit }'
}

ensure_deno() {
    _copilot_env_root="$1"
    export DENO_NO_UPDATE_CHECK=1
    _copilot_env_want="$(tr -d '[:space:]' < "${_copilot_env_root}/.dvmrc")"
    # Where the official installer puts deno, and where an existing install already is.
    _copilot_env_deno_bin="${DENO_INSTALL:-$HOME/.deno}/bin"
    _copilot_env_pinned="${_copilot_env_deno_bin}/deno"

    _copilot_env_have="$(_copilot_env_deno_version "${_copilot_env_pinned}")"
    if [ "${_copilot_env_have}" != "${_copilot_env_want}" ]; then
        if [ -n "${_copilot_env_have}" ]; then
            echo "==> deno ${_copilot_env_have} at ${_copilot_env_pinned} does not match the .dvmrc pin; installing v${_copilot_env_want} ..." >&2
        else
            echo "==> Installing deno v${_copilot_env_want} (one-time) ..." >&2
        fi
        # Downloaded to a private scratch directory and run from the file, so a failed
        # download fails the install instead of feeding sh an empty script (exit 0). CI=1 is
        # the installer's switch for its shell-setup step, which edits ~/.zshrc, ~/.bashrc,
        # and ~/.profile (and prompts on a tty without -y). PATH is our job: bin/agent and
        # shell/agents.bashrc put the pinned copy on PATH themselves.
        _copilot_env_tmp="$(mktemp -d)" || return 1
        _copilot_env_rc=0
        {
            curl -fsSL -o "${_copilot_env_tmp}/install.sh" https://deno.land/install.sh &&
                CI=1 sh "${_copilot_env_tmp}/install.sh" "v${_copilot_env_want}"
        } >&2 || _copilot_env_rc=1
        rm -rf "${_copilot_env_tmp}"
        [ "${_copilot_env_rc}" -eq 0 ] || return 1
        # One attempt, then verify the pinned file itself: a botched install fails loudly
        # here rather than letting the caller run on whatever version it happens to find.
        [ "$(_copilot_env_deno_version "${_copilot_env_pinned}")" = "${_copilot_env_want}" ] || return 1
    fi

    # Prepend, not "add if absent": the pinned copy must WIN, and PATH may already list its
    # directory behind another deno (codex, for one, pushes /opt/homebrew/bin to the front).
    if [ "$(command -v deno 2>/dev/null)" != "${_copilot_env_pinned}" ]; then
        PATH="${_copilot_env_deno_bin}:$PATH"
        export PATH
    fi
}
