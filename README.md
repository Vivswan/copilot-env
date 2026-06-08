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
- **Optional:** run `agent setup clis --launchers` for Claude/Copilot/Codex CLIs and `cl` / `co` / `cx`.
- **Update later:** `agent update`.
- **Specific version:** use the versioned release asset instead of `latest`, e.g.
  `curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/install.sh | bash`
  or `irm https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/install.ps1 | iex`.

### Install flags

| macOS / Linux | Windows | Effect |
| --- | --- | --- |
| `--dir DIR` | `-InstallDir DIR` | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`). |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`. |

## Usage

```bash
agent start              # launch the daemon and sync aliases (--dry-run to preview)
agent env                # print shell env vars pointing at the local gateway
agent cost               # estimated token spend across all per-host usage DBs
agent stop               # stop the daemon
agent health             # check the gateway is reachable (exit 1 if not)
agent update             # update to the latest release (--check / --cooldown)
agent setup clis         # install optional CLIs (--cooldown[=DAYS], --no-sudo, --launchers)
agent setup launchers    # wire/remove opt-in cl / co / cx launchers
agent setup shell        # (re)wire rc / $PROFILE (--remove to unwire)
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

- **CLI:** `agent setup clis --launchers` while installing CLIs, or `agent setup launchers` just for the launcher block; remove only the launcher block with `agent setup launchers --remove`.
- **Manually:** source the file:

```bash
source ~/.copilot-env/shell/agents.launchers.bashrc   # . ...\shell\agents.launchers.ps1 on Windows
```

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript
entry points; already-set shell environment variables take precedence. The
gateway float reads these values:

- `COPILOT_API_VERSION=<version|tag>`: pin the gateway to a specific release
  (bypasses the floor and cooldown).
- `COPILOT_API_NO_FLOAT=1`: skip the gateway float entirely.

Without `COPILOT_API_VERSION`, the gateway float reads npm publish times, picks
the newest version satisfying `bunfig.toml`'s `install.minimumReleaseAge`, and
clamps it to the bounds in `copilot-env.config`.

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
