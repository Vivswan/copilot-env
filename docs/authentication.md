---
title: Authentication
group: Reference
order: 4
---

# Authentication

`agent auth` is the credential front door: one GitHub Copilot credential, resolved at fetch time. Agent configs never store a copy, and `gh-cli` holds no token of its own; `static-key` ([below](#static-key)) is the one opt-out.

This page is about the credential and the profiles that carry one each. The wiring commands that ask for a credential are on the [getting started page](getting-started.md#the-first-agent-init).

## Providers

| `--provider` | Where the credential comes from                                               |
| ------------ | ----------------------------------------------------------------------------- |
| `copilot`    | GitHub device flow (`read:user` scope)                                        |
| `gh-cli`     | the machine's existing `gh` login, pinned to one account at auth time (below) |
| `gh-token`   | paste a GitHub token; `--set <token>` stores one non-interactively            |
| `gh-env`     | copy a token from `$COPILOT_GITHUB_TOKEN` / `$GH_TOKEN` / `$GITHUB_TOKEN`     |

- `gh-cli` pins an account when you run `agent auth`: `--gh-user <login>` names it; without the flag, a single saved login or a headless run pins the active account, and a terminal asks when there are several logins or the only one comes from a token env var. Only the `auto` choice in that prompt follows a later `gh auth switch`; a pinned account stays until you re-run `agent auth`.
- `gh-env` in a terminal always shows the var and its GitHub account first: one set asks yes/no, several set get a menu. Headless takes the most specific (servers).
- Every pasted or copied token is labelled with the account GitHub reports for it (GraphQL `viewer`, no `gh` needed); a lookup miss only changes the label.
- `--get` / `--del` / `--check` print, clear, or check that a credential resolves.
- `--profile <name>` addresses one [profile](#profiles)'s slot; `--list` shows every slot.

## PAT passthrough

Classic and fine-grained PATs can't perform the proxy's editor token exchange. So `agent start` transparently enables a passthrough shim for PAT-shaped tokens, using the PAT as the bearer directly. Force it either way with `agent config --set passthrough on|off` ([key](configuration.md#credential)).

## Client identity

Copilot reads the client from two things on every request: the `Copilot-Integration-Id` header (or its absence, which is Direct's `codex` default) and the `User-Agent`. Which identity a credential is accepted under differs per host and per token kind, so `agent auth` surveys them.

```text
$ agent auth --identities
integration-id: auto
* = in effect today: Direct as the agent configs bake it, Proxy as a fresh daemon launch sends it
identity                   Direct (api.githubcopilot.com)  Proxy (api.enterprise.githubcopilot.com)  note
-------------------------  ------------------------------  ----------------------------------------  ------------------------------------------------------------
codex                      rejected (400)                  -                                         Direct default: no Copilot-Integration-Id header (auto only)
copilot-developer-cli      accepted (5 models)             accepted (37 models) *                    GitHub Copilot CLI; accepts fine-grained PATs
copilot-developer-sandbox  accepted (2 models)             rejected (400)
vscode-chat                -                               rejected (400)                            proxy default (copilot-api's own identity)
Direct: no agent is wired Direct; `agent init` would bake copilot-developer-cli.
  codex on Direct: 400 Personal Access Tokens are not supported for this endpoint
  copilot-developer-sandbox on Proxy: 400 Personal Access Tokens are not supported for this endpoint
  vscode-chat on Proxy: 400 Personal Access Tokens are not supported for this endpoint
```

- **Rows** are the identities: each host's built-in candidates (Direct: `codex`, `copilot-developer-cli`, `copilot-developer-sandbox`; Proxy: `vscode-chat`, `copilot-developer-cli`, `copilot-developer-sandbox`), plus a pinned id and whatever the agent configs bake today. The rows are probed concurrently, and the survey never stops at the first acceptance.
- **Columns** are the two hosts: Direct (`api.githubcopilot.com`, what the agent configs call) and Proxy (the API host the credential's account reports, `api.enterprise.githubcopilot.com` above; what the daemon's PAT passthrough calls).
- **Cells:** `accepted (N models)` is a 2xx with the `/models` catalog size; `rejected (400)` a 400/401; `unclear (403)` or `unclear (network error)` a non-definitive status or a blip; `-` an identity not probed on that host, because it is neither one of the host's candidates nor pinned nor baked there.
- **The `*`** marks what is in effect today, per host. Direct: the header the agent configs bake right now (a pin lands there only at the next rewire; a config that cannot be read is reported as unknown, never as "not wired"). Proxy: what a fresh daemon launch sends; a running daemon keeps its launch-time identity until restarted.
- **Lines under the table:** the reason for every rejected or unclear cell (trimmed to 160 characters), and a note for each gap.
- **The gaps a note can name:** the Direct wiring sends one identity until `agent init` (or `agent profile --add <name>`) rebakes the next pick; Codex and Claude disagree; passthrough is off for the credential, so the proxy exchanges the token itself and always sends `vscode-chat`; a daemon is running and needs `agent stop`, then `agent start`.

`agent auth --identity <id>` pins one; the store is the [`integration-id`](configuration.md#credential) key, so `agent config --set integration-id <id>` is the same write.

```text
$ agent auth --identity copilot-developer-cli
integration-id = copilot-developer-cli (pinned; `agent auth --identity auto` restores probing).
```

- The pin is probed once on both hosts with exactly the headers it would send. A definitive rejection on both hosts refuses the pin; a one-sided or unclear result pins with a warning naming what carried it; with no credential resolving, the pin is stored unverified and the warning says so.
- `--identity auto` clears the pin and needs no credential. A bare `--identity` in a terminal prints the table, then offers every identity at least one host accepted, plus `auto`.
- `codex` cannot be pinned: Direct's default identity is the absence of the header, and a pin is always sent as the header's value. `auto` already selects it whenever Direct accepts the credential under it.
- A pin applies to Direct at the next `agent init` / `agent profile --add` and to the proxy at its next daemon launch.
- `--profile <name>` probes with that profile's credential and names `agent profile --add <name> --direct` as the rewire; the pin itself is one store-wide key.

**User-Agent.** Direct wiring for both agents sends `codex_exec/<version>`, and the version is resolved once per process, in this order: the installed `codex --version`, else npm's current `@openai/codex` release (`npm view @openai/codex version`), else the version baked into this copilot-env build. A machine without Codex and without network still sends a versioned header, since Copilot rejects some models for the bare shape.

## Static key

`static-key` names which agent's config carries the credential value itself instead of a resolver command: `none` (the default), `claude`, `codex`, or `all`. An agent in scope runs no copilot-env process at request time.

```bash
agent config --set static-key codex   # bake Codex's config only; Claude keeps its helper
agent config --set static-key all     # both agents and Claude Desktop
```

| `static-key`     | Claude Code `settings.json`                   | Codex `config.toml`, managed provider                  | Claude Desktop entry                                                              |
| ---------------- | --------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `none` (default) | `apiKeyHelper` command                        | `auth.command`                                         | helper script                                                                     |
| `claude`         | `env.ANTHROPIC_AUTH_TOKEN`; no `apiKeyHelper` | `auth.command`                                         | `inferenceCredentialKind = "static"` + `inferenceGatewayApiKey`; no helper script |
| `codex`          | `apiKeyHelper` command                        | `http_headers.Authorization = "Bearer ..."`; no `auth` | helper script                                                                     |
| `all`            | `env.ANTHROPIC_AUTH_TOKEN`; no `apiKeyHelper` | `http_headers.Authorization = "Bearer ..."`; no `auth` | `inferenceCredentialKind = "static"` + `inferenceGatewayApiKey`; no helper script |

- Claude Desktop follows Claude's scope (`claude` or `all`).
- Direct bakes the GitHub credential (`gh-cli` is resolved once, at write time); proxy bakes the daemon's own API key.
- The value does not follow a credential change: re-run `agent init` (or `agent profile --add <name>`) after `agent auth`, which notes that the agents in scope keep their baked value until that rewire.
- Proxy mode loses the resolver's side effects for the agent in scope: the daemon is not auto-started and no idle heartbeat is recorded. Start it with `agent start`, or launch through `cl` / `cx`, which do.
- `agent claude --check`, `agent codex --check`, and `agent health` report the static shape as wired. `agent health` also warns when the baked value no longer matches the store (or the daemon's key), naming the rewire.
- The key was a boolean through 4.0.9. Updating past 4.0.9 runs the migration that turns a stored `true` into `all` and drops a stored `false`; `true` and `false` are now rejected.

## Profiles

A profile is an atomic unit: ONE credential + ONE mode (direct or proxy, never both), always wired into BOTH agents. Several sessions then run at once without touching the default setup.

```bash
agent profile --add work --proxy --provider gh-env   # credential + mode + both agents
cl --profile work        # Claude under the profile (its own proxy daemon, own port)
cx --profile work        # Codex under the same profile
agent profile --list     # NAME  MODE  PROVIDER  DAEMON
agent profile --del work # stop its daemon, clear its credential, strip both agents' wiring
```

- **No fallback:** a named profile hard-fails rather than falling back to the default credential. Re-authenticate one with `agent auth --profile <name>`.
- **Own daemon:** a proxy-mode profile runs in an isolated home (`<copilot-api home>/profiles/<name>`) on a stable reserved port, managed via `agent start/stop --profile <name>`.
- **Own files:** Claude reads `~/.claude/settings-<name>.json`; Codex reads `~/.codex/<name>.config.toml`, whose top-level `model_provider` selects the `[model_providers.copilot-env-<name>]` table in `config.toml` (`codex --profile <name>` layers the file over `config.toml`). Your own keys in the profile file survive a rewire. Both files are in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Legacy shape:** Codex 0.134 and later refuse to start `--profile <name>` on a `[profiles.<name>]` table, and refuse every launch on a top-level `profile` key. The 4.0.9 migration, through `agent update`, moves each table copilot-env wrote into `<name>.config.toml` and reports the ones it did not write; `agent health` reports a leftover as broken wiring with that repair, never as wired.
- **Switch mode:** re-run `--add` with the other mode flag.
- **Web-search caveat:** a DIRECT profile over a PROXY default has no search path in Claude. The builtin 400s on Direct, and the machine-global MCP server is only registered while the default wiring is direct ([web search](usage.md#web-search-for-claude-code)).
- **Workaround:** register the server by hand there, under a name other than `copilot-env`. A hand-written entry under that name reads as foreign, so a later default wiring leaves it alone and cannot register its own.
