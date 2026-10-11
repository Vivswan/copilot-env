#!/usr/bin/env bash
# The one env init, so its callers cannot drift; scripts/setup-env.ps1 is the Windows twin.
#   .github/workflows/copilot-setup-steps.yml  -> GitHub Copilot coding agent
#   .devcontainer/devcontainer.json            -> Codespaces / Dev Containers
#   a fresh `git worktree add`                 -> humans and agents
# bun + deps only: it never installs the agent CLIs or starts the proxy.
set -eu

cd "$(dirname "$0")/.."

# shellcheck source=ensure-bun.sh
. "$(dirname "$0")/ensure-bun.sh"
caller_path="$PATH"
ensure_bun "$PWD"

echo "Initializing copilot-env: bun install --frozen-lockfile ..."
bun install --frozen-lockfile

# A relative hooksPath resolves against each worktree's root.
git config core.hooksPath .githooks

echo "Done. Try: bun run typecheck && bun run lint && bun run test:unit"
# Advise only when the CALLER's PATH has no bun: this shell has already run bun, so bash's
# `command -v` would answer from its hash table, hence the fresh sh with the saved PATH.
bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
if ! PATH="${caller_path}" /bin/sh -c 'command -v bun' > /dev/null 2>&1; then
    echo "Note: put ${bun_bin} on PATH for new shells; this script does not edit shell rc files."
fi
