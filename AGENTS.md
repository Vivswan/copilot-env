# copilot-env

Local copilot-api gateway lifecycle + config helper. TypeScript port of the original Python `copilot-api` package. Supports **Linux, macOS, and Windows** via a POSIX launcher (`bin/agent`) and a PowerShell one (`bin/agent.ps1`); every cross-platform pair (`bin/agent` ⇄ `.ps1`, `shell/agents.bashrc` ⇄ `shell/agents.ps1`, `shell/agents.launchers.bashrc` ⇄ `shell/agents.launchers.ps1`, `install.sh` ⇄ `install.ps1`) must stay feature-matched.

`CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file.

## Architecture & key decisions

The non-obvious choices live here; everything else is discoverable in the code.

- **In-place, no cache.** `bin/agent` installs `node_modules` in the checkout itself (when needed — see below) and runs `cli.ts` from there — `node_modules` lives in the checkout, and module resolution anchors at it (`PROJECT_ROOT`, `src/utils/root.ts`). Install output is routed to stderr so it never pollutes the `agent env` stdout the shell wrapper evals.
- **bun runtime, no bundler.** Bin shims auto-install bun if missing. Normal no-env `bun src/gateway_float.ts --verify` reads npm publish-time metadata on each call, computes the cooldown-aged target, and skips `bun install --frozen-lockfile` when that exact target is already installed; missing `node_modules`, stale `bun.lock`, disabled floating without an installed gateway, or a changed target still force install.
- **The gateway floats.** `@jeffreycao/copilot-api` is tracked as `"latest"`; `src/gateway_float.ts` (run as `bun install`'s postinstall) computes the newest release satisfying `bunfig.toml`'s `install.minimumReleaseAge`, clamps it to `[GATEWAY_MIN_VERSION, GATEWAY_MAX_VERSION]` (`copilot-env.config`), then overlays that exact version. The overlay uses `bun add --no-save`, so `bun.lock` stays the pinned reproducible baseline for every *other* dep — but note `bun list`/bun's summary then report the *locked* version, not the floated one on disk (check `node_modules/@jeffreycao/copilot-api/package.json`).
- **Best-effort at install, hard floor at launch.** The postinstall float never fails `bun install` (offline/registry hiccups are swallowed), so a fresh offline install could sit below the floor. `start.ts` makes the floor a real contract: it refuses to launch a sub-floor gateway. Bump `GATEWAY_MIN_VERSION` when the wrapper depends on newer gateway behavior; set the optional ceiling to hold the float below a known-bad release.
- **Float env knobs** (set on any `bin/agent` call or in root `.env`, loaded from `PROJECT_ROOT` by `src/utils/dotenv.ts`): `COPILOT_API_VERSION` pins an exact release/tag (bypasses floor + cooldown); `COPILOT_API_NO_FLOAT=1` skips the float. Real shell environment wins over `.env`.
- **Supply-chain cooldown applies after bootstrap.** The bootstrap installers always resolve the latest copilot-env release; version-specific installs use the `install.sh` / `install.ps1` assets attached to that GitHub Release. Optional copilot-env release cooldown lives under `agent update --cooldown[=DAYS]`; optional agent-CLI cooldown lives under `agent setup-clis --cooldown[=DAYS]` and uses `src/utils/aged_version.ts` fed by `npm view <pkg> time`. Copilot-env release selection uses `src/install/resolve-release.ts` (the same module `agent update` imports, which the installers download standalone and run).
- **`agent env` is the one machine-readable command.** The shell wrapper runs a command, then evals `agent env` (and only that) to refresh session state — so a new subcommand needs no wrapper change, and no command's incidental stdout is ever eval'd.

## Repo map

- `bin/agent`, `bin/agent.ps1` — self-bootstrapping launchers (install bun + deps, dispatch `cli.ts`).
- `shell/agents.bashrc`, `shell/agents.ps1` — shell integration (sourced from rc / `$PROFILE`); the `agent` wrapper + eager gateway-env export. Pure runtime wiring, never installs.
- `shell/agents.launchers.bashrc`, `shell/agents.launchers.ps1` — opt-in `cl`/`co`/`cx` agent launchers, sourced after the integration file (`cx` re-applies `setup-codex-config` before launch). Wired with `agent setup-clis --launchers` or `agent setup-launchers`, removed with `agent setup-launchers --remove`; otherwise source manually.
- `install.sh`, `install.ps1` — one-line bootstrap installers: ensure bun, download the latest release source archive to `~/.copilot-env`, verify its source checksum against GitHub release metadata, replace any previous install at the target dir, then run release-local `src/install/installer.ts` to bootstrap deps and wire shell integration. Optional agent CLIs live under `agent setup-clis`. Version-specific installer copies are uploaded as release assets by `.github/workflows/release-please.yml` after release creation.
- `src/install/installer.ts` — release-bundled first-install handoff; keep it dependency-light because it runs before `node_modules` exists.
- `src/cli.ts` — citty entry; declares subcommands and delegates to command/domain `run*` functions.
- `src/commands/` — command modules that still own their implementation (`start`/`stop`/`health`/`env`/`update`). Pure wrapper modules are avoided.
- `src/gateway_float.ts` — the gateway float (see above).
- `src/commands/setup.ts` — optional agent-CLI install/verification plus setup subcommand helpers.
- `src/commands/shell_integration.ts` — cross-platform shell/profile block wiring for integration and launchers.
- `src/install/release.ts` — release archive download/verification/extraction/sync used by `agent update`.
- `src/codex/` — Codex config and per-host `CODEX_HOME` farm logic.
- `src/migrations/` — one file per version step (`<from-version>.ts`, registered in `index.ts`); `agent update` runs the due ones for the `[old, new)` range. See "Migrations" below.
- `src/copilot_api/` — gateway-specific helpers: admin REST, config/state JSON, model-alias generation, per-host paths, daemon process control.
- `src/usage/` — `cost` reporting over per-host SQLite usage DBs using live OpenRouter pricing.
- `src/utils/` — generic helpers (hostname, `PROJECT_ROOT`, semver compare).
- `copilot-env.config` — `KEY=value` gateway-float floor/ceiling, read by `src/gateway_float.ts` (+ `start.ts`).
- `test/` — `bun test` suites: pure-logic units + a start/stop daemon lifecycle against `test/copilot-api-fake.mjs`.
- `.github/`, `.devcontainer/`, `.claude/`, `.codex/` — CI/CodeQL, Codespaces, and agent-worktree wiring.

## Agent & dev environment init

Every agent/dev environment and any fresh `git worktree` initializes through **one** idempotent script — `scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows) — so no entry point drifts. It runs `bun install --frozen-lockfile` (which also fires the best-effort gateway float; no agent CLIs). Entry points that invoke it: the GitHub Copilot coding agent (`.github/workflows/copilot-setup-steps.yml`), Codespaces / Dev Containers (`.devcontainer/`), Claude Code and Codex CLI worktrees (`SessionStart` hooks in `.claude/` and `.codex/`, no-op when `node_modules` already exists), and humans (run it directly). For the Codex app, configure a Local Environment that runs `scripts/setup-env.sh` on worktree creation and `./bin/agent stop || true` on cleanup.

## Migrations

`src/migrations/` carries one-time, version-to-version fix-ups for an existing install (e.g. relocating files, re-pointing rc blocks). One file per step named for the release it migrates **away from** (`1.2.1.ts`) — so a migration is authored against the *current* released version and never has to predict the future release number release-please will assign. Each exports a `Migration { version, description, run }` registered in `index.ts`; `run` must be **idempotent** (an update can be retried).

`agent update` runs the due migrations after it swaps in the new release: it spawns `bun src/migrations/index.ts <old> <new>` (the module is runnable via an `import.meta.main` guard) — a **fresh process**, because the running `update.ts` still holds the pre-update code in memory, so the new migration set and the code it calls must load from disk. `dueMigrations` selects every from-version left behind, the half-open range `[old, new)`; failures are non-fatal (warn, continue).

**Bootstrapping caveat:** an update is driven by the *old* release's `update.ts`, so the migration call only fires for updates whose old version already ships it (≥ the one that added migrations). The very transition that introduces the subsystem can't auto-run via `update`; that one is covered by the installer's `agent setup-shell` refresh (which rewrites a stale owned block in place — see `wireBlocks`/`upsertBlock` in `src/commands/shell_integration.ts`).

## Conventions

- **No `any`** — biome's `noExplicitAny` is `error`.
- **camelCase** functions/vars/params, **PascalCase** types/classes/interfaces, **CONSTANT_CASE** top-level constants; **snake_case only on object-literal keys** (for external config-file keys we don't control). Always quote object-literal keys.
- **No new deps without an explicit reason.** Current: `citty`, `consola`, `dotenv` (root `.env` loading), `smol-toml`, `tar` (release-tarball extraction for `agent update`), `@jeffreycao/copilot-api`, `patch-package`.
- **String literals are external contracts** — model ids, JSON keys, env var names, log markers: never rename them during refactors.
- **bun** (runtime), **biome** (TS format/lint), **tsc** (typecheck), **shellcheck** / **PSScriptAnalyzer** (shell / PowerShell). No webpack, rollup, or bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", or "codex" lines** in commits or PR descriptions.
- **Conventional Commits** — commit subjects use a type prefix so release-please can version: `feat:` (minor), `fix:` (patch), `feat!:` or a `BREAKING CHANGE:` footer (major); `chore:`/`docs:`/`refactor:`/`test:`/`ci:` don't release. (This is separate from the no-Co-Authored-By rule above, which still applies.)

## Releases

Versioned via [release-please](.github/workflows/release-please.yml): after `CI / all-green` succeeds on a push to `main`, CI calls the reusable release-please workflow to update ONE rolling **release PR** (`chore(main): release X.Y.Z`) that bumps `package.json` + regenerates `CHANGELOG.md` from the commit prefixes. **Nothing releases on ordinary feature/fix pushes** — merging the release PR is what tags `vX.Y.Z` and publishes the GitHub Release. The main-branch installers and `agent update` install the newest release tag (not `main`); `agent update --cooldown[=DAYS]` installs the newest release ≥N days old.

- **Releases only ever move forward.** Once a version is published (tagged + GitHub Release), treat it as immutable: never re-release it, overwrite it, or pin a future release back to it — users may already be on it. Each new release must be **> the latest published tag**. `release-as` is a one-time override to set a starting point (it forced the first release to `1.0.0`, and has since been removed); leave it **absent** so versions derive from commit prefixes (`feat:`→minor, etc.). Do not reintroduce it pointing at a shipped or older version.
- The release PR opens with `RELEASE_PLEASE_TOKEN` (a PAT or GitHub App token, set as a repo secret) so CI runs on it like a normal PR. **Without that secret** the workflow falls back to the built-in `GITHUB_TOKEN`, and GitHub's recursion guard means workflows never trigger on a `GITHUB_TOKEN`-opened PR — so the required `all-green` check sits unmet and you merge with admin bypass (the code already passed CI into `main`).


## Commands

```bash
bun run typecheck     # tsc --noEmit
bun test              # test/**/*.test.ts
bun run lint          # biome check src bin test scripts
bun run lint:sh       # shellcheck     (skip-if-absent)
bun run lint:ps       # PSScriptAnalyzer (skip-if-absent)
bun run check         # biome check --write src bin test scripts

./bin/agent start     # start the daemon; also: stop / health / env / cost / update / setup-shell / setup-launchers / setup-clis / setup-codex-config / setup-codex-host
./bin/agent env       # print shell env vars pointing at the local gateway
```

The husky `pre-commit` hook runs lint-staged (biome) + typecheck + tests + the shell/PS linters; the linters are skip-if-absent and gate only on warnings+errors. CI runs the same on a Linux/macOS/Windows matrix, plus the start/stop lifecycle and end-to-end installer jobs.

## Patching `@jeffreycao/copilot-api`

Patching and floating are mutually exclusive: a `patch-package` patch is keyed to one exact version and stops applying once the float moves on. To patch: temporarily pin an exact version in `package.json` (freezing the float), edit under `node_modules/@jeffreycao/copilot-api/dist/`, run `npx patch-package @jeffreycao/copilot-api`, and commit the patch alongside the pin; restore `"latest"` to resume floating. `patch-package` is non-fatal, so a stale patch won't break startup. No patch exists today.
