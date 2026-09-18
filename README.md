# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE.md)

Point the Codex and Claude CLIs at GitHub Copilot: through a local [`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api) proxy that copilot-env manages, or straight to Copilot Direct.

TypeScript port of the original Python `copilot-api` helper. Runs on Linux, macOS, and Windows.

## What it does

- **Codex + Claude wiring**: both CLIs point at the proxy or at Copilot Direct, with `~/.codex` / `~/.claude` written for you.
- **Lifecycle**: `start` / `stop` the proxy yourself, or let `daemon.auto-start` run it on demand and stop it when idle.
- **Zero setup**: one self-contained binary, no runtime or package manager first. The proxy is fetched on first use, never installed globally.
- **One credential per setup**: `agent profile auth` holds the GitHub Copilot token (device flow, `gh` CLI, or a stored PAT), plus one slot per profile.
- **Named profiles**: `agent profile` bundles one credential and one mode into both agents, so several sessions run at once.
- **Typed preferences**: `agent config` gets and sets every knob under one precedence rule everywhere.
- **Web search on Direct**: Claude Code's builtin WebSearch is replaced by copilot-env's MCP `web_search` tool.
- **Cost reporting**: estimated spend from the proxy usage DBs plus the Codex and Claude session logs.
- **Controlled floating**: the proxy floats to the newest cooldown-aged release; every other dependency is pinned via `deno.lock`.

## Requirements

- A GitHub account with Copilot access. `agent profile auth` stores the credential: device flow, your `gh` login, or a token.
- Linux, macOS, or Windows. Nothing else first: the install is one self-contained binary.
- The Claude and Codex CLIs, or let `agent shell --clis` install them.

## Quick start

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows (runs from any shell -- cmd, PowerShell, or the Run dialog)
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex"
```

Then, in a new shell:

```bash
agent shell --clis   # install the Claude, Codex, and Copilot CLIs (the add probes Direct through them, or at the endpoint without them)
agent profile add    # wire Codex + Claude to GitHub Copilot
agent start          # run the local proxy (only if the add picked it)
```

Install from a release, not `main`. Why, the flags, a pinned version, and what the installer writes are on the [getting started page](docs/getting-started.md#install).

## Documentation

- [Docs index](docs/README.md) - the pages by task ("I want to...")
- [Getting started](docs/getting-started.md) - install and its flags, the first `agent profile add` and the two modes, updating, verifying a download, uninstall
- [Usage](docs/usage.md) - every command, shell integration and the launchers, the managed proxy lifecycle, web search for Claude Code, cost reporting
- [Configuration](docs/configuration.md) - every `agent config` key with its default, the proxy-side keys, the Codex model catalog, per-host `CODEX_HOME`, Claude Desktop, environment overrides
- [Authentication](docs/authentication.md) - the credential providers, PAT passthrough, static key, profiles
- [Development](docs/development.md) - running from a checkout, the tasks, the env init, where the rules live

## Development

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh
deno task test
```

[Development](docs/development.md) covers the tasks and the env init; [CONTRIBUTING.md](CONTRIBUTING.md) covers how to submit a change; [AGENTS.md](AGENTS.md) holds the rules.

## License

[MIT](./LICENSE.md)
