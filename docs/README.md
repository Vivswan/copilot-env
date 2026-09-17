# copilot-env

copilot-env points the Codex and Claude CLIs at GitHub Copilot, either through a local `@jeffreycao/copilot-api` proxy it manages or straight to Copilot Direct. Everything it does is an `agent` subcommand or an `agent config` key, and these pages cover them by task.

## I want to...

| Goal                                                                        | Read                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Install on macOS, Linux, or Windows                                         | [Getting started: install](getting-started.md#install)                                   |
| Install a specific version, or change the install directory                 | [Getting started: install flags](getting-started.md#install-flags)                       |
| Understand Direct vs the proxy, and which one `agent init` picks            | [Getting started: the first `agent init`](getting-started.md#the-first-agent-init)       |
| Update, or check what `agent update` verifies                               | [Getting started: updating](getting-started.md#updating)                                 |
| Verify a downloaded binary against the release attestation                  | [Getting started: verifying a download](getting-started.md#verifying-a-download-by-hand) |
| Remove copilot-env from a machine                                           | [Getting started: uninstall](getting-started.md#uninstall)                               |
| Look up a command and its flags                                             | [Usage: commands](usage.md#commands)                                                     |
| Check a real launch end-to-end with `agent health --live`                   | [Usage: health checks](usage.md#health-checks)                                           |
| Get the `cl` / `co` / `cx` launchers, or their permissive variants          | [Usage: launchers](usage.md#launchers)                                                   |
| Let the proxy start on demand and stop when idle                            | [Usage: managed proxy lifecycle](usage.md#managed-proxy-lifecycle-auto-start)            |
| Give Claude Code web search on Direct, or register the MCP server elsewhere | [Usage: web search for Claude Code](usage.md#web-search-for-claude-code)                 |
| See what I spent, and what the usage index stores                           | [Usage: cost reporting](usage.md#cost-reporting)                                         |
| Look up any `agent config` key and its default                              | [Configuration](configuration.md)                                                        |
| Change a proxy-side setting and know when it applies                        | [Configuration: proxy features](configuration.md#proxy-features)                         |
| Give Codex Copilot's real context windows                                   | [Configuration: Codex model catalog](configuration.md#codex-model-catalog)               |
| Keep one `CODEX_HOME` per host                                              | [Configuration: per-host CODEX_HOME](configuration.md#per-host-codex_home)               |
| Wire Claude Desktop, or see which files it touches                          | [Configuration: Claude Desktop](configuration.md#claude-desktop)                         |
| Pin the proxy version or the cooldown with an env var                       | [Configuration: environment overrides](configuration.md#environment-overrides)           |
| Store the GitHub Copilot credential, or switch how it is obtained           | [Authentication: providers](authentication.md#providers)                                 |
| Use a personal access token with the proxy                                  | [Authentication: PAT passthrough](authentication.md#pat-passthrough)                     |
| See which Copilot client identity each host accepts, or pin one             | [Authentication: client identity](authentication.md#client-identity)                     |
| Bake the credential into one agent's config, or both                        | [Authentication: static key](authentication.md#static-key)                               |
| Run several sessions under different credentials or modes                   | [Authentication: profiles](authentication.md#profiles)                                   |
| Run the CLI from a checkout                                                 | [Development](development.md)                                                            |
| See how the code is layered, and which module imports which                 | [Architecture](architecture.md)                                                          |

## The pages

In reading order:

1. [Getting started](getting-started.md) - install and its flags, the first `agent init` and the two modes, updating, verifying a download, uninstall.
2. [Usage](usage.md) - every command, shell integration and the launchers, the managed proxy lifecycle, health checks, web search for Claude Code, cost reporting.
3. [Configuration](configuration.md) - every `agent config` key with its default, the proxy-side keys, the Codex model catalog, per-host `CODEX_HOME`, Claude Desktop, environment overrides.
4. [Authentication](authentication.md) - the credential providers, PAT passthrough, client identity, static key, profiles.
5. [Development](development.md) - running from a checkout, the tasks, the env init, where the rules live.
6. [Architecture](architecture.md) - the decisions as diagrams over real files, and the layer map the lint keeps equal to the import graph.
