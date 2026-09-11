
## Prerequisites

- [deno](https://deno.com) - runtime, test runner, formatter, and linter

## Setup

```bash
git clone https://github.com/<your-fork>/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # scripts/setup-env.ps1 on Windows; installs the pinned deno and the locked deps
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
