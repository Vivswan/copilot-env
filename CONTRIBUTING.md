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

The full task list is in `deno.json`. The pre-commit hook runs `typecheck`, `test`, and `lint`, deno's own checks. CI's `check` job adds `lint:sh` and `lint:ps`, which need shellcheck and PSScriptAnalyzer installed.

`release-gate.yml` holds only the checks required before a release that run nowhere on a PR or a push to main. Its one job, `release-assets`, is the five-target build with checksums, the release-assets prepare and validate with the installer syntax checks, and the asset presence with the host `--help`; `ci.yml` runs it on the release PR and a dispatch, `nightly.yml` every night. Every other check runs on every PR.
