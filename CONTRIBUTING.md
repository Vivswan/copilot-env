# Contributing to copilot-env

Thanks for contributing. Setup and checks are here; the conventions are in [AGENTS.md](AGENTS.md).

## Pull requests

- Squash-merged: the PR title becomes the commit subject.
- Titles are [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat: add X`, `fix(parser): handle Y`. `feat:` and `fix:` release; other prefixes do not.
- CI gates on the `all-green` check. Run the checks below before pushing.
- Security problems go to [SECURITY.md](.github/SECURITY.md), never to an issue or PR.
- The account-wide [code of conduct](https://github.com/Vivswan/.github/blob/main/CODE_OF_CONDUCT.md) applies.

## Setup

```bash
git clone https://github.com/<your-fork>/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # scripts/setup-env.ps1 on Windows: deno, the locked deps, the git hooks
```

## Checks

```bash
deno task check       # lint --fix + fmt
deno task test
deno task typecheck
```

The full task list is in `deno.json`; the pre-commit hook in `.githooks/` runs the same checks.
