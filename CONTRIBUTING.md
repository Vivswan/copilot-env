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
bash scripts/setup-env.sh   # scripts/setup-env.ps1 on Windows: the locked deps and the git hooks
```

The toolchain (Bun, which the CLI, the tests, and the proxy daemon all run on) is described on the [development page](docs/development.md).

## Checks

```bash
bun run check       # lint, typecheck, the unit tests, knip: what the pre-commit hook runs, plus knip
bun run test:unit   # the unit tests alone; or one file: bun run test:unit test/usage/usage.test.ts
bun run typecheck
```

The full script list is in `package.json` (`bun run` with no name prints it). The pre-commit hook runs `typecheck`, `lint`, and `test:unit`.

The `*.e2e.test.ts` files (a process, a listener, a home-shaped sandbox, a real CLI) run in CI, where `bun run test` runs the whole suite; `bun run test --e2e` runs them on a developer machine ([development page](docs/development.md#unit-tests-and-e2e-tests)). CI's `check` job adds `lint:sh` and `lint:ps`, which need shellcheck and PSScriptAnalyzer installed.

`release-gate.yml` holds only the checks required before a release that run nowhere on a PR or a push to main. Its one job, `release-assets`, is the five-target build with checksums, the release-assets prepare and validate with the installer syntax checks, and the asset presence with the host `--help`; `ci.yml` runs it on the release PR and a dispatch, `nightly.yml` every night. Every other check runs on every PR.
