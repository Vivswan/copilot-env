# copilot-env

Local copilot-api gateway lifecycle + config helper. TypeScript port of the original Python `copilot-api` package.

## Cross-platform

This project supports **Linux, macOS, and Windows**.

- POSIX launcher: `bin/agent` (single self-bootstrapping entry point)
- Windows launcher: `bin/agent.ps1`
- All TS code uses `process.platform` branches where OS-specific behavior is needed (see `src/utils/cache.ts`).
- Cache directory follows OS conventions: `~/.cache/copilot-env` (Linux), `~/Library/Caches/copilot-env` (macOS), `%LOCALAPPDATA%\copilot-env\Cache` (Windows).
- By default there is **no cache**: `user_cache.ts` installs deps + floats the gateway directly in the source checkout and `cli.ts` runs from there. A separate per-user cache is opt-in via `agent local_cache_start` (which passes `--local-cache` to `user_cache.ts`): a real **symlink** mirror on macOS/Linux, a **copy** mirror on Windows (junctions are OS-transparent reparse points that break module resolution from the cache). The mirror mode is recorded in a `.symlink-cache` marker (`src/user_cache.ts`).

## Architecture

- **node_modules + the gateway live in the "runtime root"** — by default the source checkout itself (in-place, no cache); opt into a per-user cache with `agent local_cache_start` (symlink mirror on macOS/Linux, copy on Windows) (`src/user_cache.ts`). The bin shims export `COPILOT_ENV_ROOT` (the root `user_cache.ts` printed) so `copilot_api/process.ts` anchors module resolution there — necessary because bun realpaths a symlinked cached source back to the checkout, where the cache's node_modules isn't reachable.
- **bun runtime** — native TS support, ~170ms per CLI invocation vs tsx's ~750ms. Bin shims auto-install bun if missing.
- **Floating `@jeffreycao/copilot-api`** — `package.json` tracks `"latest"`. A 7-day supply-chain cooldown (`bunfig.toml` `install.minimumReleaseAge = 604800`) means only releases public for ≥7 days are ever adopted. `src/user_cache.ts` overlays the runtime root's `node_modules` with `bun add` (re-checked at most weekly via a `.gateway-checked` stamp), so the read-only committed `bun.lock` is never rewritten — every *other* dep stays pinned. The lock pins the reproducible baseline (used on cold start / offline). The float runs in every mode (in-place + cache); `--no-float` skips it. `copilot_api/process.ts:launchDaemon` resolves the entry through `createRequire` (anchored at `COPILOT_ENV_ROOT`) and spawns it via `process.execPath` (the running runtime, i.e. `bun`) directly — no `npx`, no separate `node`. On start, `start.ts` logs the running gateway version + its npm publish date (`copilotApiVersion` + best-effort registry fetch).
- **Compatibility floor / ceiling** (`GATEWAY_MIN_VERSION` / `GATEWAY_MAX_VERSION` in `user_cache.ts`, currently `1.10.30` / `null`) — the version window the wrapper is known to work against; bump the floor when the wrapper relies on newer gateway behavior, set the (optional, inclusive) ceiling to hold the float below a known-bad release. The default float installs the newest release in `[floor, max]` AND ≥7 days old (`bun add @">=floor <=max"`); if none has cleared the cooldown yet, it pins exactly the floor with the cooldown bypassed, so the floor is always available. `floatGateway` is **self-healing**: it records the resolved version in the `.gateway-checked` stamp (content = version, mtime = weekly throttle) and, between weekly resolutions, holds exactly that version — if the installed gateway drifts from it (e.g. a plain `bun install` pulled a different ≥7-day-old release into the same `node_modules`), it reinstalls that exact version + repatches regardless of the stamp. Offline policy: a failed refresh keeps (and backs off on) an installed ≥floor gateway, but `die`s rather than run a sub-floor one.
- **Gateway float cadence** — `user_cache.ts` has no per-command behavior: whenever it runs it (in a cache mode) mirrors the source, frozen-installs when `bun.lock` changed, and `floatGateway` re-resolves the gateway only when the weekly `.gateway-checked` stamp is due, the gateway is missing, or a baseline (re)install just happened. In a cache mode it deliberately does **not** wipe the cache (a full wipe forces a slow byte-copy of all deps on network filesystems). So the gateway updates on the weekly cadence (or via `COPILOT_API_VERSION` / a lockfile change), independent of which command triggered the build.
- **Version override** — set `COPILOT_API_VERSION=<version|tag>` to pin the gateway to a specific release, bypassing both the floor and the 7-day cooldown (`bun add --minimum-release-age=0`). Unset = float per the floor above.

## Files

- `package.json` — `@jeffreycao/copilot-api: "latest"` (floats, see Architecture) + pinned dev/runtime deps + `engines.bun` / `packageManager` metadata + `trustedDependencies` (bun blocks postinstall scripts by default)
- `bunfig.toml` — `install.minimumReleaseAge = 604800` (7-day supply-chain cooldown on dependency resolution)
- `bun.lock` — committed reproducible baseline for every dep except the floated gateway; `npm ci`-equivalent reproducibility
- `bin/agent` — the single POSIX self-bootstrapping launcher. Installs bun if missing, prepares node_modules via `user_cache.ts` (in-place in the checkout by default; a `--local-cache` cache build when the subcommand is `local_cache_start`, which it translates → `start`), exports `COPILOT_ENV_ROOT` (the run dir `user_cache.ts` printed), then `exec`s `src/cli.ts` with the args. cli.ts dispatches everything (`start`/`stop`/`health`/`env`/`cost`/`codex_config`/`host_codex`).
- `bin/agent.ps1` — Windows equivalent of `bin/agent`.
- `agents.bashrc` — sourced from your shell rc; defines a **uniform** `agent` wrapper over `bin/agent`: it runs the requested command, then re-applies the session env from the single source of truth — `agent env`, which prints only `export KEY=val` lines (gateway vars, plus `CODEX_HOME` when a per-host Codex farm is active). No per-subcommand logic — a new `bin/agent` subcommand needs no change here, and only the dedicated, contract-stable `env` output is ever eval'd (never a command's incidental stdout). User commands: `agent start` / `agent local_cache_start` (build + start; the latter builds a per-user cache — symlink mirror on macOS/Linux, copy on Windows — instead of installing in-place), `agent codex_config`, `agent host_codex` (Linux-only farm), `agent stop|env|cost|…`. Also defines `cl`, `co`, `cx`. Pure runtime wiring — never installs anything; resolves its dir into `_COPILOT_AGENTS_DIR`.
- `agents.ps1` — PowerShell equivalent of `agents.bashrc`; dot-sourced from the user's `$PROFILE`. Same uniform `agent` wrapper over `bin/agent.ps1` (`Invoke-Agent` + `Import-CopilotEnv` to apply `$env:KEY = …` lines), prepends `~/.bun/bin` to PATH. `agent local_cache_start` builds a copy-mirror cache on Windows; the per-host `CODEX_HOME` farm is Linux-only (ignored on Windows).
- `install.sh` — POSIX installer (runs from a checkout or piped via `curl … | bash`). Ensures `git`, clones/updates the repo to `~/.copilot-env` (`COPILOT_ENV_DIR` override), installs Node via nvm + bun via its official installer + the agent CLIs (`claude`/`copilot`/`codex`) via npm, then adds a source block for `agents.bashrc` to `~/.bashrc` and/or `~/.zshrc`. Idempotent; curl-pipe-safe (no interactive prompts).
- `install.ps1` — Windows installer (runs from a checkout or piped via `irm … | iex`). Installs prerequisites via `winget` (Git, Node/npm, Bun) + the agent CLIs, clones/updates the repo to `%USERPROFILE%\.copilot-env`, bootstraps copilot-env deps, and adds a dot-source block for `agents.ps1` to the PowerShell `$PROFILE` (`-AllHosts` targets the CurrentUserAllHosts profile).
- `src/cli.ts` — the single citty entry: declares the subcommands (`start`/`stop`/`health`/`env`/`cost`/`codex_config`/`host_codex`) + their args, and each `run()` just calls the matching function. `bin/agent` execs this after building the cache.
- `src/commands/` — one module per command (each exports a `run*` function called by `cli.ts`):
  - `start.ts` (`runStart`) — launch the daemon detached, wait for readiness, sync catalog-derived model aliases via the admin API, and persist the resolved port to state. Holds the default config (smallModel, flags) written before launch.
  - `stop.ts` (`runStop`) — terminate the tracked daemon on this host.
  - `health.ts` (`runHealth`) — report whether the gateway is HTTP-reachable + the tracked pid state; exits non-zero when unreachable.
  - `env.ts` (`runEnv`) — print shell-evaluable env assignments (`--format posix` default, `--format powershell`). The only machine-readable-stdout command (the `agent` wrapper evals it): the 4 gateway vars, plus `CODEX_HOME` when `state.codexHome` is set.
  - `codex_config.ts` (`runCodexConfig` + exported `configureCodexConfig`/`applyCodexConfig`) — write a Codex `config.toml`/`.env` at a CODEX_HOME wired to the gateway (default `~/.codex`, falling back to `state.codexHome`). Operates only on the given CODEX_HOME — agnostic of hostname and of the global `~/.codex`. Persists the resolved CODEX_HOME to state so `env` can export it.
  - `codex_host.ts` (`runCodexHost`) — Linux-only (`assertLinux`): build the per-host `~/.codex/hosts/<hostname>` symlink farm (seeding shared state + copying the global config into the host dir), then call `applyCodexConfig` to wire its config.
- `src/user_cache.ts` — cross-platform node_modules bootstrap (standalone, **not** a cli.ts subcommand; run by `bin/agent` before every dispatch, since it must work before node_modules exist). Four modes by flag: no flag = in-place (install + float directly in the checkout); `--symlink` / `--copy` = mirror the source into a per-user cache (symlinks / real copies) then install + float there; `--local-cache` = `--symlink` on macOS/Linux, `--copy` on Windows; `--no-float` skips the gateway float. Always: frozen `bun install` on lockfile change, floats the gateway when due/missing (`floatGateway`, honors `COPILOT_API_VERSION`), prints the resolved run dir on stdout. Cache mirror mode is recorded in a `.symlink-cache` marker. Imports only `./utils/cache.ts`.
- `src/usage/` — `cost.ts` (`runCost` + table/JSON rendering) alongside its data layer `pricing.ts` (OpenRouter pricing: `fetchPricing`/`resolvePricingId`/`estimateCost`) and `usage.ts` (`discoverUsageDbs`/`readUsage` over the per-host `token_usage_events` SQLite tables via `bun:sqlite`).
- `src/copilot_api/` — the gateway-specific utils: `admin.ts` (`CopilotAdminClient` REST), `config.ts` (`CopilotApiConfig`: API-key management + generic atomic JSON read/write), `models.ts` (pure `generateAliases`), `paths.ts` (`CopilotApiPaths`/`DEFAULT_HOME` — per-host log/sqlite/state paths), `port.ts`, `process.ts` (`launchDaemon`/`getOrphanPids`/`copilotApiVersion`), `state.ts` (`CopilotApiState`: a typed `read()`/`set()` over `.run/<host>/.state.json` holding `port`/`pid`/`codexHome`, backed by `CopilotApiConfig`; `set({key:null})` deletes a key). `start` sets `port`+`pid`, `stop` clears them, `host_codex` sets/clears `codexHome`, and `env`/`port`/`health` only read.
- `src/utils/` — generic, non-gateway helpers: `cache.ts` (OS-native cache dir resolver), `hostname.ts` (`HOME`/`getSanitizedHostname`), and `root.ts` (`moduleRoot` — the runtime root for module resolution: `COPILOT_ENV_ROOT` or the nearest-`package.json` project root fallback).
- `biome.json` — formatter + linter config (camelCase, snake_case allowed only on object-literal keys for config-file keys like `max_input_tokens`)
- `tsconfig.json` — strict + noUncheckedIndexedAccess
- `.editorconfig` / `.gitattributes` — enforce UTF-8 + LF line endings (text normalized to LF, binary assets left untouched) so the cross-platform sources stay consistent
- `patches/` — patch-package patches (applied via `postinstall`)
- `test/**/*.test.ts` — `bun test` suites, centralized under `test/` (pure-logic units for `models.ts`/`pricing.ts`/`paths.ts`/`config.ts`/`usage.ts`, a `codex_config.ts` config test, and a `cli.ts --help` smoke test). They import the code under test via `../src/...`. `bun:test`/`bun:sqlite` are exempted from biome's `noUnresolvedImports` via a `*.test.ts` override in `biome.json`.
- `scripts/lint-sh.sh` / `scripts/lint-ps.sh` — skip-if-absent shell/PowerShell linters used by pre-commit + CI
- `.github/workflows/ci.yml` — CI: install/typecheck/lint/test **plus a start/stop daemon-lifecycle step** on a Linux+macOS+Windows matrix (shellcheck on Linux, PSScriptAnalyzer on Windows) + an `actionlint` job; the lifecycle step runs `cli.ts start`→`stop` against a fake gateway (`COPILOT_API_ENTRY` → `test/copilot-api-fake.mjs`, no auth needed); `concurrency` cancels superseded runs
- `test/copilot-api-fake.mjs` — stand-in gateway for the start/stop check: binds the port, answers the admin endpoints, prints the `Listening on:` marker, stays alive until `SIGTERM`. Selected via the `COPILOT_API_ENTRY` override in `copilot_api/process.ts:resolveCopilotApiEntry`. Its name must contain `copilot-api` so `isCopilotApiPid`'s cmdline matcher recognizes the launched daemon (else `stop` won't signal it).
- `.github/workflows/codeql.yml` — CodeQL code scanning (javascript-typescript) on push/PR + a weekly schedule
- `.github/workflows/auto-assign.yml` — assigns new issues/PRs to the repo owner and labels same-repo PRs `fix-lint`
- `.github/dependabot.yml` — monthly `github-actions` + `bun` updates (bun ecosystem is GA in Dependabot; 7-day cooldown mirroring `bunfig.toml`; floated gateway ignored)
- `.github/settings.yml` — repo settings-as-code for the [Settings app](https://github.com/repository-settings/app) (squash-only merges, `allow_auto_merge`, wiki/projects off) **plus an experimental `rulesets` block** for `main` (restrict deletions, block force-push, require CI + CodeQL, admin bypass). Inert unless that app is installed; two newer rules (code-quality results, auto Copilot review) must be enabled in the UI.
- `.github/CODEOWNERS` — default owner `@Vivswan`
- `.github/copilot-instructions.md` — symlink to `AGENTS.md` (GitHub Copilot reads repo instructions from here, mirroring the `CLAUDE.md` symlink)
- `SECURITY.md` / `CONTRIBUTING.md` — security disclosure policy + contributor guide
- `.github/ISSUE_TEMPLATE/` + `.github/PULL_REQUEST_TEMPLATE.md` — issue / PR templates

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
