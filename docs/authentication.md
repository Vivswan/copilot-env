---
title: Authentication
group: Reference
order: 4
---

# Authentication

`agent profile auth` is the credential front door: one GitHub Copilot credential, resolved at fetch time. Agent configs never store a copy, and `gh-cli` holds no token of its own; `static-key` ([below](#static-key)) is the one opt-out.

This page is about the credential and the profiles that carry one each. The wiring commands that ask for a credential are on the [getting started page](getting-started.md#the-first-agent-profile-add).

## Providers

| `--provider` | Where the credential comes from                                               |
| ------------ | ----------------------------------------------------------------------------- |
| `copilot`    | GitHub device flow (`read:user` scope)                                        |
| `gh-cli`     | the machine's existing `gh` login, pinned to one account at auth time (below) |
| `gh-token`   | paste a GitHub token; `--set <token>` stores one non-interactively            |
| `gh-env`     | copy a token from `$COPILOT_GITHUB_TOKEN` / `$GH_TOKEN` / `$GITHUB_TOKEN`     |

- `copilot` runs GitHub's device flow in copilot-env itself (VS Code Copilot's OAuth app, `read:user`), printing the URL and code on stderr; the token goes straight into the credential store, and no proxy-side token file is written.
- `gh-cli` pins an account when you run `agent profile auth`: `--gh-user <login>` names it; without the flag, a single saved login or a headless run pins the active account, and a terminal asks when there are several logins or the only one comes from a token env var. Only the `auto` choice in that prompt follows a later `gh auth switch`; a pinned account stays until you re-run `agent profile auth`.
- A pinned account resolves through `gh auth token --user <login>`. When that gh cannot serve it (gh before 2.40 has no `--user`; a `hosts.yml` login may not answer to it) and the pin is gh's active account, `gh auth token --hostname github.com` serves the same login.
- The fallback keeps the pin honest: a `gh auth switch` to another account fails the pin instead of following it, an env token (`$GH_TOKEN`, `$GITHUB_TOKEN`) is never adopted, and a miss quotes the gh call and its stderr.
- `gh-env` in a terminal always shows the var and its GitHub account first: one set asks yes/no, several set get a menu. Headless takes the most specific (servers).
- Every pasted or copied token is labelled with the account GitHub reports for it (GraphQL `viewer`, no `gh` needed); a lookup miss only changes the label.
- `--get` / `--del` / `--check` print, clear, or check that a credential resolves.
- `agent profile <name> auth` addresses one [profile](#profiles)'s slot; bare `agent profile` lists every profile with its provider.

## PAT passthrough

Classic and fine-grained PATs can't perform the proxy's editor token exchange. So `agent start` transparently enables a passthrough shim for PAT-shaped tokens, using the PAT as the bearer directly. Force it either way with `agent config --set passthrough on|off` ([key](configuration.md#profile)).

Passthrough decides only the exchange; the proxy's [client identity](#client-identity) is the credential's whatever the decision.

## Client identity

Copilot reads the client from two things on every request: the `Copilot-Integration-Id` header (or its absence) and the `User-Agent`. Together they decide which credentials are accepted and which catalog is served, so copilot-env resolves ONE client identity per credential and every mode sends it:

- **Candidates, in probe order:** `codex` (the codex User-Agent with no `Copilot-Integration-Id`; the identity that lists the widest catalog), then `copilot-developer-cli`, then `copilot-developer-sandbox`, then `vscode-chat` (copilot-api's former default). The first `GET /models` that answers 2xx on the host in use wins, so a later candidate is reached only when every earlier one answered without a 2xx.
- **Probed at a landing, stored in the slot:** a credential landing (`agent profile [<name>] add`, `agent profile <name> auth`) probes on the host in use and stores the halves the probe answered; a pinned identity or a literal host is an overlay, never stored.
- **Read back everywhere else:** every Direct re-render and every daemon start read the slot under the `identity` pin and `host` literal, with no request; a half still unknown is probed once and stored.
- **Direct** bakes the header set into the agent configs (Codex `http_headers`, Claude `ANTHROPIC_CUSTOM_HEADERS`).
- **Proxy** applies the same header set inside the daemon: a preload rewrites `User-Agent` and `Copilot-Integration-Id` on every fetch and WebSocket to the Copilot API hosts, deleting the id for `codex`, so the proxy serves the catalog Direct sees. The proxy's own `agent models --proxy` list is copilot-api's trimmed view of that catalog.

```text
$ agent profile identity
identity: auto
host: auto (api.githubcopilot.com in use)
* = in use: the pin, else the slot's probed identity; what every Direct re-render bakes and a daemon launch sends, on the host in use
identity                   api.githubcopilot.com (in use)  api.enterprise.githubcopilot.com (account)  note
-------------------------  ------------------------------  ------------------------------------------  ---------------------------------------------------------
codex                      rejected (400)                  rejected (400)                              the default: no Copilot-Integration-Id header (auto only)
copilot-developer-cli      accepted (5 models) *           accepted (37 models)                        GitHub Copilot CLI; accepts fine-grained PATs
copilot-developer-sandbox  accepted (2 models)             rejected (400)
vscode-chat                rejected (400)                  rejected (400)                              copilot-api's former default
  codex on api.githubcopilot.com: 400 Personal Access Tokens are not supported for this endpoint
  codex on api.enterprise.githubcopilot.com (account): 400 Personal Access Tokens are not supported for this endpoint
  copilot-developer-sandbox on api.enterprise.githubcopilot.com (account): 400 Personal Access Tokens are not supported for this endpoint
  vscode-chat on api.githubcopilot.com: 400 Personal Access Tokens are not supported for this endpoint
  vscode-chat on api.enterprise.githubcopilot.com (account): 400 Personal Access Tokens are not supported for this endpoint
```

- **Rows** are the identities: the four candidates, plus the pin and the slot's stored identity when they are neither. Every row is probed with exactly the header set every mode sends; the rows are probed concurrently, and the survey never stops at the first acceptance. The survey never reads the agent files and never stores a pair.
- **Columns** are the hosts: `api.githubcopilot.com`, the API host the credential's account reports when it differs (`api.enterprise.githubcopilot.com` above), and the host in use when it is neither: the `host` literal (tagged `host`) or the slot's stored host (tagged `stored`).
- **Cells:** `accepted (N models)` is a 2xx with the `/models` catalog size; `rejected (400)` a 400/401; `unclear (403)` or `unclear (network error)` a non-definitive status or a blip; `-` an identity not probed on that host.
- **The `*`** marks the one identity in use for this credential, on the host in use: the pin, else the slot's stored identity, on the literal, else the slot's stored host. Nothing is marked `*` while either half is unknown.
- **The `>`** appears only while nothing is stored and no pin is set: it marks the identity the next landing would pick, the first candidate the host in use accepts. A row never carries both marks.
- **Lines under the table:** the reason for every rejected or unclear cell (trimmed to 160 characters), and a note for each gap: nothing (or one half) is stored yet and one `agent profile add` (or `agent start`) probes and stores what it lands on; a pin overlays the stored identity; a daemon is running and keeps its launch-time identity until `agent stop`, then `agent start`.
- **Width:** the table fits the terminal by the [terminal width](usage.md#terminal-width) rules; with the two hosts above the columns give way to one block per identity below about 105 columns.

`agent profile set identity <id>` pins one; the store is the [`identity`](configuration.md#profile) key.

```text
$ agent profile set identity copilot-developer-cli
identity = copilot-developer-cli (pinned; `agent profile set identity auto` restores probing).
$ agent profile set identity auto
identity = auto: the identity is probed per credential again.
```

- The pin is probed once on every host with exactly the headers it would send. A definitive rejection on the host in use, or on every host, refuses the pin; a one-sided or unclear result pins with a warning naming what carried it; with no credential resolving, the pin is stored unverified and the warning says so.
- `set identity auto` clears the pin and needs no credential.
- `codex` cannot be pinned: it is the absence of the header, and a pin is always sent as the header's value. `auto` already selects it whenever the credential is accepted under it.
- A pin overlays the stored identity: it applies to Direct at the next re-render and to the proxy at its next daemon launch.
- `agent profile <name> identity` surveys with that profile's credential and slot; `agent profile <name> set identity <id>` (or `identity --set <id>`) pins that profile's `identity` key.

**User-Agent.** Every mode sends `codex_exec/<version>`, and the version is resolved once per process, in this order: the installed `codex --version`, else npm's current `@openai/codex` release (`npm view @openai/codex version`), else the version baked into this copilot-env build. A machine without Codex and without network still sends a versioned header, since Copilot rejects some models for the bare shape.

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
- The value does not follow a credential change. A named profile's `agent profile <name> auth` rewires both agents itself, so its baked value is fresh at once. The default's `agent auth` only stores the credential: re-run `agent init` after it, which notes that the agents in scope keep their baked value until that rewire.
- Proxy mode loses the resolver's side effects for the agent in scope: the daemon is not auto-started and no idle heartbeat is recorded. Start it with `agent start`, or launch through `cl` / `cx`, which do.
- `agent profile check` (`--claude` / `--codex`) and `agent health` report the static shape as wired. `agent health` also warns when the baked value no longer matches the store (or the daemon's key), naming the rewire.
- The key was a boolean through 4.0.9. Updating past 4.0.9 runs the migration that turns a stored `true` into `all` and drops a stored `false`; `true` and `false` are now rejected.

## Profiles

A profile is an atomic unit: ONE credential + ONE mode (direct or proxy, never both), always wired into BOTH agents. Several sessions then run at once without touching the default setup.

```bash
agent profile work add --proxy                # the mode, then the credential step (it asks how)
agent profile work add --proxy --no-auth      # headless: the mode alone, then
agent profile work auth --provider gh-env     # the credential; wires both agents
cl --profile work        # Claude under the profile (its own proxy daemon, own port)
cx --profile work        # Codex under the same profile
agent list               # NAME  MODE  PROVIDER  DAEMON
agent profile work del --yes  # stop its daemon, clear its credential, strip both agents' wiring
```

- **No fallback:** a named profile hard-fails rather than falling back to the default credential. Re-authenticate one with `agent profile <name> auth`.
- **Own daemon:** a proxy-mode profile runs in an isolated home (`<copilot-api home>/profiles/<name>`) on a stable reserved port, managed via `agent start/stop --profile <name>`.
- **Own files:** Claude reads `~/.claude/settings-<name>.json`; Codex reads `~/.codex/<name>.config.toml`, whose top-level `model_provider` selects the `[model_providers.copilot-env-<name>]` table in `config.toml` (`codex --profile <name>` layers the file over `config.toml`). Your own keys in the profile file survive a rewire. Both files are in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Legacy shape:** Codex 0.134 and later refuse to start `--profile <name>` on a `[profiles.<name>]` table, and refuse every launch on a top-level `profile` key. The 4.0.9 migration, through `agent update`, moves each table copilot-env wrote into `<name>.config.toml` and reports the ones it did not write; `agent health` reports a leftover as broken wiring with that repair, never as wired.
- **Switch mode:** re-run `add` with the other mode flag.
- **Web-search caveat:** a DIRECT profile over a PROXY default has no search path in Claude. The builtin 400s on Direct, and the machine-global MCP server is only registered while the default wiring is direct ([web search](usage.md#web-search-for-claude-code)).
- **Workaround:** register the server by hand there, under a name other than `copilot-env`. A hand-written entry under that name reads as foreign, so a later default wiring leaves it alone and cannot register its own.
