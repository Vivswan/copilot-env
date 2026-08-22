#!/usr/bin/env bash
# Lint the project's shell scripts with shellcheck. No-op (with a hint) when the
# tool is not installed, so commits don't break on machines without it.
# --severity=warning ignores style/info nitpicks and gates only on warnings+errors.
#
# The file list is DISCOVERED, never hand-maintained: an enumerated list silently
# stops covering a script the moment someone adds one.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v shellcheck >/dev/null 2>&1; then
    echo "shellcheck not installed -- skipping shell lint." >&2
    echo "  Install: brew install shellcheck  |  apt-get install shellcheck" >&2
    exit 0
fi

# Every *.sh and *.bashrc in the tree, plus the extensionless `bin/agent` launcher.
targets() {
    find . -type f \( -name '*.sh' -o -name '*.bashrc' \) \
        -not -path './node_modules/*' -not -path './.git/*' -not -path './.claude/*' \
        -not -path './.husky/_/*' -print
    printf '%s\n' ./bin/agent
}

targets | sort | xargs shellcheck --severity=warning
echo "shellcheck: OK"
