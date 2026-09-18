---
title: Development
group: Internals
order: 6
---

# Development

How to drive the CLI from a checkout and where the repository's own rules live. Users install a release instead ([getting started](getting-started.md#install)); `agent update` refuses to overwrite a checkout unless you pass `--force`.

Deps install into the checkout (`deno install --frozen`); the proxy floats into the copilot-env data home on the first `agent start`, the same as a release.

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (deno install --frozen)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

- **Tasks:** run `deno task` for the list (typecheck, test, bench, lint, check). They are defined in `deno.json`.
- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single initializer. The Copilot coding agent and Codespaces / Dev Containers both run it.
- **Checks before a push:** the tasks and the pre-commit hook are listed in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Rules and decisions:** the conventions, the hard rules, and the decisions a reader would otherwise reverse (the proxy float, one credential, atomic profiles) live in [`AGENTS.md`](../AGENTS.md).
- **Layering:** the layers, the edges they draw, and the decisions as diagrams are on the [architecture page](architecture.md); `architecture.json` declares the edges and `deno task test` fails on any import it does not declare.

## Test fakes

Two loopback fakes let the suite and CI run with no Copilot credential and no network:

| Fake                          | Stands in for                                                                                                          | Used by                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `test/copilot-api-fake.mjs`   | the copilot-api daemon: its admin routes and the `Listening on:` marker                                                | the start/stop lifecycle smoke (`COPILOT_API_ENTRY`) |
| `test/fake_model_endpoint.ts` | the model endpoint: Anthropic Messages, OpenAI Responses and chat completions (streaming and not), Copilot's `/models` | the Direct smoke test, the real-CLI tests            |

### The fake model endpoint

[aimock](https://github.com/CopilotKit/aimock) (`npm:@copilotkit/aimock`, pinned in `deno.json`, zero runtime deps) behind a thin front. aimock's request and stream shapes are validated daily against the real vendors by its own drift job (the `test-drift.yml` workflow in CopilotKit/aimock).

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

`test/claude_cli_live.test.ts` and `test/codex_cli_live.test.ts` run the installed CLIs with the Direct probe's own argv against the fake, in a scratch HOME, and pin the output shapes our probe and health checks parse. On a machine without a binary they skip; CI installs both through `.github/actions/install-agent-clis` and sets `COPILOT_ENV_LIVE_CLIS=1`, which turns a missing binary into a failure.

The nightly runs through repo-platform's fleet nightly module (`nightly` in `.repo-platform.yml`; the repo-owned `.github/workflows/nightly.yml`). It installs the latest CLI releases and runs only those two files.

A red night opens or refreshes one `nightly-failure` issue naming the run; the next green night closes it. It gates no merge, but an open nightly issue blocks release-please releases until fixed or overridden (repo-platform docs/nightly.md, docs/tracking-issues.md).

What a red means: usually a claude or codex release changed the shape our probe parses; an install or `deno ci` failure reads red too. Read the run's `nightly-evidence` artifact (the CLI versions and the test log; present once the test step ran), then fix the parser or record the change.

- The header comment of `.github/workflows/nightly.yml` lists what each red step points at.
