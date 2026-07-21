# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A small, self-bootstrapping CLI that manages a local
[`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api)
proxy: start/stop the daemon, wire model aliases, export env vars for your shell
and for Codex, and report estimated token spend.

TypeScript port of the original Python `copilot-api` helper. Runs on **Linux,
macOS, and Windows**.

- **Lifecycle**: `start` / `stop` the local proxy with one command — or opt in
  to the managed lifecycle (`auto-start`) that starts the proxy when an agent
  needs it and stops it after an idle window.
- **Zero setup**: auto-installs [bun](https://bun.sh), dependencies, and the
  proxy on first run. No global installs to manage.
- **Codex + Claude wiring**: point both CLIs at the local proxy or GitHub
  Copilot Direct automatically; write `~/.codex` / `~/.claude` config; build a
  per-host `CODEX_HOME` farm (Linux/macOS).
- **One credential per setup**: `agent auth` manages the GitHub Copilot token
  (device flow, `gh` CLI, or a stored PAT) as the single source of truth for the
  default setup — and one slot per named profile; PATs work through an automatic
  passthrough shim.
- **Named profiles**: `agent profile` bundles ONE credential + ONE mode (direct
  or proxy) into both agents, so several sessions run at once — direct beside
  proxy, or a second GitHub account — each proxy profile with its own daemon on
  its own port. Launch with `cl --profile <name>` / `cx --profile <name>`.
- **Typed preferences**: `agent config` gets/sets every knob — lifecycle,
  ports, proxy feature flags, model ids — with one precedence rule everywhere.
- **Cost reporting**: estimated spend from per-host usage DBs via live OpenRouter pricing.
- **Controlled floating**: the proxy floats to the newest cooldown-aged release
  within configured bounds; every other dependency is pinned via `bun.lock`.

## Install

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows (runs from any shell -- cmd, PowerShell, or the Run dialog)
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex"
```

Installs bun and copilot-env into `~/.copilot-env`, bootstraps dependencies, then wires your shell.

- **Recommended:** install from the latest GitHub release asset, not from the
  `main` branch. `main` is for development and can be temporarily ahead of the
  latest released installer flow.
- **Artifact:** the installer extracts the official `copilot-env-vX.Y.Z.tar.gz` release asset when present, verifies that asset's SHA256, and checks the archive source marker against GitHub release metadata before extraction.
- **Replaceable:** re-run the bootstrapper to replace the previous install with the selected release.
- **Next:** restart your shell, then `agent start`.
- **Optional:** run `agent shell --clis --launchers` for Claude/Copilot/Codex CLIs and `cl` / `co` / `cx`.
- **Update later:** `agent update`.
- **Specific version:** replace `latest` with an exact release tag:

  ```bash
  curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.sh | bash
  ```

  ```powershell
  powershell -c "irm https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.ps1 | iex"
  ```

### Install flags

| macOS / Linux | Windows | Effect |
| --- | --- | --- |
| `--dir DIR` | `-InstallDir DIR` | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`). |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`. |

## Usage

```bash
agent init                 # set up BOTH Codex + Claude (auto-detect direct vs the proxy) + next-step guidance
agent auth                 # manage the GitHub Copilot credential (--provider copilot|gh-cli|gh-token, --set, --get, --del, --check; --profile <name> addresses a named profile's slot, --list shows every slot)
agent profile              # manage named profiles: --add <name> --direct|--proxy (one credential + one mode, both agents), --del <name>, --list, --check <name>
agent config               # get/set preferences (--set <key> <value> / --get [key] / --del <key>; see Configuration below)
agent start                # launch the daemon and sync aliases (--dry-run to preview, --port to pin, --check to probe, --profile <name> for a profile's daemon)
agent stop                 # stop the daemon (--profile <name> for one profile's daemon, --all for every daemon)
agent health               # full environment diagnosis (--scope full|runtime|proxy|setup|auth|codex|claude, --json, --live)
agent models               # list the model ids + names Copilot serves (--proxy / --direct / --json; no flag auto-picks)
agent env                  # print shell exports for the calling shell (CODEX_HOME / proxy ANTHROPIC_BASE_URL)
agent cost                 # estimated token spend across all usage DBs (default + profile daemons)
agent update               # update to the latest release (--check; cooldown via `agent config --set update-cooldown`)
agent shell                # wire rc / $PROFILE; --launchers adds cl/co/cx, --clis installs the CLIs, --remove unwires
agent codex                # configure Codex; no flag auto-detects the backend, --check reports it
agent codex --direct       # force GitHub Copilot Direct (no auto-detect probe)
agent codex --check        # print provider mode; exits 0 direct, 2 proxy, 1 other
agent codex --host         # per-host CODEX_HOME symlink farm (Linux/macOS); --delete-host to remove
agent codex --mobile       # pair the Codex desktop app with the phone remote-control flow (interactive)
agent claude               # configure Claude; no flag auto-detects the backend, --check reports it
agent claude --direct      # force GitHub Copilot Direct for Claude (no auto-detect probe)
agent claude --check       # print Claude provider mode; exits 0 direct, 2 proxy, 1 other
```

Once the profile is wired, the same commands run via `agent` on Windows too (or
directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`).

### Shell integration

The installer wires the `agent` wrapper into your shell and exports the proxy env.

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

The `cl` / `co` / `cx` launchers are opt-in:

- `cl` reads the configured Claude provider (`agent claude --check`), starts the proxy for proxy-backed or not-yet-configured setups (re-syncing the port/token), then Claude.
- `co` runs Copilot.
- `cx` does the same as `cl` for Codex (`agent codex --check`), then Codex.
- `cl --profile <name>` / `cx --profile <name>` (leading arguments) launch under a named profile instead: the profile's wiring is honored as-is, its own daemon is ensured when proxy-mode, and the default setup is untouched.

Each has a more-permissive variant that adds the agent's most-relaxed flag: `clx` (`--dangerously-skip-permissions`), `cox` (`--allow-all`), `cxx` (`--sandbox danger-full-access`).

Enable them while installing optional CLIs:

```bash
agent shell --clis --launchers
```

Or manage only the launcher block:

```bash
agent shell --launchers
agent shell --launchers --remove
```

Manual sourcing is also supported:

```bash
source ~/.copilot-env/shell/agents.launchers.bashrc
```

```powershell
. ~/.copilot-env/shell/agents.launchers.ps1
```

### Managed proxy lifecycle (auto-start)

By default you manage the proxy yourself with `agent start` / `agent stop`.
Opt in to the managed lifecycle instead:

```bash
agent config --set auto-start true
```

With `auto-start` on:

- **Auto-start:** whenever Codex, Claude, or the `cl`/`cx` launchers need the
  proxy and it is down, it is started automatically (the shared credential
  resolver handles this — no manual `agent start`).
- **Idle auto-stop:** a watchdog inside the daemon stops the proxy after an
  idle window. Inference requests and the resolver's session heartbeats count
  as activity; health and liveness pings never keep it alive. Configure the
  window with `agent config --set idle-timeout <seconds>` (default `3600`;
  `0` disables) or the `COPILOT_API_IDLE_TIMEOUT` env var.

With `auto-start` off, the launchers prompt before starting a downed proxy;
headless callers (Codex/Claude config hooks) never start it implicitly.

### Configuration

`agent config` is the typed preference store. Every read site applies the same
precedence: **explicit flag/env (per-invocation) > stored config > built-in
default**.

```bash
agent config --get                    # print all preferences
agent config --set auto-start true    # set one
agent config --del idle-timeout       # revert one to its default
```

| Key | Default | Effect |
| --- | --- | --- |
| `auto-start` | `false` | Managed proxy lifecycle: auto-start on agent open + idle auto-stop. |
| `codex-model-catalog` | `false` | Patched Codex model catalog serving Copilot's real context windows (opt-in). |
| `idle-timeout` | `3600` | Idle auto-stop window in seconds (`0` disables). |
| `min-port` / `max-port` | `1024` / `65535` | Allowed proxy port range. |
| `message-websearch-model` | proxy default | Model id the proxy uses for Messages-API web search. |
| `messages-api` | `true` | Proxy Messages-API (Anthropic-shaped) endpoint. |
| `passthrough` | `auto` | PAT passthrough: `auto` / `on` / `off` (see below). |
| `port` | `4141` | Default proxy port (then next free unless `strict-port`). |
| `proxy-logs` | `true` | Proxy request logging under `<home>/logs` (`false` discards the writes). |
| `proxy-version` | latest (floated) | Pin the floated proxy to a version/tag. |
| `release-cooldown` | bunfig `minimumReleaseAge` | Proxy float supply-chain cooldown in seconds. |
| `responses-context-management` | proxy default | Proxy Responses-API server-side context management. |
| `responses-websearch` | `true` | Proxy Responses-API web search. |
| `responses-websocket` | `true` | Proxy Responses-API transport: WebSocket vs HTTP/SSE. |
| `small-model` | `gpt-5-mini` | Small/fast model id the proxy uses. |
| `strict-port` | `false` | Fail `start` when the default port is busy instead of auto-incrementing. |
| `update-cooldown` | none | `agent update` cooldown in days. |

Proxy-side keys (`small-model`, the `responses-*`/`messages-api` flags,
`message-websearch-model`) are projected into the proxy's own `config.json` at
`agent start`, so changing them needs a daemon restart to take effect.

`codex-model-catalog` applies at the next Codex auth refresh (within ~5
minutes) or `agent codex`/`agent init` wiring; turning it off also removes the
generated `codex-model-catalog.json` and the managed `model_catalog_json`
reference from the Codex config.

### Authentication

`agent auth` is the credential front door — one GitHub Copilot credential,
resolved at fetch time (agent configs never store a copy; `gh-cli` holds no
token of its own and defers to the machine's `gh` login):

- `--provider copilot` — GitHub device flow (`read:user` scope).
- `--provider gh-cli` — use the machine's existing `gh` login.
- `--provider gh-token` — store `$COPILOT_GITHUB_TOKEN`/`$GH_TOKEN`/`$GITHUB_TOKEN`
  (first set wins; headless servers); `--set [token]` stores one non-interactively.
- `--get` / `--del` / `--check` — print, clear, or check that a credential resolves.

Classic and fine-grained PATs can't perform the proxy's editor token exchange,
so `agent start` transparently enables a passthrough shim for PAT-shaped
tokens that uses the PAT as the bearer directly. Force it either way with
`agent config --set passthrough on|off`.

### Profiles

A profile is an atomic unit — ONE credential + ONE mode (direct or proxy,
never both) — always wired into BOTH agents, so several sessions run at once
without touching the default setup:

```bash
agent profile --add work --proxy --provider gh-token --set   # own credential + mode + both agents, one command
cl --profile work        # Claude under the profile (its own proxy daemon, own port)
cx --profile work        # Codex under the same profile
agent profile --list     # NAME  MODE  PROVIDER  DAEMON
agent profile --del work # stop its daemon, clear its credential, strip both agents' wiring
```

Named profiles hard-fail rather than falling back to the default credential;
re-authenticate one with `agent auth --profile <name>`. A proxy-mode profile
gets its own daemon in an isolated home (`<copilot-api home>/profiles/<name>`)
on a stable reserved port, managed via `agent start/stop --profile <name>`.
Re-running `--add` with the other mode flag switches the profile's mode.

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript
entry points; already-set shell environment variables take precedence, and env
vars take precedence over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: override the managed-lifecycle idle
  window for this invocation (beats the `idle-timeout` config key).
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a specific release
  (bypasses the cooldown and float bounds at install; `agent start` still
  refuses a proxy below the version floor. The `proxy-version` config key is
  the persistent equivalent).
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: override the cooldown window
  (`0` = no cooldown), taking precedence over the `release-cooldown` config
  key and `bunfig.toml`'s `install.minimumReleaseAge`.

Without a pin, the proxy float reads npm publish times, picks the newest
version at least the cooldown window old (env var, else `release-cooldown`
config, else `bunfig.toml`'s `install.minimumReleaseAge`), and clamps it to
the bounds in `copilot-env.config`.

## Development

Drive the CLI from a checkout (deps + proxy install in-place; no separate cache):

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (bun install --frozen-lockfile)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

```bash
bun run typecheck   # tsc --noEmit
bun test            # test/**/*.test.ts
bun run lint        # biome check src bin test scripts
bun run check       # biome check --write src bin test scripts
```

- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single
  initializer; the Copilot coding agent and Codespaces / Dev Containers both run it.
- **More docs:** conventions, the proxy float/cooldown model, and a file-by-file
  breakdown live in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
