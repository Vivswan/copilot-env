# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE.md)

A small, self-bootstrapping CLI that manages a local [`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api) proxy: start/stop the daemon, wire model aliases, export env vars for your shell and for Codex, and report estimated token spend.

TypeScript port of the original Python `copilot-api` helper. Runs on **Linux, macOS, and Windows**.

- **Lifecycle**: `start` / `stop` the local proxy with one command - or opt in to the managed lifecycle (`auto-start`) that starts the proxy when an agent needs it and stops it after an idle window.
- **Zero setup**: the CLI ships as one self-contained binary - no runtime and no package manager to install first. The proxy and what it needs to run are fetched on first use, never installed globally.
- **Codex + Claude wiring**: point both CLIs at the local proxy or GitHub Copilot Direct automatically; write `~/.codex` / `~/.claude` config; build a per-host `CODEX_HOME` farm (Linux/macOS). A Codex Direct config pins `service_tier = "default"` (Copilot rejects the `priority` tier Codex 0.153.x may otherwise ask for under fast mode; `flex` is kept), and `agent codex --check` reports the tier.
- **One credential per setup**: `agent auth` manages the GitHub Copilot token (device flow, `gh` CLI, or a stored PAT) as the single source of truth for the default setup - and one slot per named profile; PATs work through an automatic passthrough shim.
- **Named profiles**: `agent profile` bundles ONE credential + ONE mode (direct or proxy) into both agents, so several sessions run at once - direct beside proxy, or a second GitHub account - each proxy profile with its own daemon on its own port. Launch with `cl --profile <name>` / `cx --profile <name>`.
- **Typed preferences**: `agent config` gets/sets every knob - lifecycle, ports, proxy feature flags, model ids - with one precedence rule everywhere.
- **Web search for Claude Code on Direct**: the builtin WebSearch does not work against Copilot's Anthropic endpoint, so direct wiring registers the copilot-env MCP server (`agent mcp --serve`), whose `web_search` tool searches through Copilot's Responses API instead.
- **Cost reporting**: estimated spend from per-host usage DBs via live OpenRouter pricing.
- **Controlled floating**: the proxy floats to the newest cooldown-aged release within configured bounds; every other dependency is pinned via `deno.lock`.

## Install

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows (runs from any shell -- cmd, PowerShell, or the Run dialog)
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex"
```

Downloads a single self-contained `agent` binary for your platform into `~/.copilot-env`, then wires your shell. There is no runtime or package manager to install first.

- **Recommended:** install from the latest GitHub release asset, not from the `main` branch. `main` is for development and can be temporarily ahead of the latest released installer flow.
- **Verified:** the installer checks the binary's SHA256 against the release's `checksums.txt` before it puts it anywhere. That proves the download is intact, not who built it (the installer is fetched from the same release, so a first install trusts it on first use). Every release also carries a build-provenance attestation, `attestation.json`, that you can check by hand with the GitHub CLI's closest equivalent of the policy `agent update` enforces: built in this repository (`-R`, by name where `agent update` pins the immutable repository id), on `main` (`--source-ref`), by its release workflow (`--cert-identity`), for the binary AND `checksums.txt`:

  ```bash
  for f in copilot-env-<target> checksums.txt; do
    gh attestation verify "$f" -R Vivswan/copilot-env --source-ref refs/heads/main --bundle attestation.json \
      --cert-identity https://github.com/Vivswan/copilot-env/.github/workflows/release.yml@refs/heads/main
  done
  ```

- **Replaceable:** re-run the installer any time to move to the selected release.
- **Next:** restart your shell, then `agent start`.
- **Optional:** run `agent shell --clis --launchers` for Claude/Copilot/Codex CLIs and `cl` / `co` / `cx`.
- **Update later:** `agent update` downloads the newest release's binary, checks its SHA256 against `checksums.txt`, then verifies both against the release's Sigstore build-provenance attestation - it must be signed by this repository's GitHub Actions release workflow, and both files must be among the attested bytes - and only then swaps it in place. That check is on by default; `agent update --no-verify` skips it once and `agent config --set verify-provenance false` turns it off. Your config, credentials, and profiles live outside the install directory and are untouched.
- **Uninstall:** `agent uninstall` removes everything copilot-env manages (daemons, profiles, agent wiring, shell integration, credentials, data, and the install itself). It does not remove the agent CLIs (`claude` / `copilot` / `codex`).
- **Specific version:** replace `latest` with an exact release tag, or pass `--version`:

  ```bash
  curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.sh | bash
  ```

  ```powershell
  powershell -c "irm https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.ps1 | iex"
  ```

> **Upgrading from 3.5.6 or earlier?** Those versions installed a source tree and bootstrapped a runtime into it, and `agent update` cannot cross that gap. Re-run the installer above once; it replaces the old layout in place (removing the `node_modules` it left behind) and every later update is the ordinary binary swap. Your settings are not stored in the install directory, so nothing is lost.

### Install flags

| macOS / Linux | Windows | Effect |
| --- | --- | --- |
| `--dir DIR` | `-InstallDir DIR` | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`). |
| `--version TAG` | `-Version TAG` | Install an exact release tag instead of the default. |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`. |

## Usage

```bash
agent init                 # set up BOTH Codex + Claude (auto-detect direct vs the proxy) + next-step guidance
agent launch <cli>         # launch claude|codex|copilot with the managed flags + provider wiring (--profile <name>, --relaxed; agent args after --)
agent auth                 # manage the GitHub Copilot credential (--provider copilot|gh-cli|gh-token, --set, --get, --del, --check; --profile <name> addresses a named profile's slot, --list shows every slot)
agent profile              # manage named profiles: --add <name> --direct|--proxy (one credential + one mode, both agents), --del <name>, --list, --check <name>
agent config               # get/set preferences (--set <key> <value> / --get [key] / --del <key>; see Configuration below)
agent settings             # export/import every portable setting as one JSON bundle (--export [file] / --import <file>; --with-credentials, --force, --no-backup; import is non-destructive - prefs are full-replace, credentials preserve-if-absent - and backs up the stores first; a rollback re-imports the backup but never deletes profiles)
agent start                # launch the daemon and sync aliases (--dry-run to preview, --port to pin, --check to probe, --profile <name> for a profile's daemon)
agent stop                 # stop the daemon (--profile <name> for one profile's daemon, --all for every daemon)
agent health               # full environment diagnosis (--scope full|runtime|proxy|setup|auth|codex|claude, --json, --live)
agent models               # list the model ids + names Copilot serves (--proxy / --direct / --json; no flag auto-picks)
agent env                  # print shell directives for the calling shell (CODEX_HOME / proxy ANTHROPIC_BASE_URL exports + the opt-in launcher functions)
agent mcp                  # MCP wiring status (--serve runs the stdio server; --remove unwires)
agent cost                 # estimated token spend across all usage DBs (default + profile daemons)
agent update               # update to the latest release (--check; --no-verify skips the provenance check; cooldown via `agent config --set update-cooldown`)
agent shell                # wire rc / $PROFILE; --launchers enables cl/co/cx, --clis installs the CLIs, --remove unwires
agent uninstall            # remove copilot-env entirely (--yes headless, --dry-run preview, --force to delete a source checkout)
agent codex                # configure Codex; no flag auto-detects the backend, --check reports it
agent codex --direct       # force GitHub Copilot Direct (no auto-detect probe)
agent codex --check        # print provider mode; exits 0 direct, 2 proxy, 1 other
agent codex --host         # per-host CODEX_HOME symlink farm (Linux/macOS); --delete-host to remove
agent codex --mobile       # pair the Codex desktop app with the phone remote-control flow (interactive)
agent claude               # configure Claude; no flag auto-detects the backend, --check reports it
agent claude --direct      # force GitHub Copilot Direct for Claude (no auto-detect probe)
agent claude --check       # print Claude provider mode; exits 0 direct, 2 proxy, 1 other
```

Once the profile is wired, the same commands run via `agent` on Windows too (or directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`).

### Shell integration

The installer wires the `agent` wrapper into your shell and exports the proxy env.

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

The `cl` / `co` / `cx` launchers are opt-in shell functions over `agent launch`:

- `cl` (`agent launch claude`) reads the configured Claude provider, starts the proxy for proxy-backed or not-yet-configured setups (re-syncing the port/token), then Claude.
- `co` (`agent launch copilot`) runs Copilot.
- `cx` (`agent launch codex`) does the same as `cl` for Codex, then Codex.
- `cl --profile <name>` / `cx --profile <name>` (leading arguments) launch under a named profile instead: the profile's wiring is honored as-is, its own daemon is ensured when proxy-mode, and the default setup is untouched.

Each has a more-permissive variant that adds the agent's most-relaxed flag (`agent launch ... --relaxed`): `clx` (`--dangerously-skip-permissions`), `cox` (`--allow-all`), `cxx` (`--sandbox danger-full-access`).

Enable them while installing optional CLIs:

```bash
agent shell --clis --launchers
```

Or toggle only the launchers (the `launchers` config key; `agent env` defines the functions in each new shell):

```bash
agent shell --launchers
agent shell --launchers --remove
```

`agent launch <claude|codex|copilot> [--profile <name>] [--relaxed] -- <args...>` works directly too, without the shell functions.

### Managed proxy lifecycle (auto-start)

By default you manage the proxy yourself with `agent start` / `agent stop`. Opt in to the managed lifecycle instead:

```bash
agent config --set auto-start true
```

With `auto-start` on:

- **Auto-start:** whenever Codex, Claude, or the `cl`/`cx` launchers need the proxy and it is down, it is started automatically (the shared credential resolver handles this - no manual `agent start`).
- **Idle auto-stop:** a watchdog inside the daemon stops the proxy after an idle window. Inference requests and the resolver's session heartbeats count as activity; health and liveness pings never keep it alive. Configure the window with `agent config --set idle-timeout <seconds>` (default `3600`; `0` disables) or the `COPILOT_API_IDLE_TIMEOUT` env var.

With `auto-start` off, the launchers prompt before starting a downed proxy; headless callers (Codex/Claude config hooks) never start it implicitly.

### Web search for Claude Code

Claude Code wired to GitHub Copilot Direct cannot use its builtin WebSearch: Copilot's Anthropic-compatible endpoint rejects the server-side search tool with a 400. Copilot's own Responses API does serve web search, so copilot-env ships an MCP stdio server (`agent mcp --serve`) whose `web_search` tool proxies through it and returns a cited answer with a `Sources:` list (bare `agent mcp` prints the wiring status).

Wiring Claude direct (`agent init`, `agent claude --direct`) sets this up by itself: it registers the server in Claude Code's user scope and denies the broken builtin, and a proxy write takes both back (through the local proxy the builtin WebSearch works, so nothing is needed there). The pair is opt-out:

```bash
agent mcp --remove                  # unregister + restore the builtin + remember the opt-out
agent config --set wire-mcp true    # opt back in (applies on the next direct wiring)
```

The search model follows `message-websearch-model` (default `gpt-5.6-sol` on this surface), read on every call - no restart:

```bash
agent config --set message-websearch-model gpt-5.6-sol
```

The server is client-agnostic. Register it in Codex, Cursor, or any other MCP client by pointing at the launcher (Codex itself needs no MCP for search - it speaks the Responses API natively):

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

It resolves the `agent auth` credential; without one it falls back to `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`, so a bare clone works: `GH_TOKEN=... bin/agent mcp --serve`. The registered server uses the default credential; a named profile that needs its own registers a second entry with `--profile <name>`.

The repo also doubles as a Claude Code plugin and a skills collection: the plugin (`.claude-plugin/`) bundles the MCP server inline in its manifest, and `npx skills add Vivswan/copilot-env` installs the companion [`web-search` skill](./skills/web-search). The plugin's bundled registration runs `bin/agent`, a POSIX script - on Windows, wire through `agent init` or register `bin\agent.ps1` by hand instead.

### Configuration

`agent config` is the typed preference store. Every read site applies the same precedence: **explicit flag/env (per-invocation) > stored config > built-in default**.

```bash
agent config --get                    # print all preferences
agent config --set auto-start true    # set one
agent config --del idle-timeout       # revert one to its default
```

| Key | Default | Effect |
| --- | --- | --- |
| `alpha-search-codex-priority` | `true` | Prefer Codex for the proxy's `/alpha/search` endpoint (Codex search). |
| `alpha-search-model` | `gpt-5-mini` | Native-Responses model for `/alpha/search` (Codex search) when the requested model is Messages-backed and cannot run the search itself. |
| `auto-start` | `false` | Managed proxy lifecycle: auto-start on agent open + idle auto-stop. |
| `claude-auto-model` | unset | Model override for Claude Code's background security-monitor requests (unset disables). |
| `claude-token-multiplier` | `1.15` | Multiplier the proxy applies when estimating Claude token usage. |
| `codex-model-catalog` | `false` | Patched Codex model catalog serving Copilot's real context windows (opt-in). |
| `idle-timeout` | `3600` | Idle auto-stop window in seconds (`0` disables). |
| `integration-id` | `auto` (probe per credential) | Pin the Copilot client identity (`Copilot-Integration-Id`), or `auto` to probe per credential. |
| `launchers` | `false` | Define the `cl` / `co` / `cx` (+ `clx` / `cox` / `cxx`) launcher functions via `agent env`. |
| `min-port` / `max-port` | `1024` / `65535` | Allowed proxy port range. |
| `message-websearch-model` | per surface | Web-search model id: the proxy's Messages-API path (default `gpt-5-mini`) and the MCP `web_search` tool (default `gpt-5.6-sol`). |
| `messages-api` | `true` | Proxy Messages-API (Anthropic-shaped) endpoint. |
| `passthrough` | `auto` | PAT passthrough: `auto` / `on` / `off` (see below). |
| `port` | `4141` | Default proxy port (then next free unless `strict-port`). |
| `proxy-logs` | `true` | Proxy request logging under `<home>/logs` (`false` discards the writes). |
| `proxy-version` | latest (floated) | Pin the floated proxy to a version/tag. |
| `release-cooldown` | `604800` (7 days) | Proxy float supply-chain cooldown in seconds. |
| `responses-context-management` | `false` | Proxy Responses-API server-side context management. |
| `responses-websearch` | `true` | Proxy Responses-API web search. |
| `responses-websocket` | `true` | Proxy Responses-API transport: WebSocket vs HTTP/SSE. |
| `small-model` | `gpt-5-mini` | Small/fast model id the proxy uses. |
| `strict-port` | `false` | Fail `start` when the default port is busy instead of auto-incrementing. |
| `update-cooldown` | none | `agent update` cooldown in days. |
| `verify-provenance` | `true` | Verify `agent update` downloads against the release's Sigstore build-provenance attestation (`agent update --no-verify` skips one run). |
| `wire-mcp` | `true` | Wire the copilot-env MCP server + WebSearch deny into Claude on direct writes. |

Proxy-side keys (`small-model`, the `responses-*`/`messages-api` flags, `message-websearch-model`, the `alpha-search-*` pair, `claude-auto-model`, `claude-token-multiplier`) are projected into the proxy's own `config.json` at `agent start`, so changing them needs a daemon restart to take effect - except that the MCP `web_search` tool reads `message-websearch-model` fresh on every call.

`codex-model-catalog` applies at the next Codex auth refresh (within ~5 minutes) or `agent codex`/`agent init` wiring; turning it off also removes the generated `codex-model-catalog.json` and the managed `model_catalog_json` reference from the Codex config.

### Authentication

`agent auth` is the credential front door - one GitHub Copilot credential, resolved at fetch time (agent configs never store a copy; `gh-cli` holds no token of its own and defers to the machine's `gh` login):

- `--provider copilot` - GitHub device flow (`read:user` scope).
- `--provider gh-cli` - use the machine's existing `gh` login.
- `--provider gh-token` - store `$COPILOT_GITHUB_TOKEN`/`$GH_TOKEN`/`$GITHUB_TOKEN` (first set wins; headless servers); `--set [token]` stores one non-interactively.
- `--get` / `--del` / `--check` - print, clear, or check that a credential resolves.

Classic and fine-grained PATs can't perform the proxy's editor token exchange, so `agent start` transparently enables a passthrough shim for PAT-shaped tokens that uses the PAT as the bearer directly. Force it either way with `agent config --set passthrough on|off`.

### Profiles

A profile is an atomic unit - ONE credential + ONE mode (direct or proxy, never both) - always wired into BOTH agents, so several sessions run at once without touching the default setup:

```bash
agent profile --add work --proxy --provider gh-token --set   # own credential + mode + both agents, one command
cl --profile work        # Claude under the profile (its own proxy daemon, own port)
cx --profile work        # Codex under the same profile
agent profile --list     # NAME  MODE  PROVIDER  DAEMON
agent profile --del work # stop its daemon, clear its credential, strip both agents' wiring
```

Named profiles hard-fail rather than falling back to the default credential; re-authenticate one with `agent auth --profile <name>`. A proxy-mode profile gets its own daemon in an isolated home (`<copilot-api home>/profiles/<name>`) on a stable reserved port, managed via `agent start/stop --profile <name>`. Re-running `--add` with the other mode flag switches the profile's mode. One web-search caveat: a DIRECT profile over a PROXY default has no search path in Claude (the builtin 400s on Direct, and the machine-global MCP server is only registered while the default wiring is direct) - register the server by hand there if you need it, under a name other than `copilot-env` (wiring writes reclaim that name).

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript entry points; already-set shell environment variables take precedence, and env vars take precedence over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: override the managed-lifecycle idle window for this invocation (beats the `idle-timeout` config key).
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a specific release (bypasses the cooldown and float bounds at install; `agent start` still refuses a proxy below the version floor. The `proxy-version` config key is the persistent equivalent).
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: override the cooldown window (`0` = no cooldown), taking precedence over the `release-cooldown` config key.

Without a pin, the proxy float reads npm publish times, picks the newest version at least the cooldown window old (env var, else `release-cooldown` config, else the 7-day default that tracks `deno.json`'s `minimumDependencyAge`), and clamps it to the bounds in `copilot-env.config`.

## Development

Drive the CLI from a checkout (deps + proxy install in-place; no separate cache):

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (deno install --frozen)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

```bash
deno task typecheck   # deno check src/ test/ scripts/ .github/scripts/
deno task test        # test/**/*.test.ts
deno task test:docker # the same suite in a container (hermetic HOME)
deno task lint        # deno lint + deno fmt --check
deno task check       # deno lint --fix + deno fmt
```

- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single initializer; the Copilot coding agent and Codespaces / Dev Containers both run it.
- **More docs:** conventions, the proxy float/cooldown model, and a file-by-file breakdown live in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE.md)
