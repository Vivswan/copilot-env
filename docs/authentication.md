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

## Static key

`agent config --set static-key true` makes every wiring write the credential value itself. Claude, Codex, and Claude Desktop then run no copilot-env process at request time.

| Host           | Written instead of the resolver command                                           |
| -------------- | --------------------------------------------------------------------------------- |
| Claude Code    | `env.ANTHROPIC_AUTH_TOKEN` in `settings.json`; no `apiKeyHelper`                  |
| Codex          | `http_headers.Authorization = "Bearer ..."` on the managed provider; no `auth`    |
| Claude Desktop | `inferenceCredentialKind = "static"` + `inferenceGatewayApiKey`; no helper script |

- Direct bakes the GitHub credential (`gh-cli` is resolved once, at write time); proxy bakes the daemon's own API key.
- The value does not follow a credential change: re-run `agent init` (or `agent profile --add <name>`) after `agent auth`.
- Proxy mode loses the resolver's side effects: the daemon is not auto-started and no idle heartbeat is recorded. Start it with `agent start`, or launch through `cl` / `cx`, which do.
- `agent claude --check`, `agent codex --check`, and `agent health` report the static shape as wired. `agent health` also warns when the baked value no longer matches the store (or the daemon's key), naming the rewire.

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
- **Switch mode:** re-run `--add` with the other mode flag.
- **Web-search caveat:** a DIRECT profile over a PROXY default has no search path in Claude. The builtin 400s on Direct, and the machine-global MCP server is only registered while the default wiring is direct ([web search](usage.md#web-search-for-claude-code)).
- **Workaround:** register the server by hand there, under a name other than `copilot-env`. A hand-written entry under that name reads as foreign, so a later default wiring leaves it alone and cannot register its own.
