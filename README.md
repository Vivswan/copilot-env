# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A small, self-bootstrapping CLI that manages a local
[`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api)
gateway: start/stop the daemon, wire model aliases, export env vars for your shell
and for Codex, and report estimated token spend.

TypeScript port of the original Python `copilot-api` helper. Runs on **Linux,
macOS, and Windows**.

- **Lifecycle**: `start` / `stop` the local gateway with one command.
- **Zero setup**: auto-installs [bun](https://bun.sh), dependencies, and the
  gateway on first run. No global installs to manage.
- **Shell + Codex wiring**: point your tools at the local gateway automatically;
  write `~/.codex` config; build a per-host `CODEX_HOME` farm (Linux).
- **Cost reporting**: estimated spend from per-host usage DBs via live OpenRouter pricing.
- **Supply-chain hygiene**: the gateway floats to `latest` but only adopts
  releases ≥7 days old; every other dependency is pinned via `bun.lock`.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
```

Installs bun, the agent CLIs, and the gateway into `~/.copilot-env`, then wires your shell.

- **Prerequisite:** `git` (macOS/Linux only); the installer fetches everything else.
- **Idempotent:** re-run to complete or repair an install.
- **Next:** restart your shell, then `agent start`.
- **Update later:** `agent update`.

### Install flags

| macOS / Linux | Windows | Effect |
| --- | --- | --- |
| `--dir DIR` | `-InstallDir DIR` | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`). |
| `--cooldown[=DAYS]` | `-Cooldown [-CooldownDays N]` | Only install releases public for ≥ N days (default 7): a supply-chain delay for the agent CLIs and the copilot-env release. Already-installed CLIs are left untouched. |
| `--launchers` | `-Launchers` | Also wire the opt-in `cl` / `co` / `cx` launchers (see below). |
| `--no-prereqs` | `-NoPrereqs` | Verify prerequisites instead of installing them (`bun` missing is fatal; Node/CLIs missing is a warning). |
| `--local-install` | `-LocalInstall` | Never use `sudo` or a system package manager (`brew`/`apt`/`winget`). Mutually exclusive with `--no-prereqs`. |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`. |

## Usage

```bash
agent start              # launch the daemon and sync aliases (--dry-run to preview)
agent env                # print shell env vars pointing at the local gateway
agent cost               # estimated token spend across all per-host usage DBs
agent stop               # stop the daemon
agent health             # check the gateway is reachable (exit 1 if not)
agent update             # update to the latest release (--check / --cooldown)
agent shell-integration  # (re)wire rc / $PROFILE (--launchers, or --remove to unwire)
agent codex-config       # write Codex config into ~/.codex, wired to the gateway
agent host-codex         # per-host CODEX_HOME symlink farm (Linux-only)
```

Once the profile is wired, the same commands run via `agent` on Windows too (or
directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`).

### Shell integration

The installer wires the `agent` wrapper into your shell and exports the gateway env:

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

The `cl` / `co` / `cx` launchers are **opt-in** (so they don't claim those names unless you ask): `cl` → Claude, `co` → Copilot, `cx` → `codex-config` then Codex. Enable them via:

- **Installer:** `--launchers` / `-Launchers`.
- **CLI:** `agent shell-integration --launchers`.
- **Manually:** source the file:

```bash
source ~/.copilot-env/shell/agents.launchers.bashrc   # . ...\shell\agents.launchers.ps1 on Windows
```

### Environment overrides

The gateway float reads these from the environment (e.g.
`COPILOT_API_COOLDOWN_DAYS=14 agent start`):

- `COPILOT_API_VERSION=<version|tag>`: pin the gateway to a specific release
  (bypasses the floor and cooldown).
- `COPILOT_API_COOLDOWN_DAYS=<n>`: override the release-age window (default 7).
- `COPILOT_API_FLOAT_INTERVAL_DAYS=<n>`: override how often (default weekly) the
  float re-resolves the newest release.
- `COPILOT_API_NO_FLOAT=1`: skip the gateway float entirely.

## Development

Drive the CLI from a checkout (deps + gateway install in-place; no separate cache):

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
  initializer; the Copilot coding agent, Codespaces / Dev Containers, and
  Claude/Codex worktrees all run it.
- **More docs:** conventions, the gateway float/cooldown model, and a file-by-file
  breakdown live in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
