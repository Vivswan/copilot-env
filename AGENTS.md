# copilot-env

Local copilot-api gateway lifecycle + config helper. TypeScript port of the original Python `copilot-api` package.

## Cross-platform

This project supports **Linux, macOS, and Windows**.

- POSIX launcher: `bin/agent` (single self-bootstrapping entry point)
- Windows launcher: `bin/agent.ps1`
- All TS code uses `process.platform` branches where OS-specific behavior is needed (see `src/utils/cache.ts`).
- Cache directory follows OS conventions: `~/.cache/copilot-env` (Linux), `~/Library/Caches/copilot-env` (macOS), `%LOCALAPPDATA%\copilot-env\Cache` (Windows).
- By default there is **no cache**: `user_cache.ts` installs deps directly in the source checkout (the gateway float runs separately, as `bun install`'s postinstall — see Architecture) and `cli.ts` runs from there. A separate per-user cache is opt-in via `agent local_cache_start` (which passes `--local-cache` to `user_cache.ts`): a real **symlink** mirror on macOS/Linux, a **copy** mirror on Windows (junctions are OS-transparent reparse points that break module resolution from the cache). The mirror mode is recorded in a `.symlink-cache` marker (`src/user_cache.ts`).

## Architecture

- **node_modules + the gateway live in the "runtime root"** — by default the source checkout itself (in-place, no cache); opt into a per-user cache with `agent local_cache_start` (symlink mirror on macOS/Linux, copy on Windows) (`src/user_cache.ts`). The bin shims export `COPILOT_ENV_ROOT` (the root `user_cache.ts` printed) so `copilot_api/process.ts` anchors module resolution there — necessary because bun realpaths a symlinked cached source back to the checkout, where the cache's node_modules isn't reachable.
- **bun runtime** — native TS support (vs tsx's ~750ms). Bin shims auto-install bun if missing. Each `bin/agent` invocation runs a `bun install --frozen-lockfile` so the postinstall gateway float fires every time (see cadence below), so a warm call is install-bound rather than a bare ~170ms CLI dispatch.
- **Floating `@jeffreycao/copilot-api`** — `package.json` tracks `"latest"`. A 7-day supply-chain cooldown (`bunfig.toml` `install.minimumReleaseAge = 604800`) means a plain resolve only ever adopts releases public for ≥7 days. The float itself lives in **`src/gateway_float.ts`**, run as `bun install`'s **postinstall** (`"postinstall": "bun src/gateway_float.ts && patch-package"`): it overlays the runtime root's `node_modules` with `bun add --no-save` (re-checked at most weekly via a `.gateway-checked` stamp), so the read-only committed `bun.lock` is never rewritten — every *other* dep stays pinned and the lock keeps pinning the reproducible baseline (used on cold start / offline). Because the overlay uses `--no-save`, `bun list` and bun's own install summary report the *locked* baseline, not the floated version actually on disk (verify with `node_modules/@jeffreycao/copilot-api/package.json`). `src/user_cache.ts` is **independent** of the float — it only mirrors caches and runs `bun install`, which triggers the postinstall float. `copilot_api/process.ts:launchDaemon` resolves the entry through `createRequire` (anchored at `COPILOT_ENV_ROOT`) and spawns it via `process.execPath` (the running runtime, i.e. `bun`) directly — no `npx`, no separate `node`. On start, `start.ts` logs the running gateway version + its npm publish date (`copilotApiVersion` + best-effort registry fetch).
- **Compatibility floor / ceiling** (`GATEWAY_MIN_VERSION` / `GATEWAY_MAX_VERSION` in `copilot-env.config`, currently `1.10.30` / empty) — the version window the wrapper is known to work against; bump the floor when the wrapper relies on newer gateway behavior, set the (optional, inclusive) ceiling to hold the float below a known-bad release. The default float installs the newest release in `[floor, max]` AND ≥7 days old (`bun add @">=floor <=max"`); if none has cleared the cooldown yet, it pins exactly the floor with the cooldown bypassed, so the floor is always available. `floatGateway` is **self-healing**: it records the resolved version in the `.gateway-checked` stamp (content = version, mtime = weekly throttle) and, between weekly resolutions, holds exactly that version — if the installed gateway drifts from it (e.g. `bun install` relaid a different release into the same `node_modules`), it reinstalls that exact version + repatches regardless of the stamp. Offline policy: a failed refresh keeps (and backs off on) an installed ≥floor gateway, otherwise it throws — but the postinstall entry (`main` in `gateway_float.ts`) catches it, so the float is **best-effort**: a registry/offline hiccup never fails `bun install` (it leaves whatever gateway is installed, which a fresh offline clone could leave below the floor). The floor is still a **hard runtime contract**: `commands/start.ts:assertGatewayFloor` refuses to launch the daemon on a sub-floor gateway (compares `copilotApiVersion()` against `GATEWAY_MIN_VERSION` before any cleanup), so best-effort-at-install never means running below the floor.
- **Gateway float cadence** — the float runs in `bun install`'s postinstall, and `src/user_cache.ts` runs `bun install --frozen-lockfile` on **every** `bin/agent` invocation (scripts enabled; `HUSKY=0`), so the postinstall float fires each time and self-throttles its registry re-resolution via the weekly `.gateway-checked` stamp (it also re-resolves when the gateway is missing, no version is recorded, or the recorded version falls outside `[floor, max]`). Each `bun install` relays the locked baseline into `node_modules`, then the float re-overlays the recorded version (so a `--no-save` overlay below the floor is a transient, self-healed state). The same `.gateway-checked` stamp is shared by the in-place checkout and any per-user cache. Updates also happen via `COPILOT_API_VERSION` or a lockfile change.
- **Env overrides** (read by `gateway_float.ts` in postinstall, inherited straight through `bun install`, e.g. `COPILOT_API_COOLDOWN_DAYS=14 ./bin/agent start`): `COPILOT_API_VERSION=<version|tag>` pins the gateway to a specific release, bypassing both the floor and the 7-day cooldown (`bun add --minimum-release-age=0`); `COPILOT_API_COOLDOWN_DAYS=<n>` overrides the float-probe release-age window (replaces the dropped `--cooldown` flag); `COPILOT_API_FLOAT_INTERVAL_DAYS=<n>` overrides the weekly re-check cadence (replaces `--float-interval`); `COPILOT_API_NO_FLOAT=1` skips the float entirely (replaces `--no-float`). Unset = float per the floor above.

## Files

- `package.json` — `@jeffreycao/copilot-api: "latest"` (floats, see Architecture) + pinned dev/runtime deps + `engines.bun` / `packageManager` metadata + `trustedDependencies` (bun blocks dependencies' postinstall scripts by default) + a `postinstall` that floats the gateway then applies patches (`bun src/gateway_float.ts && patch-package` — float first so patch-package lands on the final version)
- `copilot-env.config` — top-level `KEY=value` release/cooldown bounds shared by TypeScript + POSIX + PowerShell: `CooldownRepoMinSha` / `CooldownRepoMaxSha` for installer repo rollback, and `GATEWAY_MIN_VERSION` / `GATEWAY_MAX_VERSION` for the gateway float. Empty MAX values mean no ceiling (`null` is also accepted).
- `bunfig.toml` — `install.minimumReleaseAge = 604800` (7-day supply-chain cooldown on dependency resolution)
- `bun.lock` — committed reproducible baseline for every dep except the floated gateway; `npm ci`-equivalent reproducibility
- `bin/agent` — the single POSIX self-bootstrapping launcher. Installs bun if missing, prepares node_modules via `user_cache.ts` (in-place in the checkout by default; a `--local-cache` cache build when the subcommand is `local_cache_start`, which it translates → `start`), exports `COPILOT_ENV_ROOT` (the run dir `user_cache.ts` printed), then `exec`s `src/cli.ts` with the args. cli.ts dispatches everything (`start`/`stop`/`health`/`env`/`cost`/`codex_config`/`host_codex`).
- `bin/agent.ps1` — Windows equivalent of `bin/agent`.
- `agents.bashrc` — sourced from your shell rc; defines a **uniform** `agent` wrapper over `bin/agent`: it runs the requested command, then re-applies the session env from the single source of truth — `agent env`, which prints only `export KEY=val` lines (gateway vars, plus `CODEX_HOME` when a per-host Codex farm is active). No per-subcommand logic — a new `bin/agent` subcommand needs no change here, and only the dedicated, contract-stable `env` output is ever eval'd (never a command's incidental stdout). User commands: `agent start` / `agent local_cache_start` (build + start; the latter builds a per-user cache — symlink mirror on macOS/Linux, copy on Windows — instead of installing in-place), `agent codex_config`, `agent host_codex` (Linux-only farm), `agent stop|env|cost|…`. Also defines `cl`, `co`, `cx`. Pure runtime wiring — never installs anything; resolves its dir into `_COPILOT_AGENTS_DIR`.
- `agents.ps1` — PowerShell equivalent of `agents.bashrc`; dot-sourced from the user's `$PROFILE`. Same uniform `agent` wrapper over `bin/agent.ps1` (`Invoke-Agent` + `Import-CopilotEnv` to apply `$env:KEY = …` lines), prepends `~/.bun/bin` to PATH. `agent local_cache_start` builds a copy-mirror cache on Windows; the per-host `CODEX_HOME` farm is Linux-only (ignored on Windows).
- `install.sh` — POSIX installer (runs from a checkout or piped via `curl … | bash`). Ensures `git`, clones/updates the repo to `~/.copilot-env` (`COPILOT_ENV_DIR` override), installs Node via nvm + bun via its official installer + the agent CLIs (`claude`/`copilot`/`codex`) via npm, then adds a source block for `agents.bashrc` to `~/.bashrc` and/or `~/.zshrc`. Idempotent; curl-pipe-safe (no interactive prompts). `--cooldown[=DAYS]` (bare = 7 days, matching `bunfig.toml`) applies a supply-chain cooldown to **both** the npm-installed agent CLIs **and** the copilot-env checkout itself: for the CLIs it pipes `npm view <pkg> time` into the shared `src/install/aged-version.ts` (run with bun) to pin the newest stable release ≥ DAYS old instead of `latest`; for the repo it rolls the installer-managed clone back to the newest commit on `main` that is ≥ DAYS old (resolved via `git rev-list … --before`, clamped to `CooldownRepoMinSha`/`CooldownRepoMaxSha` from `copilot-env.config` — same model as the gateway's `GATEWAY_MIN_VERSION`/`MAX`). The rollback is deferred to the end of the script (the run itself uses the fresh checkout, e.g. the CLI resolver); an existing user checkout is never rewritten. Defends against a compromised just-published npm release **or** just-pushed copilot-env commit.
- `install.ps1` — Windows installer (runs from a checkout or piped via `irm … | iex`). Installs prerequisites via `winget` (Git, Node/npm, Bun) + the agent CLIs, clones/updates the repo to `%USERPROFILE%\.copilot-env`, bootstraps copilot-env deps, and adds a dot-source block for `agents.ps1` to the PowerShell `$PROFILE` (`-AllHosts` targets the CurrentUserAllHosts profile). `-Cooldown [-CooldownDays N]` is the parity of `install.sh`'s `--cooldown` — it calls the **same** `src/install/aged-version.ts` resolver (run with bun) for the agent CLIs and applies the same `git rev-list --before` + `[MIN, MAX]` commit cooldown to the repo checkout (deferred rollback). Sets `$PSNativeCommandUseErrorActionPreference = $false` so `git merge-base --is-ancestor`'s expected exit 1 doesn't throw under PS 7.4+. **`install.sh` and `install.ps1` must always stay feature-matched.**
- `src/install/aged-version.ts` — the **single** npm-package supply-chain-cooldown resolver shared by both installers (so they can't drift). Pure `pickAgedVersion(timeMap, days, nowMs)` (newest stable `x.y.z` ≥ N days old, prereleases + `created`/`modified` skipped, numeric-semver ordering) + a `bun`-run CLI that reads `npm view <pkg> time --json` on stdin (`--days N`; exits 0+version / 2 bad args / 3 unparseable-or-non-object stdin / 4 none old enough). Unit- + smoke-tested by `test/aged-version.test.ts`. (The repo-commit cooldown logic lives inline in each installer as `resolve_aged_commit` / `Resolve-AgedCommit`, since it's git-native; its floor/ceiling values live in `copilot-env.config`.)
- `src/cli.ts` — the single citty entry: declares the subcommands (`start`/`stop`/`health`/`env`/`cost`/`codex_config`/`host_codex`) + their args, and each `run()` just calls the matching function. `bin/agent` execs this after building the cache.
- `src/commands/` — one module per command (each exports a `run*` function called by `cli.ts`):
  - `start.ts` (`runStart`) — launch the daemon detached, wait for readiness, sync catalog-derived model aliases via the admin API, and persist the resolved port to state. Holds the default config (smallModel, flags) written before launch. `assertGatewayFloor` gates launch on a ≥`GATEWAY_MIN_VERSION` gateway (the postinstall float is best-effort, so this is where the floor becomes a hard contract).
  - `stop.ts` (`runStop`) — terminate the tracked daemon on this host.
  - `health.ts` (`runHealth`) — report whether the gateway is HTTP-reachable + the tracked pid state; exits non-zero when unreachable.
  - `env.ts` (`runEnv`) — print shell-evaluable env assignments (`--format posix` default, `--format powershell`). The only machine-readable-stdout command (the `agent` wrapper evals it): the 4 gateway vars, plus `CODEX_HOME` when `state.codexHome` is set.
  - `codex_config.ts` (`runCodexConfig` + exported `configureCodexConfig`/`applyCodexConfig`) — write a Codex `config.toml`/`.env` at a CODEX_HOME wired to the gateway (default `~/.codex`, falling back to `state.codexHome`). Operates only on the given CODEX_HOME — agnostic of hostname and of the global `~/.codex`. Persists the resolved CODEX_HOME to state so `env` can export it.
  - `codex_host.ts` (`runCodexHost`) — Linux-only (`assertLinux`): build the per-host `~/.codex/hosts/<hostname>` symlink farm (seeding shared state + copying the global config into the host dir), then call `applyCodexConfig` to wire its config.
- `src/user_cache.ts` — cross-platform node_modules bootstrap (standalone, **not** a cli.ts subcommand; run by `bin/agent` before every dispatch, since it must work before node_modules exist). **Independent of the gateway float** (no import of `gateway_float.ts`): it only mirrors the source into a per-user cache when asked, then runs `bun install`. Three mirror modes by flag: no flag = in-place (install in the checkout); `--symlink` / `--copy` = mirror the source into a per-user cache (symlinks / real copies) then install there; `--local-cache` = `--symlink` on macOS/Linux, `--copy` on Windows. Always runs `bun install --frozen-lockfile` (scripts **enabled** — no `--ignore-scripts` — so `bun install`'s postinstall gateway float fires; `env HUSKY=0` so husky's `prepare` doesn't reinstall git hooks each call), then prints the resolved run dir on stdout. Cache mirror mode is recorded in a `.symlink-cache` marker. Imports only `./utils/cache.ts`.
- `src/gateway_float.ts` — the gateway float, run as `bun install`'s **postinstall** (`bun src/gateway_float.ts && patch-package`) and nothing else; `src/user_cache.ts` and this module never import each other, so the `bun install` is the only handoff. Exports `floatGateway` (resolution order: `COPILOT_API_VERSION` pin → newest `[floor, max]` release ≥7 days old → floor pin, cooldown bypassed; overlays via `bun add --no-save --ignore-scripts`, self-heals drift, weekly `.gateway-checked` stamp). A `main()` guarded by `import.meta.main` (so tests can import without running it) resolves the runtime root from `process.cwd()` (the package root during a lifecycle script), reads the floor/ceiling from `./project_config.ts` (`copilot-env.config`), and reads `COPILOT_API_VERSION` / `COPILOT_API_COOLDOWN_DAYS` / `COPILOT_API_FLOAT_INTERVAL_DAYS` / `COPILOT_API_NO_FLOAT` from the env. Fatal paths **throw** (`fail`), and `main` catches → **best-effort** (never fails `bun install`). Imports only `./project_config.ts`.
- `src/usage/` — `cost.ts` (`runCost` + table/JSON rendering) alongside its data layer `pricing.ts` (OpenRouter pricing: `fetchPricing`/`resolvePricingId`/`estimateCost`) and `usage.ts` (`discoverUsageDbs`/`readUsage` over the per-host `token_usage_events` SQLite tables via `bun:sqlite`).
- `src/copilot_api/` — the gateway-specific utils: `admin.ts` (`CopilotAdminClient` REST), `config.ts` (`CopilotApiConfig`: API-key management + generic atomic JSON read/write), `models.ts` (pure `generateAliases`), `paths.ts` (`CopilotApiPaths`/`DEFAULT_HOME` — per-host log/sqlite/state paths), `port.ts`, `process.ts` (`launchDaemon`/`getOrphanPids`/`copilotApiVersion`), `state.ts` (`CopilotApiState`: a typed `read()`/`set()` over `.run/<host>/.state.json` holding `port`/`pid`/`codexHome`, backed by `CopilotApiConfig`; `set({key:null})` deletes a key). `start` sets `port`+`pid`, `stop` clears them, `host_codex` sets/clears `codexHome`, and `env`/`port`/`health` only read.
- `src/utils/` — generic, non-gateway helpers: `cache.ts` (OS-native cache dir resolver), `hostname.ts` (`HOME`/`getSanitizedHostname`), `root.ts` (`moduleRoot` — the runtime root for module resolution: `COPILOT_ENV_ROOT` or the nearest-`package.json` project root fallback), and `semver.ts` (`versionLessThan` — dotted-numeric floor/ceiling comparison shared by `gateway_float.ts` and `start.ts`'s floor gate).
- `biome.json` — formatter + linter config (camelCase, snake_case allowed only on object-literal keys for config-file keys like `max_input_tokens`)
- `tsconfig.json` — strict + noUncheckedIndexedAccess
- `.editorconfig` / `.gitattributes` — enforce UTF-8 + LF line endings (text normalized to LF, binary assets left untouched) so the cross-platform sources stay consistent
- `patches/` — patch-package patches (applied via `postinstall`)
- `test/**/*.test.ts` — `bun test` suites, centralized under `test/` (pure-logic units for `models.ts`/`pricing.ts`/`paths.ts`/`config.ts`/`usage.ts`/`install/aged-version.ts`, a `codex_config.ts` config test, the `aged-version.ts` resolver units + CLI smoke tests, and a `cli.ts --help` smoke test). They import the code under test via `../src/...`. `bun:test`/`bun:sqlite` are exempted from biome's `noUnresolvedImports` via a `*.test.ts` override in `biome.json`.
- `scripts/lint-sh.sh` / `scripts/lint-ps.sh` — skip-if-absent shell/PowerShell linters used by pre-commit + CI
- `scripts/setup-env.sh` / `scripts/setup-env.ps1` — the **single** environment/worktree init (`bun install --frozen-lockfile`, idempotent, bun + deps + no agent CLIs; note its `bun install` now also runs the postinstall gateway float, best-effort). Shared by every agent/dev entry point so they can't drift (see "Agent & dev environment init" below).
- `.github/workflows/copilot-setup-steps.yml` — provisions the GitHub **Copilot coding agent**'s ephemeral env before it starts a task: a single job named exactly `copilot-setup-steps` (the name GitHub recognizes) runs `setup-bun` (1.3.14) → `scripts/setup-env.sh` (`HUSKY=0`). `actionlint` lints it; it is not a required status check.
- `.devcontainer/devcontainer.json` — Codespaces / VS Code Dev Containers: base ubuntu + node 20 feature, `postCreateCommand` installs `bun@1.3.14` then runs `scripts/setup-env.sh`; recommends the biome + bun VS Code extensions.
- `.claude/settings.json` — Claude Code `SessionStart` hook that auto-inits a fresh worktree (`[ -d "$CLAUDE_PROJECT_DIR/node_modules" ] || bash "$CLAUDE_PROJECT_DIR/scripts/setup-env.sh"` — anchored on the project root so it works even when Claude is launched from a subdirectory) — a no-op in the main checkout, installs deps in a new worktree.
- `.codex/hooks.json` — Codex CLI `SessionStart` hook (same pattern as `.claude/settings.json`): runs `scripts/setup-env.sh` on first startup when `node_modules` is missing. Project-scoped; Codex loads it when the project `.codex/` layer is trusted.
- `.github/workflows/ci.yml` — CI: install/typecheck/lint/test **plus a start/stop daemon-lifecycle step** on a Linux+macOS+Windows matrix (shellcheck on Linux, PSScriptAnalyzer on Windows), **an `install-sh` job that runs the real `install.sh --cooldown` end-to-end on Linux+macOS and an `install-ps1` job that runs `install.ps1 -Cooldown` end-to-end on Windows** (prereqs + the agent CLIs + shell/profile wiring, asserting the CLIs and integration block land), + an `actionlint` job; the lifecycle step runs `cli.ts start`→`stop` against a fake gateway (`COPILOT_API_ENTRY` → `test/copilot-api-fake.mjs`, no auth needed); `concurrency` cancels superseded runs
- `test/copilot-api-fake.mjs` — stand-in gateway for the start/stop check: binds the port, answers the admin endpoints, prints the `Listening on:` marker, stays alive until `SIGTERM`. Selected via the `COPILOT_API_ENTRY` override in `copilot_api/process.ts:resolveCopilotApiEntry`. Its name must contain `copilot-api` so `isCopilotApiPid`'s cmdline matcher recognizes the launched daemon (else `stop` won't signal it).
- `.github/workflows/codeql.yml` — CodeQL code scanning (javascript-typescript) on push/PR + a weekly schedule
- `.github/workflows/auto-assign.yml` — assigns new issues/PRs to the repo owner and labels same-repo PRs `fix-lint`
- `.github/dependabot.yml` — monthly `github-actions` + `bun` updates (bun ecosystem is GA in Dependabot; 7-day cooldown mirroring `bunfig.toml`; floated gateway ignored)
- `.github/settings.yml` — repo settings-as-code for the [Settings app](https://github.com/repository-settings/app) (squash-only merges, `allow_auto_merge`, wiki/projects off) **plus an experimental `rulesets` block** for `main` (restrict deletions, block force-push, linear history, require CI + CodeQL, auto Copilot code review via `copilot_code_review`, admin bypass). Inert unless that app is installed; "Require code quality results" isn't a documented ruleset rule yet (public preview) so it must be enabled in the UI.
- `.github/CODEOWNERS` — default owner `@Vivswan`
- `.github/copilot-instructions.md` — symlink to `AGENTS.md` (GitHub Copilot reads repo instructions from here, mirroring the `CLAUDE.md` symlink)
- `SECURITY.md` / `CONTRIBUTING.md` — security disclosure policy + contributor guide
- `.github/ISSUE_TEMPLATE/` + `.github/PULL_REQUEST_TEMPLATE.md` — issue / PR templates

## Agent & dev environment init

Every agent/dev environment — and any fresh `git worktree` that Claude Code or
Codex spins up — initializes through **one** idempotent script,
`scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows), which runs
`bun install --frozen-lockfile` (bun + deps; no agent CLIs — but `bun install`'s
postinstall floats the gateway, best-effort). The single script keeps every entry
point from drifting:

- **GitHub Copilot coding agent** → `.github/workflows/copilot-setup-steps.yml` (job `copilot-setup-steps`) runs it automatically when provisioning the agent's env.
- **Codespaces / VS Code Dev Containers** → `.devcontainer/devcontainer.json` `postCreateCommand` runs it on container create.
- **Claude Code worktrees** → `.claude/settings.json` `SessionStart` hook runs it when `node_modules` is missing (no-op otherwise).
- **Codex CLI worktrees** → `.codex/hooks.json` `SessionStart` hook runs `scripts/setup-env.sh` when `node_modules` is missing (no-op otherwise). The project `.codex/` layer must be trusted (Codex prompts on first use). For the **Codex app** (cloud/desktop), setup runs from an app-configured **Local Environment** (Codex app settings → Local Environments) that executes automatically on worktree creation (worktrees live under `$CODEX_HOME/worktrees`; the worktree path is `$CODEX_WORKTREE_PATH`). Recommended config:
  - **Setup script** (runs at project root on worktree creation): `bash scripts/setup-env.sh` (Default/macOS/Linux); `pwsh scripts/setup-env.ps1` (Windows).
  - **Cleanup script** (runs before worktree cleanup): `./bin/agent stop || true` (best-effort: stop the gateway daemon if this worktree started one).
  - **Actions** (toolbar commands): `bun run typecheck`, `bun run lint`, `bun test`, `bun run check`, `./bin/agent start`, `./bin/agent stop`.

  Once saved, Codex writes the project config under `.codex/` at the repo root — commit it to share the setup with the team.
- **Humans** → just run `bash scripts/setup-env.sh` (or `bun install`).

## Conventions

- **No `any`** — biome's `noExplicitAny` is `error`.
- **camelCase** for functions, methods, variables, parameters. **PascalCase** for classes, interfaces, types. **CONSTANT_CASE** for top-level constants. **snake_case allowed on object-literal keys only** (for external config-file keys we don't control).
- **Always quote object-literal keys.** Mixed quoted/unquoted keys in the same literal are inconsistent and easy to misread. Biome's `quoteProperties: "preserve"` keeps the quotes you write; never strip them.
- **No new deps without an explicit reason.** Current deps: `citty` (CLI), `consola` (logging), `smol-toml` (TOML load-mutate-stringify), `@jeffreycao/copilot-api` (pinned gateway), `patch-package`.
- **String literals are external contracts** — model ids, JSON keys, env var names, log strings: never rename them during refactors.
- **bun for runtime, biome for format/lint (TS), tsc for typecheck, shellcheck for shell, PSScriptAnalyzer for PowerShell.** No webpack, no rollup, no bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", or "codex" lines in commits or PR descriptions.**

## Commands

```bash
# from the project dir
bun run typecheck          # tsc --noEmit
bun test                   # bun's test runner (test/**/*.test.ts)
bun run lint               # biome check src bin test
bun run lint:sh            # shellcheck (install.sh, agents.bashrc, bin/agent)
bun run lint:ps            # PSScriptAnalyzer (install.ps1, agents.ps1, bin/*.ps1)
bun run format             # biome format --write
bun run check              # biome check --write src bin
```

The husky `pre-commit` hook runs `lint-staged` (biome) + `typecheck` + `bun test` + `lint:sh` + `lint:ps`. The shell/PowerShell linters are **skip-if-absent**: `lint:sh` no-ops when `shellcheck` isn't installed, `lint:ps` no-ops when `pwsh`/PSScriptAnalyzer isn't — so commits never break for lack of an optional linter. Both gate only on warnings+errors (style/info findings are ignored). Helper scripts live in `scripts/`. CI (`.github/workflows/ci.yml`) runs the same checks on a Linux/macOS/Windows matrix.

Direct CLI use (the single `bin/agent` launcher):
```bash
./bin/agent --help
./bin/agent start
./bin/agent env
./bin/agent codex_config        # or: host_codex (Linux-only)
```
On Windows, use the `.ps1` launcher (`powershell -ExecutionPolicy Bypass -File bin\agent.ps1 ...`).

Install (one-line — clones/updates to `~/.copilot-env`, installs prereqs + agent CLIs, wires the shell):
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
```
```powershell
# Windows
irm https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.ps1 | iex
```

From a checkout, `install.sh` / `install.ps1` do the same (idempotent):
```bash
./install.sh          # install prereqs + source agents.bashrc into ~/.bashrc / ~/.zshrc
```
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Patching `@jeffreycao/copilot-api`

**Caveat:** the gateway floats (`"latest"`, ≥7-day cooldown), and a `patch-package` patch is keyed to one exact version — it will fail to apply once the float moves on. So patching and floating are mutually exclusive. If you must patch:

1. Temporarily pin `@jeffreycao/copilot-api` to an exact version in `package.json` (this freezes the float).
2. Edit files under `<cache>/node_modules/@jeffreycao/copilot-api/dist/`
3. From the project dir, `npx patch-package @jeffreycao/copilot-api` → commit `patches/@jeffreycao+copilot-api+<version>.patch` alongside the pin.
4. To resume floating, drop the patch and restore `"latest"`.

`patch-package` stays non-fatal (default warns, doesn't fail install), so a stale patch from a prior pin won't break startup — but don't rely on it applying. No patch exists today (`patches/` holds only `README.md`).
