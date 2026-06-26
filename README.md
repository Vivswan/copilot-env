# copilot-env

[![CI](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/copilot-env/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A small, self-bootstrapping CLI that manages a local
[`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api)
proxy: start/stop the daemon, wire model aliases, export env vars for your shell
and for Codex, and report estimated token spend.

TypeScript port of the original Python `copilot-api` helper. Runs on **Linux,
macOS, and Windows**.

- **Lifecycle**: `start` / `stop` the local proxy with one command.
- **Zero setup**: auto-installs [bun](https://bun.sh), dependencies, and the
  proxy on first run. No global installs to manage.
- **Shell + Codex wiring**: point your tools at the local proxy automatically;
  write `~/.codex` config; build a per-host `CODEX_HOME` farm (Linux/macOS).
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
agent start                # launch the daemon and sync aliases (--dry-run to preview, --port to pin)
agent stop                 # stop the daemon
agent health               # full environment diagnosis (--scope runtime|proxy|setup|codex|claude, --json, --live)
agent env                  # print shell exports for the calling shell (CODEX_HOME / proxy ANTHROPIC_BASE_URL)
agent cost                 # estimated token spend across all per-host usage DBs
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

- `cl` runs Claude.
- `co` runs Copilot.
- `cx` reads the configured Codex provider (`agent codex --check`), starts the proxy only for proxy-backed configs (re-syncing the port/token), then Codex.

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

### Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript
entry points; already-set shell environment variables take precedence. The
proxy float reads these values:

- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a specific release
  (bypasses the floor and cooldown).
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: override the cooldown window
  (`0` = no cooldown), taking precedence over `bunfig.toml`'s
  `install.minimumReleaseAge`.

Without `COPILOT_API_VERSION`, the proxy float reads npm publish times, picks
the newest version at least the cooldown window old (`COPILOT_API_MIN_RELEASE_AGE`
if set, else `bunfig.toml`'s `install.minimumReleaseAge`), and clamps it to the
bounds in `copilot-env.config`.

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
  initializer; the Copilot coding agent, Codespaces / Dev Containers, and
  Claude/Codex worktrees all run it.
- **More docs:** conventions, the proxy float/cooldown model, and a file-by-file
  breakdown live in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
