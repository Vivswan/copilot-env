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
  if it is missing, install dependencies + the gateway, and spawn the daemon
  directly. No global installs to manage. By default deps go straight into the
  checkout; `local_cache_start` opts into a separate per-user cache instead.
- **Model aliases** — once the daemon is up, catalog-derived aliases are synced
  live via the admin API and printed grouped by target model.
- **Shell + Codex wiring** — `env` prints the variables to point your tools at the
  local gateway (the `agent` shell wrapper applies them automatically); `agent
  codex_config` writes your `~/.codex` config wired to the gateway, and `agent
  host_codex` builds a per-host `CODEX_HOME` symlink farm on Linux.
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

For extra supply-chain safety, add `--cooldown`. It applies a delay to **both**
the agent CLIs (`claude` / `copilot` / `codex`) **and** the copilot-env checkout
itself (override the 7-day default with `--cooldown=DAYS`): each CLI installs the
newest npm release whose **publish time** is ≥ 7 days ago instead of bleeding-edge
`latest`, and the installer-managed clone is rolled back to the newest `main`
commit **dated** ≥ 7 days ago, never below a manually-vetted known-good baseline
commit. (The npm side uses the registry's publish timestamp; the repo side uses
the commit date, which is advisory — the pinned baseline floor is the hard
anchor.) The same delay the gateway's own dependencies already get, it defends
against a compromised just-published npm release or just-pushed commit (note:
`--cooldown` governs *fresh* CLI installs — an already-installed `claude` /
`copilot` / `codex` is left untouched, never downgraded):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash -s -- --cooldown
```

```powershell
# Windows (from a checkout; -CooldownDays N overrides the 7-day default)
powershell -ExecutionPolicy Bypass -File install.ps1 -Cooldown
```

Prefer to drive the CLI directly from a manual checkout? That works too:

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
./bin/agent --help        # or: powershell -File bin\agent.ps1 --help
```

By default the first invocation installs dependencies + the gateway directly in
the checkout and runs from there — no cache. `local_cache_start` instead builds a
separate per-user cache, following OS conventions:

| OS      | Cache directory                       |
| ------- | ------------------------------------- |
| Linux   | `~/.cache/copilot-env`                |
| macOS   | `~/Library/Caches/copilot-env`        |
| Windows | `%LOCALAPPDATA%\copilot-env\Cache`    |

## Usage

```bash
./bin/agent start      # install deps + gateway in-place, launch the daemon, sync aliases
./bin/agent start --dry-run  # preview the resolved start plan without runtime changes
./bin/agent local_cache_start  # like start, but in a per-user cache (symlink on macOS/Linux, copy on Windows)
./bin/agent env        # print shell env vars pointing at the local gateway
./bin/agent cost       # estimated token spend across all per-host usage DBs
./bin/agent stop       # stop the daemon
./bin/agent health     # check the gateway is reachable (exit 1 if not)

./bin/agent codex_config   # write Codex config into ~/.codex, wired to the gateway
./bin/agent host_codex     # per-host CODEX_HOME symlink farm (Linux-only)
```

On Windows, use the PowerShell launcher `bin/agent.ps1`
(e.g. `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 codex_config`).
`codex_config` writes config to `~/.codex` (`%USERPROFILE%\.codex`) by default, which
Codex reads natively; the per-host symlink farm (`host_codex`) is Linux-only and
rarely needed.

### Environment overrides

- `COPILOT_API_VERSION=<version|tag>` — pin the gateway to a specific release,
  bypassing both the compatibility floor and the 7-day cooldown. Unset = float to
  the newest release that is both ≥ the floor and ≥7 days old.

### Shell integration

The one-line installer above already wires this up — it adds a source block for
`agents.bashrc` to `~/.bashrc` and/or `~/.zshrc` (or dot-sources `agents.ps1`
from your PowerShell `$PROFILE` on Windows). `agents.bashrc` defines an `agent`
wrapper (`agent start` launches the gateway and applies its env into your shell;
`agent codex_config` / `agent host_codex` wire Codex; anything else passes
through to the CLI) plus `cl` / `co` / `cx` launchers.

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
bash scripts/setup-env.sh  # one-shot env/worktree init (bun install --frozen-lockfile)
bun install                # install dev/runtime deps
bun run typecheck          # tsc --noEmit
bun run lint               # biome check src bin
bun run format             # biome format --write src bin
bun run check              # biome check --write src bin
```

`scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows) is the single
environment initializer — the GitHub Copilot coding agent, Codespaces / Dev
Containers, Claude Code worktrees, and Codex worktrees all run it so the env
comes up ready (see [`AGENTS.md`](./AGENTS.md) → "Agent & dev environment init").

Conventions, the gateway floating/cooldown model, and a file-by-file breakdown are
documented in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
