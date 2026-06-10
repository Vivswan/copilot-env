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
  write `~/.codex` config; build a per-host `CODEX_HOME` farm (Linux/macOS).
- **Cost reporting**: estimated spend from per-host usage DBs via live OpenRouter pricing.
- **Controlled floating**: the gateway floats to the newest cooldown-aged release
  within configured bounds; every other dependency is pinned via `bun.lock`.

## Install

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows
irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex
```

Installs bun and copilot-env into `~/.copilot-env`, bootstraps dependencies, then wires your shell.

- **Recommended:** install from the latest GitHub release asset, not from the
  `main` branch. `main` is for development and can be temporarily ahead of the
  latest released installer flow.
- **Artifact:** the installer extracts the official `copilot-env-vX.Y.Z.tar.gz` release asset when present, verifies that asset's SHA256, and checks the archive source marker against GitHub release metadata before extraction.
- **Replaceable:** re-run the bootstrapper to replace the previous install with the selected release.
- **Next:** restart your shell, then `agent start`.
- **Optional:** run `agent setup-clis --launchers` for Claude/Copilot/Codex CLIs and `cl` / `co` / `cx`.
- **Update later:** `agent update`.
- **Specific version:** replace `latest` with an exact release tag:

  ```bash
  curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/install.sh | bash
  ```

  ```powershell
  irm https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/install.ps1 | iex
  ```

### Install flags

| macOS / Linux | Windows | Effect |
| --- | --- | --- |
| `--dir DIR` | `-InstallDir DIR` | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`). |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`. |

## Usage

```bash
agent init                 # set up BOTH Codex + Claude (auto-detect direct vs the gateway) + next-step guidance
agent start                # launch the daemon and sync aliases (--dry-run to preview, --port to pin)
agent stop                 # stop the daemon
agent health               # full environment diagnosis (--scope runtime|gateway|setup|codex|claude, --json, --live)
agent env                  # print shell exports for the calling shell (CODEX_HOME / proxy ANTHROPIC_BASE_URL)
agent cost                 # estimated token spend across all per-host usage DBs
agent update               # update to the latest release (--check / --cooldown)
agent setup-shell          # (re)wire rc / $PROFILE (--remove to unwire)
agent setup-launchers      # wire/remove opt-in cl / co / cx launchers
agent setup-clis           # install optional CLIs + auto-detect each backend (--cooldown[=DAYS], --no-sudo, --launchers)
agent codex                # configure Codex; --auto auto-detects the backend, --check reports it
agent codex --auto         # probe GitHub Copilot Direct; fall back to the local gateway proxy
agent codex --check        # print provider mode; exits 0 direct, 2 proxy, 1 other
agent codex --host         # per-host CODEX_HOME symlink farm (Linux/macOS); --delete-host to remove
agent claude               # configure Claude; --auto auto-detects the backend, --check reports it
agent claude --auto        # probe GitHub Copilot Direct for Claude; fall back to the local gateway proxy
agent claude --check       # print Claude provider mode; exits 0 direct, 2 proxy, 1 other
```

Once the profile is wired, the same commands run via `agent` on Windows too (or
directly: `powershell -ExecutionPolicy Bypass -File bin\agent.ps1 <cmd>`).

### Shell integration

The installer wires the `agent` wrapper into your shell and exports the gateway env.

- **macOS / Linux:** sources `shell/agents.bashrc` from `~/.bashrc` / `~/.zshrc`.
- **Windows:** dot-sources `shell/agents.ps1` from your PowerShell `$PROFILE`.

The `cl` / `co` / `cx` launchers are opt-in:

- `cl` runs Claude.
- `co` runs Copilot.
- `cx` reads the configured Codex provider (`agent codex --check`), starts the gateway only for proxy-backed configs (re-syncing the port/token), then Codex.

Enable them while installing optional CLIs:

```bash
agent setup-clis --launchers
```

Or manage only the launcher block:

```bash
agent setup-launchers
agent setup-launchers --remove
```

Manual sourcing is also supported:

```bash
source ~/.copilot-env/shell/agents.launchers.bashrc
```

```powershell
. ~/.copilot-env/shell/agents.launchers.ps1
```

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript
entry points; already-set shell environment variables take precedence. The
gateway float reads these values:

- `COPILOT_API_VERSION=<version|tag>`: pin the gateway to a specific release
  (bypasses the floor and cooldown).
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: override the cooldown window
  (`0` = no cooldown), taking precedence over `bunfig.toml`'s
  `install.minimumReleaseAge`.

Without `COPILOT_API_VERSION`, the gateway float reads npm publish times, picks
the newest version at least the cooldown window old (`COPILOT_API_MIN_RELEASE_AGE`
if set, else `bunfig.toml`'s `install.minimumReleaseAge`), and clamps it to the
bounds in `copilot-env.config`.

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
