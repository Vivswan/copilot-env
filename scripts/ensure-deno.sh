#!/bin/sh
# Sourced (never executed) by scripts/setup-env.sh and bin/agent, so the two cannot drift on
# which deno they use. Plain POSIX sh: bin/agent is `#!/bin/sh`.
#
# ensure_deno <repo-root> [quiet]
#   every message                    -> stderr: bin/agent's stdout is the text the `agent env`
#                                       wrapper evals
#   deno on PATH, older than .dvmrc  -> one warning, used anyway (upgrading is the user's job)
#   quiet non-empty                  -> no warning: the wrapper re-runs bin/agent for every
#                                       `agent env` refresh and must not repeat it
#   no deno at all                   -> the latest release, once, into $DENO_INSTALL

# The version of the deno executable $1 ("deno 2.9.5 (stable, ...)" -> "2.9.5"), or empty
# when it does not run.
_copilot_env_deno_version() {
    "$1" --version 2>/dev/null | awk 'NR == 1 { print $2; exit }'
}

# An unparseable version never compares (exit 1), so it never warns.
_copilot_env_deno_older() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        if (a !~ /^[0-9]+\.[0-9]+\.[0-9]+$/ || b !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1
        split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) {
            if (x[i] + 0 < y[i] + 0) exit 0
            if (x[i] + 0 > y[i] + 0) exit 1
        }
        exit 1
    }'
}

ensure_deno() {
    _copilot_env_root="$1"
    _copilot_env_quiet="${2:-}"
    export DENO_NO_UPDATE_CHECK=1
    _copilot_env_deno_bin="${DENO_INSTALL:-$HOME/.deno}/bin"

    # `|| true`: under a caller's `set -e` (setup-env.sh) a bare failed
    # substitution would abort the shell before the install arm could run.
    _copilot_env_found="$(command -v deno 2>/dev/null || true)"
    if [ -z "${_copilot_env_found}" ] && [ -x "${_copilot_env_deno_bin}/deno" ]; then
        # An earlier one-time install the caller's PATH lost: put it back on.
        PATH="${_copilot_env_deno_bin}:$PATH"
        export PATH
        _copilot_env_found="${_copilot_env_deno_bin}/deno"
    fi
    if [ -n "${_copilot_env_found}" ]; then
        if [ -z "${_copilot_env_quiet}" ]; then
            _copilot_env_have="$(_copilot_env_deno_version "${_copilot_env_found}")"
            _copilot_env_want="$(tr -d '[:space:]' < "${_copilot_env_root}/.dvmrc")"
            if _copilot_env_deno_older "${_copilot_env_have}" "${_copilot_env_want}"; then
                echo "==> deno ${_copilot_env_have} is older than the tested ${_copilot_env_want} - continuing" >&2
            fi
        fi
        return 0
    fi

    echo "==> Installing the latest deno (one-time; none found on PATH) ..." >&2
    # Run from a downloaded file, not `curl | sh`: a failed download then fails the install
    # instead of feeding sh an empty script. CI=1 turns off the official installer's rc-file
    # edits (~/.zshrc, ~/.bashrc, ~/.profile) and its tty prompt; PATH is bin/agent's and
    # shell/agents.bashrc's job.
    _copilot_env_tmp="$(mktemp -d)" || return 1
    _copilot_env_rc=0
    {
        curl -fsSL -o "${_copilot_env_tmp}/install.sh" https://deno.land/install.sh &&
            CI=1 sh "${_copilot_env_tmp}/install.sh"
    } >&2 || _copilot_env_rc=1
    rm -rf "${_copilot_env_tmp}"
    [ "${_copilot_env_rc}" -eq 0 ] || return 1
    # The installed file must itself run: a botched install fails loudly here.
    [ -n "$(_copilot_env_deno_version "${_copilot_env_deno_bin}/deno")" ] || return 1
    PATH="${_copilot_env_deno_bin}:$PATH"
    export PATH
}
