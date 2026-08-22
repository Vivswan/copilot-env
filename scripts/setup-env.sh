#!/usr/bin/env bash
# Initialize a copilot-env environment (or a freshly-created git worktree):
# install the pinned deno toolchain (version from .dvmrc) and the locked
# project dependencies so `deno task typecheck` / `deno task test` /
# `deno task lint` work immediately. Idempotent -- safe to re-run.
#
# This is the single source of truth for "init the env", called by every entry
# point so they can't drift:
#   - .github/workflows/copilot-setup-steps.yml  (GitHub Copilot coding agent)
#   - .devcontainer/devcontainer.json            (Codespaces / Dev Containers)
#   - humans / a fresh `git worktree add`
#
# deno + deps only -- it does NOT install the agent CLIs or start the proxy.
set -eu

# Run from the repo root regardless of where we're invoked (e.g. a worktree).
cd "$(dirname "$0")/.."

# The deno bootstrap is shared with bin/agent so the two can't drift.
# shellcheck source=ensure-deno.sh
. "$(dirname "$0")/ensure-deno.sh"
ensure_deno "$PWD"

echo "Initializing copilot-env: deno install --frozen ..."
deno install --frozen

# Wire the checked-in git hooks (.githooks/pre-commit, the deno-native gate).
# Idempotent; a relative hooksPath resolves against each worktree's root.
git config core.hooksPath .githooks

echo "Done. Try: deno task typecheck && deno task lint && deno task test"
