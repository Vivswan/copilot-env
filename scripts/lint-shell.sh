#!/usr/bin/env bash
# Lint the project's shell scripts with shellcheck. No-op (with a hint) when
# shellcheck is not installed, so commits don't break on machines without it.
# --severity=warning ignores style/info nitpicks and gates only on warnings+errors.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v shellcheck >/dev/null 2>&1; then
    echo "shellcheck not installed -- skipping shell lint." >&2
    echo "  Install: brew install shellcheck  |  apt-get install shellcheck" >&2
    exit 0
fi

shellcheck --severity=warning install.sh agents.bashrc bin/copilot-api bin/codex-home
echo "shellcheck: OK"
