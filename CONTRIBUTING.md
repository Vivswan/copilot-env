# Contributing to copilot-env

Thanks for contributing! This document covers the conventions every change
in this repository goes through.

CI, settings, and standards files here (including this document above the
marker at the bottom) are managed by
[Vivswan/repo-platform](https://github.com/vivswan/repo-platform);
local edits to managed files are replaced on the next template sync.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title
  becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a
  [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/),
  for example `feat: add X` or `fix(parser): handle Y`. Releases are
  versioned from these subjects.

## CI

- CI gates on a single status check, `all-green`, which needs every
  gating CI job (the convention is documented in
  [repo-platform's all-green guide](https://github.com/vivswan/repo-platform/blob/main/docs/all-green.md)).
- Repository-specific checks live in `.github/workflows/checks.yml`; run
  the commands it lists locally before pushing.
- A typography gate enforces plain ASCII punctuation: no curly quotes,
  em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see
[SECURITY.md](SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the
[code of conduct](CODE_OF_CONDUCT.md).

<!-- Repository-specific contributing documentation (dev setup, build and
     test commands, review expectations) goes below this line. It survives
     template updates via three-way merge. -->
<!-- repo-platform:local-section -->

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
