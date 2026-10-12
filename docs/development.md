---
title: Development
group: Internals
order: 6
---

# Development

How to drive the CLI from a checkout and where the repository's own rules live. Users install a release instead ([getting started](getting-started.md#install)); `agent update` refuses to overwrite a checkout unless you pass `--force`.

Deps install into the checkout (`bun install --frozen-lockfile`); the proxy floats into the copilot-env data home on the first `agent start`, the same as a release.

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (bun install --frozen-lockfile, the git hooks)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

- **Tasks:** run `bun run` for the list (typecheck, test, bench, lint, check). They are the `scripts` of `package.json`; the toolchain is Bun at the version in `.bun-version`.
- **Tests:** `bun run test` is `scripts/run_tests.ts`, which runs one bun process per test file. Name files to run a subset: `bun run test test/usage/usage.test.ts`. `bun run test:unit` runs the unit files alone ([below](#unit-tests-and-e2e-tests)).
- **A stalled test:** every body runs under a per-test deadline, 15 s by default (`test/helpers/testing.ts`); a body that may stall marks `step("...")` before each await or spawn, and the deadline error then names the step it was in and how long each earlier step took.
- **The daemon:** the proxy daemon runs on the same bun as the CLI: a checkout spawns the `bun` it runs under, a release spawns its own binary as a bun CLI (`BUN_BE_BUN=1`). Nothing else is downloaded; the float installs the proxy with `bun install` into the data home.
- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single initializer. The Copilot coding agent and Codespaces / Dev Containers both run it.
- **Checks before a push:** the tasks and the pre-commit hook are listed in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Rules and decisions:** the conventions, the hard rules, and the decisions a reader would otherwise reverse (the proxy float, one credential, atomic profiles) live in [`AGENTS.md`](../AGENTS.md).
- **Layering:** the layers, the edges they draw, and the decisions as diagrams are on the [architecture page](architecture.md); `architecture.json` declares the edges and `bun run test` fails on any import it does not declare.

## Unit tests and e2e tests

A test file is one of two kinds, told apart by its name:

- `<name>.test.ts` is a unit test: it runs in this process and touches nothing outside the suite's temp root. `bun run test:unit` runs these, and so does the pre-commit hook.
- `<name>.e2e.test.ts` is a realistic test: it spawns a process (the CLI, the daemon, bun, biome), opens a listener, sets up a home-shaped sandbox (`isolateAgentHomes` or `agentHomeEnv` from `test/helpers/env.ts`), or needs a real CLI, the proxy, or the network. A file with both kinds of tests is e2e. CI runs these; `bun run test` runs both kinds.

The launcher refuses to run an `*.e2e.test.ts` file unless `GITHUB_ACTIONS=true` or `CI=true` is set or `--e2e` is passed. The refusal is one line on stderr, exit 2, naming the count of e2e files selected, the two markers, the flag, and `bun run test:unit`. A file named outright obeys the same rule, and must match `**/*.test.ts` at all: any other name is refused rather than handed to `bun test` unexamined.

The refusal answers an incident. Bun resolves `os.homedir()` once at startup, so a HOME the test helpers retarget inside a test never reaches the paths derived from it, and one run of the realistic files under a developer's own HOME rewrote the real Claude and Codex configs.

Two guards keep it from recurring. The launcher starts every test file under a scratch HOME (or the one `COPILOT_ENV_TEST_HOME` names) and sets `COPILOT_ENV_TEST_HOME` to it. `test/helpers/home_guard.ts`, loaded before every test file, refuses a file whose HOME that variable does not name, so a bare `bun test <file>` is refused with the launcher command to use instead.

The boundary is linted by `biome/no_e2e_helper_imports.grit` over every `.ts` file under `test/` except the `*.e2e.test.ts` files, the banned helpers themselves, and `testing.ts` (it imports nothing banned, and the child-spawn rule's scope fixture pins its finding count), so a helper that re-exports a banned one is flagged as it is written. The fix for a finding is the rename to `.e2e.test.ts`. A file in scope may not:

- import a banned helper: `run.ts`, `daemon.ts`, `mcp.ts`, `scratch_home.ts`, `fake_codex.ts`, `fake_endpoint.ts`, `fake_model_endpoint.ts`, `net.ts`, `biome_plugin.ts`, `usage_goldens.ts` (the files that spawn, listen, or point HOME somewhere, closed under import)
- import `node:child_process` or a listener module (`node:net`, `http`, `https`, `http2`, `dgram`)
- reach `Bun.spawn`, `spawnSync`, `serve`, `listen`, or `connect`, under any spelling, or import any value from the `bun` module (its `$` shell spawns too)
- reach `isolateAgentHomes` or `agentHomeEnv` from `env.ts`, or use `require`

## Test fakes

Two loopback fakes let the suite and CI run with no Copilot credential and no network:

| Fake                                  | Stands in for                                                                                                          | Used by                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `test/copilot-api-fake.mjs`           | the copilot-api daemon: its admin routes and the `Listening on:` marker                                                | the start/stop lifecycle smoke (`COPILOT_API_ENTRY`) |
| `test/helpers/fake_model_endpoint.ts` | the model endpoint: Anthropic Messages, OpenAI Responses and chat completions (streaming and not), Copilot's `/models` | the Direct smoke test, the real-CLI tests            |

### The fake model endpoint

[aimock](https://github.com/CopilotKit/aimock) (`@copilotkit/aimock`, pinned in `package.json`, zero runtime deps) behind a thin front. aimock's request and stream shapes are validated daily against the real vendors by its own drift job (the `test-drift.yml` workflow in CopilotKit/aimock).

The front serves the one route aimock lacks in Copilot's shape, the root `/models` catalog with the picker fields both smoke pickers read, and proxies everything else byte for byte. The real `claude` and `codex` binaries talk to it over `ANTHROPIC_BASE_URL` / a Codex provider `base_url`.

A scenario selects one request's reply through the header aimock matches exactly, `X-AIMock-Context: <name>`; claude forwards it from `ANTHROPIC_CUSTOM_HEADERS`, codex from `model_providers.<id>.http_headers`. The table lives in `test/helpers/fake_endpoint.ts`:

| Scenario                     | Reply                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `ok`                         | the text `OK`                                                                               |
| `unauthorized`               | 401 in the wire's own error envelope                                                        |
| `model-not-found`            | 404, the vendor's unknown-model rejection                                                   |
| `tier-rejected`              | 400 `service_tier is not supported`, Copilot's answer to a Codex tier it does not take      |
| `truncate-after-first-delta` | the connection drops right after the first content delta of a codex-shaped Responses stream |
| (none)                       | a default line                                                                              |

Facts the tests rest on, verified against the installed releases:

- claude never calls `/v1/messages/count_tokens` in `--print` mode, and tolerates a 404 on its `HEAD /api/hello` reachability probe.
- Both CLIs retry 429 and 5xx with backoff; claude also retries 401 (10 attempts, about 3 minutes), so an auth failure on Direct ends at the probe's own timeout.
- A connection dropped mid-stream: codex reconnects five times within seconds and fails the turn (exercised); claude reads it as a connection error it retries 10 times (about 6 minutes) before re-asking without streaming (recorded, never exercised: no test may take that long).
- aimock's `truncateAfterChunks` counts SSE frames from the first one, prelude included; its journal (`GET /__aimock/journal`) redacts credential header values, so a test asserts their presence there and their value only on the catalog request the front journals in full.

### Real CLIs against the fake

`test/health/claude_cli_live.e2e.test.ts` and `test/health/codex_cli_live.e2e.test.ts` run the installed CLIs with the Direct probe's own argv against the fake, in a scratch HOME, and pin the output shapes our probe and health checks parse. On a machine without a binary they skip; CI installs both through `.github/actions/install-agent-clis` and sets `COPILOT_ENV_LIVE_CLIS=1`, which turns a missing binary into a failure.

The nightly runs through repo-platform's fleet nightly module (`nightly` in `.repo-platform.yml`; the repo-owned `.github/workflows/nightly.yml`). Its `checks` job installs the latest CLI releases and runs only those two files; its `release-gate` job runs the release gate below.

A red night opens or refreshes one `nightly-failure` issue naming the run; the next green night closes it. It gates no merge, but an open nightly issue blocks release-please releases until fixed or overridden (repo-platform docs/nightly.md, docs/tracking-issues.md).

What a red means: usually a claude or codex release changed the shape our probe parses; an install or `bun install` failure reads red too. Read the run's `nightly-evidence` artifact (the CLI versions and the test log; present once the test step ran), then fix the parser or record the change.

- The header comment of `.github/workflows/nightly.yml` lists what each red job points at.

### The release gate

`.github/workflows/release-gate.yml` holds the checks required before a release that run nowhere on a PR or a push to main. Its one job, `release-assets`, runs the build and validation that `update-release.yml` otherwise first runs after the tag exists:

- the five-target cross-compile with `dist/checksums.txt` verified
- the release-assets prepare and validate against a synthetic tag (`.github/scripts/release-assets.ts`), with the installers' syntax checks
- every asset proven present at a real size, and the host's binary run with `--help`

The managed `ci.yml` calls it on the release-please PR and on a dispatch, where `all-green` blocks on it; `nightly.yml` calls it on the schedule. `checks.yml` is what every PR runs and never calls it.
