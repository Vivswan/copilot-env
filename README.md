# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A small, self-bootstrapping CLI that manages the lifecycle of a local
[`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api)
gateway — starting and stopping the daemon, wiring up model aliases, exporting
environment variables for your shell and for Codex, and reporting estimated
token spend.

It is a TypeScript port of an original Python `copilot-api` helper, and runs on
**Linux, macOS, and Windows**.

## What it does

- **Lifecycle** — `start` / `stop` the local gateway daemon with a single command.
- **Zero-setup runtime** — the `bin/` launchers auto-install [bun](https://bun.sh)
  if it is missing, bootstrap dependencies into a per-user cache, and spawn the
  daemon directly. No global installs to manage.
- **Model aliases** — once the daemon is up, catalog-derived aliases are synced
  live via the admin API and printed grouped by target model.
- **Shell + Codex wiring** — `env` prints the variables to point your tools at the
  local gateway; `agent start` also wires Codex to it by default (writing your
  `~/.codex` config), and `agent codex` re-runs that on demand.
- **Cost reporting** — `cost` reads the gateway's per-host usage databases and
  prints estimated spend using live OpenRouter pricing.
- **Supply-chain hygiene** — the gateway dependency floats to `latest` but only
  adopts releases that have been public for ≥7 days (a cooldown enforced in
  `bunfig.toml`); every other dependency is pinned via the committed `bun.lock`.

## Requirements

The installer sets up everything for you (Node via [nvm](https://github.com/nvm-sh/nvm),
[bun](https://bun.sh), and the agent CLIs on macOS/Linux; Git, Node, Bun, and the
agent CLIs via `winget` on Windows). `git` is the only thing you need up front on
macOS/Linux — and the installer will attempt to install it via your system
package manager if it is missing.

## Install

One line — clones into `~/.copilot-env` (override with `COPILOT_ENV_DIR`),
installs prerequisites + the agent CLIs, and wires up your shell:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
```

Re-running the same command later **updates** an existing checkout (`git pull`)
and is otherwise idempotent.

Prefer to drive the CLI directly from a manual checkout? That works too:

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
./bin/copilot-api --help        # or: powershell -File bin\copilot-api.ps1 --help
```

The first invocation bootstraps a per-user cache (dependencies + gateway) following
OS conventions:

| OS      | Cache directory                       |
| ------- | ------------------------------------- |
| Linux   | `~/.cache/copilot-env`                |
| macOS   | `~/Library/Caches/copilot-env`        |
| Windows | `%LOCALAPPDATA%\copilot-env\Cache`    |

## Usage

```bash
./bin/copilot-api start      # wipe + rebuild the cache, launch the daemon, sync aliases
./bin/copilot-api start --dry-run  # preview the resolved start plan without runtime changes
./bin/copilot-api env        # print shell env vars pointing at the local gateway
./bin/copilot-api cost       # estimated token spend across all per-host usage DBs
./bin/copilot-api stop       # stop the daemon

./bin/codex-home --base-url <url> --api-key <key>   # write Codex config into ~/.codex
```

On Windows, use the PowerShell launchers: `bin/copilot-api.ps1` and
`bin/codex-home.ps1` (e.g. `powershell -ExecutionPolicy Bypass -File bin\codex-home.ps1`).
`codex-home` writes config to `~/.codex` (`%USERPROFILE%\.codex`) by default, which
Codex reads natively; the `--hostname-path` / `--symlink-farm` per-host layout is
Linux-only and rarely needed.

### Environment overrides

- `COPILOT_API_VERSION=<version|tag>` — pin the gateway to a specific release,
  bypassing both the compatibility floor and the 7-day cooldown. Unset = float to
  the newest release that is both ≥ the floor and ≥7 days old.

### Shell integration

The one-line installer above already wires this up — it adds a source block for
`agents.bashrc` to `~/.bashrc` and/or `~/.zshrc` (or dot-sources `agents.ps1`
from your PowerShell `$PROFILE` on Windows). `agents.bashrc` defines an `agent`
dispatcher (`agent start` launches the gateway and wires Codex to it by default,
`agent codex` re-wires Codex on demand, anything else passes through to the CLI)
plus `cl` / `co` / `cx` launchers.

From a manual checkout you can run the installer directly (idempotent —
re-running skips files that already have the block, and updates the checkout):

```bash
./install.sh          # install prereqs + source agents.bashrc
```

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Then restart your shell (or `source` your rc / `. $PROFILE`) and use `agent start`
to launch the gateway, or `cl` / `co` / `cx` to launch an agent.

## Development

```bash
bun install                # install dev/runtime deps
bun run typecheck          # tsc --noEmit
bun run lint               # biome check src bin
bun run format             # biome format --write src bin
bun run check              # biome check --write src bin
```

Conventions, the gateway floating/cooldown model, and a file-by-file breakdown are
documented in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
