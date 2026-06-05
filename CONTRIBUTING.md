# Contributing to copilot-env

Thanks for your interest in improving copilot-env! This guide covers how to set up the project, run the checks, and submit a pull request.

## Prerequisites

- [bun](https://bun.sh) — runtime and test runner

## Setup

```bash
git clone https://github.com/<your-fork>/copilot-env.git
cd copilot-env
bun install
```

## Running checks

From the project directory:

```bash
bun test            # run the test suite
bun run typecheck   # tsc --noEmit
bun run lint        # biome format/lint check
bun run lint:shell  # shellcheck on shell scripts
bun run lint:ps     # PSScriptAnalyzer on PowerShell scripts
bun run format      # biome format --write
```

A husky pre-commit hook runs lint-staged (biome) + typecheck + `bun test` + shell/PowerShell lint, so most issues are caught before they land.

## Code style

Conventions live in [AGENTS.md](AGENTS.md) — please read it before contributing. In short:

- biome enforces formatting and linting (run `bun run format` / `bun run lint`).
- No `any` — biome's `noExplicitAny` is an error.

## Submitting a pull request

1. Fork the repo and create a branch for your change.
2. Make sure `bun test`, `bun run typecheck`, and `bun run lint` all pass.
3. Follow the conventions in [AGENTS.md](AGENTS.md).
4. Open a PR. Merges to `main` are squash-only — keep your PR description meaningful, since it becomes the squash commit message.

## Security

Please do not report security vulnerabilities through public issues. See [SECURITY.md](SECURITY.md) for how to disclose them responsibly.
