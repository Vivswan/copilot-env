---
title: CLI redesign
group: Internals
order: 8
---

# CLI redesign

The profile-centric command surface: everything about one profile lives under `agent profile`, the default profile is the one you do not name, and every writing command plans before it applies. A design page for review before any code; the surface it replaces is `src/cli.ts` today. An interactive (menu-driven) front end is parked separately and is out of scope here.

## The command tree

```text
agent
  profile [<name>] <verb>         one profile; no name = the default profile
      add [--direct|--proxy]      create or re-wire: credential + mode, BOTH agents; no flag = the recorded mode,
                                  or the Direct-vs-proxy probe for a new default (question 2)
          [--provider <p>] [--set <token>] [--gh-user <login>]
      del                         delete everywhere (daemon, credential, wiring, home)
      show                        mode, provider, daemon, identity, files, keys in effect
      auth                        the credential: [--provider <p>] [--set <token>] [--gh-user <login>]
                                  [--get] [--del] [--check] [--identities] [--identity]
      set <key> <value>           a profile or profile-default key, this profile's value
      unset <key>                 drop that value: a profile key falls to its built-in default,
                                  a profile-default key to the shared default
      get [<key>]                 the value in effect, with its origin
      sync [--claude|--codex]     re-render the agent files from the store
      check [--claude|--codex]    the recorded mode, or one agent's file; exit codes in the table below
      settings-for                sync, then print the Claude settings path
  profile list                    every profile: mode, provider, daemon (also bare `agent profile`)
  sync                            every profile's sync
  config set|get|unset            global keys, and the shared default of a profile-default key (proxy.*, probe.*)
  auth ...                        == profile auth ...        (the default profile)
  mobile                          the Codex desktop pairing flow (was `agent codex --mobile`)
  launch  start  stop  proxy-token  health  models  env  cost  credits  settings
  mcp  shell  update  install  uninstall  migrate                        unchanged
```

Every writing verb takes `--dry-run` and names every file it writes or deletes; see [Plan then apply](#plan-then-apply-and---dry-run). A `sync --claude` or `--codex` whose Direct pair cannot be rendered from the store (`directPairIncomplete`, `src/agents/profile_wiring.ts`) lands both agents and says so, as the one-agent re-render does today: the pair is selected once, never per agent.

## Old to new

Every command and flag `src/cli.ts` declares today. "Unchanged" means the command and all of its flags stay as they are.

| Today                                                                   | New spelling                                                    | Note                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent init` (no flag: probe Direct vs proxy)                           | `agent profile add`                                             | Depends on question 2: the probe stays for a new default only, and a flag is required otherwise; the next-steps box prints as today                                                                           |
| `agent init --direct` / `--proxy` / `--dry-run`                         | `agent profile add --direct` / `--proxy` / `--dry-run`          |                                                                                                                                                                                                               |
| `agent codex` / `agent claude` (re-render, no flag)                     | `agent profile sync --codex` / `--claude`                       | On a fresh default both wire both agents today; new: refused, `add` is the landing                                                                                                                            |
| `agent codex --direct` / `--proxy` (+ `claude`)                         | DELETED                                                         | A mode is set by `add`; a re-render never takes a mode flag                                                                                                                                                   |
| `agent codex --check` / `agent claude --check`                          | `agent profile check --codex` / `--claude`                      | Same exit codes (0 direct, 2 proxy or unconfigured, 1 other); `--claude` keeps the Claude Desktop status tail (`src/commands/claude.ts`)                                                                      |
| `agent codex --mobile`                                                  | `agent mobile`                                                  | Not about a profile; interactive, macOS/Windows (`src/codex/mobile.ts`)                                                                                                                                       |
| `agent codex --dry-run` / `agent claude --dry-run`                      | `agent profile sync --codex --dry-run` (etc.)                   |                                                                                                                                                                                                               |
| `agent auth` (+ `--provider`, `--set`, `--gh-user`)                     | `agent profile auth ...` (alias: `agent auth ...`)              | The default profile's credential                                                                                                                                                                              |
| `agent auth --get` / `--del` / `--check` / `--dry-run`                  | same flags on `profile [<name>] auth`                           | `--get` stays the resolver the agent files shell into (`AGENT_AUTH_GET_ARGS`, `src/utils/root.ts`)                                                                                                            |
| `agent auth --profile <name> ...`                                       | `agent profile <name> auth ...`                                 |                                                                                                                                                                                                               |
| `agent auth --list`                                                     | `agent profile list`                                            | One table: mode, provider, daemon; tokens never                                                                                                                                                               |
| `agent auth --identities`                                               | `agent profile [<name>] auth --identities`                      | The probe table, read-only                                                                                                                                                                                    |
| `agent auth --identity` (bare, interactive)                             | `agent profile [<name>] auth --identity`                        | The picker needs the credential, so it stays on `auth`                                                                                                                                                        |
| `agent auth --identity <id>` / `--identity auto`                        | `agent profile [<name>] set identity <id>` / `unset identity`   | `identity` is a profile key; `set identity` runs the same probe-backed pin as the picker (`pinIdentity`, `src/commands/auth.ts`), so a host-rejected id is refused on both paths (open question 5)            |
| `agent auth --print-proxy-token`                                        | DELETED                                                         | Prints the proxy's stored API key, minting one if absent, with no daemon check (`runPrintProxyToken`, `src/commands/auth.ts`); `agent proxy-token` calls that function in-process and keeps it. The flag goes |
| `agent profile --add <name> --direct or --proxy`                        | `agent profile <name> add --direct or --proxy`                  | `--provider`, `--set`, `--gh-user`, `--dry-run` ride along; no mode flag re-wires an existing profile in its recorded mode and is refused for a new one, as today                                             |
| `agent profile --del <name>`                                            | `agent profile <name> del`                                      |                                                                                                                                                                                                               |
| `agent profile --list`                                                  | `agent profile list` (or bare `agent profile`)                  |                                                                                                                                                                                                               |
| `agent profile --check <name>`                                          | `agent profile <name> check`                                    | No agent flag = the recorded mode: 0 direct, 2 proxy, 1 missing or partial (today's contract); `--claude or --codex` = that agent's file: 0 direct, 2 proxy or unconfigured, 1 other                          |
| `agent profile --settings-for <name>`                                   | `agent profile <name> settings-for`                             |                                                                                                                                                                                                               |
| `agent profile --sync`                                                  | `agent sync`                                                    | Every profile; one profile is `agent profile <name> sync`                                                                                                                                                     |
| `agent config --set <key> <value>` (global key)                         | `agent config set <key> <value>`                                | Verbs, not flags, like `profile`                                                                                                                                                                              |
| `agent config --set <profile-default key>` (no `--profile`)             | `agent config set <key> <value>`                                | The shared default of `proxy.*` and `probe.*`, inherited by every profile without an override                                                                                                                 |
| `agent config --get [key]` / `--del <key>`                              | `agent config get [<key>]` / `agent config unset <key>`         | For a global or shared-default key                                                                                                                                                                            |
| `agent config --set` / `--get` / `--del <profile key>` (no `--profile`) | `agent profile set` / `get` / `unset <key>`                     | `host`, `identity`, `passthrough`, `static-key`: `agent config` refuses them with this spelling                                                                                                               |
| `agent config --profile <name> ...`                                     | `agent profile <name> set, unset, get ...`                      | The flag is deleted                                                                                                                                                                                           |
| `agent config --dry-run`                                                | `--dry-run` on `config set or unset` and `profile set or unset` |                                                                                                                                                                                                               |
| `agent launch`, `start`, `stop`, `proxy-token`                          | unchanged                                                       | Their `--profile <name>` flags stay: they address a runtime, not the profile (open question 7)                                                                                                                |
| `agent health`, `models`, `env`, `cost`, `credits`                      | unchanged                                                       |                                                                                                                                                                                                               |
| `agent settings`, `mcp`, `shell`, `update`                              | unchanged                                                       | The settings bundle keeps its shape; import lands through `profile add`'s writer                                                                                                                              |
| `agent install`, `uninstall`, `migrate`                                 | unchanged                                                       |                                                                                                                                                                                                               |
| `agent --version`, `--help`, `--full-help`                              | unchanged                                                       | `--full-help` walks the `profile` verbs like subcommands                                                                                                                                                      |

Capabilities with no home in the new tree: none. Every flag above lands, is a flag over an in-process path (`--print-proxy-token`), or is a mode flag on a re-render, which the profile model already forbids.

## Reserved words and the no-name rule

- `agent profile <first> ...`: when `<first>` is a verb, the verb applies to the default profile; otherwise `<first>` is a profile name and the verb follows.
- Verbs are therefore reserved names: `add`, `del`, `show`, `auth`, `set`, `unset`, `get`, `sync`, `check`, `settings-for`, `list`. They join today's `default`, `direct`, `proxy`, `all` (`RESERVED_PROFILE_NAMES`, `src/copilot_api/profile.ts`).
- Refusal, from the one name constructor (`parseProfileName`): `profile name 'sync' is reserved (it is a verb of agent profile)`. The `default` wording follows the flag it named: `profile name 'default' is reserved (omit the name for the default profile)` replaces today's `(omit --profile for the default profile)`.
- Aliases are exactly the no-name forms: `agent auth X` is `agent profile auth X`. Nothing else is aliased and no old flag spelling is kept.
- `agent profile del` with no name is refused: `the default profile cannot be deleted; agent uninstall removes everything`. `agent profile auth --del` still clears its credential.

## Config split

The registry (`CONFIG_REGISTRY`, `src/copilot_api/env_config.ts`) already carries a scope per key; the split follows it and adds no scope.

| Scope             | Keys                                                                                                                                                                                                                                    | `agent config`                                                                  | `agent profile [<name>] set`                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `global`          | `claude.desktop`, `claude.wire-mcp`, `codex.home`, `codex.host`, `codex.model-catalog`, `cost.credits-target`, `cost.pricing-url`, `daemon.*` (9 keys), `shell.launchers`, `update.auto`, `update.cooldown`, `update.verify-provenance` | the one value                                                                   | refused: `'daemon.port' is a global setting: agent config set daemon.port <value>` |
| `profile`         | `host`, `identity`, `passthrough`, `static-key`                                                                                                                                                                                         | refused: `'host' is a profile setting: agent profile [<name>] set host <value>` | this profile's value (the default's without a name)                                |
| `profile-default` | `probe.claude-model`, `probe.codex-model`, `proxy.*` (10 keys)                                                                                                                                                                          | the shared default every profile inherits                                       | this profile's override                                                            |

- The override rule stays as `resolveSettingIn` reads it: explicit flag or env > profile section > shared default > built-in default; `settingTarget` keeps choosing the write destination by scope. `agent profile [<name>] get <key>` prints the value and which layer it came from.
- New: the default profile may hold an override for a profile-default key like any named profile (open question 6). Today no name means the shared value; the default's section already exists for its profile keys, so no store shape changes.
- `agent config get` with no key prints the global table; `agent profile [<name>] show` prints that profile's keys in effect. The `configuration.md` key tables split the same way, and `test/docs_config.test.ts` keeps checking that every registry key has a row.

## Plan then apply and `--dry-run`

The substrate is the filesystem facade ([Dry-run filesystem](dry-run-facade.md)): a writer reads, computes, and writes on the seam, and a dry run overlays the writes and prints a tree diff at the end.

- This redesign adds no second plan mechanism: a verb calls the same writers a flag calls today, and its `--dry-run` output is whatever the seam reports.
- Until every writer is on the facade, the new verbs print through the plan path main has (`landPlan`, `src/commands/dry_run.ts`), exactly as today's flags do.

| Command                           | What `--dry-run` prints                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent profile [<name>] add ...`  | The store slot keys (provider, mode; token `<redacted>`), `settings.json` or `settings-<name>.json`, `config.toml` (the default's provider table, or a named profile's `[model_providers.copilot-env-<name>]` table) plus `<name>.config.toml` for a named profile, each managed attribute `old -> new`, the Claude Desktop entry when `claude.desktop` is on, and for `--proxy` the reserved port and the daemon home |
| `agent profile <name> del`        | The same paths as `delete` rows, the slot keys removed, the daemon named as "would stop" (never signalled)                                                                                                                                                                                                                                                                                                             |
| `agent sync` / `profile ... sync` | Each agent file as `rewrite` with the changed attributes, or `unchanged <path>` when it already matches; no summary line                                                                                                                                                                                                                                                                                               |

`check`, `show`, `get`, and `list` write nothing and refuse `--dry-run`, as `--check` does today. `settings-for` always syncs first, as today (`runSettingsFor`, `src/commands/profile.ts`): its `--dry-run` prints the sync's plan and no path.

## Deletions

Old surfaces go outright; nothing stays as a compatibility alias.

| Goes                                                                                                                                                               | Why                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `agent init`, `agent codex`, `agent claude` (their `src/cli.ts` blocks)                                                                                            | Folded into `profile add`, `sync --claude or --codex`, `check --claude or --codex` |
| `src/commands/init.ts`, `src/commands/claude.ts`, `src/commands/configure_agents.ts`                                                                               | The landing and the next-steps box move into the default's `profile add`           |
| `parseCodexAction`, `parseClaudeAction`, `CodexCliAction`, `ClaudeCliAction` (`src/agents/configure.ts`)                                                           | Per-agent flag parsing; the verb parser replaces it                                |
| The flag parser in `src/commands/profile.ts` (`parseProfileAction`, `ProfileArgs`)                                                                                 | Replaced by the `[<name>] <verb>` parser                                           |
| `agent auth --list`, `--print-proxy-token`, `--profile` (`src/commands/auth.ts`)                                                                                   | List is `profile list`; the token is `agent proxy-token`; the name is positional   |
| `agent config --profile` and its profile-key arms (`src/commands/config.ts`)                                                                                       | Profile keys are `profile set, unset, get`                                         |
| `--direct` / `--proxy` on any re-render                                                                                                                            | A mode is set by `add` alone                                                       |
| Tests pinning the deleted flag spellings (`test/configure.test.ts`, `test/profiles.test.ts`, `test/cli.smoke.test.ts`, `test/auth.test.ts`, `test/config.test.ts`) | Rewritten to the verbs, same behaviours                                            |

The writers themselves (`src/agents/profile_wiring.ts`, `src/agents/configure_defaults.ts`, the `src/codex/` and `src/claude/` adapters) do not change: the redesign is a command-layer change.

## Shell wrapper

No change to `shell/agents.bashrc` or `shell/agents.ps1`.

- The wrappers run `bin/agent` (`bin\agent.ps1` on Windows) with the user's arguments, then eval `agent env` (`--format powershell` there) and nothing else.
- The `cl` / `co` / `cx` functions `agent env` emits call `agent launch`; `src/commands/launch.ts` reaches the profile hooks (check, settings-for, sync) in-process, never by spelling a subcommand.
- Two command lines are baked into agent files and stay valid for the default: `agent auth --get` (Codex `auth.command`, Claude `apiKeyHelper`) and `agent proxy-token --yes`.
- The named form changes: `auth --get --profile <name>` becomes `profile <name> auth --get`, which is the re-render in the migration below.

## Migration

- The store (`~/.local/share/copilot-env`) is untouched: no key moves, no shape changes. A settings bundle exported today imports tomorrow, unless it names a profile like a verb (below).
- One step in `src/migrations/`, under the release it leaves behind, in two jobs:
  - Rewrite the baked helper line of every named Direct profile in place, then re-render (the `agent sync` path). The line lives in `settings-<name>.json` (`apiKeyHelper`) and in the shared `config.toml` (`[model_providers.copilot-env-<name>]`); the default's own entries do not change.
  - The in-place edit comes first because the readers classify the old spelling as foreign (`managedHelperShape`, `src/claude/config.ts`; `authMatches`, `src/codex/config.ts`) and a re-render refuses a foreign file.
  - A profile named like a new verb (`sync`, `auth`, ...) is valid today and invisible tomorrow: `profileNames()` (`src/copilot_api/env_state.ts`) filters reserved names, so a plain sync would skip it.
  - The step reads the raw store, stops that profile's daemon first (as `moveRootDaemonHome` in `src/migrations/4.0.9.ts` does), and renames it to the first `<name>-<n>` unused across the store, the daemon homes, and the agent files.
  - The rename moves every artifact and retargets the old name inside it before any re-render: the store slot and preferences section, the daemon home, `settings-<name>.json` with its baked `--profile` argument (a stale one reads as foreign and is refused, `src/claude/config.ts`), `<name>.config.toml`'s `model_provider` selector, the `[model_providers.copilot-env-<name>]` table with its auth arguments, and the owned Claude Desktop entry (`src/claude/desktop.ts`, which drops an entry it cannot parse).
  - The rule the implementing PR pins: nothing carrying the old name survives the step un-retargeted, so hand-added settings and the Desktop entry's identity survive. The step prints the old and new names (open question 11).
- Nothing a user does by hand; `agent update` runs it.

## Delivery plan

Three PRs, each landable alone with its tests and docs.

| PR | Scope                                                                                                                                                                                                                                                                                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | The `agent profile [<name>] <verb>` parser and reserved words; verbs `add`, `del`, `list`, `show`, `auth`, `check`, `sync`, `settings-for`; `agent auth` as the no-name alias; `agent sync`; the old `profile` and `auth` flags deleted, except the valued `auth --identity`, which waits for its replacement in PR 3; the migration step |
| 2  | Fold `agent init`, `agent codex`, `agent claude`: `add` takes the landing and the next-steps box, `sync`/`check` take `--claude or --codex`, `agent mobile`; delete `init.ts`, `claude.ts`, `configure_agents.ts`, the per-agent parsers                                                                                                  |
| 3  | Config split: `profile set, unset, get`, `agent config` verbs, refusals by scope, `--profile` deleted from `config`; the valued `auth --identity` deleted now that `set identity` exists; `configuration.md` tables split                                                                                                                 |

Dependency on the facade's second part (writers on the seam, `dry-run-facade.md`): none blocking. The verbs call the writers, and the writers own the dry run either way; landing the facade first means the verbs are wired once and their `--dry-run` tests pin the tree-diff output from the start.

## Open questions

1. `del` and `unset` are two verbs so a forgotten key can never delete a profile; the brief said `del <key>`. Recommended: keep them apart (`unset`).
2. Does `agent profile add` with no mode flag keep `agent init`'s Direct-vs-proxy probe for the default? Recommended: yes for the default only, since it is the first command a new install runs; a named profile keeps today's rule (no flag re-wires an existing one, a new one needs the flag).
3. Is bare `agent profile` the list, or the default's `show`? Recommended: the list, since `agent profile show` is one word away and the table is what you look at most.
4. Is `settings-for` still a public verb now that the launcher reaches it in-process? Recommended: keep it; it is the one way to get the Claude settings path from a script.
5. Does the valued `--identity <id>` / `--identity auto` survive on `auth`, or is `set identity` / `unset identity` its only spelling? Recommended: only the bare interactive `--identity` stays on `auth`; the valued forms go once `set identity` runs the same probe-backed pin.
6. May the default profile hold its own override of a profile-default key (`agent profile set proxy.small-model X` with no name)? Recommended: yes, the default is a profile like any other and its section already exists.
7. Do `start`, `stop`, `proxy-token`, `launch`, `health`, `models`, `env`, `mcp` keep `--profile <name>`, or move under `agent profile <name> start`? Recommended: keep the flag; they operate a runtime for a profile rather than manage it.
8. Is `get [<key>]` wanted on `profile`, or does `show` cover reads? Recommended: add `get`, it mirrors `config get` and scripts need one value without a table.
9. The brief lists `agent status` as unchanged, but no such command exists; `profile list`, `start --check`, and `health` cover it. Recommended: do not add one.
10. Does `agent mobile` earn a top-level command, or is the Codex desktop pairing flow deleted? Recommended: keep it as `agent mobile`; it is used and touches no profile state.
11. A profile whose name becomes a verb (`sync`, `auth`, ...): does the migration rename it to an unused `<name>-<n>`, or delete it and print the re-create command (losing its preferences, daemon usage history, and hand-added settings)? Recommended: rename; a migration cannot refuse, since `agent update` flips to the new binary before it runs (`src/autoupdate/apply.ts`).
