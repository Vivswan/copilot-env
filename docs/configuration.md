---
title: Configuration
group: Reference
order: 3
---

# Configuration

`agent config` is the typed preference store, and this page is its reference: every key, its scope, its default, and what it changes. The commands that read these keys are on the [usage page](usage.md).

```bash
agent config get                                   # every machine key and shared default, with its origin
agent config set daemon.auto-start true            # a machine key
agent config set daemon.auto-start=true            # the same, in one word
agent config unset daemon.idle-timeout             # back to its built-in default
agent config set proxy.small-model gpt-5           # the shared default every profile follows
agent profile set identity copilot-developer-cli   # a profile key, for the default profile
agent profile work set proxy.small-model gpt-5-codex   # work overrides the shared default
agent profile work get proxy.small-model           # what that profile's daemon uses, and where it came from
```

## Scope and precedence

Every key has one scope:

| Scope             | Meaning                                                                                                                              | Where it is stored                                           | Command                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `profile`         | The value follows the credential. `default` is a profile like any other.                                                             | The profile's section only, never the global map             | `agent profile [<name>] set\|get\|unset`                                          |
| `profile-default` | The shared default every profile follows; a named profile may override it. The default profile never carries an override of its own. | The global map, or a named profile's section when overridden | `agent config` for the shared default; `agent profile <name> set` for an override |
| `global`          | How this machine runs; a profile never carries it.                                                                                   | The global map only                                          | `agent config set\|get\|unset`                                                    |

Every read resolves one way: **explicit flag or env (per invocation) > the profile's own value > the global value > the built-in default**, each layer only where the key's scope admits it (a `global` key never resolves from a profile's section).

Both faces take `set <key> <value>` or `set <key>=<value>`, split at the first `=`, so a URL value keeps its `?a=b`.

The two faces write the same store. With no name, `agent profile set|unset|get <proxy.*|probe.*>` is an alias of `agent config set|unset|get`: the same store bytes, the same output. A machine key under `agent profile set`, or a profile key under `agent config set`, is refused with the other face's verb.

A keyless `get` lists one view. `agent config get` prints `SHARED DEFAULTS` (the `profile-default` groups as every profile inherits them) and `GLOBAL` (the `global` keys); `agent config --help` prints the same. `agent profile [<name>] get` prints `PROFILE <name>`: its `profile` keys, then the `profile-default` groups with the value this profile resolves to.

A starred row is stored. Under `PROFILE` a `profile-default` row names where its value came from: `(shared default)`, `(overrides the shared default <v>)`, or `(overrides the built-in default <v>)` when no shared default is set; an unstarred row is the built-in default. `get <key>` prints the value alone on stdout and its origin on stderr.

The key names below are also the stored JSON keys in `~/.local/share/copilot-env/state.json`, under `global` and `profiles.<name>`, beside the state keys the commands write into the same maps (a profile's credential slot, the Codex catalog throttle).

Which a key is, is a per-key fact: `set` and `unset` refuse a state key by name, naming the command that owns it. The file's third map, `ownership`, is the wiring commands' ledger of the files they wrote.

## profile

| Key           | Scope     | Default                       | Effect                             |
| ------------- | --------- | ----------------------------- | ---------------------------------- |
| `host`        | `profile` | `auto`                        | Copilot API host; auto probes it   |
| `identity`    | `profile` | `auto` (probe per credential) | Client identity; auto probes it    |
| `passthrough` | `profile` | `auto`                        | Send a PAT as-is; auto detects it  |
| `static-key`  | `profile` | `none`                        | Which agent configs bake the token |

`identity` is surveyed by `agent profile [<name>] identity` and pinned by `agent profile [<name>] set identity <id|auto>` ([client identity](authentication.md#client-identity)); `passthrough` is explained under [PAT passthrough](authentication.md#pat-passthrough) and `static-key` under [static key](authentication.md#static-key).

### Copilot host

`auto` resolves the host per credential. The client identity is settled first (`identity`, probed on `https://api.githubcopilot.com` as before), then one `GET /models` under that identity's headers decides:

- the account's designated host (`endpoints.api` of `api.github.com/copilot_internal/user`, one of `api.individual.` / `api.business.` / `api.enterprise.githubcopilot.com`) when it answers 403, 404, 5xx, or fails at the network level; a PAT's identity is then probed again on that host;
- `https://api.githubcopilot.com` again when that lookup fails too;
- `https://api.githubcopilot.com` on any other answer: 2xx serves, 400 is an identity rejection and 401 a bad token (identical on every host), a transient 408 or 429 says nothing about the host.

A literal `https://` origin skips the probe (a GitHub Enterprise Server serves Copilot at `https://copilot-api.<ghe-domain>`). Either way one host serves everything after the identity probe:

- the Direct `base_url` / `ANTHROPIC_BASE_URL` and the Claude Desktop gateway;
- the proxy daemon's upstream (a pinned daemon ignores an inherited `COPILOT_API_ENTERPRISE_URL`);
- every catalog, discovery, smoke, and web-search request.

A Direct profile slot (`profiles.<name>` in `~/.local/share/copilot-env/state.json`) holds the probed identity and host as state. A credential landing (`agent profile [<name>] add`, `agent profile <name> auth`, a settings import) writes it; every re-render reads it, with no request and no read of the agent files, which are outputs.

| event                                                                                                            | the slot's Direct pair                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a re-render (`agent profile [<name>] sync`, `agent sync`, the `cl --profile` hook, the Claude Desktop reconcile) | bakes `identity` pin ?? slot identity and `host` literal ?? slot host: no request while the pair is stored; a missing pair is landed once through the landing path (the Desktop reconcile alone never lands, it names the repair) |
| a credential write                                                                                               | takes the previous credential's pair with it                                                                                                                                                                                      |
| a named profile's next re-render after that                                                                      | probes once and stores the new pair                                                                                                                                                                                               |
| the default's next `agent profile sync` after that                                                               | lands BOTH agents and says so: the default's pair is stored only together with both agents' files. The Claude Desktop reconcile leaves a pair-less Direct entry alone and names that repair                                       |
| a Direct landing with no resolvable credential                                                                   | refused before any write (`agent profile auth` first): a selection made without one would store the fallback identity and host                                                                                                    |
| a pin or literal set or cleared                                                                                  | applies at the next re-render; it renders over the slot and never enters it, so the slot keeps only what a probe answered (a half never probed under an overlay is probed once when the overlay is cleared)                       |

The default profile is one mode for both agents. Its recorded mode comes from a landing that succeeded for both agents, or from `add` with no credential yet, which records the mode alone.

- `agent profile add`: no flag probes both agents first and lands one mode (the proxy when they disagree); `--direct|--proxy` lands that mode for both. With no credential yet, `add` records the mode alone (`--no-auth` stops there) and the landing follows the credential.
- `agent settings --import` of a bundle naming both agents, or one Direct agent on a Direct default whose stored pair is incomplete or whose credential the import replaces (the plan names both files).
- The first `agent profile sync` or launcher write on a default with no record yet, or on a Direct default whose stored pair is incomplete: it lands both agents and says so. Whether a write lands is decided by the stored pair alone; a pin or literal renders over the pair and never decides it.

A failed write leaves the previous record and names the agent that did not move. With a mode recorded and its pair stored, `agent profile sync` (with or without `--claude` / `--codex`) is a re-render of it: it renders the slot's pair with no probe and never moves the record. Changing the mode is an `agent profile add --direct|--proxy`, which lands both agents.

`agent profile identity` shows the hosts as columns and marks the one in use.

Applies at the next wiring pass (`agent profile [<name>] add` / `sync`, `agent sync`) and the next proxy start.

## daemon

| Key                       | Scope    | Default           | Effect                             |
| ------------------------- | -------- | ----------------- | ---------------------------------- |
| `daemon.auto-start`       | `global` | `false`           | Auto-start and idle-stop the proxy |
| `daemon.idle-timeout`     | `global` | `3600`            | Idle stop after N seconds; 0 never |
| `daemon.min-port`         | `global` | `1024`            | Lowest proxy port to try           |
| `daemon.max-port`         | `global` | `65535`           | Highest proxy port to try          |
| `daemon.port`             | `global` | `4141`            | Proxy port; next free one if busy  |
| `daemon.logs`             | `global` | `false`           | Proxy request log in `<home>/logs` |
| `daemon.version`          | `global` | latest (floated)  | Pin the proxy version or tag       |
| `daemon.release-cooldown` | `global` | `604800` (7 days) | Min proxy release age in seconds   |
| `daemon.strict-port`      | `global` | `false`           | Fail on a busy port, never move    |

`daemon.auto-start` and `daemon.idle-timeout` are the [managed lifecycle](usage.md#managed-proxy-lifecycle-auto-start); `daemon.version` and `daemon.release-cooldown` are the [proxy float](#environment-overrides).

## proxy

| Key                                  | Scope             | Default      | Effect                            |
| ------------------------------------ | ----------------- | ------------ | --------------------------------- |
| `proxy.alpha-search.codex-priority`  | `profile-default` | `true`       | Prefer Codex for /alpha/search    |
| `proxy.alpha-search.model`           | `profile-default` | `gpt-5-mini` | /alpha/search fallback model      |
| `proxy.claude-auto-model`            | `profile-default` | unset        | Claude security-monitor model     |
| `proxy.claude-token-multiplier`      | `profile-default` | `1.15`       | Claude token estimate multiplier  |
| `proxy.message-websearch-model`      | `profile-default` | `gpt-5-mini` | Web-search model (Messages + MCP) |
| `proxy.messages-api`                 | `profile-default` | `true`       | Prefer the native Messages API    |
| `proxy.responses.context-management` | `profile-default` | `false`      | Responses API context management  |
| `proxy.responses.websearch`          | `profile-default` | `true`       | Responses API web search          |
| `proxy.responses.websocket`          | `profile-default` | `true`       | Responses API over WebSocket      |
| `proxy.small-model`                  | `profile-default` | `gpt-5-mini` | Small/fast model the proxy uses   |

**The `proxy.*` keys** are projected into the proxy's own `config.json` at `agent start`, resolved for the daemon's profile, so changing one needs that daemon restarted. That file sits in the daemon's profile home, `~/.local/share/copilot-env/profiles/<name>/config.json`, with `default` as the default profile's name.

- One exception: the MCP `web_search` tool reads `proxy.message-websearch-model` fresh on every call ([web search](usage.md#web-search-for-claude-code)).

## codex

| Key                   | Scope    | Default | Effect                           |
| --------------------- | -------- | ------- | -------------------------------- |
| `codex.home`          | `global` | `auto`  | Codex home root; auto detects it |
| `codex.host`          | `global` | `false` | One Codex home per host (POSIX)  |
| `codex.model-catalog` | `global` | `false` | Patch the Codex model catalog    |

`codex.home` at `auto` is `~/.codex`, or the shell's own `CODEX_HOME` while `codex.host` is off (never copilot-env's farm export); `codex.host` builds its farm under whichever `codex.home` resolves to.

### Codex model catalog

`codex.model-catalog` applies at the next `agent profile add` / `sync` wiring or the next default-profile launch (`cl` / `cx` on a proxy default, or a direct `cx`); `cx --profile <name>` never refreshes it. Credential printing (`agent profile auth --get`, `agent profile proxy-token`) never refreshes the catalog or rewrites an agent file. Turning it off also removes the generated `codex-model-catalog.json` and the managed `model_catalog_json` reference from the Codex config.

What the generated catalog holds:

- every model the installed `codex` bundles, with every field it ships, plus GitHub Copilot's real context window and prompt cap where Copilot serves the model;
- the OpenAI-family models Copilot serves on `/responses` that this Codex does not bundle, for example `gpt-5.3-codex`, `gpt-5.6-sol-fast`, or `gpt-6-astra` on an older Codex. They are added as clones of their closest bundled relative, with Copilot's name, limits, and reasoning levels, so they appear in Codex's model picker.

Codex parses that file strictly and treats it as a replacement for its bundled catalog. A Codex build that requires a field the file lacks fails at startup with `failed to parse model_catalog_json path ...`.

copilot-env guards the installed `codex`: before writing or referencing a catalog it asks that binary to parse it, and a catalog it rejects is left out of the config.

Other Codex consumers sharing `~/.codex`, such as an IDE extension's own codex-core or a desktop app, cannot be probed. If one reports that error, run `agent profile sync --codex` to regenerate from the installed CLI, or `agent config set codex.model-catalog false` to remove the catalog.

### Per-host CODEX_HOME

`codex.host` (Linux/macOS) is the per-host `CODEX_HOME` symlink farm switch. Setting it is refused on Windows.

```bash
agent config set codex.host true    # false removes the farm again
```

- What builds the farm, what it holds, and what removes it are in the [write list](getting-started.md#what-a-wiring-pass-writes).
- `agent profile env` exports `CODEX_HOME` whenever `codex.host` is on (the farm path, built or not) or `codex.home` is set (the path itself); the next wiring pass creates what is missing.
- `agent profile check --codex` / `agent health` report any drift between the key and the disk.

## claude

| Key               | Scope    | Default | Effect                            |
| ----------------- | -------- | ------- | --------------------------------- |
| `claude.desktop`  | `global` | `true`  | Also wire Claude Desktop          |
| `claude.wire-mcp` | `global` | `true`  | Give Claude Code web search (MCP) |

`claude.wire-mcp` is the opt-out for [web search](usage.md#web-search-for-claude-code).

### Claude Desktop

`claude.desktop` applies at the next `agent profile [<name>] add` / `sync` or `agent sync` wiring. Setting the key writes no Desktop file itself. After a wiring pass, quit and reopen Claude Desktop: it reads everything below at launch only, and lands on the GitHub Copilot gateway with no sign-in chooser.

One exception: a configuration you applied in the app yourself stays applied, since a wire never displaces it. `agent profile check --claude` names it, and the switch is `Developer > Configure Third-Party Inference...`.

| Setting                                             | Why                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the gateway entry, one per wired default or profile | provider `gateway`, credential from a helper script or the [static key](authentication.md#static-key), the model list (first row = default model, newest of the most capable family), the `copilot-env` MCP server |
| `"deploymentMode": "3p"`                            | the app boots third-party instead of asking "Continue with Gateway" or "sign in with Claude.ai"; other keys in the file are kept                                                                                   |
| `{"allowDevTools": true}`                           | the Developer menu, where saved entries are switched (`Developer > Configure Third-Party Inference...`)                                                                                                            |

The files these land in, what writes and removes them, and where they sit on each platform are in the [wiring write list](getting-started.md#what-a-wiring-pass-writes).

- **On:** a wiring pass ends with `Claude Desktop is ready to use.` once the default entry is wired, applied, and the app boots third-party; which passes write what is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Off:** the default entry stays in place as yours, named once and never rewritten; only `agent uninstall` removes it. Profile entries go, each with its credential-helper scripts under `~/.local/share/copilot-env/helpers/`; what the same writes remove is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Drift:** `agent profile check --claude` and `agent health` report an entry missing or stale with the key on, profile entries left behind after turning it off, which entry the app applies, and whether it will show the sign-in chooser or lacks the Developer menu.

## probe

| Key                  | Scope             | Default                                                                                                 | Effect                            |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `probe.claude-model` | `profile-default` | unset tries the claude CLI's `haiku` alias, then the newest claude model in the catalog                 | Claude model for the Direct probe |
| `probe.codex-model`  | `profile-default` | unset prefers a reduced GPT tier (`mini`, `nano`) from the catalog, else its first codex-servable model | Codex model for the Direct probe  |

The Direct probe behind `auto` (`agent profile add` with neither `--direct` nor `--proxy`; a re-render of a recorded mode never probes) runs each CLI's read-only smoke prompt against a throwaway Direct config. A set value is the model that prompt runs, sent as-is: no alias, no catalog check.

```bash
agent config set probe.claude-model claude-sonnet-5
```

Unset, the claude smoke runs `--model haiku` (the CLI resolves its own alias, so it sends no reasoning-effort field a Copilot model may lack) and, should Copilot reject that model, the newest claude model in the catalog once; any other failure stops with its reason.

## shell

| Key               | Scope    | Default | Effect                       |
| ----------------- | -------- | ------- | ---------------------------- |
| `shell.launchers` | `global` | `false` | Shell launchers cl / co / cx |

The functions are described under [launchers](usage.md#launchers).

## update

| Key                        | Scope    | Default                             | Effect                             |
| -------------------------- | -------- | ----------------------------------- | ---------------------------------- |
| `update.auto`              | `global` | `false`                             | Daily self-update on agent start   |
| `update.cooldown`          | `global` | none by hand, `7` for `update.auto` | Update only to releases N days old |
| `update.verify-provenance` | `global` | `true`                              | Sigstore-verify update downloads   |

What `agent update` verifies is under [updating](getting-started.md#updating); `agent update --auto-status` shows the last check `update.auto` made.

## cost

| Key                       | Scope    | Default                                                                                         | Effect                         |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| `cost.pricing-url`        | `global` | `https://openrouter.ai/api/v1/models`                                                           | OpenRouter models API URL      |
| `cost.github-pricing-url` | `global` | `https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml` | GitHub's Copilot rate card URL |
| `cost.credits-target`     | `global` | none                                                                                            | Monthly credits to stay under  |

What `agent cost` reads and stores is under [cost reporting](usage.md#cost-reporting).

## Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript entry points. Already-set shell variables win over that file, and env vars win over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: the managed-lifecycle idle window for this invocation. Beats the `daemon.idle-timeout` config key.
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a release, bypassing the cooldown and float bounds at install. `agent start` still refuses a proxy below the version floor, and the `daemon.version` config key is the persistent equivalent.
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: the cooldown window (`0` = no cooldown). Beats the `daemon.release-cooldown` config key.
- `COPILOT_CREDITS_TARGET=<credits>`: the monthly credits `agent credits` paces against. Beats the `cost.credits-target` config key; `agent credits --target` beats both for one run.

Without a pin, the proxy float reads npm publish times, picks the newest version at least the cooldown window old, and clamps it to the bounds in `copilot-env.config`. The window is the env var, else `daemon.release-cooldown`, else the 7-day default that tracks `deno.json`'s `minimumDependencyAge`.
