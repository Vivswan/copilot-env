# copilot-env

Local copilot-api proxy lifecycle + config helper (a TypeScript port of the Python
`copilot-api`). It wraps a floating `@jeffreycao/copilot-api` proxy and wires the Codex and
Claude CLIs to either that local proxy or GitHub Copilot Direct.

**Cross-platform is non-negotiable.** Everything must work on Linux, macOS, and Windows
unless the user says otherwise. Each POSIX/PowerShell pair stays feature-matched: `bin/agent`
⇄ `bin/agent.ps1`, `shell/agents*.bashrc` ⇄ `shell/agents*.ps1`, `install.sh` ⇄ `install.ps1`,
`src/scripts/proxy-token.sh` ⇄ `.ps1`. Prefer the platform helpers (`agentLauncherCommand`,
`proxyTokenCommand` in `src/utils/root.ts`) over hardcoding a shell.

`CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file.

## Architecture: the non-obvious decisions

Only the *why* lives here; the mechanics are discoverable in the code.

- **In-place, no cache.** `bin/agent` installs `node_modules` into the checkout and runs
  `cli.ts` from there (resolution anchors at `PROJECT_ROOT`, `src/utils/root.ts`). Install
  noise goes to stderr so it never pollutes the `agent env` stdout the shell wrapper evals.
- **The proxy floats; patching and floating are mutually exclusive.** `@jeffreycao/copilot-api`
  is tracked as `latest`; `src/proxy_float.ts` (a `bun install` postinstall) overlays the
  newest release inside a supply-chain cooldown window, clamped to the floor/ceiling in
  `copilot-env.config`. The float is best-effort at install; `start.ts` enforces the floor as
  a hard contract at launch. A `patch-package` patch pins one version, so we never patch —
  runtime needs are `bun --preload` shims instead (see the PAT shim below).
- **`agent env` is the one machine-readable command.** The shell wrapper evals only `agent env`
  to refresh session state, so a new subcommand needs no wrapper change. Otherwise each agent's
  proxy/direct wiring lives in its own config file (`~/.codex/config.toml`,
  `~/.claude/settings.json`).
- **One credential, resolved not baked.** The GitHub Copilot token is the single source of
  truth in `CopilotEnvState` (`src/copilot_api/env_state.ts`), an account-wide file under the
  copilot-api home (not per-host `.run/` state). Agent Direct configs never store a copy; they
  resolve it at fetch time via `agent auth --get`, provider-driven with **no implicit `gh`
  fallback**. `agent auth` is the credential front door; when auth is none we **ask, never
  silently fall back**.
- **The managed proxy lifecycle is opt-in** (`agent init --auto-start` / `--no-auto-start`,
  stored as `autoStart` in `CopilotEnvState`). When ON: the agents' shared proxy-token resolver
  (`src/scripts/proxy-token.{sh,ps1}`, run by Codex's `auth.command` + Claude's `apiKeyHelper`)
  auto-starts the proxy on demand, and the proxy auto-stops when idle. Auto-stop is an
  **in-daemon watchdog** (`src/scripts/idle_watchdog_preload.ts`, `bun --preload`-ed into the
  proxy), so the server and its watchdog are one process and neither can orphan the other.
  OFF (default): manage the proxy yourself with `agent start` / `agent stop`. Idle window:
  `COPILOT_API_IDLE_TIMEOUT` seconds (default 3600; `0` disables).
- **A PAT works through a runtime shim.** A classic/fine-grained PAT can't perform copilot-api's
  editor token exchange (403) but is accepted directly under the `vscode-chat` integration. So
  `agent start` preloads `src/scripts/pat_passthrough_preload.ts`, which fakes the exchange so
  the daemon uses the PAT as the bearer. Auto-on for PAT-shaped tokens; `--passthrough` /
  `--no-passthrough` force it.

## Repo map

- `bin/agent`(`.ps1`) — self-bootstrapping launchers (install bun + deps, dispatch `cli.ts`).
- `shell/` — shell integration (the `agent` wrapper + eager `agent env`) and the opt-in
  `cl`/`co`/`cx` launchers; pure runtime wiring, never installs.
- `install.sh`/`install.ps1` — one-line bootstrap installers: ensure bun, download + checksum
  the latest release archive, then hand off to release-local `src/install/installer.ts`.
- `src/cli.ts` — Commander entry; delegates to `run*` functions.
- `src/commands/` — command implementations (`init`/`auth`/`start`/`stop`/`health`/`env`/
  `update`/`setup`); `init` and `auth` share `configure_agents.ts` to avoid a cycle.
- `src/codex/`, `src/claude/` — per-agent config wiring (Codex farm/`--mobile`; Claude settings).
- `src/copilot_api/` — proxy helpers: admin REST, JSON config/state, model aliases, per-host
  paths, daemon process control.
- `src/scripts/` — runtime scripts that run as their OWN process or preload, NOT CLI handlers:
  `proxy-token.{sh,ps1}` (proxy-mode credential resolver) and the two `bun --preload` daemon
  shims `pat_passthrough_preload.ts` + `idle_watchdog_preload.ts`.
- `src/install/`, `src/migrations/`, `src/usage/`, `src/utils/` — release download/verify,
  version-step fix-ups, `cost` reporting, generic helpers.
- `copilot-env.config` — proxy-float floor/ceiling. `test/` — `bun test` units + a start/stop
  lifecycle against `test/copilot-api-fake.mjs`.

## Agent & dev environment init

Every agent/dev environment and fresh `git worktree` initializes through **one** idempotent
script — `scripts/setup-env.sh` (`.ps1` on Windows) — so no entry point drifts. It runs
`bun install --frozen-lockfile` (which fires the best-effort float; no agent CLIs). It is
invoked by the Copilot coding agent, Codespaces/Dev Containers, the Claude/Codex worktree
`SessionStart` hooks, and humans.

## Migrations

`src/migrations/` carries one-time, idempotent fix-ups for existing installs, one file per step
named for the release it migrates **away from** (`1.2.1.ts`) — authored against the current
version, never predicting the next. `agent update` runs the due ones (`[old, new)`) in a fresh
process after swapping in the new release; failures are non-fatal. The transition that *adds* a
subsystem can't auto-run via update — that one is covered by the installer's `agent shell`
refresh.

## Conventions

- **No `any`** — biome's `noExplicitAny` is `error`.
- **camelCase** functions/vars, **PascalCase** types/classes, **CONSTANT_CASE** top-level
  constants; **snake_case only on object-literal keys** (external config keys), always quoted.
- **No new deps without an explicit reason.** Current: `commander`, `consola`, `dotenv`,
  `execa`, `semver`, `smol-toml`, `tar`, `valibot`, `which`, `ps-list`, `@jeffreycao/copilot-api`,
  `patch-package`.
- **String literals are external contracts** — model ids, JSON keys, env var names, log
  markers: never rename them during refactors.
- **ASCII source, except user-facing output.** Comments/identifiers/code are pure ASCII (no em
  dashes, arrows, ellipses); non-ASCII only inside string/template literals. Enforced by
  `test/no_weird_chars.test.ts`.
- **bun** (runtime), **biome** (format/lint), **tsc** (typecheck), **shellcheck** /
  **PSScriptAnalyzer**. No bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", "codex", or "copilot" lines** anywhere.
- **Conventional Commits** — `feat:` (minor), `fix:` (patch), `feat!:`/`BREAKING CHANGE:`
  (major); `chore:`/`docs:`/`refactor:`/`test:`/`ci:` don't release.
- **Run `/rubber-duck-review` before any commit** — an independent cross-model review of the
  pending changes, then commit.

## Releases

Versioned via [release-please](.github/workflows/release-please.yml): pushes to `main` update one
rolling **release PR**; merging it tags `vX.Y.Z` and publishes the GitHub Release. Ordinary
pushes release nothing. Installers and `agent update` install the newest release tag, not `main`.

- **Releases only ever move forward.** A published version is immutable: never re-release,
  overwrite, or pin a future release back to it. Each new release must be **> the latest tag**.
  Leave `release-as` absent so versions derive from commit prefixes.
- The release PR needs `RELEASE_PLEASE_TOKEN` (a PAT/App token) to run CI like a normal PR.
  Without it, the built-in `GITHUB_TOKEN` can't trigger the workflows, so `all-green` sits unmet
  and you merge with admin bypass (the code already passed CI into `main`).

## Commands

```bash
bun run typecheck     # tsc --noEmit
bun test              # test/**/*.test.ts
bun run lint          # biome check (lint:sh / lint:ps for shell / PowerShell, skip-if-absent)
bun run check         # biome check --write

./bin/agent init      # set up Codex + Claude (auto-detect direct vs proxy; --direct/--proxy/--auto-start)
./bin/agent auth      # manage the GitHub credential (--provider/--get/--del/--check)
./bin/agent start     # start the daemon; also stop / health / env / cost / update / shell / codex / claude
```

The husky `pre-commit` hook and CI run the same gate (lint-staged + typecheck + tests + the
skip-if-absent shell/PS linters); CI adds a Linux/macOS/Windows matrix plus lifecycle and
installer jobs.
