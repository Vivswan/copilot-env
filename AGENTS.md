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
- **The proxy floats; we never patch it.** `@jeffreycao/copilot-api`
  is tracked as `latest`; `src/proxy_float.ts` (a `bun install` postinstall) overlays the
  newest release inside a supply-chain cooldown window, clamped to the floor/ceiling in
  `copilot-env.config`. The float is best-effort at install; `start.ts` enforces the floor as
  a hard contract at launch. When BOTH Codex and Claude are wired Direct the float (and its
  `--verify`/`--assert-installed` modes) is a no-op — the local proxy is unused, so no npm
  check runs; an explicit `COPILOT_API_VERSION` env pin forces the normal path. Patching the
  package would pin one version, so we never do —
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
- **`agent config` is the typed preference store.** A `--set <key> <value>` / `--get [key]`
  / `--del <key>` front-end over `CopilotEnvConfig` (`src/copilot_api/env_config.ts`, a
  `.copilot-env-config.json` SEPARATE from the credential store), with a single key registry
  as the source of truth (alphabetical): `auto-start`, `codex-model-catalog`, `idle-timeout`,
  `max-port`, `message-websearch-model`, `messages-api`, `min-port`, `passthrough` (auto/on/off),
  `port`, `proxy-logs`, `proxy-version`, `release-cooldown`, `responses-context-management`,
  `responses-websearch`, `responses-websocket`, `small-model`, `strict-port`, `update-cooldown`.
  Registry entries marked for proxy projection are
  **written into the proxy's own `config.json` at `agent start`** (`applyDefaultConfig` ->
  `projectedProxyConfig`): a `proxyDefault` key (`small-model` + the three `responses-websocket`
  /`responses-websearch`/`messages-api` flags) is force-written every start, while a
  `proxyProjected` key (`responses-context-management`, `message-websearch-model`) is written
  only when set so the proxy's own default otherwise stands. Either way a daemon restart is
  needed (the `agent config` set/del prints that hint). Every read site applies the same
  precedence: **explicit flag/env (per-invocation) > stored config > built-in default** (e.g.
  `COPILOT_API_IDLE_TIMEOUT` env > config `idle-timeout` > 3600). `proxy_float.ts` reads
  `proxy-version`/`release-cooldown` from it at install time (a best-effort read that falls
  back to env/bunfig).
- **The managed proxy lifecycle is opt-in** (the `auto-start` config key; `agent config
  --set auto-start true`). The shared resolver `src/scripts/proxy-token.{sh,ps1}` (run by
  Codex's `auth.command`, Claude's `apiKeyHelper`, and the `cl`/`cx` launchers) is built from
  **honest primitives** rather than a magic flag: `start --check` (is the proxy up?), `config
  --get auto-start` (the gate), `start` (launch), `start --record-event` (the watchdog
  heartbeat), `auth --print-proxy-token` (a pure key printer). The resolver: if the proxy is
  down and the lifecycle is ON, auto-start it; if OFF, only `--yes` callers (Codex/Claude,
  headless) skip starting while non-`--yes` callers (the launcher) prompt; then it prints the
  key only if the proxy is up. Auto-stop is an **in-daemon watchdog**
  (`src/scripts/idle_watchdog_preload.ts`, `bun --preload`-ed into the proxy) gated on the
  same flag, so server and watchdog are one process and neither can orphan the other. Its
  activity signal is an always-loaded **inbound-request observer**
  (`src/scripts/inference_activity_preload.ts`, wrapping `Bun.serve`): only inference POSTs
  count, so health/liveness pings never reset the idle clock -- and muting the proxy's
  verbose handler logs (`proxy-logs false`) can't starve it. OFF
  (default): manage the proxy yourself with `agent start` / `agent stop`. Idle window:
  `COPILOT_API_IDLE_TIMEOUT` env / `idle-timeout` config (default 3600; `0` disables).
- **A PAT works through a runtime shim.** A classic/fine-grained PAT can't perform copilot-api's
  editor token exchange (403, and `gh`-CLI/`gho_` OAuth tokens 404 it) but is accepted directly
  under the `vscode-chat` integration. So `agent start` preloads
  `src/scripts/pat_passthrough_preload.ts`, which fakes the exchange so the daemon uses the
  token as the bearer. Auto-on for PAT-shaped tokens (`ghp_`/`github_pat_`), `gho_` tokens, and
  the `gh-cli` provider; the device-flow `copilot` token is never auto-shimmed. Force it either
  way with the `passthrough` config key (`agent config --set passthrough on|off`) — e.g. `on`
  for a legacy unprefixed 40-hex classic PAT, which auto-detection misses.

## Repo map

- `bin/agent`(`.ps1`) — self-bootstrapping launchers (install bun + deps, dispatch `cli.ts`).
- `shell/` — shell integration (the `agent` wrapper + eager `agent env`) and the opt-in
  `cl`/`co`/`cx` launchers; pure runtime wiring, never installs.
- `install.sh`/`install.ps1` — one-line bootstrap installers: ensure bun, download + checksum
  the latest release archive, then hand off to release-local `src/install/installer.ts`.
- `src/cli.ts` — Commander entry; delegates to `run*` functions.
- `src/commands/` — command implementations (`init`/`auth`/`config`/`start`/`stop`/`health`/
  `models`/`env`/`update`, plus `setup`+`shell_integration` behind `agent shell` and `apply_update`
  shared by `agent update` and the autoupdate preflight); `init` configures both agents via
  `configure_agents.ts` (`auth` manages the credential only and never configures agents).
- `src/codex/`, `src/claude/` — per-agent config wiring (Codex farm/`--mobile`; Claude settings).
- `src/copilot_api/` — proxy helpers: admin REST, raw catalog fetch (proxy or Direct), JSON
  config/state, model aliases, per-host paths, daemon process control.
- `src/scripts/` — runtime scripts that run as their OWN process or preload, NOT CLI handlers:
  `proxy-token.{sh,ps1}` (proxy-mode credential resolver) and the `bun --preload` daemon
  shims: `token_argv_preload.ts` (first when a token is handed off; splices it from an env var
  onto in-process argv so it stays off process listings), `inference_activity_preload.ts`
  (always), `pat_passthrough_preload.ts`, `idle_watchdog_preload.ts`, `log_mute_preload.ts`
  (each conditional).
- `src/install/`, `src/migrations/`, `src/autoupdate/`, `src/health/`, `src/usage/`,
  `src/utils/` — release download/verify, version-step fix-ups, the `agent start`-time
  autoupdate preflight, the `agent health` check/probe/report engine, `cost` reporting,
  generic helpers.
- `copilot-env.config` — proxy-float floor/ceiling. `test/` — `bun test` units + a start/stop
  lifecycle against `test/copilot-api-fake.mjs`.

## Agent & dev environment init

Every agent/dev environment and fresh `git worktree` initializes through **one** idempotent
script — `scripts/setup-env.sh` (`.ps1` on Windows) — so no entry point drifts. It runs
`bun install --frozen-lockfile` (which fires the best-effort float; no agent CLIs). It is
invoked by the Copilot coding agent (`.github/workflows/copilot-setup-steps.yml`),
Codespaces/Dev Containers (`.devcontainer/devcontainer.json`), and humans.

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
  `execa`, `semver`, `smol-toml`, `tar`, `valibot`, `which`, `ps-list`, `@jeffreycao/copilot-api`.
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

./bin/agent init      # set up Codex + Claude (auto-detect direct vs proxy; --direct / --proxy)
./bin/agent auth      # manage the GitHub credential (--provider/--get/--del/--check)
./bin/agent config    # get/set preferences (--set <key> <value> / --get [key] / --del <key>)
./bin/agent start     # start the daemon; also stop / health / models / env / cost / update / shell / codex / claude
```

The husky `pre-commit` hook and CI run the same gate (lint-staged + typecheck + tests + the
skip-if-absent shell/PS linters); CI adds a Linux/macOS/Windows matrix plus lifecycle and
installer jobs.
