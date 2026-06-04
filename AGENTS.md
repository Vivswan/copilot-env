# copilot-env

Local copilot-api gateway lifecycle + config helper. TypeScript port of the original Python `copilot-api` package.

## Cross-platform

This project supports **Linux, macOS, and Windows**.

- POSIX launchers: `bin/copilot-api`, `bin/codex-home`
- Windows launchers: `bin/copilot-api.ps1`, `bin/codex-home.ps1`
- All TS code uses `process.platform` branches where OS-specific behavior is needed (see `src/utils/cache.ts`).
- Cache directory follows OS conventions: `~/.cache/copilot-env` (Linux), `~/Library/Caches/copilot-env` (macOS), `%LOCALAPPDATA%\copilot-env\Cache` (Windows).
- Symlink fallback to copy on Windows when the user lacks symlink-create privilege (`src/cache_setup.ts`).

## Architecture

- **node_modules lives in the per-user cache**, populated via symlinks (`src/cache_setup.ts`).
- **bun runtime** — native TS support, ~170ms per CLI invocation vs tsx's ~750ms. Bin shims auto-install bun if missing.
- **Floating `@jeffreycao/copilot-api`** — `package.json` tracks `"latest"`. A 7-day supply-chain cooldown (`bunfig.toml` `install.minimumReleaseAge = 604800`) means only releases public for ≥7 days are ever adopted. `src/cache_setup.ts` overlays the cache's `node_modules` with `bun add` (re-checked at most weekly via a `.gateway-checked` stamp), so the read-only committed `bun.lock` is never rewritten — every *other* dep stays pinned. The lock pins the reproducible baseline (used on cold start / offline). `process.ts:launchDaemon` resolves the entry through `createRequire` and spawns `node <dist/main.js>` directly — no `npx`. On start, `server.ts` logs the running gateway version + its npm publish date (`copilotApiVersion` + best-effort registry fetch).
- **Compatibility floor** (`GATEWAY_MIN_VERSION` in `cache_setup.ts`, currently `1.10.30`) — the minimum gateway version the wrapper code is known to work against; bump it when the wrapper starts relying on newer gateway behavior. The default float installs the newest release that is BOTH ≥ this floor AND ≥7 days old (`bun add @">=<floor>"`); if none has cleared the cooldown yet, it pins exactly the floor with the cooldown bypassed, so the floor is always available and never silently violated.
- **Fresh cache on `start`** — the bin shims forward the subcommand to `cache_setup.ts`; on `start` it `rm -rf`s the entire per-user cache and rebuilds it (mirror + frozen install + gateway float) for a clean, reproducible environment each launch. Other subcommands (`env`, `cost`, `stop`, `codex-home`) reuse the cache so shell-open `env` calls stay fast.
- **Version override** — set `COPILOT_API_VERSION=<version|tag>` to pin the gateway to a specific release, bypassing both the floor and the 7-day cooldown (`bun add --minimum-release-age=0`). Unset = float per the floor above.

## Files

- `package.json` — `@jeffreycao/copilot-api: "latest"` (floats, see Architecture) + pinned dev/runtime deps + `engines.bun` / `packageManager` metadata + `trustedDependencies` (bun blocks postinstall scripts by default)
- `bunfig.toml` — `install.minimumReleaseAge = 604800` (7-day supply-chain cooldown on dependency resolution)
- `bun.lock` — committed reproducible baseline for every dep except the floated gateway; `npm ci`-equivalent reproducibility
- `bin/copilot-api`, `bin/codex-home` — POSIX self-bootstrapping launchers
- `bin/copilot-api.ps1` — Windows equivalent of `copilot-api`
- `bin/codex-home.ps1` — Windows equivalent of `codex-home` (self-bootstraps, reuses the cache, execs `src/codex_home.ts`)
- `agents.bashrc` — sourced from your shell rc; defines the `agent` dispatcher (`agent start` launches the gateway + exports its env; `agent codex` (re)writes `~/.codex` via `bin/codex-home` so Codex routes through the gateway; everything else passes through to the bin), plus `cl`, `co`, `cx`. Pure runtime wiring — never installs anything; the launchers assert the agent CLI exists and point you at `install.sh` if not. Plain function defs (no `eval`); resolves its dir into `_COPILOT_AGENTS_DIR`.
- `agents.ps1` — PowerShell equivalent of `agents.bashrc`; dot-sourced from the user's `$PROFILE`. Delegates lifecycle wrappers to `bin/copilot-api.ps1`, prepends `~/.bun/bin` to PATH, and applies the session env via `copilot-api env --format powershell` + `Invoke-Expression` (no manual parsing). Unlike POSIX (where Codex is wired on demand via `agent codex`), `copilot-start` here also refreshes Codex automatically: after the gateway is up it runs `bin/codex-home.ps1` to (re)write `config.toml`/`.env` into the default `~/.codex` (`%USERPROFILE%\.codex`). It does **not** set `CODEX_HOME` — Codex reads its default home natively; `CODEX_HOME` is only needed on Linux when the per-host symlink farm is used.
- `install.sh` — POSIX installer (runs from a checkout or piped via `curl … | bash`). Ensures `git`, clones/updates the repo to `~/.copilot-env` (`COPILOT_ENV_DIR` override), installs Node via nvm + bun via its official installer + the agent CLIs (`claude`/`copilot`/`codex`) via npm, then adds a source block for `agents.bashrc` to `~/.bashrc` and/or `~/.zshrc`. Idempotent; curl-pipe-safe (no interactive prompts).
- `install.ps1` — Windows installer (runs from a checkout or piped via `irm … | iex`). Installs prerequisites via `winget` (Git, Node/npm, Bun) + the agent CLIs, clones/updates the repo to `%USERPROFILE%\.copilot-env`, bootstraps copilot-env deps, and adds a dot-source block for `agents.ps1` to the PowerShell `$PROFILE` (`-AllHosts` targets the CurrentUserAllHosts profile).
- `src/cache_setup.ts` — cross-platform per-user cache setup: on `start` wipes & recreates the whole cache, else reuses it; symlink manifest + sources into cache, frozen `bun install` when the lockfile changes, gateway float (`floatGateway`, honors `COPILOT_API_VERSION`), print cache path on stdout
- `src/server.ts` — citty CLI for `start`/`stop`/`env`/`cost`. Holds the default config (smallModel, flags) written before launch; model aliases are not hardcoded — once the daemon is up it syncs catalog-derived aliases via the admin API and prints them grouped by target model. `env` prints shell-evaluable env assignments (`--format posix` default, `--format powershell` for `$env:` lines). `cost` reads every per-host usage DB and prints estimated spend.
- `src/utils/admin.ts` — `CopilotAdminClient`: all REST communication with the local daemon (`getModels`, `getModelMappings`, `setModelMappings`) over a shared `request()` wrapper.
- `src/utils/models.ts` — pure alias logic: `generateAliases(catalog)` and the `CatalogModel` type. No I/O.
- `src/utils/usage.ts` — discover (`discoverUsageDbs`) and read (`readUsage`) the gateway's per-host `token_usage_events` SQLite tables via `bun:sqlite` (read-only), aggregating tokens by model across hosts.
- `src/utils/pricing.ts` — pure-ish OpenRouter pricing: `fetchPricing` (live catalog), `resolvePricingId` (internal id -> OpenRouter id), and `estimateCost`.
- `src/codex_home.ts` — writes a `CODEX_HOME` (config.toml/.env) wired to the local gateway. Cross-platform for config writes: defaults to the standard `~/.codex` (`%USERPROFILE%\.codex` on Windows). The per-host `~/.codex/hosts/<hostname>` layout and the `--symlink-farm` build (`buildCodexSymlinkFarm`) are used **only** for `--hostname-path`/`--symlink-farm` and are guarded Linux-only (`assertLinux`); an explicit `--codex-home` overrides on any platform.
- `src/utils/cache.ts` — OS-native cache dir resolver
- `src/utils/config.ts` — `CopilotApiConfig` class: API-key management (`ensureApiKey`/`ensureAdminApiKey`) + generic atomic JSON read/write (sort_keys parity with the Python writer)
- `src/utils/{hostname,paths,port,process}.ts` — small utility modules
- `biome.json` — formatter + linter config (camelCase, snake_case allowed only on object-literal keys for config-file keys like `max_input_tokens`)
- `tsconfig.json` — strict + noUncheckedIndexedAccess
- `.editorconfig` / `.gitattributes` — enforce UTF-8 + LF line endings (text normalized to LF, binary assets left untouched) so the cross-platform sources stay consistent
- `patches/` — patch-package patches (applied via `postinstall`)

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
bun run lint               # biome check src bin
bun run lint:shell         # shellcheck (install.sh, agents.bashrc, bin/copilot-api, bin/codex-home)
bun run lint:ps            # PSScriptAnalyzer (install.ps1, agents.ps1, bin/*.ps1)
bun run format             # biome format --write
bun run check              # biome check --write src bin
```

The husky `pre-commit` hook runs `lint-staged` (biome) + `typecheck` + `lint:shell` + `lint:ps`. The shell/PowerShell linters are **skip-if-absent**: `lint:shell` no-ops when `shellcheck` isn't installed, `lint:ps` no-ops when `pwsh`/PSScriptAnalyzer isn't — so commits never break for lack of an optional linter. Both gate only on warnings+errors (style/info findings are ignored). Scripts live in `scripts/`.

Direct CLI use:
```bash
./bin/copilot-api --help
./bin/copilot-api start
./bin/copilot-api env
./bin/codex-home --base-url ... --api-key ...
```
On Windows, use the `.ps1` launchers (`powershell -ExecutionPolicy Bypass -File bin\copilot-api.ps1 ...`, `bin\codex-home.ps1`).

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
