<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

This file provides guidance to AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and overwritten by template sync; this repository's own guidance belongs outside the markers (below the END marker at the bottom).

## Project

copilot-env: Local copilot-api proxy lifecycle + config helper (TypeScript).

## Toolchain

- Deno runtime (`deno install`, `deno test`, `deno task <task>`)
- See `deno.json` for tasks, imports (`npm:`/`jsr:` dependency specifiers), and lint/format settings.
- `.dvmrc` pins the toolchain and is managed by the template: sync overwrites it, so version overrides belong in the repo-owned workflows' explicit version inputs.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`, `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the commit subject and drives release-please versioning. CI validates both (the required pr-title check + validate-commit-names).
- CI gates on the required check `all-green`: ci.yml's own `all-green` job needs the `checks` and `ci` caller jobs and fails unless each result is success or skipped, with at least one success (the gate jobs themselves run centrally through repo-platform's fleet-ci.yml; the `pr-title` check is required separately by its own ruleset). This repository's own test/lint jobs belong in `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not edit ci.yml, template sync overwrites it. A green gate on a push to main releases: ci.yml's `release` job (`needs: [all-green]`, gated on its result) calls the managed release pipeline in `.github/workflows/release.yml` with the judged commit; this repository's release preparation (packaging, asset uploads, note edits) goes in the repo-owned `.github/workflows/update-release.yml` hook it calls.
- No typographic look-alike characters (curly quotes, em-dashes, invisible unicode). CI enforces this with the check-typography action; use plain ASCII punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs pushed by that repository. Do not edit them here; change them in Vivswan/repo-platform and let the next sync PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy) are applied from Vivswan/repo-platform: it merges the fleet defaults and this repository's selected-module layers at apply time, then this repository's own `.github/settings.yml` (identity keys and local overrides) over them, and finally a fleet override layer carrying the invariants no repository may weaken (squash-only merging, the branch protection rulesets). A same-name label here replaces the fleet one; a same-name ruleset merges, so you can tighten a fleet ruleset but not strip a rule from it. Do not change settings by hand in the GitHub UI; edit `.github/settings.yml`.
- Repo-owned escape hatches stay local: `.github/workflows/checks.yml`, `.github/workflows/update-release.yml`, `.github/workflows/update-release-pr.yml`, `release-please-config.json` and `.release-please-manifest.json` (release state, seeded once), `.gitleaks.toml`, `.gitignore` outside its BEGIN/END managed region, `.typography-allow.local` (typography exemptions; the managed `.typography-allow` is overwritten by sync), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker. They are this
     repository's own and survive template updates. -->
<!-- END REPO-PLATFORM MANAGED -->

copilot-env wires the Codex and Claude CLIs to GitHub Copilot, either through a floating `@jeffreycao/copilot-api` proxy it manages or to Copilot Direct. Code is the source of truth: this section holds only the rules and the decisions a reader could not recover from the code.

### Hard rules

- **Cross-platform is non-negotiable**: Linux, macOS, and Windows. Every POSIX/PowerShell pair stays feature-matched (`bin/agent`, `shell/agents*`, `install.*`, `src/scripts/proxy-token.*`), and PowerShell must run on Windows PowerShell 5.1 as well as pwsh 7. Prefer the platform helpers in `src/utils/root.ts` over hardcoding a shell.
- **Nothing hidden**: every command names every file it writes or deletes.
- **A personal utility, not a product**: no backwards compatibility anywhere except `src/migrations/` (one-time fix-ups run by `agent update`); no compatibility shims or legacy-state adoption in read sites. No production hardening. Delete old surfaces outright; a flag removal is a plain `feat:`/`fix:`.
- **Tests are minimal and highest-quality**: pin behaviour, never tooling internals; no tautological or one-off asserts.
- **String literals are external contracts** (model ids, JSON keys, env var names, log markers): never rename them in a refactor.
- **ASCII source**: non-ASCII only inside string literal text, and no typographic look-alikes anywhere (CI enforces this).
- **No `any`. No new deps without an explicit reason. No bundler.**
- **Naming**: camelCase functions and variables, PascalCase types, CONSTANT_CASE top-level constants; snake_case only on quoted object-literal keys.
- **Layering**: command files (`src/commands/`) validate, orchestrate, and render; the domain layers never import them. `src/scripts/` holds only things that run as their own process or via `deno run --preload`, never CLI handlers.
- **Never add "Generated by", "Co-Authored-By", "claude", "codex", or "copilot" lines** anywhere.
- **Conventional Commits**: `feat:`/`fix:` release, other prefixes do not; the version always bumps the patch (`always-bump-patch`).
- **Run `/rubber-duck-review` before any commit.**
- **Managed files** (header says "managed by Vivswan/repo-platform") are never edited here; add each to deno.json's fmt/lint `exclude`.
- **Shell/PowerShell lint lists are discovered, never enumerated** (`scripts/lint-*.sh`).

### Decisions a reader would otherwise reverse

- **A release is a binary, a checkout is a checkout.** The same `agent install` serves both and can never overwrite a checkout (`src/install/installer.ts`).
- **The proxy floats; we never patch it.** Runtime needs are preload shims in `src/scripts/`, never package edits (`src/proxy_float.ts`).
- **`agent env` is the only output the shell wrapper evals** (`shell/`), so a new subcommand needs no wrapper change.
- **One credential, resolved not baked** (`src/copilot_api/env_state.ts`): Direct configs never store a token copy, and there is no implicit `gh` fallback. When auth is none we ask.
- **Profiles are atomic units** (`src/agents/profile_wiring.ts`): one credential + one mode, always both agents. A named profile hard-fails rather than falling back to the default credential.
- **`agent config` is the typed preference store** with a single key registry (`src/copilot_api/env_config.ts`). Every read site applies explicit flag/env > stored config > built-in default.
- **`agent update` proves origin and fails closed** (Sigstore provenance, `src/install/provenance.ts`). The installer is trust-on-first-use: verifying against the same release it was fetched from would be circular.
- **Claude Desktop wiring is state driven by the `claude-desktop` key** (`src/agents/claude_desktop.ts`): every pass re-derives from the key and the ownership ledger (`src/copilot_api/ownership.ts`), and the ledger identifies our entries by uuid path, never by display name; a sweep never removes an entry it does not own.
- **The usage index is a pre-index, never a result cache.** Every `agent cost` report folds fresh from the files that exist now and must equal the full parse.
- **Migrations** (`src/migrations/`): one file per from-version, named for the release it migrates away from; fix-ups run in registry order. Delete a step once its fix is re-derivable; the format it read goes with it, never into a reader.
- **One env init**: every agent/dev environment and fresh worktree runs `scripts/setup-env.sh` (`.ps1` on Windows).

### Releases

release-please, patch-only. Releases only move forward: never re-release or pin back, and leave `release-as` absent. A build broken at release time fails after the tag exists: re-run the failed jobs, never re-cut.

### Commands

```bash
deno task typecheck     # deno check
deno task test          # test/**/*.test.ts
deno task test:docker   # the same suite in a container (hermetic HOME)
deno task lint          # deno lint + deno fmt --check
deno task lint:sh       # shellcheck, skip-if-absent
deno task lint:ps       # PSScriptAnalyzer, skip-if-absent
deno task check         # deno lint --fix + deno fmt
deno task compile       # release build: five targets into dist/
./bin/agent --help      # the CLI; `agent config --help` lists the preference keys
```

The pre-commit hook in `.githooks/` (wired by setup-env) runs the typecheck, test, and lint tasks above.
