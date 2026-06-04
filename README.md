# copilot-env

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
  local gateway; `codex-home` writes a host-local `CODEX_HOME`.
- **Cost reporting** — `cost` reads the gateway's per-host usage databases and
  prints estimated spend using live OpenRouter pricing.
- **Supply-chain hygiene** — the gateway dependency floats to `latest` but only
  adopts releases that have been public for ≥7 days (a cooldown enforced in
  `bunfig.toml`); every other dependency is pinned via the committed `bun.lock`.

## Requirements

- [bun](https://bun.sh) `>=1.3.0` — the `bin/` launchers will install it for you
  if absent.
- Node.js `>=20` (used to run the gateway daemon).

## Install

Clone the repo and use the launchers in `bin/` directly:

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
./bin/copilot-api --help
```

On Windows, use the PowerShell launcher instead of the POSIX shim:

```powershell
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
powershell -ExecutionPolicy Bypass -File bin\copilot-api.ps1 --help
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

./bin/codex-home --base-url <url> --api-key <key>   # write a host-local CODEX_HOME
```

On Windows, use the PowerShell launchers: `bin/copilot-api.ps1` and
`bin/codex-home.ps1` (e.g. `powershell -ExecutionPolicy Bypass -File bin\codex-home.ps1`).
`codex-home` writes config to `%USERPROFILE%\.codex\config.toml` by default;
`--hostname-path` and `--symlink-farm` (the per-host symlink farm) are Linux-only.

### Environment overrides

- `COPILOT_API_VERSION=<version|tag>` — pin the gateway to a specific release,
  bypassing both the compatibility floor and the 7-day cooldown. Unset = float to
  the newest release that is both ≥ the floor and ≥7 days old.

### Shell integration

`agents.bashrc` defines an `agent` dispatcher plus `cl` / `co` / `cx` aliases, and
`agents_codex.bashrc` adds Codex `CODEX_HOME` wiring. Source them from your shell
rc to get the lifecycle wrappers on your `PATH`.

Run `install.sh` to add the source block to `~/.bashrc` and/or `~/.zshrc`
automatically (idempotent — re-running skips files that already have it):

```bash
./install.sh          # source agents.bashrc
./install.sh --codex  # also source agents_codex.bashrc (Codex CODEX_HOME wiring)
```

On Windows, `agents.ps1` is the PowerShell equivalent of `agents.bashrc`. Run the
PowerShell installer to install Git, Node.js/npm, Bun, the agent CLIs, bootstrap
copilot-env dependencies, and dot-source `agents.ps1` from your `$PROFILE`:

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
