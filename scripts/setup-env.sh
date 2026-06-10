#!/usr/bin/env bash
# Initialize a copilot-env environment (or a freshly-created git worktree):
# install the pinned project dependencies so `bun run typecheck` / `bun test` /
# `biome` work immediately. Idempotent -- safe to re-run.
#
# This is the single source of truth for "init the env", called by every entry
# point so they can't drift:
#   - .github/workflows/copilot-setup-steps.yml  (GitHub Copilot coding agent)
#   - .devcontainer/devcontainer.json            (Codespaces / Dev Containers)
#   - .claude/settings.json SessionStart hook    (Claude Code worktrees)
#   - Codex Cloud: point its environment setup script here
#   - humans / a fresh `git worktree add`
#
# bun + deps only -- it does NOT install the agent CLIs or start the proxy.
set -eu

# Run from the repo root regardless of where we're invoked (e.g. a worktree).
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun is required but not found. Install it from https://bun.sh," >&2
    echo "       then re-run scripts/setup-env.sh." >&2
    exit 1
fi

echo "Initializing copilot-env: bun install --frozen-lockfile ..."
bun install --frozen-lockfile
echo "Done. Try: bun run typecheck && bun run lint && bun test"
