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
                           #   exits 0 direct, 2 proxy, 1 other
agent codex --mobile       # pair the Codex desktop app with the phone remote-control flow
agent claude               # configure Claude; no flag auto-detects the backend
agent claude --direct      # force GitHub Copilot Direct for Claude (no auto-detect probe)
agent claude --check       # print Claude provider mode; exits 0 direct, 2 proxy, 1 other
agent --full-help          # help for agent and every subcommand, every flag included
```

`agent install` and `agent migrate <from> <to>` are run for you by the installer and `agent update`. You run one by hand only when a message tells you to: `agent migrate <from> <to>` after a migration step did not complete, or `agent install` to refresh the current version in place.

`agent settings --import` is non-destructive: preferences are full-replace, credentials are preserve-if-absent, and the stores are backed up first. A rollback re-imports the backup but never deletes profiles.

On Windows the same commands run via `agent` once the profile is wired, or directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`.

## Shell integration

The installer wires the `agent` wrapper into your shell and exports the proxy env.

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

`agent env` defines the launcher functions in each new shell, and `agent shell` reports the state it wired.

### Launchers

The `cl` / `co` / `cx` launchers are opt-in shell functions over `agent launch`. They follow the `launchers` config key:

```bash
agent config --set launchers true
agent config --set launchers false
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
agent config --set auto-start true
```

With `auto-start` on:

- **Auto-start:** whenever Codex, Claude, or the `cl` / `cx` launchers need a downed proxy, the shared credential resolver starts it. No manual `agent start`.
- **Idle auto-stop:** a watchdog inside the daemon stops the proxy after an idle window. Inference requests and session heartbeats count as activity; health and liveness pings never do.
- **Window:** `agent config --set idle-timeout <seconds>` ([default and the `0` case](configuration.md#proxy-daemon)) or the [`COPILOT_API_IDLE_TIMEOUT`](configuration.md#environment-overrides) env var.

With `auto-start` off, the launchers prompt before starting a downed proxy. Headless callers, such as the Codex and Claude config hooks, never start it implicitly.

## Web search for Claude Code

Claude Code wired to GitHub Copilot Direct cannot use its builtin WebSearch. Copilot's Anthropic-compatible endpoint rejects the server-side search tool with a 400.

Copilot's own Responses API does serve web search, so copilot-env ships an MCP stdio server. `agent mcp --serve` runs it, and its `web_search` tool proxies through that API and returns a cited answer with a `Sources:` list. Bare `agent mcp` prints the wiring status.

Wiring Claude direct (`agent init`, `agent claude --direct`) sets this up by itself. It registers the server in Claude Code's user scope and denies the broken builtin, and a proxy write takes both back. Through the local proxy the builtin WebSearch works, so nothing is needed there.

The pair is opt-out:

```bash
agent mcp --remove                  # unregister + restore the builtin + remember the opt-out
agent config --set wire-mcp true    # opt back in (applies on the next direct wiring)
```

The search model follows the [`message-websearch-model`](configuration.md#proxy-features) key, shared with the proxy; when a change applies to each is on that page:

```bash
agent config --set message-websearch-model gpt-5.6-sol   # one override, both surfaces
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

`agent cost` prices the proxy's usage DBs plus the Codex and Claude session logs at public OpenRouter rates ([`pricing-url`](configuration.md#cost)). Re-parsing every log on each run is slow, so the readers keep a usage index.

- **What it stores:** per-file facts only. The path, size, mtime, how far it was parsed, and its contribution (token counts, timestamps, model names, hashed dedup keys).
- **What it never stores:** message text or any other session content.
- **Pre-index, not a cache:** every run folds the report fresh from the files that exist right now, so a deleted session drops out of the next report.
- **Where:** `<copilot-api home>/usage-index/index.sqlite`, by default `~/.local/share/copilot-env/usage-index/index.sqlite`.
- **Also there:** the one thing that IS cached, the public OpenRouter price list (`pricing-*.json`, 24-hour TTL). `agent uninstall` removes both.
- **Verify it:** `agent cost --no-index` parses every file from scratch.

`agent credits` reports this month's Copilot AI credits: spent, projected, and paced against the plan and the optional [`credits-target`](configuration.md#cost). It is one live read of GitHub's meter; nothing local.
