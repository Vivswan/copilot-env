# Task #12 final sweep - handoff notes (worker-sweep)

Branch: worktree-agent-ab020e96d6e5225ce, rebased onto main 3daa12c mid-task
(per coordinator heads-up; no collision, this sweep never touches install.ps1).

## Leg 1 - harvest of wip/hardening's env-semantics commit

Harvested from f5a7bad (the rebased form; 2c9ad90 is the same change on
four-waves-old main and was not used) plus the hardening worktree's two
uncommitted files. Disposition per hunk:

- test/helpers/run.ts (childEnv + runSync): TAKEN verbatim. runSync now gives
  the child EXACTLY the requested env (null-prototype map, Object.hasOwn
  membership, parent extras cleared for the span of the sync spawn, restore in
  finally). Call-site audit for the merge-over-parent hazard: every runSync /
  runScript / runCli / spawnChild call site either spreads process.env, builds
  a full env copy (test/helpers/mcp.ts mcpEnv + clearEnv), or omits env
  (defaults to process.env). The only partial-env calls are the new
  run_helper tests, where partial-env is the property under test.
- test/run_helper.test.ts (two new tests): TAKEN (exact-env replacement,
  prototype-member key clearing). The twice-hotfixed status-or-throw
  failed-spawn test on main is untouched and still passes.
- test/helpers.ts TEST_ENV_KEYS + COPILOT_ENV_CI_PS_DOCUMENTS_DIR: TAKEN.
- test/helpers/testing.ts: TAKEN in the uncommitted (newer) form - the suite
  floor imports CI_RC_DIR_ENV / CI_PS_DOCUMENTS_DIR_ENV from
  src/shell/integration.ts instead of retyping literals, rc seam floor is
  SANDBOX_HOME itself, and the PS Documents floor is new. The old "cannot
  import from src/" claim was stale - the import typechecks and the whole
  suite passes with it.
- test/env.test.ts hunk: DROPPED as superseded. Main already carries
  childBaseEnv's COPILOT_ENV_CI_RC_DIR line in its settled form; f5a7bad's
  hunk would have re-added it as a duplicate key (which the hardening
  worktree's uncommitted env.test.ts then removed - net zero).
- test/shell_integration.test.ts drift guard: KEPT and extended, comment
  rewritten. The literal pins remain as the external-contract pin for the env
  var NAMES (children get them via hand-built env maps); the floor-activity
  assertions now cover both seams.

Windows caveat: RESOLVED in the round-1 fix (see below) - the two partial-env
tests fold the platform essentials (SystemRoot/windir/ComSpec/PATH/TEMP/TMP)
into the requested env, so the child is spawnable everywhere while the named
assertions are unchanged.

## Leg 2 - zero-bun audit

Sanctioned survivors (verified, untouched):
- src/copilot_api/process.ts WINDOWS_DAEMON_IMAGES "bun.exe" + comment.
- LEGACY_ARTIFACTS bun.lock/bunfig.toml in install.sh / install.ps1 /
  src/install/installer.ts.
- CHANGELOG.md history.
- .github/workflows/dependabot-bun-lockfile.yml (managed; next sync retires
  it) and deno.json's exclude entry for it (stays while the file exists).
- .claude/patches historical notes.

Additional keepers, with reasons:
- .gitignore bun section: in the MANAGED region (only the marked LOCAL
  section is repo-owned); the next sync's deno module replaces it.
- .gitleaks.toml bun.lock/bun.lockb allowlist: LOAD-BEARING - gitleaks git
  scans history where those lockfiles exist. Do not remove.
- .copier-answers.yml (modules: bun, topics bun): managed template record of
  the last applied sync; .repo-platform.yml already selects "deno", the next
  sync rewrites the answers file.
- .github/dependabot.yml "bun" ecosystem entry: managed by repo-platform.
- AGENTS.md migrations section + src/migrations/index.ts bun mentions:
  deliberate historical rationale for the empty registry.
- test/helpers/testing.ts "bun:test surface / bun-parity" headers: deliberate -
  they name the emulated contract. (run.ts's "Bun.spawnSync result shape"
  clause was scrubbed in round 1: the shape is now just RunResult.)
- test/web_search.test.ts "Bun 1.3 shipped" fixtures: content ABOUT the Bun
  product inside simulated search results, not toolchain references.

Deleted/ported:
- .devcontainer/devcontainer.json: bun global install + bun/biome VS Code
  extensions -> setup-env.sh only + denoland.vscode-deno. Node feature kept
  (husky's hook shim needs node, skip-if-absent).
- "bunfig minimumReleaseAge" defaultLabel -> "7 days (built-in)"
  (env_config.ts) and the matching .env.example precedence note. The real
  default is DEFAULT_RELEASE_COOLDOWN_SECONDS in proxy_float.ts; a label
  import would be circular (proxy_float imports env_config), hence the
  hand-written label, consistent with the other labels in that registry.
- Stale bun-era comments/test names across test/ (see the scrub commit).
  codex_host.test.ts's "bun caches os.homedir()" escape note: verified by
  probe that deno's node:os homedir() follows a runtime HOME change, so the
  escape is gone; comment now says so.
- .github/settings.yml topics: bun -> deno (settings.yml is the sanctioned
  place to change repo settings; three-way merge keeps repo edits).
- skills/web-search/.codex-plugin/plugin.json example prompt: bun -> deno.

Final grep proof (word-ish, case-insensitive, CHANGELOG/.claude excluded):
`grep -rinE "\bbun\b|bunx|bunfig|bun:|bun\.lock|bun\.exe" .` returns only the
sanctioned/keeper lines listed above. No bun-runtime machinery remains.

## Leg 3 - dead code

- npm:typescript verdict: a FOSSIL, removed. 13fd1a3 added
  "typescript": "npm:typescript@^7.0.2" to deno.json for the import-free
  guard's ts.preProcessFile; the guard was replaced (lint plugin) and the
  import removed, but deno.lock kept valibot resolved against the optional
  peer (valibot@1.4.2_typescript@7.0.2), installing typescript 7 + its ~26MB
  native platform binary on every install. No module imports typescript.
  Lockfile surgically re-resolved (valibot@1.4.2 plain, all typescript
  entries dropped), canonicalized by deno install, verified by a clean
  node_modules rebuild + full gate.
- Declared deps: every deno.json import has real import sites (consola 28,
  smol-toml 10, valibot 7, execa 3, @std/crypto 3, etc). The
  @jeffreycao/copilot-api entry has no `from` site by design - it is the
  float's manifest baseline (DO-NOT-TOUCH honored). package.json devDeps
  (husky, lint-staged) are live via hooks.
- No orphaned files: every src/test/scripts/.github/scripts file is
  referenced (scan cross-checked against workflows, Dockerfile, manifests).
- Exported-but-not-imported symbols exist (mostly interfaces/types on public
  signatures plus a few in-file-used runtime helpers); none are dead code
  (all execute or type public API), so no unexport churn was done. Full list
  available by re-running the scan; src/codex/catalog.ts left alone (user
  WIP).

## Leg 4 - stale docs

- AGENTS.md proxy-float bullet: package.json/postinstall/npm-check wording ->
  deno.json import-map baseline, resolved at `agent start` when the recorded
  resolution has gone stale (the only ensureProxyFloor caller is
  src/commands/start.ts since 0f4d932), float no-op when both agents are
  Direct.
- AGENTS.md dep list: "dotenv" -> "@std/dotenv"; zod exclusion now points at
  deno.json's imports (package.json carries no dependencies anymore).
- README/CONTRIBUTING/SECURITY/Dockerfile/scripts/shell: scanned for
  bun/biome/postinstall - already clean from chunk6's pass.

## Drift to surface upstream (not actioned here)

- The "copilot-api baseline bump pending" memory says the ^2.0.1 bump lands
  in package.json; the baseline now lives in deno.json's imports. The bump,
  when due (2026-08-16 cooldown has passed), goes to deno.json +
  test/proxy_float.test.ts's manifest guard.

## Round-1 review fixes (opus items 1-2, codex items 3-5)

1. run_helper.test.ts: the two new partial-env tests fold platformEssentials()
   (SystemRoot/windir/ComSpec/PATH/TEMP/TMP, case-insensitive match) into the
   requested env - Windows CreateProcess passes the block verbatim, and the
   tests assert a NAMED variable, never minimality.
2. test/helpers.ts isolateAgentHomes: sets USERPROFILE alongside HOME (node:os
   homedir() resolves from USERPROFILE on Windows), actually closing the
   catalog-sweep read escape everywhere; codex_host.test.ts's comment now
   names both variables. USERPROFILE was already in TEST_ENV_KEYS, so
   envSnapshot restoration covers it.
3. AGENTS.md float bullet: "install/update time" -> "at `agent start`, when
   the recorded resolution has gone stale" (verified: start.ts:329 is the only
   ensureProxyFloor caller).
4. test/helpers/run.ts: "Bun.spawnSync result shape" -> "RunResult shape";
   rest of the docblock untouched.
5. test/env_config.test.ts: new drift guard deriving the "7 days (built-in)"
   release-cooldown label from DEFAULT_RELEASE_COOLDOWN_SECONDS (test count
   380).
6. (codex item 6) codex_host comment re-checked after the USERPROFILE change:
   the bun-contrast stays, wording now matches what isolateAgentHomes sets.

## Round-2 review fixes

1. run.ts / run_helper.test.ts hasOwn comments: the old justification claimed
   `in` would leak prototype members, but childEnv's map is null-prototype, so
   `in` and hasOwn agree there today. Comments now state the real reason: the
   guard survives childEnv ever returning an ordinary object again.
2. env_config.test.ts drift guard: 86_400 -> SECONDS_PER_DAY from
   src/utils/time.ts (single-sourcing).
3. proxy_float.ts stale trigger claims fixed in all three spots (configRead
   comment, header, verify docblock), plus the cooldown doc, the record-refresh
   comment, launch.ts's "rather than in the bin shim", checks.yml's
   "--assert-installed" comment, and three test comments.
4. DECISION - proxy_float's direct-run CLI surface DELETED. Zero invokers
   anywhere: bin/, installers, workflows, scripts/, Dockerfile, skills/, docs,
   and no test spawns the file as a script (tests import the functions).
   Removed: parseMode, mainFloat/mainVerify/mainAssertInstalled, main, the
   import.meta.main block, DIRECT_ONLY_SKIP_MESSAGE (output of a never-run
   CLI, so no external contract). Kept: every exported function.
   proxyFloatSkips stays (health probe + tests) with its doc repointed at its
   real consumer; proxyInstallAssertStatus stays as the hard end-state check,
   documented as tests-only today with the checks.yml rationale for why CI
   does not wire it. The module header now names the real consumers
   (ensureProxyFloor at `agent start`, process.ts, uninstall, health,
   warm-proxy-cache.ts, tests).

## Gate

See the SendMessage report; run from this worktree:
deno task typecheck, deno task lint, deno task test (380 = 377 + 2 harvested
tests + 1 label drift guard), bash scripts/lint-sh.sh, deno task test:docker.
