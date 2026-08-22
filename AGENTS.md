# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

copilot-env: Local copilot-api proxy lifecycle + config helper (TypeScript).

## Toolchain

- Runtime and package manager: deno (`deno install`, `deno test`, `deno task <name>`)
- See the `tasks` table in `deno.json` for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (the ci.yml pr-title job + validate-commit-names).
- CI gates on a single required check named `all-green` in the managed
  `.github/workflows/ci.yml`. This repository's own test/lint jobs belong in
  `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not
  edit ci.yml, template sync overwrites it. The `release` job runs on top
  of the gate (`needs: all-green`); the release pipeline is repo-owned in
  `.github/workflows/release.yml` (pre/post-release jobs go there, around the
  managed release-please machinery).
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform"
  arrive via sync PRs pushed by that repository. Do not edit them here;
  change them in Vivswan/repo-platform and let the next sync
  PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy)
  are applied from Vivswan/repo-platform: by the
  `settings/repos/` file named after this repository over there when one
  exists, otherwise by this repository's own `.github/settings.yml`. Do not
  change settings by hand in the GitHub UI; edit the settings file.
- Repo-owned escape hatches stay local:
  `.github/workflows/checks.yml`,
  `.github/workflows/release.yml`, `.gitleaks.toml`,
  `.gitignore`'s marked LOCAL section, `.typography-allow.local`
  (typography exemptions; the managed `.typography-allow` is overwritten
  by sync), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->
<!-- repo-platform:local-section -->

copilot-env is a local copilot-api proxy lifecycle + config helper (a
TypeScript port of the Python `copilot-api`). It wraps a floating
`@jeffreycao/copilot-api` proxy and wires the Codex and Claude CLIs to either
that local proxy or GitHub Copilot Direct.

**Cross-platform is non-negotiable.** Everything must work on Linux, macOS, and Windows
unless the user says otherwise. Each POSIX/PowerShell pair stays feature-matched: `bin/agent`
⇄ `bin/agent.ps1`, `shell/agents*.bashrc` ⇄ `shell/agents*.ps1`, `install.sh` ⇄ `install.ps1`,
`src/scripts/proxy-token.sh` ⇄ `.ps1`. Prefer the platform helpers (`agentLauncherCommand`,
`proxyTokenCommand` in `src/utils/root.ts`) over hardcoding a shell.

### Architecture: the non-obvious decisions

Only the *why* lives here - the code is the source of truth for mechanics, key lists, and
file layouts. Don't restate here what a reader can grep.

- **A release is a binary, a checkout is a checkout.** Users get one compiled `agent`
  per platform (`deno task compile`, five targets); `agent install` unpacks the runtime
  assets it embeds into the install root and writes a `bin/agent` shim beside itself.
  A dev checkout keeps the self-bootstrapping `bin/agent`, which installs deps in place
  and runs `cli.ts`; install noise goes to stderr so it never pollutes the `agent env`
  stdout the shell wrapper evals. The SAME `agent install` code path serves both and
  discriminates on whether its embedded asset source IS the install root, so a checkout
  can never be overwritten by an install.
- **The proxy floats; we never patch it.** `@jeffreycao/copilot-api` sits at a caret-range
  baseline in deno.json's import map and is resolved at `agent start`, when the recorded
  resolution has gone stale, to the newest release older than a supply-chain cooldown
  window (`src/proxy_float.ts`), clamped by `copilot-env.config`, into a dedicated deno
  cache under the proxy root home.
  Patching the package would pin one version, so runtime needs are
  `deno run --preload` shims instead. Two agents wired Direct means no proxy, so the float
  is a no-op.
- **`agent env` is the one machine-readable command.** The shell wrapper evals only that, so
  a new subcommand needs no wrapper change. Each agent's wiring otherwise lives in its own
  config file (`~/.codex/config.toml`, `~/.claude/settings.json`).
- **One credential, resolved not baked.** The token is the single source of truth in
  `CopilotEnvState`; Direct configs never store a copy, they resolve it at fetch time via
  `agent auth --get`. Provider-driven with **no implicit `gh` fallback** - when auth is none
  we **ask, never silently fall back**.
- **Profiles are opt-in atomic units; the default path never changes.** A profile = ONE
  credential + ONE mode (never both), always wired into BOTH agents. The store slot is the
  source of truth and the per-agent artifacts are *derived* from it, which is what lets one
  command create/check/delete a profile atomically. Named profiles **hard-fail rather than
  falling back** to the default credential. A proxy-mode profile gets its own daemon in an
  isolated home so concurrent daemons never contend.
- **`agent config` is the typed preference store**, separate from the credential store, with
  a single key registry as the source of truth (`agent config --help` lists the keys). Some
  keys project into the proxy's own `config.json` at `agent start`, so they need a daemon
  restart. Projection is two-tier: **force-projected** keys are always written (copilot-env's
  default wins over the proxy's), while **opt-in** keys land only when stored, leaving the
  proxy's own default untouched otherwise - and opt-in projections are **ownership-tracked
  per daemon home** (`projection_state.ts`, same recorded-ownership philosophy as the
  WebSearch deny), so unsetting a key clears only the value we wrote, never a hand edit or
  the daemon's own. Every read site applies the same precedence: **explicit flag/env >
  stored config > built-in default**.
- **The managed proxy lifecycle is opt-in** (`auto-start`). The shared resolver
  `agent proxy-token` (src/commands/proxy_token.ts) is built from **honest primitives**
  (is-it-up, the gate, launch, heartbeat, print-key) rather than one magic flag, so each
  step is independently testable. Auto-stop is an **in-daemon** watchdog preload: server
  and watchdog are one process, so neither can orphan the other. Its activity signal
  counts only inference requests, so health pings can't keep it alive and muted logs
  can't starve it.
- **PATs need two runtime workarounds, both because Copilot treats them as a distinct
  credential class.** A PAT can't perform copilot-api's editor token exchange, so a preload
  fakes it and the daemon uses the token directly. And the inference hosts gate on a
  `Copilot-Integration-Id` that a PAT is only accepted under (`copilot-developer-cli`), so
  the identity is **probed per credential** rather than assumed - baked into Direct configs,
  or rewritten onto the daemon's calls by the same preload. Non-PAT credentials skip the
  probe entirely. `passthrough` and `integration-id` force either decision by hand.
- **Web search on Claude Direct is an MCP tool, not the builtin.** Copilot's Anthropic
  endpoint rejects Claude's server-side WebSearch, but `/responses` executes `web_search`
  server-side - so `agent mcp --serve` serves it as a tool and a direct default write wires the
  **register-then-deny pair** (registration in `~/.claude.json` first, the `WebSearch` deny
  only on success, never denied without a replacement; gated by `wire-mcp`, default on).
  Deny **ownership is recorded** in the state store so removal never deletes a deny the user
  had before us. The pair is default-profile-only: deny rules union across settings layers,
  so named profiles inherit it from the default layer and could never un-deny anyway.
- **The settings bundle moves the stores, never the artifacts.** `agent settings` exports
  exactly the two stores plus the current modes, tokens **redacted by default**, and import
  is a **strict parse boundary**: unknown keys and malformed values are rejections that
  never echo a received value (it could be a token). Restore is **non-destructive** - wiring
  and profiles are re-derived through the same init/profile machinery from one up-front
  plan (which also renders the confirmation), slots whose credential cannot resolve are
  skipped whole (ask, never break a working local credential), and imports write a
  credentials-included local backup first (unless opted out) whose re-import IS the
  rollback.

### Repo map

- `bin/agent`(`.ps1`) - self-bootstrapping launchers (install deno + deps, dispatch `cli.ts`).
- `shell/` - shell integration (the `agent` wrapper + eager `agent env`) and the opt-in
  `cl`/`co`/`cx` launchers; pure runtime wiring, never installs.
- `install.sh`/`install.ps1` - one-line installers: fetch the platform binary, verify its
  SHA256 against the release `checksums.txt`, then hand off to its own `agent install`.
  `COPILOT_ENV_DOWNLOAD_BASE` (a directory or URL) replaces the release as the source, which
  is how CI smokes an installer against a binary built from the branch under test.
- `scripts/compile.ts` (`deno task compile`) - the release build: five targets into `dist/`
  plus `checksums.txt`. It imports `RELEASE_TARGETS` from `src/install/targets.ts`, so the
  target list cannot drift; it drives only the target loop, because `deno.json`'s
  `compile.include` owns what gets embedded - a CLI `--include` MERGES with the config's list
  instead of replacing it, so a second copy would silently union.
  `test/installer_pinning.test.ts` pins `compile.include` to `installer.ts`'s asset lists in
  both directions (a drift is either a broken install or dead weight in every binary) and the
  installers' platform mappings to `targets.ts` (shell cannot import TypeScript).
- `src/cli.ts` - Commander entry; delegates to `run*` functions.
- `src/commands/` - one file per command; `init` configures both agents, `auth` manages the
  credential only and never configures agents. Command files validate, orchestrate, and
  render; the domain layers below never import `commands/`.
- `src/agents/` - cross-agent domain (needs BOTH `src/codex/` and `src/claude/`, so it can
  live in neither): the live Direct probe, direct-mode detection, provider-mode vocabulary,
  the agent-CLI list, the shared default/profile wiring writers (`configure_defaults.ts`,
  `profile_wiring.ts` - used by init, profile, and import alike), and the `agent settings`
  portable-bundle domain (`transfer.ts`: strict parse boundary, redaction, non-destructive
  import, pre-import backups).
- `src/shell/` - the rc-file shell-integration domain (markers, block wiring, launcher
  queries) behind `agent shell`; `shell/` at the repo root is the runtime payload it wires.
- `src/codex/`, `src/claude/` - per-agent config wiring.
- `src/copilot_api/` - proxy helpers: admin REST, catalog fetch, JSON config/state, model
  aliases, per-host paths, daemon process control, client-identity probe, the projection
  ownership record (`projection_state.ts`), the /responses web-search client.
- `src/mcp/` - the copilot-env MCP stdio server behind `agent mcp --serve` (first tool:
  web_search), dual-era via serveStdio (legacy handshake and MCP 2026-07-28 per
  connection); bare `agent mcp` is the human status command.
- `src/scripts/` - things that run as their OWN process or `deno run --preload`, NOT CLI handlers:
  the daemon shims, plus the one-release proxy-token forwarders onto `agent proxy-token`.
- `src/install/`, `src/migrations/`, `src/autoupdate/`, `src/health/`, `src/usage/`,
  `src/utils/` - release download/verify, version-step fix-ups, the update preflight, the
  health engine, cost reporting, generic helpers.
- `.claude-plugin/` (plugin manifest, including the inline `mcpServers` entry) + `skills/` -
  the repo's plugin/skill distribution surface (Claude marketplace installs and
  `npx skills add`); plain content, guarded by `test/skills_manifests.test.ts`. The inline
  MCP entry is POSIX-only by decision, and it must stay inside `plugin.json`: a root
  `.mcp.json` would be read as project-scope MCP config by any `claude` session in this
  checkout and conflict with the user-scope registration.
- `copilot-env.config` - proxy-float floor/ceiling. `test/` - `deno test` units + a start/stop
  lifecycle against `test/copilot-api-fake.mjs`. The fake is what keeps the lifecycle smoke
  auth-free and offline, so it is also the reason `deno task test:docker --floated-lifecycle`
  exists: that one run uses the REAL proxy, and it is the only thing that exercises the float
  against the live registry and the daemon's permission set against the proxy's real
  dependency tree.

### Agent & dev environment init

Every agent/dev environment and fresh `git worktree` initializes through **one** idempotent
script - `scripts/setup-env.sh` (`.ps1` on Windows) - so no entry point drifts. It is invoked
by the Copilot coding agent, Codespaces/Dev Containers, and humans.

### Migrations

`src/migrations/` carries one-time, idempotent fix-ups for existing installs, one file per step
named for the release it migrates **away from** (`3.6.0.ts`) - authored against the current
version, never predicting the next. `agent update` runs the due ones (`[old, new)`) on the NEW
install after swapping it in; failures are non-fatal. The runner is reached through the
`agent migrate <from> <to>` subcommand, because a compiled binary has no source file to
spawn. The transition that *adds* a subsystem can't auto-run via update - that one is covered
by the installer's `agent shell` refresh.

**The registry is currently EMPTY.** Every pre-deno-rewrite step was deleted, because the
rewrite is a hard runtime break: a pre-rewrite install runs the old bun-based updater, and bun
cannot load the runner at all (its first import reaches `@std/dotenv`, a jsr specifier only
deno's import map resolves), so no historical step can still be reached. Before deleting a
step, check that its persisted-state fix is re-derivable (`agent init`/`auth`/`claude`/`shell`)
or self-healing; if a step is the ONLY reader of a format the current code cannot parse, move
that tolerance into the reader instead of keeping the migration.

### Project conventions

- **No `any`** - deno lint's `no-explicit-any` is on (the recommended tag).
- **camelCase** functions/vars, **PascalCase** types/classes, **CONSTANT_CASE** top-level
  constants; **snake_case only on object-literal keys** (external config keys), always quoted.
- **No new deps without an explicit reason.** Current: `commander`, `consola`, `@std/dotenv`,
  `@std/semver`, `smol-toml`, `valibot`,
  `@jeffreycao/copilot-api`, `@modelcontextprotocol/server` (the `agent mcp --serve` stdio
  server; the v2 split package is the only line implementing MCP 2026-07-28 - the v1
  monolith is maintenance-only - and its zod arrives transitively either way). Dev-only:
  `@modelcontextprotocol/sdk` (v1, also still a runtime transitive of the proxy) and
  `@modelcontextprotocol/client` (v2), the two real
  MCP clients the interop tests drive against our server; zod itself stays out of our
  code and out of deno.json's imports.
- **String literals are external contracts** - model ids, JSON keys, env var names, log
  markers: never rename them during refactors.
- **ASCII source, and no typographic look-alikes anywhere.** By convention,
  comments/identifiers/code stay pure ASCII and non-ASCII appears only inside
  string/template literal text (user-facing output). The check-typography CI gate
  enforces the hard rule: no em dashes, curly quotes, ellipses, or
  invisible/ambiguous unicode in any file, string literals included.
- **deno** (runtime), **deno fmt** / **deno lint** (format/lint), **deno check** (typecheck),
  **shellcheck** / **PSScriptAnalyzer**. No bundler.
- **The repo-platform-managed files are excluded from `deno fmt`/`deno lint`** in `deno.json`'s
  top-level `exclude`. They arrive template-formatted from sync, so formatting them here is
  both an edit we are not allowed to make and a guaranteed `fmt --check` failure on the next
  sync PR. Add a file to that list whenever its header says "managed by".
- **The shell/PowerShell lint lists are discovered, never enumerated** (`scripts/lint-*.sh`):
  a hand-kept list stops covering new scripts silently.
- **Never add "Generated by", "Co-Authored-By", "claude", "codex", or "copilot" lines** anywhere.
- **Conventional Commits** - `feat:`/`fix:` release, `chore:`/`docs:`/`refactor:`/`test:`/`ci:`
  don't. The prefix only gates WHETHER a release happens: the version always bumps the
  **patch** (release-please `versioning: always-bump-patch`), never minor/major.
- **Run `/rubber-duck-review` before any commit** - an independent cross-model review of the
  pending changes, then commit.

### Releases

Versioned via release-please: pushes to `main` update one rolling **release PR**; merging it
tags `vX.Y.Z` and publishes the GitHub Release. Ordinary pushes release nothing. Installers
and `agent update` install the newest release tag, not `main`. The repo-owned
`.github/workflows/release.yml` wraps the managed release-please machinery: it pins the
installer assets AND cross-compiles all five binaries before the release (so a broken build
fails before anything is tagged), uploads them to the draft release with a build-provenance
attestation, verifies and runs the real uploaded binaries and installers on Linux + Windows,
and only then publishes.

`agent update` is the same fetch-verify-swap the installer does, minus the bootstrap: it
renames the new binary over the live one (POSIX) or moves the running image aside first
(Windows), then runs the NEW binary for both post-swap steps - `install --assets-only` to lay
down that release's runtime files, and `migrate` for the due migrations. Both are
best-effort: the version has already moved forward at the rename, so failing there would
strand the install instead of retrying.

- **Releases only ever move forward.** A published version is immutable: never re-release,
  overwrite, or pin a future release back to it. Each new release must be **> the latest tag**.
  Leave `release-as` absent; with `always-bump-patch` every release is the next patch version.
- The release PR needs the `REPO_PLATFORM_TOKEN` secret (a PAT/App token) to run CI like a
  normal PR. Without it, the built-in `GITHUB_TOKEN` can't trigger the workflows, so
  `all-green` sits unmet; close/reopen the PR to trigger CI, or merge with admin bypass
  (the code already passed CI into `main`).

### Commands

```bash
deno task typecheck     # deno check src/ test/ scripts/ .github/scripts/
deno task test          # test/**/*.test.ts
deno task test:docker   # the same suite in a container (hermetic HOME)
deno task lint          # deno lint + deno fmt --check (lint:sh / lint:ps for shell / PowerShell, skip-if-absent)
deno task check         # deno lint --fix + deno fmt

./bin/agent init      # set up Codex + Claude (auto-detect direct vs proxy; --direct / --proxy)
./bin/agent auth      # manage the GitHub credential (--provider/--get/--del/--check)
./bin/agent config    # get/set preferences (--set <key> <value> / --get [key] / --del <key>)
./bin/agent settings  # export/import the portable settings bundle (--export [file] / --import <file>)
./bin/agent profile   # manage named profiles (--add <name> --direct|--proxy / --del / --list)
./bin/agent start     # start the daemon; also stop / health / models / env / cost / update / shell / codex / claude / uninstall
```

The checked-in `.githooks/pre-commit` hook (wired by `scripts/setup-env.sh` via
`core.hooksPath`; deno-native, no node) runs the same gate as the `check` job in `checks.yml`
(staged-file lint/format + typecheck + tests + repo-wide lint + the skip-if-absent shell/PS
linters); `checks.yml` adds a Linux/macOS/Windows matrix plus lifecycle and installer jobs.
