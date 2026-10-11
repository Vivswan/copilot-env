#!/bin/sh
# Sourced (never executed) by scripts/setup-env.sh and bin/agent, so the two cannot drift on
# which bun they use. Plain POSIX sh: bin/agent is `#!/bin/sh`.
#
# ensure_bun <repo-root> [quiet]
#   every message                        -> stderr: bin/agent's stdout is the text the `agent profile env`
#                                           wrapper evals
#   bun on PATH, older than .bun-version -> one warning, used anyway (upgrading is the user's job)
#   quiet non-empty                      -> no warning: the wrapper re-runs bin/agent for every
#                                           `agent profile env` refresh and must not repeat it
#   no bun at all                        -> the .bun-version release (the latest when the file is
#                                           absent), once, into $BUN_INSTALL/bin/bun

# The version of the bun executable $1 ("1.4.2" -> "1.4.2"), or empty when it does not run.
_copilot_env_bun_version() {
    "$1" --version 2>/dev/null | awk 'NR == 1 { print $1; exit }'
}

# An unparseable version never compares (exit 1), so it never warns.
_copilot_env_bun_older() {
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

ensure_bun() {
    _copilot_env_root="$1"
    _copilot_env_quiet="${2:-}"
    _copilot_env_bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
    # Absent on a checkout the platform sync has not written it to: no pin, the latest installs.
    _copilot_env_want=""
    if [ -f "${_copilot_env_root}/.bun-version" ]; then
        _copilot_env_want="$(tr -d '[:space:]' < "${_copilot_env_root}/.bun-version")"
    fi

    # `|| true`: under a caller's `set -e` (setup-env.sh) a bare failed
    # substitution would abort the shell before the install arm could run.
    _copilot_env_found="$(command -v bun 2>/dev/null || true)"
    if [ -z "${_copilot_env_found}" ] && [ -x "${_copilot_env_bun_bin}/bun" ]; then
        # An earlier one-time install the caller's PATH lost: put it back on.
        PATH="${_copilot_env_bun_bin}:$PATH"
        export PATH
        _copilot_env_found="${_copilot_env_bun_bin}/bun"
    fi
    if [ -n "${_copilot_env_found}" ]; then
        if [ -z "${_copilot_env_quiet}" ] && [ -n "${_copilot_env_want}" ]; then
            _copilot_env_have="$(_copilot_env_bun_version "${_copilot_env_found}")"
            if _copilot_env_bun_older "${_copilot_env_have}" "${_copilot_env_want}"; then
                echo "==> bun ${_copilot_env_have} is older than the tested ${_copilot_env_want} - continuing" >&2
            fi
        fi
        return 0
    fi

    echo "==> Installing bun ${_copilot_env_want:-(latest)} (one-time; none found on PATH) into ${_copilot_env_bun_bin}/bun ..." >&2
    # Run from a downloaded file, not `curl | bash`: a failed download then fails the install
    # instead of feeding bash an empty script. The official installer appends PATH lines to the
    # rc file of $SHELL (bash, zsh or fish) with no opt-out; under a shell it does not know it
    # prints them instead, so SHELL=sh keeps it out of rc files: PATH is bin/agent's and
    # shell/agents.bashrc's job. It needs curl, bash and unzip.
    set --
    [ -z "${_copilot_env_want}" ] || set -- "bun-v${_copilot_env_want}"
    _copilot_env_tmp="$(mktemp -d)" || return 1
    _copilot_env_rc=0
    {
        curl -fsSL -o "${_copilot_env_tmp}/install.sh" https://bun.sh/install &&
            SHELL="sh" bash "${_copilot_env_tmp}/install.sh" "$@"
    } >&2 || _copilot_env_rc=1
    rm -rf "${_copilot_env_tmp}"
    [ "${_copilot_env_rc}" -eq 0 ] || return 1
    # The installed file must itself run: a botched install fails loudly here.
    [ -n "$(_copilot_env_bun_version "${_copilot_env_bun_bin}/bun")" ] || return 1
    PATH="${_copilot_env_bun_bin}:$PATH"
    export PATH
}
