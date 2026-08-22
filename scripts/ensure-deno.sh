#!/bin/sh
# The deno bootstrap, SOURCED (never executed) by scripts/setup-env.sh and bin/agent so
# the two cannot drift on which deno they install or where they look for it. Plain POSIX
# sh, because bin/agent is `#!/bin/sh`.
#
# Every message goes to stderr: bin/agent's stdout is the `export ...` text the `agent env`
# shell wrapper evals, and one stray line there breaks the caller's shell.
#
# ensure_deno <repo-root>: put the .dvmrc-pinned deno on PATH, installing it when it is
# missing OR when the deno already on PATH is a DIFFERENT version -- an unpinned local
# toolchain would otherwise silently diverge from CI. Returns non-zero when `deno` still
# does not resolve to the pin afterwards.

# The version of the `deno` currently on PATH ("deno 2.9.5 (stable, ...)" -> "2.9.5"),
# or empty when there is none.
_copilot_env_deno_current() {
    command -v deno >/dev/null 2>&1 || return 0
    deno --version 2>/dev/null | awk 'NR == 1 { print $2; exit }'
}

ensure_deno() {
    _copilot_env_root="$1"
    export DENO_NO_UPDATE_CHECK=1
    _copilot_env_want="$(tr -d '[:space:]' < "${_copilot_env_root}/.dvmrc")"
    # Where the official installer puts deno, and where an existing install already is.
    # Prepending it is what lets our pinned copy win over a system deno at another version.
    _copilot_env_deno_bin="${DENO_INSTALL:-$HOME/.deno}/bin"
    if [ -x "${_copilot_env_deno_bin}/deno" ]; then
        case ":$PATH:" in
            *":${_copilot_env_deno_bin}:"*) ;;
            *) PATH="${_copilot_env_deno_bin}:$PATH" ; export PATH ;;
        esac
    fi

    _copilot_env_have="$(_copilot_env_deno_current)"
    if [ "${_copilot_env_have}" = "${_copilot_env_want}" ]; then
        return 0
    fi
    if [ -n "${_copilot_env_have}" ]; then
        echo "==> deno ${_copilot_env_have} does not match the .dvmrc pin; installing v${_copilot_env_want} ..." >&2
    else
        echo "==> Installing deno v${_copilot_env_want} (one-time) ..." >&2
    fi
    # From a scratch directory, never the repo: the installer's own shell-setup step is a
    # `deno run jsr:...`, which would resolve the checkout's deno.json and die on its frozen
    # lockfile.
    _copilot_env_tmp="$(mktemp -d)" || return 1
    _copilot_env_rc=0
    (cd "${_copilot_env_tmp}" && curl -fsSL https://deno.land/install.sh | sh -s -- -y "v${_copilot_env_want}") >&2 || _copilot_env_rc=1
    rm -rf "${_copilot_env_tmp}"
    [ "${_copilot_env_rc}" -eq 0 ] || return 1
    PATH="${_copilot_env_deno_bin}:$PATH"
    export PATH
    # One attempt, then verify: a botched install fails loudly here rather than letting the
    # caller run on whatever version it happens to find.
    [ "$(_copilot_env_deno_current)" = "${_copilot_env_want}" ]
}
