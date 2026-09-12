# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE.md)

```bash
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
agent init      # wire Codex + Claude to GitHub Copilot
agent start     # run the local proxy
```

A self-bootstrapping CLI that points the Codex and Claude CLIs at GitHub Copilot. It wires them either through a local [`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api) proxy it manages, or straight to Copilot Direct.

TypeScript port of the original Python `copilot-api` helper. Runs on **Linux, macOS, and Windows**.

- **Lifecycle**: `start` / `stop` the proxy yourself, or let `auto-start` run it on demand and stop it when idle.
- **Zero setup**: one self-contained binary, no runtime or package manager first. The proxy is fetched on first use, never installed globally.
- **Codex + Claude wiring**: both CLIs point at the proxy or at Copilot Direct, with `~/.codex` / `~/.claude` written for you.
- **One credential per setup**: `agent auth` holds the GitHub Copilot token (device flow, `gh` CLI, or a stored PAT), plus one slot per profile.
- **Named profiles**: `agent profile` bundles one credential and one mode into both agents, so several sessions run at once.
- **Typed preferences**: `agent config` gets and sets every knob under one precedence rule everywhere.
- **Web search on Direct**: Claude Code's builtin WebSearch is replaced by copilot-env's MCP `web_search` tool.
- **Cost reporting**: estimated spend from the proxy usage DBs plus the Codex and Claude session logs.
- **Controlled floating**: the proxy floats to the newest cooldown-aged release; every other dependency is pinned via `deno.lock`.

## Install

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows (runs from any shell -- cmd, PowerShell, or the Run dialog)
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex"
```

This downloads one self-contained `agent` binary for your platform into `~/.copilot-env`, then wires your shell. Next: restart your shell and run `agent start`.

- **Install from a release, not `main`.** `main` is for development and can run ahead of the released installer flow.
- **Replaceable:** re-run the installer any time to move to the selected release.
- **Optional:** `agent shell --clis` installs or updates the Claude/Copilot/Codex CLIs. `agent config --set launchers true` adds the `cl` / `co` / `cx` launchers.
- **Uninstall:** `agent uninstall` removes everything copilot-env manages: daemons, profiles, agent wiring, shell integration, credentials, data, and the install itself. It leaves the agent CLIs (`claude` / `copilot` / `codex`) alone.

**Specific version:** replace `latest` with an exact release tag, or pass `--version`.

```bash
curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.sh | bash
```

```powershell
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.ps1 | iex"
```

### Install flags

| macOS / Linux            | Windows               | Effect                                                                 |
| ------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `--dir DIR`              | `-InstallDir DIR`     | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`) |
| `--version TAG`          | `-Version TAG`        | Install an exact release tag instead of the default                    |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`                                       |

### Updating

`agent update` fetches the newest release's binary, checks its SHA256 against `checksums.txt`, then verifies both files against the release's Sigstore build-provenance attestation. Only then does it swap the binary in place.

The attestation must be signed by a release workflow this build trusts, running in this repository on `main`, and both files must be among the attested bytes.

- That check is on by default. `agent update --no-verify` skips it once, `agent config --set verify-provenance false` turns it off.
- Your config, credentials, and profiles live outside the install directory and are untouched.
- `agent config --set auto-update true` self-updates daily, with the cooldown from `update-cooldown`.

### Verifying a download by hand

The installer checks the binary's SHA256 against the release's `checksums.txt` before it puts it anywhere. That proves the download is intact, not who built it: the installer comes from the same release, so a first install trusts it on first use.

Every release also carries a build-provenance attestation, `attestation.json`. The GitHub CLI checks it with the closest equivalent of the policy `agent update` enforces, for the binary AND `checksums.txt`:

```bash
for f in copilot-env-<target> checksums.txt; do
  gh attestation verify "$f" -R Vivswan/copilot-env --source-ref refs/heads/main --bundle attestation.json \
    --cert-identity-regex '^https://github\.com/Vivswan/(copilot-env/\.github/workflows/release\.yml|repo-platform/\.github/workflows/fleet-release-publish\.yml)@refs/.+$'
done
```

- `-R` names this repository, where `agent update` pins the immutable repository id.
- `--source-ref` requires `main`.
- `--cert-identity-regex` allows either release workflow at any ref: this repository's own `release.yml`, or the fleet's `fleet-release-publish.yml` that the attest step is moving to.

> **Upgrading from 3.5.6 or earlier?** Those versions installed a source tree and bootstrapped a runtime into it, and `agent update` cannot cross that gap.
>
> Re-run the installer once. It replaces the old layout in place, removing the `node_modules` it left behind, and every later update is the ordinary binary swap. Your settings live outside the install directory, so nothing is lost.

## Usage

```bash
agent init                 # set up BOTH Codex + Claude (auto-detect direct vs proxy) + next steps
agent launch <cli>         # launch claude|codex|copilot with managed flags + provider wiring
                           #   --profile <name>, --relaxed; agent args after --
agent auth                 # manage the GitHub Copilot credential
                           #   --provider copilot|gh-cli|gh-token, --set, --get, --del, --check
                           #   --profile <name> addresses one profile's slot, --list shows every slot
agent profile              # manage named profiles: one credential + one mode, both agents
                           #   --add <name> --direct|--proxy, --del <name>, --list, --check <name>
agent config               # get/set preferences (see Configuration below)
                           #   --set <key> <value>, --get [key], --del <key>
agent settings             # export/import every portable setting as one JSON bundle
                           #   --export [file], --import <file>
                           #   --with-credentials, --force, --no-backup
agent start                # launch the daemon and sync aliases
                           #   --dry-run previews, --port pins, --check probes, --profile <name>
agent stop                 # stop the daemon (--profile <name> for one, --all for every daemon)
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
```

`agent settings --import` is non-destructive: preferences are full-replace, credentials are preserve-if-absent, and the stores are backed up first. A rollback re-imports the backup but never deletes profiles.

On Windows the same commands run via `agent` once the profile is wired, or directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`.

### Shell integration

The installer wires the `agent` wrapper into your shell and exports the proxy env.

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

The `cl` / `co` / `cx` launchers are opt-in shell functions over `agent launch`:

- `cl` (`agent launch claude`) reads the configured Claude provider. For proxy-backed or unconfigured setups it starts the proxy, re-syncing port and token, then runs Claude.
- `cx` (`agent launch codex`) does the same for Codex.
- `co` (`agent launch copilot`) runs Copilot.
- `cl --profile <name>` / `cx --profile <name>` launch under a named profile instead. Leading arguments only; the default setup is untouched.

Each has a more-permissive variant that adds the agent's most-relaxed flag (`agent launch ... --relaxed`):

| Launcher | Adds                             |
| -------- | -------------------------------- |
| `clx`    | `--dangerously-skip-permissions` |
| `cox`    | `--allow-all`                    |
| `cxx`    | `--sandbox danger-full-access`   |

They follow the `launchers` config key. `agent env` defines the functions in each new shell, and `agent shell` reports the state it wired.

```bash
agent config --set launchers true
agent config --set launchers false
```

`agent launch <claude|codex|copilot> [--profile <name>] [--relaxed] -- <args...>` works directly too, without the shell functions.

### Managed proxy lifecycle (auto-start)

By default you manage the proxy yourself with `agent start` / `agent stop`. Opt in to the managed lifecycle instead:

```bash
agent config --set auto-start true
```

With `auto-start` on:

- **Auto-start:** whenever Codex, Claude, or the `cl` / `cx` launchers need a downed proxy, the shared credential resolver starts it. No manual `agent start`.
- **Idle auto-stop:** a watchdog inside the daemon stops the proxy after an idle window. Inference requests and session heartbeats count as activity; health and liveness pings never do.
- **Window:** `agent config --set idle-timeout <seconds>` (default `3600`, `0` disables) or the `COPILOT_API_IDLE_TIMEOUT` env var.

With `auto-start` off, the launchers prompt before starting a downed proxy. Headless callers, such as the Codex and Claude config hooks, never start it implicitly.

### Web search for Claude Code

Claude Code wired to GitHub Copilot Direct cannot use its builtin WebSearch. Copilot's Anthropic-compatible endpoint rejects the server-side search tool with a 400.

Copilot's own Responses API does serve web search, so copilot-env ships an MCP stdio server. `agent mcp --serve` runs it, and its `web_search` tool proxies through that API and returns a cited answer with a `Sources:` list. Bare `agent mcp` prints the wiring status.

Wiring Claude direct (`agent init`, `agent claude --direct`) sets this up by itself. It registers the server in Claude Code's user scope and denies the broken builtin, and a proxy write takes both back. Through the local proxy the builtin WebSearch works, so nothing is needed there.

The pair is opt-out:

```bash
agent mcp --remove                  # unregister + restore the builtin + remember the opt-out
agent config --set wire-mcp true    # opt back in (applies on the next direct wiring)
```

The search model follows `message-websearch-model` (default `gpt-5-mini`, the same default the proxy uses). It is read on every call, so no restart is needed:

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

- **Credential:** it resolves the `agent auth` credential, falling back to `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`. A bare clone works: `GH_TOKEN=... bin/agent mcp --serve`.
- **Profiles:** the registered server uses the default credential. A named profile that needs its own registers a second entry with `--profile <name>`.
- **Plugin + skill:** the repo doubles as a Claude Code plugin (`.claude-plugin/`, which bundles the MCP server inline) and a skills collection. `npx skills add Vivswan/copilot-env` installs the companion [`web-search` skill](./skills/web-search).
- **Windows:** the plugin's bundled registration runs `bin/agent`, a POSIX script. Wire through `agent init` or register `bin\agent.ps1` by hand instead.

### Cost reporting

`agent cost` prices the proxy's usage DBs plus the Codex and Claude session logs at public OpenRouter rates. Re-parsing every log on each run is slow, so the readers keep a usage index.

- **What it stores:** per-file facts only. The path, size, mtime, how far it was parsed, and its contribution (token counts, timestamps, model names, hashed dedup keys).
- **What it never stores:** message text or any other session content.
- **Pre-index, not a cache:** every run folds the report fresh from the files that exist right now, so a deleted session drops out of the next report.
- **Where:** `<copilot-api home>/usage-index/index.sqlite`, by default `~/.local/share/copilot-env/usage-index/index.sqlite`.
- **Also there:** the one thing that IS cached, the public OpenRouter price list (`pricing-*.json`, 24-hour TTL). `agent uninstall` removes both.
- **Verify it:** `agent cost --no-index` parses every file from scratch.

### Configuration

`agent config` is the typed preference store. Every read site applies the same precedence: **explicit flag/env (per-invocation) > stored config > built-in default**.

```bash
agent config --get                    # print all preferences
agent config --set auto-start true    # set one
agent config --del idle-timeout       # revert one to its default
```

**Proxy daemon**

| Key                     | Default           | Effect                                                                  |
| ----------------------- | ----------------- | ----------------------------------------------------------------------- |
| `auto-start`            | `false`           | Managed proxy lifecycle: auto-start on agent open + idle auto-stop      |
| `idle-timeout`          | `3600`            | Idle auto-stop window in seconds (`0` disables)                         |
| `min-port` / `max-port` | `1024` / `65535`  | Allowed proxy port range                                                |
| `port`                  | `4141`            | Default proxy port (then next free unless `strict-port`)                |
| `proxy-logs`            | `false`           | Proxy request logging under `<home>/logs` (`false` discards the writes) |
| `proxy-version`         | latest (floated)  | Pin the floated proxy to a version/tag                                  |
| `release-cooldown`      | `604800` (7 days) | Proxy float supply-chain cooldown in seconds                            |
| `strict-port`           | `false`           | Fail `start` when the default port is busy instead of auto-incrementing |

**Proxy features**

| Key                            | Default      | Effect                                                                          |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| `alpha-search-codex-priority`  | `true`       | Prefer Codex for the proxy's `/alpha/search` endpoint                           |
| `alpha-search-model`           | `gpt-5-mini` | Native-Responses model for `/alpha/search` when the requested one cannot run it |
| `claude-auto-model`            | unset        | Model override for Claude Code's background security-monitor requests           |
| `claude-token-multiplier`      | `1.15`       | Multiplier the proxy applies when estimating Claude token usage                 |
| `message-websearch-model`      | `gpt-5-mini` | Web-search model id for the proxy's Messages path and the MCP `web_search`      |
| `messages-api`                 | `true`       | Proxy Messages-API (Anthropic-shaped) endpoint                                  |
| `responses-context-management` | `false`      | Proxy Responses-API server-side context management                              |
| `responses-websearch`          | `true`       | Proxy Responses-API web search                                                  |
| `responses-websocket`          | `true`       | Proxy Responses-API transport: WebSocket vs HTTP/SSE                            |
| `small-model`                  | `gpt-5-mini` | Small/fast model id the proxy uses                                              |

**Credential**

| Key              | Default                       | Effect                                                     |
| ---------------- | ----------------------------- | ---------------------------------------------------------- |
| `integration-id` | `auto` (probe per credential) | Pin the Copilot client identity (`Copilot-Integration-Id`) |
| `passthrough`    | `auto`                        | PAT passthrough: `auto` / `on` / `off` (see below)         |

**Codex**

| Key                   | Default | Effect                                                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `codex-host`          | `false` | Per-host `CODEX_HOME` symlink farm at `~/.codex/hosts/<hostname>`, exported by `agent env` (Linux/macOS) |
| `codex-model-catalog` | `false` | Patched Codex model catalog serving Copilot's real context windows                                       |

**Claude**

| Key              | Default | Effect                                                                        |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `claude-desktop` | `true`  | Keep Claude Desktop's config library wired while the app is installed         |
| `wire-mcp`       | `true`  | Wire the copilot-env MCP server + WebSearch deny into Claude on direct writes |

**Shell**

| Key         | Default | Effect                                                                            |
| ----------- | ------- | --------------------------------------------------------------------------------- |
| `launchers` | `false` | Define the `cl` / `co` / `cx` (+ `clx` / `cox` / `cxx`) functions via `agent env` |

**Updates**

| Key                 | Default | Effect                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `auto-update`       | `false` | Self-update once a day on `agent start` (`agent update --auto-status` shows the last check) |
| `update-cooldown`   | none    | `agent update` cooldown in days; a release must be this old to be adopted                   |
| `verify-provenance` | `true`  | Verify `agent update` downloads against the release's Sigstore attestation                  |

**Cost**

| Key              | Default                               | Effect                                                                                                                                                            |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing-url`    | `https://openrouter.ai/api/v1/models` | OpenRouter models API URL `agent cost` prices at (`agent cost --pricing-url` overrides one run)                                                                   |
| `credits-target` | none                                  | Copilot AI credits (100 to the dollar) to stay under per month; `agent credits` paces against it (`COPILOT_CREDITS_TARGET` or `agent credits --target` overrides) |

**Proxy-side keys** are projected into the proxy's own `config.json` at `agent start`, so changing one needs a daemon restart. That file sits in the daemon's profile home, `~/.local/share/copilot-env/profiles/<name>/config.json`, with `default` as the default profile's name.

- The keys: `small-model`, the `responses-*` and `messages-api` flags, `message-websearch-model`, the `alpha-search-*` pair, `claude-auto-model`, `claude-token-multiplier`.
- One exception: the MCP `web_search` tool reads `message-websearch-model` fresh on every call.

#### Codex model catalog

`codex-model-catalog` applies at the next Codex auth refresh (within ~5 minutes) or the next `agent codex` / `agent init` wiring. Turning it off also removes the generated `codex-model-catalog.json` and the managed `model_catalog_json` reference from the Codex config.

What the generated catalog holds:

- every model the installed `codex` bundles, with every field it ships, plus GitHub Copilot's real context window and prompt cap where Copilot serves the model;
- the OpenAI-family models Copilot serves on `/responses` that this Codex does not bundle, for example `gpt-5.3-codex`, `gpt-5.6-sol-fast`, or `gpt-6-astra` on an older Codex. They are added as clones of their closest bundled relative, with Copilot's name, limits, and reasoning levels, so they appear in Codex's model picker.

Codex parses that file strictly and treats it as a replacement for its bundled catalog. A Codex build that requires a field the file lacks fails at startup with `failed to parse model_catalog_json path ...`.

copilot-env guards the installed `codex`: before writing or referencing a catalog it asks that binary to parse it, and a catalog it rejects is left out of the config.

Other Codex consumers sharing `~/.codex`, such as an IDE extension's own codex-core or a desktop app, cannot be probed. If one reports that error, run `agent codex` to regenerate from the installed CLI, or `agent config --set codex-model-catalog false` to remove the catalog.

#### Per-host CODEX_HOME

`codex-host` (Linux/macOS) is the per-host `CODEX_HOME` symlink farm switch. Setting it is refused on Windows.

```bash
agent config --set codex-host true    # false removes the farm again
```

- `agent init` / `agent codex` build the farm when the key is on, and remove it when it is off.
- `agent env` exports `CODEX_HOME` only while a wiring pass has built and activated the farm and the key is not off.
- `agent codex --check` / `agent health` report any drift between the key and the disk.

#### Claude Desktop

`claude-desktop` applies at the next `agent init`, `agent claude`, or `agent profile` wiring. Setting the key writes no Desktop file itself.

- **On:** every managed Claude write keeps a matching entry in Claude Desktop's config library, for the default and every profile, while the app is installed.
- **Off:** the same writes remove the profile entries and their credential-helper scripts. The default entry stays in place as yours, named once and never rewritten; only `agent uninstall` removes it.
- **Always:** every file created, rewritten, or removed is printed.
- **Drift:** `agent claude --check` and `agent health` report an entry missing or stale with the key on, or profile entries left behind after turning it off.

### Authentication

`agent auth` is the credential front door: one GitHub Copilot credential, resolved at fetch time. Agent configs never store a copy, and `gh-cli` holds no token of its own.

- `--provider copilot` - GitHub device flow (`read:user` scope).
- `--provider gh-cli` - use the machine's existing `gh` login.
- `--provider gh-token` - store `$COPILOT_GITHUB_TOKEN` / `$GH_TOKEN` / `$GITHUB_TOKEN`, first set wins (headless servers). `--set [token]` stores one non-interactively.
- `--get` / `--del` / `--check` - print, clear, or check that a credential resolves.

Classic and fine-grained PATs can't perform the proxy's editor token exchange. So `agent start` transparently enables a passthrough shim for PAT-shaped tokens, using the PAT as the bearer directly. Force it either way with `agent config --set passthrough on|off`.

### Profiles

A profile is an atomic unit: ONE credential + ONE mode (direct or proxy, never both), always wired into BOTH agents. Several sessions then run at once without touching the default setup.

```bash
agent profile --add work --proxy --provider gh-token --set   # credential + mode + both agents
cl --profile work        # Claude under the profile (its own proxy daemon, own port)
cx --profile work        # Codex under the same profile
agent profile --list     # NAME  MODE  PROVIDER  DAEMON
agent profile --del work # stop its daemon, clear its credential, strip both agents' wiring
```

- **No fallback:** a named profile hard-fails rather than falling back to the default credential. Re-authenticate one with `agent auth --profile <name>`.
- **Own daemon:** a proxy-mode profile runs in an isolated home (`<copilot-api home>/profiles/<name>`) on a stable reserved port, managed via `agent start/stop --profile <name>`.
- **Switch mode:** re-run `--add` with the other mode flag.
- **Web-search caveat:** a DIRECT profile over a PROXY default has no search path in Claude. The builtin 400s on Direct, and the machine-global MCP server is only registered while the default wiring is direct.
- **Workaround:** register the server by hand there, under a name other than `copilot-env`, which wiring writes reclaim.

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript entry points. Already-set shell variables win over that file, and env vars win over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: the managed-lifecycle idle window for this invocation. Beats the `idle-timeout` config key.
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a release, bypassing the cooldown and float bounds at install. `agent start` still refuses a proxy below the version floor, and the `proxy-version` config key is the persistent equivalent.
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: the cooldown window (`0` = no cooldown). Beats the `release-cooldown` config key.

Without a pin, the proxy float reads npm publish times, picks the newest version at least the cooldown window old, and clamps it to the bounds in `copilot-env.config`. The window is the env var, else `release-cooldown`, else the 7-day default that tracks `deno.json`'s `minimumDependencyAge`.

## Development

Drive the CLI from a checkout. Deps and the proxy install in place, with no separate cache.

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (deno install --frozen)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

- **Tasks:** run `deno task` for the list (typecheck, test, bench, lint, check). They are defined in `deno.json`.
- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single initializer. The Copilot coding agent and Codespaces / Dev Containers both run it.
- **More docs:** conventions, the proxy float/cooldown model, and a file-by-file breakdown live in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE.md)
