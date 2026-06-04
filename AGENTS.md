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
- `agents.bashrc` — sourced from your shell rc; defines the `agent` dispatcher (`agent start` lifecycle wrapper, else pass-through to the bin), plus `cl`, `co`, `cx`. Gateway-only — no Codex wiring.
- `agents_codex.bashrc` — Codex `CODEX_HOME` wiring, kept separate as an optional add-on. Sourced *after* `agents.bashrc`; redefines `copilot-start` to also create/refresh a host-local `CODEX_HOME`, and eagerly exports it on shell startup when the host-local dir exists.
- `agents.ps1` — PowerShell equivalent of `agents.bashrc`; dot-sourced from the user's `$PROFILE`. Delegates lifecycle wrappers to `bin/copilot-api.ps1`, prepends `~/.bun/bin` to PATH, and applies the session env via `copilot-api env --format powershell` + `Invoke-Expression` (no manual parsing). Unlike the POSIX split (where Codex wiring lives in the optional `agents_codex.bashrc`), `copilot-start` here also refreshes Codex: after the gateway is up it runs `bin/codex-home.ps1` to (re)write `config.toml`/`.env` into the default `~/.codex` (`%USERPROFILE%\.codex`). It does **not** set `CODEX_HOME` — Codex reads its default home natively; `CODEX_HOME` is only needed on Linux when the per-host symlink farm is used.
- `install.sh` — POSIX shell-integration installer: adds a source block for `agents.bashrc` to `~/.bashrc` and/or `~/.zshrc`. `--codex` also sources `agents_codex.bashrc`.
- `install.ps1` — Windows installer: installs prerequisites (Git, Node/npm, Bun, the agent CLIs), bootstraps copilot-env deps, and adds a dot-source block for `agents.ps1` to the PowerShell `$PROFILE` (`-AllHosts` targets the CurrentUserAllHosts profile).
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
- **bun for runtime, biome for format/lint, tsc for typecheck.** No webpack, no rollup, no bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", or "codex" lines in commits or PR descriptions.**

## Commands

```bash
# from the project dir
bun run typecheck          # tsc --noEmit
bun run lint               # biome check src bin
bun run format             # biome format --write
bun run check              # biome check --write src bin
```

Direct CLI use:
```bash
./bin/copilot-api --help
./bin/copilot-api start
./bin/copilot-api env
./bin/codex-home --base-url ... --api-key ...
```
On Windows, use the `.ps1` launchers (`powershell -ExecutionPolicy Bypass -File bin\copilot-api.ps1 ...`, `bin\codex-home.ps1`).

Shell integration (one-time, sources the `agent`/`cl`/`co`/`cx` helpers on shell startup):
```bash
./install.sh          # source agents.bashrc into ~/.bashrc / ~/.zshrc
./install.sh --codex  # also source agents_codex.bashrc (Codex CODEX_HOME wiring)
```
```powershell
# Windows: install prerequisites + dot-source agents.ps1 from $PROFILE
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Patching `@jeffreycao/copilot-api`

**Caveat:** the gateway floats (`"latest"`, ≥7-day cooldown), and a `patch-package` patch is keyed to one exact version — it will fail to apply once the float moves on. So patching and floating are mutually exclusive. If you must patch:

1. Temporarily pin `@jeffreycao/copilot-api` to an exact version in `package.json` (this freezes the float).
2. Edit files under `<cache>/node_modules/@jeffreycao/copilot-api/dist/`
3. From the project dir, `npx patch-package @jeffreycao/copilot-api` → commit `patches/@jeffreycao+copilot-api+<version>.patch` alongside the pin.
4. To resume floating, drop the patch and restore `"latest"`.

`patch-package` stays non-fatal (default warns, doesn't fail install), so a stale patch from a prior pin won't break startup — but don't rely on it applying. No patch exists today (`patches/` holds only `README.md`).
