# copilot-env

Local copilot-api proxy lifecycle + config helper. TypeScript port of the original Python `copilot-api` package. Supports **Linux, macOS, and Windows** via a POSIX launcher (`bin/agent`) and a PowerShell one (`bin/agent.ps1`); every cross-platform pair (`bin/agent` ⇄ `.ps1`, `shell/agents.bashrc` ⇄ `shell/agents.ps1`, `shell/agents.launchers.bashrc` ⇄ `shell/agents.launchers.ps1`, `install.sh` ⇄ `install.ps1`) must stay feature-matched.

`CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file.

## Architecture & key decisions

The non-obvious choices live here; everything else is discoverable in the code.

- **In-place, no cache.** `bin/agent` installs `node_modules` in the checkout itself (when needed — see below) and runs `cli.ts` from there — `node_modules` lives in the checkout, and module resolution anchors at it (`PROJECT_ROOT`, `src/utils/root.ts`). Install output is routed to stderr so it never pollutes the `agent env` stdout the shell wrapper evals.
- **bun runtime, no bundler.** Bin shims auto-install bun if missing. Normal no-env `bun src/proxy_float.ts --verify` reads npm publish-time metadata on each call, computes the cooldown-aged target, and skips `bun install --frozen-lockfile` when that exact target is already installed; missing `node_modules`, stale `bun.lock`, or a changed target still force install.
- **The proxy floats.** `@jeffreycao/copilot-api` is tracked as `"latest"`; `src/proxy_float.ts` (run as `bun install`'s postinstall) computes the newest release satisfying the cooldown window (`COPILOT_API_MIN_RELEASE_AGE` if set, else `bunfig.toml`'s `install.minimumReleaseAge`), clamps it to `[PROXY_MIN_VERSION, PROXY_MAX_VERSION]` (`copilot-env.config`), then overlays that exact version. The overlay uses `bun add --no-save`, so `bun.lock` stays the pinned reproducible baseline for every *other* dep — but note `bun list`/bun's summary then report the *locked* version, not the floated one on disk (check `node_modules/@jeffreycao/copilot-api/package.json`).
- **Best-effort at install, hard floor at launch.** The postinstall float never fails `bun install` (offline/registry hiccups are swallowed), so a fresh offline install could sit below the floor. `start.ts` makes the floor a real contract: it refuses to launch a sub-floor proxy. Bump `PROXY_MIN_VERSION` when the wrapper depends on newer proxy behavior; set the optional ceiling to hold the float below a known-bad release.
- **Float env knobs** (set on any `bin/agent` call or in root `.env`, loaded from `PROJECT_ROOT` by `src/utils/dotenv.ts`): `COPILOT_API_VERSION` pins an exact release/tag (bypasses floor + cooldown); `COPILOT_API_MIN_RELEASE_AGE` overrides the cooldown window in seconds (`0` = no cooldown), taking precedence over `bunfig.toml`'s `install.minimumReleaseAge`. Real shell environment wins over `.env`.
- **Supply-chain cooldown applies after bootstrap.** The bootstrap installers always resolve the latest copilot-env release; version-specific installs use the `install.sh` / `install.ps1` assets attached to that GitHub Release. Optional copilot-env release cooldown lives under `agent update --cooldown[=DAYS]`; optional agent-CLI cooldown lives under `agent shell --clis --cooldown[=DAYS]` and uses `src/utils/aged_version.ts` fed by `npm view <pkg> time`. Copilot-env release selection uses `src/install/resolve-release.ts` (the same module `agent update` imports, which the installers download standalone and run).
- **`agent env` is the one machine-readable command.** The shell wrapper runs a command, then evals `agent env` (and only that) to refresh session state — so a new subcommand needs no wrapper change, and no command's incidental stdout is ever eval'd. It exports `CODEX_HOME` (when a `codex --host` farm set one and its dir exists) and `ANTHROPIC_BASE_URL` (only when Claude is proxy-wired and its base URL is the local proxy, ≠ the direct default). Otherwise each agent's proxy/direct wiring lives in its own config file — Codex in `~/.codex/config.toml` + `.env`, Claude in `~/.claude/settings.json` + a managed `apiKeyHelper`.
- **Direct mode needs a Copilot GitHub OAuth token, managed by `agent auth`.** The credential is the **single source of truth**, held by the `CopilotEnvState` class (`src/copilot_api/env_state.ts`) in a SHARED file under the copilot-api home (`~/.local/share/copilot-api/.copilot-env-state.json`, NOT per-host `.run/` state — it's account/machine-wide). It stores `githubToken` (for `copilot`/`gh-token`) and the chosen `authProvider`. The agent Direct configs do **not** bake their own copy; they resolve the credential at fetch time by shelling into **`agent auth --get`** (`src/commands/auth.ts`). Resolution is **provider-driven, with NO implicit `gh` fallback**: `gh-cli` → `gh auth token` (live), `copilot`/`gh-token` → the stored token, none → null. So Claude's `apiKeyHelper` (`copilot-token.sh`) execs `agent auth --get`, and Codex's `copilot-env` provider runs it via `auth.command` (re-fetched on `refresh_interval_ms`) — neither stores the token. `agent start` passes the resolved credential to the daemon as `--github-token` (in-memory only — copilot-api never writes its own `github_token` file). A provisioned Direct config requires copilot-env to stay installed (the tradeoff for single-file storage). `agent auth` provisions via a chosen `--provider` (no flag ⇒ interactive picker): `copilot` (interactive GitHub **device flow**, `read:user` scope, run via the installed copilot-api's `auth login` — its `github_token` is imported into our store and scrubbed), `gh-cli` (use the machine's `gh` login; store nothing), or `gh-token` (store a token read from `$COPILOT_GITHUB_TOKEN`/`$GH_TOKEN`/`$GITHUB_TOKEN`, else prompt for it in a TTY; `--set [token]` provides it inline / `--set` bare reads those env vars for headless servers — the var list + precedence live in `ghTokenFromEnv`, `src/utils/direct_probe.ts`). The token must be Copilot-enabled (what `gh auth token` / the device flow emit). A PAT (classic `ghp_` / fine-grained `github_pat_`) can drive **Direct** (api.githubcopilot.com accepts the raw token as the bearer) but NOT the proxy's *default* editor token exchange (`copilot_internal/v2/token` → 403 "Resource not accessible by personal access token") — so `agent start` auto-runs the proxy in **passthrough mode** (`--oauth-app opencode`: copilot-api forwards the token directly, the same request shape Direct uses) when the resolved token is PAT-shaped. `--passthrough`/`--no-passthrough` force it on/off, an explicit `COPILOT_API_OAUTH_APP` in the env is honored, and the policy lives in `passthroughOauthApp`/`isPatToken` (`src/commands/start.ts`). (Caveat: passthrough presents copilot-api as the *opencode* OAuth client, and GitHub may still reject a fine-grained PAT at the `/user` step under that client's `Bearer` headers — a PAT that works in Direct is not guaranteed to work through the proxy.) **When auth is none, never fall back — ask:** bare `agent auth` is idempotent on the *recorded provider* (not an incidental `gh` login) and prompts when none; `agent init` (non-`--proxy`) and `agent start` (in a TTY) run the login first and **error out** if it fails. `agent auth --get` prints the token (the `// codeql[js/clear-text-logging]` site); `--check` reports status (exit 0/1); `--del` de-authenticates (clears token + provider, so the next `agent auth` prompts). `agent health` reports the credential under its own **Authentication** section (`--scope auth`); it treats Direct as "no gh needed" only when the config is the managed `agent auth --get` resolver AND a token is stored — a stale `gh`-based config still gets the `gh` check.

## Repo map

- `bin/agent`, `bin/agent.ps1` — self-bootstrapping launchers (install bun + deps, dispatch `cli.ts`).
- `shell/agents.bashrc`, `shell/agents.ps1` — shell integration (sourced from rc / `$PROFILE`); the `agent` wrapper + eager `agent env` export (CODEX_HOME + proxy ANTHROPIC_BASE_URL). Pure runtime wiring, never installs.
- `shell/agents.launchers.bashrc`, `shell/agents.launchers.ps1` — opt-in `cl`/`co`/`cx` agent launchers, sourced after the integration file (`cx`/`cl` read the configured provider via `agent codex --check`/`agent claude --check` and, for proxy, ensure the proxy + re-sync the port/token before launch — no live probe). Wired with `agent shell --launchers` (which also wires the integration), removed with `agent shell --launchers --remove`; otherwise source manually.
- `install.sh`, `install.ps1` — one-line bootstrap installers: ensure bun, download the latest release source archive to `~/.copilot-env`, verify its source checksum against GitHub release metadata, replace any previous install at the target dir, then run release-local `src/install/installer.ts` to bootstrap deps and wire shell integration (via `agent shell`). Optional agent CLIs install via `agent shell --clis`. Version-specific installer copies are uploaded as release assets by `.github/workflows/release-please.yml` after release creation.
- `src/install/installer.ts` — release-bundled first-install handoff; keep it dependency-light because it runs before `node_modules` exists.
- `src/cli.ts` — Commander entry; declares subcommands and delegates to command/domain `run*` functions.
- `src/commands/` — command modules that still own their implementation (`start`/`stop`/`health`/`env`/`update`/`init`). Pure wrapper modules are avoided.
- `src/commands/init.ts` — `agent init`: ensure authentication (runs `agent auth` when unauthenticated), then configure BOTH agents (auto/--direct/--proxy) + next-step guidance.
- `src/commands/auth.ts` — `agent auth`: the GitHub credential front door. `--provider copilot|gh-cli|gh-token` to authenticate, `--get` (the resolver the Direct configs call), `--del`, `--check`; bare is idempotent. Exports `ensureAuthenticated`.
- `src/commands/configure_agents.ts` — shared `configureBothAgents` + `printGuidance`, used by both `init` and `auth` (kept here to avoid an init ↔ auth import cycle).
- `src/proxy_float.ts` — the proxy float (see above).
- `src/commands/setup.ts` — `agent shell` (`runShell`): wire the shell integration, optionally the cl/co/cx launchers (`--launchers`) and the optional agent CLIs (`--clis`, via `installAgentClis`); `--remove` unwires.
- `src/commands/shell_integration.ts` — cross-platform shell/profile block wiring for integration and launchers.
- `src/install/release.ts` — release archive download/verification/extraction/sync used by `agent update`.
- `src/install/verify-source-archive.ts` — source-archive checksum verification against GitHub release metadata, shared by the installers and `agent update`.
- `src/codex/` — Codex config, per-host `CODEX_HOME` farm logic, and the `--mobile` phone-pairing flow (`mobile.ts`: temporarily strips `model_provider` around the Codex app's remote-control pairing).
- `src/claude/` — Claude Code config wiring (`~/.claude/settings.json`): GitHub Copilot Direct vs the proxy.
- `src/migrations/` — one file per version step (`<from-version>.ts`, registered in `index.ts`); `agent update` runs the due ones for the `[old, new)` range. See "Migrations" below.
- `src/copilot_api/` — proxy-specific helpers: admin REST, config/state JSON, model-alias generation, per-host paths, daemon process control.
- `src/usage/` — `cost` reporting over per-host SQLite usage DBs using live OpenRouter pricing.
- `src/utils/` — generic helpers (hostname, `PROJECT_ROOT`, semver compare).
- `copilot-env.config` — `KEY=value` proxy-float floor/ceiling, read by `src/proxy_float.ts` (+ `start.ts`).
- `test/` — `bun test` suites: pure-logic units + a start/stop daemon lifecycle against `test/copilot-api-fake.mjs`.
- `.github/`, `.devcontainer/`, `.claude/`, `.codex/` — CI/CodeQL, Codespaces, and agent-worktree wiring.

## Agent & dev environment init

Every agent/dev environment and any fresh `git worktree` initializes through **one** idempotent script — `scripts/setup-env.sh` (`scripts/setup-env.ps1` on Windows) — so no entry point drifts. It runs `bun install --frozen-lockfile` (which also fires the best-effort proxy float; no agent CLIs). Entry points that invoke it: the GitHub Copilot coding agent (`.github/workflows/copilot-setup-steps.yml`), Codespaces / Dev Containers (`.devcontainer/`), Claude Code and Codex CLI worktrees (`SessionStart` hooks in `.claude/` and `.codex/`, no-op when `node_modules` already exists), and humans (run it directly). For the Codex app, configure a Local Environment that runs `scripts/setup-env.sh` on worktree creation and `./bin/agent stop || true` on cleanup.

## Migrations

`src/migrations/` carries one-time, version-to-version fix-ups for an existing install (e.g. relocating files, re-pointing rc blocks). One file per step named for the release it migrates **away from** (`1.2.1.ts`) — so a migration is authored against the *current* released version and never has to predict the future release number release-please will assign. Each exports a `Migration { version, description, run }` registered in `index.ts`; `run` must be **idempotent** (an update can be retried).

`agent update` runs the due migrations after it swaps in the new release: it spawns `bun src/migrations/index.ts <old> <new>` (the module is runnable via an `import.meta.main` guard) — a **fresh process**, because the running `update.ts` still holds the pre-update code in memory, so the new migration set and the code it calls must load from disk. `dueMigrations` selects every from-version left behind, the half-open range `[old, new)`; failures are non-fatal (warn, continue).

**Bootstrapping caveat:** an update is driven by the *old* release's `update.ts`, so the migration call only fires for updates whose old version already ships it (≥ the one that added migrations). The very transition that introduces the subsystem can't auto-run via `update`; that one is covered by the installer's `agent shell` refresh (which rewrites a stale owned block in place — see `wireBlocks`/`upsertBlock` in `src/commands/shell_integration.ts`).

## Conventions

- **No `any`** — biome's `noExplicitAny` is `error`.
- **camelCase** functions/vars/params, **PascalCase** types/classes/interfaces, **CONSTANT_CASE** top-level constants; **snake_case only on object-literal keys** (for external config-file keys we don't control). Always quote object-literal keys.
- **No new deps without an explicit reason.** Current: `commander` (CLI parsing; rejects unknown flags + native help wrapping), `consola`, `dotenv` (root `.env` loading), `execa` (subprocess spawning), `semver` (version-precedence ordering for the proxy float/floor + update/migration ranges), `smol-toml`, `tar` (release-tarball extraction for `agent update`), `valibot` (lenient schema validation for the JSON state files we own — `env_state`/`state`/`autoupdate`), `which` (resolve executables on PATH), `ps-list` (process enumeration), `@jeffreycao/copilot-api`, `patch-package`.
- **String literals are external contracts** — model ids, JSON keys, env var names, log markers: never rename them during refactors.
- **ASCII source, except user-facing output.** Comments, identifiers, and code must be pure ASCII — no em dashes, arrows, ellipses, or stray math/logic glyphs (the kind generated text drags in, e.g. the double arrow U+21D4). Non-ASCII is allowed ONLY inside string/template literals, which carry the boxes/arrows/check-marks shown to the user. Enforced by `test/no_weird_chars.test.ts`, which parses each `.ts`/`.js` with the TypeScript compiler (so it tells strings from comments/regex) and requires non-code files to be pure ASCII.
- **bun** (runtime), **biome** (TS format/lint), **tsc** (typecheck), **shellcheck** / **PSScriptAnalyzer** (shell / PowerShell). No webpack, rollup, or bundler.
- **Never add "Generated by", "Co-Authored-By", "claude", "codex", or "copilot" lines** anywhere — commits, PR descriptions, issues, comments, or any other output.
- **Conventional Commits** — commit subjects use a type prefix so release-please can version: `feat:` (minor), `fix:` (patch), `feat!:` or a `BREAKING CHANGE:` footer (major); `chore:`/`docs:`/`refactor:`/`test:`/`ci:` don't release. (This is separate from the no-Co-Authored-By rule above, which still applies.)
- **Run `/rubber-duck-review` before any commit** — get an independent cross-model review of the pending changes, surface its findings, then commit.

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
bun run format        # biome format --write src bin test scripts

./bin/agent init      # set up both Codex + Claude (auto-detect direct vs proxy); --direct / --proxy force
./bin/agent auth      # manage the GitHub credential: --provider copilot|gh-cli|gh-token / --get / --del / --check
./bin/agent start     # start the daemon (--port to pin); also: stop / health / env / cost / update / shell / codex / claude
./bin/agent env       # print shell exports for the calling shell (CODEX_HOME + proxy ANTHROPIC_BASE_URL)
```

The husky `pre-commit` hook runs lint-staged (biome) + typecheck + tests + the shell/PS linters; the linters are skip-if-absent and gate only on warnings+errors. CI runs the same on a Linux/macOS/Windows matrix, plus the start/stop lifecycle and end-to-end installer jobs.

## Patching `@jeffreycao/copilot-api`

Patching and floating are mutually exclusive: a `patch-package` patch is keyed to one exact version and stops applying once the float moves on. To patch: temporarily pin an exact version in `package.json` (freezing the float), edit under `node_modules/@jeffreycao/copilot-api/dist/`, run `npx patch-package @jeffreycao/copilot-api`, and commit the patch alongside the pin; restore `"latest"` to resume floating. `patch-package` is non-fatal, so a stale patch won't break startup. No patch exists today.
