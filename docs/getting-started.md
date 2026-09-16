# Getting started

One install per OS, one `agent init`, and the Codex and Claude CLIs talk to GitHub Copilot. This page is the install-to-uninstall lifecycle of copilot-env itself; the commands you run every day are on the [usage page](usage.md).

## Install

```bash
# macOS / Linux
curl -fsSL https://github.com/Vivswan/copilot-env/releases/latest/download/install.sh | bash
```

```powershell
# Windows (runs from any shell -- cmd, PowerShell, or the Run dialog)
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/latest/download/install.ps1 | iex"
```

This downloads one self-contained `agent` binary for your platform into `~/.copilot-env`, then wires your shell ([shell integration](usage.md#shell-integration)). Next: restart your shell and run `agent init` ([below](#the-first-agent-init)).

- **Install from a release, not `main`.** `main` is for development and can run ahead of the released installer flow.
- **Replaceable:** re-run the installer any time to move to the selected release.
- **Optional:** `agent shell --clis` installs or updates the Claude/Copilot/Codex CLIs. `agent config --set launchers true` adds the `cl` / `co` / `cx` [launchers](usage.md#launchers).

**Specific version:** replace `latest` with an exact release tag, or pass `--version`.

```bash
curl -fsSL https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.sh | bash
```

```powershell
powershell -c "irm https://github.com/Vivswan/copilot-env/releases/download/vX.X.X/install.ps1 | iex"
```

### Install flags

| macOS / Linux            | Windows               | Effect                                                                                                                             |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--dir DIR`              | `-InstallDir DIR`     | Install target (default `~/.copilot-env`; overrides `COPILOT_ENV_DIR`)                                                             |
| `--version TAG`          | `-Version TAG`        | Install an exact release tag instead of the default                                                                                |
| `--no-shell-integration` | `-NoShellIntegration` | Don't touch your rc / `$PROFILE`                                                                                                   |
| `--no-exec-shell`        | `-NoExecShell`        | Don't offer to reload your shell at the end (also skipped when non-interactive, under CI, or with `COPILOT_ENV_NO_EXEC_SHELL` set) |
|                          | `-AllHosts`           | Wire the CurrentUserAllHosts PowerShell profile instead of the current host's                                                      |

## The first `agent init`

`agent init` sets up both Codex and Claude and prints the next steps. When no credential is stored it runs the `agent auth` picker first ([providers](authentication.md#providers)), `--proxy` included. Headless runs store a token beforehand with `agent auth --provider gh-env` or `agent auth --set <token>`.

With no mode flag, `init` probes whether that credential can use Direct and falls back to the proxy when it cannot. The probe runs through the installed agent CLIs when they exist, and against the Copilot endpoint when they do not. `--direct` and `--proxy` skip the probe and force one mode for both agents.

| Mode   | What the CLIs talk to                                                                                                                   | What runs locally                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Direct | GitHub Copilot's own endpoints, with your GitHub credential                                                                             | no daemon; Claude Code's WebSearch is replaced by the MCP tool ([web search](usage.md#web-search-for-claude-code)) |
| Proxy  | a local [`@jeffreycao/copilot-api`](https://www.npmjs.com/package/@jeffreycao/copilot-api) daemon that copilot-env fetches on first use | `agent start` / `agent stop`, or the [managed lifecycle](usage.md#managed-proxy-lifecycle-auto-start)              |

`agent codex` and `agent claude` rewire one agent the same way ([commands](usage.md#commands)).

### What a wiring pass writes

Every file copilot-env leaves outside its own homes (`~/.copilot-env`, `~/.local/share/copilot-env`), and every command prints the ones it touched:

| File                                                                                                                                                                                                                                                                                                                        | Written by                                                                                                                              | Holds                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.codex/config.toml`                                                                                                                                                                                                                                                                                                      | `agent init`, `agent codex`, `agent profile`                                                                                            | the `copilot-env` model provider; the default and every profile share this file                                                          |
| `~/.codex/hosts/<hostname>/`, and the shared `~/.codex` root: existing host state (`installation_id`, `shell-init.sh`, `sessions/`, `skills/`, `memories/`, the other Codex state dirs) is merged into it, and empty `.codex-global-state.json`, `AGENTS.md`, `session_index.jsonl`, `version.json` are seeded when missing | `agent init`, `agent codex`, while [`codex-host`](configuration.md#per-host-codex_home) is on                                           | the per-host `CODEX_HOME` symlink farm (Linux/macOS)                                                                                     |
| `~/.claude/settings.json`; `~/.claude/settings-<name>.json` per profile                                                                                                                                                                                                                                                     | `agent init`, `agent claude`, `agent profile`                                                                                           | Claude Code's base URL, the credential helper or the [static key](authentication.md#static-key), and the WebSearch deny on direct wiring |
| `~/.claude.json`                                                                                                                                                                                                                                                                                                            | direct wiring while `wire-mcp` is on; `agent mcp --remove`                                                                              | the `copilot-env` MCP server registration ([web search](usage.md#web-search-for-claude-code))                                            |
| the [Claude Desktop files](configuration.md#claude-desktop) under `Claude-3p/` and `Claude/`                                                                                                                                                                                                                                | `agent init`, `agent claude`, `agent profile`, while [`claude-desktop`](configuration.md#claude-desktop) is on and the app is installed | the Claude Desktop gateway entry and the two app files that make the app boot into it                                                    |
| `~/.codex/.env`, in every known Codex home                                                                                                                                                                                                                                                                                  | `agent update`, through the 4.0.0 migration                                                                                             | strips the `COPILOT_ENV_GH_TOKEN` line an older release baked in                                                                         |
| `~/.codex/config.toml.copilot-env-mobile.bak`                                                                                                                                                                                                                                                                               | `agent codex --mobile`                                                                                                                  | a backup of the Codex config for the pairing, removed on a clean finish                                                                  |
| the path you pass to `agent settings --export [file]`                                                                                                                                                                                                                                                                       | `agent settings --export`                                                                                                               | the settings bundle (stdout without a path)                                                                                              |
| `~/.bashrc` / `~/.zshrc`; on Windows `<Documents>/WindowsPowerShell/Microsoft.PowerShell_profile.ps1` and `<Documents>/PowerShell/Microsoft.PowerShell_profile.ps1` (`profile.ps1` with `--all-hosts`)                                                                                                                      | the installer, `agent shell`                                                                                                            | the [shell integration](usage.md#shell-integration) block                                                                                |

`~/.codex` stands for `$CODEX_HOME` when set, and for the active per-host home while `codex-host` is on, except the farm itself, which always sits under the real `~/.codex/hosts`; `~/.claude` and `~/.claude.json` follow `$CLAUDE_CONFIG_DIR` when set. `Claude-3p` and `Claude` sit in `~/Library/Application Support/` on macOS, in `%LOCALAPPDATA%` and `%APPDATA%` on Windows, and in `$XDG_CONFIG_HOME` (default `~/.config`) on Linux.

## Updating

`agent update` fetches the newest release's binary, checks its SHA256 against `checksums.txt`, then verifies both files against the release's Sigstore build-provenance attestation. Only then does it swap the binary in place.

The attestation must be signed by a release workflow this build trusts, running in this repository on `main`, and both files must be among the attested bytes.

- That check is on by default. `agent update --no-verify` skips it once, `agent config --set verify-provenance false` turns it off.
- Your config, credentials, and profiles live outside the install directory and are untouched.
- `agent config --set auto-update true` self-updates daily, with the cooldown from [`update-cooldown`](configuration.md#updates).

### Verifying a download by hand

The installer checks the binary's SHA256 against the release's `checksums.txt` before it puts it anywhere. That proves the download is intact, not who built it: the installer comes from the same release, so a first install trusts it on first use.

Every release also carries a build-provenance attestation, `attestation.json`. The GitHub CLI checks it with the closest equivalent of the policy `agent update` enforces, for the binary AND `checksums.txt`:

```bash
for f in copilot-env-<target> checksums.txt; do
  gh attestation verify "$f" -R Vivswan/copilot-env --source-ref refs/heads/main --bundle attestation.json \
    --cert-identity-regex '^https://github\.com/Vivswan/(copilot-env/\.github/workflows/release\.yml|repo-platform/\.github/workflows/fleet-release-publish\.yml)@refs/.+$'
done
```

- `-R` names this repository, where `agent update` pins the immutable repository id.
- `--source-ref` requires `main`.
- `--cert-identity-regex` allows either release workflow at any ref: this repository's own `release.yml`, or the fleet's `fleet-release-publish.yml` that the attest step is moving to.

### Upgrading from 3.5.6 or earlier

Those versions installed a source tree and bootstrapped a runtime into it, and `agent update` cannot cross that gap.

Re-run the installer once. It replaces the old layout in place, removing the `node_modules` it left behind, and every later update is the ordinary binary swap. Your settings live outside the install directory, so nothing is lost.

## Uninstall

`agent uninstall` removes everything copilot-env manages: daemons, profiles, agent wiring, shell integration, credentials, data, and the install itself. It leaves the agent CLIs (`claude` / `copilot` / `codex`) alone. Its flags are in the [command list](usage.md#commands).
