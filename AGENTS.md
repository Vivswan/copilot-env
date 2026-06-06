# copilot-env

Local copilot-api gateway lifecycle + config helper. TypeScript port of the original Python `copilot-api` package. Supports **Linux, macOS, and Windows** via a POSIX launcher (`bin/agent`) and a PowerShell one (`bin/agent.ps1`); every cross-platform pair (`bin/agent` ⇄ `.ps1`, `agents.bashrc` ⇄ `agents.ps1`, `install.sh` ⇄ `install.ps1`) must stay feature-matched.

`CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file.

## Architecture & key decisions

The non-obvious choices live here; everything else is discoverable in the code.

- **In-place, no cache.** `bin/agent` installs `node_modules` in the checkout itself (when needed — see below) and runs `cli.ts` from there — `node_modules` lives in the checkout, and module resolution anchors at it (`PROJECT_ROOT`, `src/utils/root.ts`). Install output is routed to stderr so it never pollutes the `agent env` stdout the shell wrapper evals.
- **bun runtime, no bundler.** Bin shims auto-install bun if missing. They don't reinstall blindly: each call runs a read-only `bun src/gateway_float.ts --verify` (no registry, no install — `gatewayFloatUpToDate` + `nodeModulesFresh`) and runs `bun install --frozen-lockfile` **only** when it reports the gateway float is stale (drift, weekly re-check due) or `node_modules` is missing / older than `bun.lock`. So the float's postinstall fires (and re-resolves) only on the calls that need it, not on every command.
- **The gateway floats.** `@jeffreycao/copilot-api` is tracked as `"latest"`; `src/gateway_float.ts` (run as `bun install`'s postinstall) overlays the newest release within `[GATEWAY_MIN_VERSION, GATEWAY_MAX_VERSION]` (`copilot-env.config`) **and** ≥7 days old (`bunfig.toml`'s supply-chain cooldown — adopt only releases public long enough to have been caught if compromised). The overlay uses `bun add --no-save`, so `bun.lock` stays the pinned reproducible baseline for every *other* dep — but note `bun list`/bun's summary then report the *locked* version, not the floated one on disk (check `node_modules/@jeffreycao/copilot-api/package.json`). The float self-heals drift and re-resolves at most weekly (`.gateway-checked` stamp).
- **Best-effort at install, hard floor at launch.** The postinstall float never fails `bun install` (offline/registry hiccups are swallowed), so a fresh offline clone could sit below the floor. `start.ts` makes the floor a real contract: it refuses to launch a sub-floor gateway. Bump `GATEWAY_MIN_VERSION` when the wrapper depends on newer gateway behavior; set the optional ceiling to hold the float below a known-bad release.
- **Float env knobs** (set on any `bin/agent` call, inherited through `bun install`): `COPILOT_API_VERSION` pins an exact release/tag (bypasses floor + cooldown); `COPILOT_API_COOLDOWN_DAYS` / `COPILOT_API_FLOAT_INTERVAL_DAYS` override the release-age window / weekly re-check; `COPILOT_API_NO_FLOAT=1` skips the float.
- **Supply-chain cooldown applies to the installers too.** `install.sh --cooldown` / `install.ps1 -Cooldown` pin the agent CLIs to an aged release and roll the managed checkout back to an aged commit. `src/install/aged-version.ts` is the **single** resolver both installers share so they can't drift.
- **`agent env` is the one machine-readable command.** The shell wrapper runs a command, then evals `agent env` (and only that) to refresh session state — so a new subcommand needs no wrapper change, and no command's incidental stdout is ever eval'd.

## Repo map

- `bin/agent`, `bin/agent.ps1` — self-bootstrapping launchers (install bun + deps, dispatch `cli.ts`).
- `agents.bashrc`, `agents.ps1` — shell integration (sourced from rc / `$PROFILE`); the `agent` wrapper + `cl`/`co`/`cx` agent launchers. Pure runtime wiring, never installs.
- `install.sh`, `install.ps1` — one-line installers: prereqs (Node, bun) + agent CLIs + shell wiring, clone/update to `~/.copilot-env`. Idempotent.
- `src/cli.ts` + `src/commands/` — citty entry; one subcommand → one `run*` module: `start`/`stop`/`health`/`env`/`cost`/`codex_config`/`host_codex` (the last, a per-host Codex `CODEX_HOME` farm, is Linux-only).
- `src/gateway_float.ts` — the gateway float (see above).
- `src/copilot_api/` — gateway-specific helpers: admin REST, config/state JSON, model-alias generation, per-host paths, daemon process control.
- `src/usage/` — `cost` reporting over per-host SQLite usage DBs using live OpenRouter pricing.
- `src/utils/` — generic helpers (hostname, `PROJECT_ROOT`, semver compare).
- `copilot-env.config` — `KEY=value` bounds shared by TS + POSIX + PowerShell: the gateway floor/ceiling and the installer repo-rollback SHA window.
- `test/` — `bun test` suites: pure-logic units + a start/stop daemon lifecycle against `test/copilot-api-fake.mjs`.
- `.github/`, `.devcontainer/`, `.claude/`, `.codex/` — CI/CodeQL, Codespaces, and agent-worktree wiring.

## Agent & dev environment init

Every agent/dev environment and any fresh `git worktree` initializes through **one** idempotent script — `scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows) — so no entry point drifts. It runs `bun install --frozen-lockfile` (which also fires the best-effort gateway float; no agent CLIs). Entry points that invoke it: the GitHub Copilot coding agent (`.github/workflows/copilot-setup-steps.yml`), Codespaces / Dev Containers (`.devcontainer/`), Claude Code and Codex CLI worktrees (`SessionStart` hooks in `.claude/` and `.codex/`, no-op when `node_modules` already exists), and humans (run it directly). For the Codex app, configure a Local Environment that runs `scripts/setup-env.sh` on worktree creation and `./bin/agent stop || true` on cleanup.

## Conventions

- **No `any`** — biome's `noExplicitAny` is `error`.
- **camelCase** functions/vars/params, **PascalCase** types/classes/interfaces, **CONSTANT_CASE** top-level constants; **snake_case only on object-literal keys** (for external config-file keys we don't control). Always quote object-literal keys.
- **No new deps without an explicit reason.** Current: `citty`, `consola`, `smol-toml`, `@jeffreycao/copilot-api`, `patch-package`.
- **String literals are external contracts** — model ids, JSON keys, env var names, log markers: never rename them during refactors.
- **bun** (runtime), **biome** (TS format/lint), **tsc** (typecheck), **shellcheck** / **PSScriptAnalyzer** (shell / PowerShell). No webpack, rollup, or bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", or "codex" lines** in commits or PR descriptions.

## Commands

```bash
bun run typecheck     # tsc --noEmit
bun test              # test/**/*.test.ts
bun run lint          # biome check src bin test scripts
bun run lint:sh       # shellcheck     (skip-if-absent)
bun run lint:ps       # PSScriptAnalyzer (skip-if-absent)
bun run check         # biome check --write src bin test scripts

./bin/agent start     # start the daemon; also: stop / health / env / cost / codex_config / host_codex
./bin/agent env       # print shell env vars pointing at the local gateway
```

The husky `pre-commit` hook runs lint-staged (biome) + typecheck + tests + the shell/PS linters; the linters are skip-if-absent and gate only on warnings+errors. CI runs the same on a Linux/macOS/Windows matrix, plus the start/stop lifecycle and end-to-end installer jobs.

## Patching `@jeffreycao/copilot-api`

Patching and floating are mutually exclusive: a `patch-package` patch is keyed to one exact version and stops applying once the float moves on. To patch: temporarily pin an exact version in `package.json` (freezing the float), edit under `node_modules/@jeffreycao/copilot-api/dist/`, run `npx patch-package @jeffreycao/copilot-api`, and commit the patch alongside the pin; restore `"latest"` to resume floating. `patch-package` is non-fatal, so a stale patch won't break startup. No patch exists today.
