#!/usr/bin/env bash
# The one env init, so its callers cannot drift; scripts/setup-env.ps1 is the Windows twin.
#   .github/workflows/copilot-setup-steps.yml  -> GitHub Copilot coding agent
#   .devcontainer/devcontainer.json            -> Codespaces / Dev Containers
#   a fresh `git worktree add`                 -> humans and agents
# deno + deps only: it never installs the agent CLIs or starts the proxy.
set -eu

cd "$(dirname "$0")/.."

# shellcheck source=ensure-deno.sh
. "$(dirname "$0")/ensure-deno.sh"
caller_path="$PATH"
ensure_deno "$PWD"

echo "Initializing copilot-env: deno install --frozen ..."
deno install --frozen

# A relative hooksPath resolves against each worktree's root.
git config core.hooksPath .githooks

echo "Done. Try: deno task typecheck && deno task lint && deno task test"
# Advise only when the CALLER's PATH has no deno: this shell has already run deno, so bash's
# `command -v` would answer from its hash table, hence the fresh sh with the saved PATH.
deno_bin="${DENO_INSTALL:-$HOME/.deno}/bin"
if ! PATH="${caller_path}" /bin/sh -c 'command -v deno' > /dev/null 2>&1; then
    echo "Note: put ${deno_bin} on PATH for new shells; this script does not edit shell rc files."
fi
