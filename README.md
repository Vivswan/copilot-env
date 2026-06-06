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
  directly. No global installs to manage. Dependencies install straight into the
  checkout (in-place, no cache).
- **Model aliases** — once the daemon is up, catalog-derived aliases are synced
  live via the admin API and printed grouped by target model.
- **Shell + Codex wiring** — `env` prints the variables to point your tools at the
  local gateway (the `agent` shell wrapper applies them automatically); `agent
  codex-config` writes your `~/.codex` config wired to the gateway, and `agent
  host-codex` builds a per-host `CODEX_HOME` symlink farm on Linux.
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

One line — downloads the latest **release** into `~/.copilot-env` (override with the
`COPILOT_ENV_DIR` env var, or the `--dir DIR` / `-InstallDir DIR` flag, which takes
precedence), installs prerequisites + the agent CLIs, and wires up your shell:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
```

Re-running installs only — it **completes or repairs** an existing checkout and
is otherwise idempotent. To move the install to a newer release later, run
`agent update`; to (re)wire your shell, run `agent shell-integration`.

For extra supply-chain safety, add `--cooldown`. It applies a delay to **both**
the agent CLIs (`claude` / `copilot` / `codex`) **and** the copilot-env release
itself (override the 7-day default with `--cooldown=DAYS`): each CLI installs the
newest npm release whose **publish time** is ≥ 7 days ago instead of bleeding-edge
`latest`, and the installer downloads the newest copilot-env **release** whose
**publish time** is ≥ 7 days ago (falling back to the oldest release if none has aged in yet).
The same delay the gateway's own dependencies already get, it defends against a
compromised just-published npm release or just-cut copilot-env release (note:
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

In a managed environment where the toolchain is provided externally, add
`--no-prereqs` (`-NoPrereqs` on Windows) to **verify** prerequisites instead of
installing them. A missing *necessary* tool (`bun`) is a fatal error; a missing
*optional* tool (Node/npm, the agent CLIs) is a warning. The repo download and
shell wiring still run.

To install but never use `sudo` or a system package manager (`brew`/`apt`/…, or
`winget` on Windows), add `--local-install` (`-LocalInstall`). Tools with a
user-local installer (bun via curl/`irm`, Node via nvm on Unix, the agent CLIs
via npm) install as usual; Node on Windows comes only from a package manager and
is not installed — a missing Node/agent-CLI is then a warning. (`--no-prereqs` and
`--local-install` are mutually exclusive.)

Prefer to drive the CLI directly from a manual checkout? That works too:

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
./bin/agent --help        # or: powershell -File bin\agent.ps1 --help
```

Every invocation installs dependencies + the gateway directly in the checkout
(in-place) and runs from there — there is no separate cache.

## Usage

```bash
./bin/agent start      # install deps + gateway in-place, launch the daemon, sync aliases
./bin/agent start --dry-run  # preview the resolved start plan without runtime changes
./bin/agent env        # print shell env vars pointing at the local gateway
./bin/agent cost       # estimated token spend across all per-host usage DBs
./bin/agent stop       # stop the daemon
./bin/agent health     # check the gateway is reachable (exit 1 if not)
./bin/agent update     # update the checkout to the latest release (--check / --cooldown)
./bin/agent shell-integration  # (re)wire rc / $PROFILE (--remove to unwire)

./bin/agent codex-config   # write Codex config into ~/.codex, wired to the gateway
./bin/agent host-codex     # per-host CODEX_HOME symlink farm (Linux-only)
```

On Windows, use the PowerShell launcher `bin/agent.ps1`
(e.g. `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 codex-config`).
`codex-config` writes config to `~/.codex` (`%USERPROFILE%\.codex`) by default, which
Codex reads natively; the per-host symlink farm (`host-codex`) is Linux-only and
rarely needed.

### Environment overrides

The gateway float runs as `bun install`'s postinstall and reads these from the
environment (inherited straight through, e.g. `COPILOT_API_COOLDOWN_DAYS=14 ./bin/agent start`):

- `COPILOT_API_VERSION=<version|tag>` — pin the gateway to a specific release,
  bypassing both the compatibility floor and the 7-day cooldown. Unset = float to
  the newest release that is both ≥ the floor and ≥7 days old.
- `COPILOT_API_COOLDOWN_DAYS=<n>` — override the float's release-age window (the
  default 7-day supply-chain cooldown) for the newest-release probe.
- `COPILOT_API_FLOAT_INTERVAL_DAYS=<n>` — override how often (default weekly) the
  float re-resolves the newest release from the registry.
- `COPILOT_API_NO_FLOAT=1` — skip the gateway float entirely.

### Shell integration

The one-line installer above already wires this up — it adds a source block for
`agents.bashrc` to `~/.bashrc` and/or `~/.zshrc` (or dot-sources `agents.ps1`
from your PowerShell `$PROFILE` on Windows). `agents.bashrc` defines an `agent`
wrapper (`agent start` launches the gateway and applies its env into your shell;
`agent codex-config` / `agent host-codex` wire Codex; anything else passes
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
bun run lint               # biome check src bin test scripts
bun run format             # biome format --write src bin test scripts
bun run check              # biome check --write src bin test scripts
```

`scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows) is the single
environment initializer — the GitHub Copilot coding agent, Codespaces / Dev
Containers, Claude Code worktrees, and Codex worktrees all run it so the env
comes up ready (see [`AGENTS.md`](./AGENTS.md) → "Agent & dev environment init").

Conventions, the gateway floating/cooldown model, and a file-by-file breakdown are
documented in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
