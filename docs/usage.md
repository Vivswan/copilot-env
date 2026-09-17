---
title: Usage
group: Start here
order: 2
---

# Usage

The `agent` subcommands and the mechanisms behind the ones that need more than a line. Installing is on the [getting started page](getting-started.md); every preference key is on the [configuration page](configuration.md).

## Commands

```bash
agent init                 # set up BOTH Codex + Claude (auto-detect direct vs proxy) + next steps
                           #   --direct | --proxy forces one mode for both
agent launch <cli>         # launch claude|codex|copilot with managed flags + provider wiring
                           #   --profile <name>, --relaxed; agent args after --
agent auth                 # manage the GitHub Copilot credential
                           #   --provider copilot|gh-cli|gh-token|gh-env, --set <token>, --get, --del, --check
                           #   --gh-user <login> pins gh-cli to one logged-in account
                           #   --profile <name> addresses one profile's slot, --list shows every slot
                           #   --identities surveys the Copilot client identities, --identity <id|auto> pins one
agent profile              # manage named profiles: one credential + one mode, both agents
                           #   --add <name> --direct|--proxy, --del <name>, --list, --check <name>
agent config               # get/set preferences (see the configuration page)
                           #   --set <key> <value>, --get [key], --del <key>
agent settings             # export/import every portable setting as one JSON bundle
                           #   --export [file], --import <file>
                           #   --with-credentials, --force, --no-backup
agent start                # launch the daemon and sync aliases
                           #   --dry-run previews, --port pins, --check probes, --profile <name>
agent stop                 # stop the daemon (--profile <name> for one, --all for every daemon)
agent proxy-token          # print the proxy's API key, auto-starting it when auto-start is on
                           #   --yes never prompts (exit 1 when down and auto-start is off), --profile <name>
agent health               # full environment diagnosis
                           #   --scope full|runtime|proxy|setup|auth|codex|claude, --json, --live
agent models               # list the model ids + names Copilot serves (--proxy, --direct, --json)
agent env                  # print shell directives for the calling shell
                           #   CODEX_HOME / proxy ANTHROPIC_BASE_URL exports + opt-in launchers
agent mcp                  # MCP wiring status (--serve runs the stdio server, --remove unwires)
agent cost                 # estimated token spend across proxy DBs + Codex/Claude logs
                           #   --days N, --json, --per-day, --sources, --no-index
agent credits              # this month's Copilot AI credits: spent, projected, paced (--json, --target N)
agent update               # update to the latest release (--check, --auto-status, --no-verify)
agent shell                # wire rc / $PROFILE (--clis installs/updates the CLIs, --remove unwires)
agent uninstall            # remove copilot-env entirely (--yes headless, --dry-run, --force)
agent codex                # configure Codex; no flag auto-detects the backend
agent codex --direct       # force GitHub Copilot Direct (no auto-detect probe)
agent codex --check        # print provider mode + a Direct config's service_tier line
                           #   exits 0 direct, 2 proxy or unconfigured, 1 other
agent codex --mobile       # pair the Codex desktop app with the phone remote-control flow
agent claude               # configure Claude; no flag auto-detects the backend
agent claude --direct      # force GitHub Copilot Direct for Claude (no auto-detect probe)
agent claude --check       # print Claude provider mode; exits 0 direct, 2 proxy or unconfigured, 1 other
agent --full-help          # help for agent and every subcommand, every flag included
```

`agent install` and `agent migrate <from> <to>` are run for you by the installer and `agent update`. You run one by hand only when a message tells you to: `agent migrate <from> <to>` after a migration step did not complete, or `agent install` to refresh the current version in place.

`agent settings --import` is non-destructive: preferences are full-replace, credentials are preserve-if-absent, and the stores are backed up first. A rollback re-imports the backup but never deletes profiles.

On Windows the same commands run via `agent` once the profile is wired, or directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`.

### Terminal width

Every table (`agent auth --identities`, `agent auth --list`, `agent models`, `agent profile --list`, the `agent start` summary and alias table, the `agent cost` tables) fits the terminal:

```text
width = a TTY: its size (80 on a size-less pty) -> a pipe: COLUMNS if set, else unbounded, never wraps
fits             -> the natural layout
too wide         -> the widest column shrinks first, never below its floor; a free-text column
                    (the identities `note`, the `--list` description, the models detail, the
                    alias list) wraps at word boundaries, a header wraps between its words; a
                    path column (the `agent start` summary) splits at its column edge
floors too wide  -> one block per record: "identity: codex", then "  header: cell" per non-empty cell
```

The lines under the identities table wrap the same way, with a hanging indent. An exported `COLUMNS` never overrides a TTY's own size. With `COLUMNS` unset, `agent auth --identities | cat` prints the full-width lines; `COLUMNS=80 agent auth --identities | cat` prints the 80-column layout.

Every other line wraps at the logger: a consola message is wrapped before its icon or frame goes on, each line under its own indent with the continuation one step deeper; a word wider than the line splits at the width. Reports printed without a logger (`agent health`, `agent cost`, the installer's next steps) and every prompt use the same wrapper. Down a pipe nothing wraps unless `COLUMNS` is set.

### Color

Every table and report uses `agent config`'s palette: headers and headings bold, the key column cyan, status words by tone (green healthy, yellow needs a hand, red failed, dim idle), notes dim; a warning prints yellow, an error red, a success green. Color is on in a TTY and off down a pipe, under `NO_COLOR=1`, or with `TERM=dumb`; widths are always measured on the visible text.

## Shell integration

The installer wires the `agent` wrapper into your shell and exports the proxy env.

- **macOS / Linux:** sources `shell/agents.bashrc`.
- **Windows:** dot-sources `shell/agents.ps1`.

The rc file and profile it edits are in the [wiring write list](getting-started.md#what-a-wiring-pass-writes).

`agent env` defines the launcher functions in each new shell, and `agent shell` reports the state it wired.

### Launchers

The `cl` / `co` / `cx` launchers are opt-in shell functions over `agent launch`. They follow the `shell.launchers` config key:

```bash
agent config --set shell.launchers true
agent config --set shell.launchers false
```

- `cl` (`agent launch claude`) reads the configured Claude provider. For proxy-backed or unconfigured setups it starts the proxy, re-syncing port and token, then runs Claude.
- `cx` (`agent launch codex`) does the same for Codex.
- `co` (`agent launch copilot`) runs Copilot.
- `cl --profile <name>` / `cx --profile <name>` launch under a [named profile](authentication.md#profiles) instead. Leading arguments only; the default setup is untouched.

Each has a more-permissive variant that adds the agent's most-relaxed flag (`agent launch ... --relaxed`):

| Launcher | Adds                             |
| -------- | -------------------------------- |
| `clx`    | `--dangerously-skip-permissions` |
| `cox`    | `--allow-all`                    |
| `cxx`    | `--sandbox danger-full-access`   |

`agent launch <claude|codex|copilot> [--profile <name>] [--relaxed] -- <args...>` works directly too, without the shell functions.

## Managed proxy lifecycle (auto-start)

By default you manage the proxy yourself with `agent start` / `agent stop`. Opt in to the managed lifecycle instead:

```bash
agent config --set daemon.auto-start true
```

With `daemon.auto-start` on:

- **Auto-start:** whenever Codex, Claude, or the `cl` / `cx` launchers need a downed proxy, the shared credential resolver starts it. No manual `agent start`.
- **Idle auto-stop:** a watchdog inside the daemon stops the proxy after an idle window. Inference requests and session heartbeats count as activity; health and liveness pings never do.
- **Window:** `agent config --set daemon.idle-timeout <seconds>` ([default and the `0` case](configuration.md#daemon)) or the [`COPILOT_API_IDLE_TIMEOUT`](configuration.md#environment-overrides) env var.

With `daemon.auto-start` off, the launchers prompt before starting a downed proxy. Headless callers, such as the Codex and Claude config hooks, never start it implicitly.

## Health checks

`agent health` diagnoses the environment by scope ([commands](#commands)); one flag needs more than a line.

### `--live`

`--live` runs one read-only prompt through each CLI as its launcher starts it, minus interactivity: the real settings discovery, hooks, and saved model, with nothing pinned. One difference from `cx`: Codex runs in its read-only sandbox.

| CLI    | What `--live` runs                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude | `claude --print --permission-mode plan --verbose --output-format stream-json "<prompt>"`; a named profile adds `--settings ~/.claude/settings-<name>.json` and drops a shell `ANTHROPIC_BASE_URL`, as `cl --profile` does |
| Codex  | `codex exec --json --skip-git-repo-check --sandbox read-only "<prompt>"`; a named profile adds `--profile <name>`                                                                                                         |

- Exit 0 alone is not a pass: a `UserPromptSubmit` hook that stops the prompt exits 0 after zero model turns. The check passes only when the stream carries the model's answer (an `assistant` event from Claude, an `item.completed` `agent_message` from Codex); otherwise it reports `exit 0 without a model answer` with the stream.
- `CLAUDE_CONFIG_DIR` is never added to the child's env (a value your shell already exports is inherited like the rest): Claude namespaces its keychain entry by that variable, and adding even the default dir hid a keychain-held key a real session reads.
- The `agent init` Direct probe is the other intent: an isolated throwaway config (`--bare`), and it is unchanged.

## Web search for Claude Code

Claude Code wired to GitHub Copilot Direct cannot use its builtin WebSearch. Copilot's Anthropic-compatible endpoint rejects the server-side search tool with a 400.

Copilot's own Responses API does serve web search, so copilot-env ships an MCP stdio server. `agent mcp --serve` runs it, and its `web_search` tool proxies through that API and returns a cited answer with a `Sources:` list. Bare `agent mcp` prints the wiring status.

Wiring Claude direct sets this up by itself: it registers the server in Claude Code's user scope and denies the broken builtin. The [write list](getting-started.md#what-a-wiring-pass-writes) names the commands that add the pair and the ones that take it back. Through the local proxy the builtin WebSearch works, so nothing is needed there.

The pair is opt-out:

```bash
agent mcp --remove                  # unregister + restore the builtin + remember the opt-out
agent config --set claude.wire-mcp true    # opt back in (applies on the next direct wiring)
```

The search model follows the [`proxy.message-websearch-model`](configuration.md#proxy) key, shared with the proxy; when a change applies to each is on that page:

```bash
agent config --set proxy.message-websearch-model gpt-5.6-sol   # one override, both surfaces
```

The server is client-agnostic. Register it in Cursor or any other MCP client by pointing at the launcher. Codex itself needs no MCP for search, since it speaks the Responses API natively.

```jsonc
{
  "mcpServers": {
    "copilot-env": {
      "type": "stdio",
      "command": "/path/to/copilot-env/bin/agent",
      "args": ["mcp", "--serve"]
    }
  }
}
```

- **Credential:** it resolves the `agent auth` credential. Only when no provider is stored at all does it fall back to `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`, so a bare clone works: `GH_TOKEN=... bin/agent mcp --serve`. A stored provider that no longer resolves is an error, never a silent switch to the env.
- **Profiles:** the registered server uses the default credential. A named profile that needs its own registers a second entry with `--profile <name>`; the [profiles section](authentication.md#profiles) has the Direct-over-proxy caveat.
- **Plugin + skill:** the repo doubles as a Claude Code plugin (`.claude-plugin/`, which bundles the MCP server inline) and a skills collection. `npx skills add Vivswan/copilot-env` installs the companion [`web-search` skill](../skills/web-search).
- **Windows:** the plugin's bundled registration runs `bin/agent`, a POSIX script. Wire through `agent init` or register `bin\agent.ps1` by hand instead.

## Cost reporting

`agent cost` prices the proxy's usage DBs plus the Codex and Claude session logs at public OpenRouter rates ([`cost.pricing-url`](configuration.md#cost)). Re-parsing every log on each run is slow, so the readers keep a usage index.

- **What it stores:** per-file facts only. The path, size, mtime, how far it was parsed, and its contribution (token counts, timestamps, model names, hashed dedup keys).
- **What it never stores:** message text or any other session content.
- **Pre-index, not a cache:** every run folds the report fresh from the files that exist right now, so a deleted session drops out of the next report.
- **Where:** `<copilot-api home>/usage-index/index.sqlite`, by default `~/.local/share/copilot-env/usage-index/index.sqlite`.
- **Also there:** the one thing that IS cached, the public OpenRouter price list (`pricing-*.json`, 24-hour TTL). `agent uninstall` removes both.
- **Verify it:** `agent cost --no-index` parses every file from scratch.

`agent credits` reports this month's Copilot AI credits: spent, projected, and paced against the plan and the optional [`cost.credits-target`](configuration.md#cost). It is one live read of GitHub's meter; nothing local.
