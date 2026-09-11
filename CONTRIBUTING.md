# Contributing to copilot-env

Thanks for contributing. This page has the local setup and the checks; the conventions are in [AGENTS.md](AGENTS.md).

## Pull requests

- Changes land through pull requests and are squash-merged, so the PR title becomes the commit subject.
- Titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`feat: add X`, `fix(parser): handle Y`); `feat:` and `fix:` release, other prefixes do not.
- CI gates on the `all-green` check: every job in `.github/workflows/checks.yml` and the fleet's checks must pass. Run the commands below before pushing.
- Security problems are never reported in issues or PRs: see [SECURITY.md](.github/SECURITY.md). Participation follows the account-wide [code of conduct](https://github.com/Vivswan/.github/blob/main/CODE_OF_CONDUCT.md).

## Prerequisites

- [deno](https://deno.com) - runtime, test runner, formatter, and linter

## Setup

```bash
git clone https://github.com/<your-fork>/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # scripts/setup-env.ps1 on Windows: deno if none is installed, the locked deps, the git hooks
```

## Running checks

From the project directory:

```bash
deno task test        # run the test suite
deno task test:docker # the same suite in a container (hermetic HOME)
deno task typecheck   # deno check
deno task lint        # deno lint + deno fmt --check
deno task lint:sh     # shellcheck on shell scripts
deno task lint:ps     # PSScriptAnalyzer on PowerShell scripts
deno task check       # deno lint --fix + deno fmt (auto-fix)
```

The checked-in pre-commit hook (`.githooks/pre-commit`, wired by `scripts/setup-env.sh`) runs staged-file lint/format + typecheck + `deno task test` + repo-wide lint + shell/PowerShell lint, so most issues are caught before they land.

## Code style

Conventions live in [AGENTS.md](AGENTS.md) - please read it before contributing. In short:

- deno enforces formatting and linting (run `deno task check` / `deno task lint`).
- No `any` - deno lint's `no-explicit-any` is an error.
