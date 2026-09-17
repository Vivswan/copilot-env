---
title: Configuration
group: Reference
order: 3
---

# Configuration

`agent config` is the typed preference store, and this page is its reference: every key, its scope, its default, and what it changes. The commands that read these keys are on the [usage page](usage.md).

```bash
agent config --get                                 # print all preferences (the default profile's view)
agent config --set daemon.auto-start true          # set one
agent config --del daemon.idle-timeout             # revert one to its default
agent config --set identity copilot-developer-cli --profile work   # a profile key, for one profile
agent config --get proxy.small-model --profile work                # what that profile's daemon uses
```

## Scope and precedence

Every key has one scope:

| Scope             | Meaning                                                                                                          | Where it is stored                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `profile`         | The value follows the credential. `default` is a profile like any other; `--set` without `--profile` targets it. | The profile's section only, never the global map         |
| `profile-default` | The global value is every profile's default; a profile may override it with `--profile <name>`.                  | The global map, or the profile's section when overridden |
| `global`          | How this machine runs. `--set` / `--del` refuse `--profile` for it; `--get --profile` shows the global value.    | The global map only                                      |

Every read resolves one way: **explicit flag or env (per invocation) > the profile's own value > the global value > the built-in default**, each layer only where the key's scope admits it (a `global` key never resolves from a profile's section).

`agent config` prints the store under two banners. `PROFILE <name>` holds every key that profile's daemon and wiring
consume: its `profile` keys, then the `profile-default` groups with the value this profile resolves to. `GLOBAL` holds
the `global` keys only.

A `profile-default` row names where its value came from. Set without `--profile` it is starred `(global)`; set by the
profile itself it is starred `(overrides global <v>)`, or `(overrides the default <v>)` when the global map has no
value; set at neither level it is unstarred.

The key names below are also the stored JSON keys in `~/.local/share/copilot-env/state.json`, under `global` and `profiles.<name>`, beside the state keys the commands write into the same maps (a profile's credential slot, the Codex catalog throttle). Which a key is, is a per-key fact: `agent config --set` and `--del` refuse a state key by name, naming the command that owns it. The file's third map, `ownership`, is the wiring commands' ledger of the files they wrote.

## profile

| Key           | Scope     | Default                       | Effect                                                                                                                                                                                      |
| ------------- | --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `profile` | `auto`                        | The Copilot API host every mode uses (Direct configs, Claude Desktop, the proxy, every probe): `auto` probes per credential, or an `https://` origin (a GitHub Enterprise Server host, say) |
| `identity`    | `profile` | `auto` (probe per credential) | Pin the Copilot client identity (`Copilot-Integration-Id`)                                                                                                                                  |
| `passthrough` | `profile` | `auto`                        | PAT passthrough: `auto` / `on` / `off`                                                                                                                                                      |
| `static-key`  | `profile` | `none`                        | Whose config carries the credential value itself: `none` / `claude` / `codex` / `all`                                                                                                       |

`identity` is surveyed and pinned by `agent auth --identities` / `--identity` ([client identity](authentication.md#client-identity)), per profile; `passthrough` is explained under [PAT passthrough](authentication.md#pat-passthrough) and `static-key` under [static key](authentication.md#static-key).

### Copilot host

`auto` resolves the host per credential. The client identity is settled first (`identity`, probed on `https://api.githubcopilot.com` as before), then one `GET /models` under that identity's headers decides:

- the account's designated host (`endpoints.api` of `api.github.com/copilot_internal/user`, one of `api.individual.` / `api.business.` / `api.enterprise.githubcopilot.com`) when it answers 403, 404, 5xx, or fails at the network level; a PAT's identity is then probed again on that host;
- `https://api.githubcopilot.com` again when that lookup fails too;
- `https://api.githubcopilot.com` on any other answer: 2xx serves, 400 is an identity rejection and 401 a bad token (identical on every host), a transient 408 or 429 says nothing about the host.

A literal `https://` origin skips the probe (a GitHub Enterprise Server serves Copilot at `https://copilot-api.<ghe-domain>`). Either way one host serves everything after the identity probe:

- the Direct `base_url` / `ANTHROPIC_BASE_URL` and the Claude Desktop gateway;
- the proxy daemon's upstream (a pinned daemon ignores an inherited `COPILOT_API_ENTERPRISE_URL`);
- every catalog, discovery, smoke, and web-search request.

A Direct profile slot (`profiles.<name>` in `~/.local/share/copilot-env/state.json`) holds the probed identity and host as state. A credential landing (`agent profile --add`, `agent auth --profile <name>`, a settings import) writes it; every re-render reads it, with no request and no read of the agent files, which are outputs.

| event                                                                                                         | the slot's Direct pair                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a re-render (`agent profile --sync`, `--settings-for`, the `cl --profile` hook, the Claude Desktop reconcile) | bakes `identity` pin ?? slot identity and `host` literal ?? slot host: no request while the pair is stored; a missing pair is landed once through the landing path (the Desktop reconcile alone never lands, it names the repair) |
| a credential write                                                                                            | takes the previous credential's pair with it                                                                                                                                                                                      |
| a named profile's next re-render after that                                                                   | probes once and stores the new pair                                                                                                                                                                                               |
| the default's next `agent codex` or `agent claude` after that                                                 | lands BOTH agents and says so: the default's pair is stored only together with both agents' files. The Claude Desktop reconcile leaves a pair-less Direct entry alone and names that repair                                       |
| a Direct landing with no resolvable credential                                                                | refused before any write (`agent auth` first): a selection made without one would store the fallback identity and host                                                                                                            |
| a pin or literal set or cleared                                                                               | applies at the next re-render; it renders over the slot and never enters it, so the slot keeps only what a probe answered (a half never probed under an overlay is probed once when the overlay is cleared)                       |

The default profile is one mode for both agents. Its recorded mode has one writer: a landing that succeeded for both agents.

- `agent init`: no flag probes both agents first and lands one mode (the proxy when they disagree); `--direct|--proxy` lands that mode for both.
- `agent settings --import` of a bundle naming both agents, or one Direct agent on a Direct default whose stored pair is incomplete or whose credential the import replaces (the plan names both files).
- The first `agent codex` / `agent claude` / launcher write on a default with no record yet, or on a Direct default whose stored pair is incomplete: it lands both agents and says so. Whether a write lands is decided by the stored pair alone; a pin or literal renders over the pair and never decides it.

A failed write leaves the previous record and names the agent that did not move. With a mode recorded and its pair stored, `agent codex` or `agent claude` is a re-render of it: no flag or the recorded flag renders the slot's pair (no probe); a flag naming the other mode is refused before any file is written.

`agent auth --identities` shows the hosts as columns and marks the one in use.

Applies at the next wiring pass (`agent init`, `agent codex`, `agent claude`, `agent profile`) and the next proxy start.

## daemon

| Key                                   | Scope    | Default           | Effect                                                                  |
| ------------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------- |
| `daemon.auto-start`                   | `global` | `false`           | Managed proxy lifecycle: auto-start on agent open + idle auto-stop      |
| `daemon.idle-timeout`                 | `global` | `3600`            | Idle auto-stop window in seconds (`0` disables)                         |
| `daemon.min-port` / `daemon.max-port` | `global` | `1024` / `65535`  | Allowed proxy port range                                                |
| `daemon.port`                         | `global` | `4141`            | Default proxy port (then next free unless `daemon.strict-port`)         |
| `daemon.logs`                         | `global` | `false`           | Proxy request logging under `<home>/logs` (`false` discards the writes) |
| `daemon.version`                      | `global` | latest (floated)  | Pin the floated proxy to a version/tag                                  |
| `daemon.release-cooldown`             | `global` | `604800` (7 days) | Proxy float supply-chain cooldown in seconds                            |
| `daemon.strict-port`                  | `global` | `false`           | Fail `start` when the default port is busy instead of auto-incrementing |

`daemon.auto-start` and `daemon.idle-timeout` are the [managed lifecycle](usage.md#managed-proxy-lifecycle-auto-start); `daemon.version` and `daemon.release-cooldown` are the [proxy float](#environment-overrides).

## proxy

| Key                                  | Scope             | Default      | Effect                                                                          |
| ------------------------------------ | ----------------- | ------------ | ------------------------------------------------------------------------------- |
| `proxy.alpha-search.codex-priority`  | `profile-default` | `true`       | Prefer Codex for the proxy's `/alpha/search` endpoint                           |
| `proxy.alpha-search.model`           | `profile-default` | `gpt-5-mini` | Native-Responses model for `/alpha/search` when the requested one cannot run it |
| `proxy.claude-auto-model`            | `profile-default` | unset        | Model override for Claude Code's background security-monitor requests           |
| `proxy.claude-token-multiplier`      | `profile-default` | `1.15`       | Multiplier the proxy applies when estimating Claude token usage                 |
| `proxy.message-websearch-model`      | `profile-default` | `gpt-5-mini` | Web-search model id for the proxy's Messages path and the MCP `web_search`      |
| `proxy.messages-api`                 | `profile-default` | `true`       | Proxy Messages-API (Anthropic-shaped) endpoint                                  |
| `proxy.responses.context-management` | `profile-default` | `false`      | Proxy Responses-API server-side context management                              |
| `proxy.responses.websearch`          | `profile-default` | `true`       | Proxy Responses-API web search                                                  |
| `proxy.responses.websocket`          | `profile-default` | `true`       | Proxy Responses-API transport: WebSocket vs HTTP/SSE                            |
| `proxy.small-model`                  | `profile-default` | `gpt-5-mini` | Small/fast model id the proxy uses                                              |

**The `proxy.*` keys** are projected into the proxy's own `config.json` at `agent start`, resolved for the daemon's profile, so changing one needs that daemon restarted. That file sits in the daemon's profile home, `~/.local/share/copilot-env/profiles/<name>/config.json`, with `default` as the default profile's name.

- One exception: the MCP `web_search` tool reads `proxy.message-websearch-model` fresh on every call ([web search](usage.md#web-search-for-claude-code)).

## codex

| Key                   | Scope    | Default | Effect                                                                                                                                                                               |
| --------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex.home`          | `global` | `auto`  | Root of the Codex home copilot-env writes and `agent env` exports; `auto` is `~/.codex`, or the shell's `CODEX_HOME` while `codex.host` is off (never copilot-env's own farm export) |
| `codex.host`          | `global` | `false` | Per-host `CODEX_HOME` symlink farm under it, exported by `agent env` (Linux/macOS)                                                                                                   |
| `codex.model-catalog` | `global` | `false` | Patched Codex model catalog serving Copilot's real context windows                                                                                                                   |

### Codex model catalog

`codex.model-catalog` applies at the next Codex auth refresh (within ~5 minutes) or the next `agent codex` / `agent init` wiring. Turning it off also removes the generated `codex-model-catalog.json` and the managed `model_catalog_json` reference from the Codex config.

What the generated catalog holds:

- every model the installed `codex` bundles, with every field it ships, plus GitHub Copilot's real context window and prompt cap where Copilot serves the model;
- the OpenAI-family models Copilot serves on `/responses` that this Codex does not bundle, for example `gpt-5.3-codex`, `gpt-5.6-sol-fast`, or `gpt-6-astra` on an older Codex. They are added as clones of their closest bundled relative, with Copilot's name, limits, and reasoning levels, so they appear in Codex's model picker.

Codex parses that file strictly and treats it as a replacement for its bundled catalog. A Codex build that requires a field the file lacks fails at startup with `failed to parse model_catalog_json path ...`.

copilot-env guards the installed `codex`: before writing or referencing a catalog it asks that binary to parse it, and a catalog it rejects is left out of the config.

Other Codex consumers sharing `~/.codex`, such as an IDE extension's own codex-core or a desktop app, cannot be probed. If one reports that error, run `agent codex` to regenerate from the installed CLI, or `agent config --set codex.model-catalog false` to remove the catalog.

### Per-host CODEX_HOME

`codex.host` (Linux/macOS) is the per-host `CODEX_HOME` symlink farm switch. Setting it is refused on Windows.

```bash
agent config --set codex.host true    # false removes the farm again
```

- What builds the farm, what it holds, and what removes it are in the [write list](getting-started.md#what-a-wiring-pass-writes).
- `agent env` exports `CODEX_HOME` whenever `codex.host` is on (the farm path, built or not) or `codex.home` is set (the path itself); the next wiring pass creates what is missing.
- `agent codex --check` / `agent health` report any drift between the key and the disk.

## claude

| Key               | Scope    | Default | Effect                                                                        |
| ----------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `claude.desktop`  | `global` | `true`  | Keep Claude Desktop's config library wired while the app is installed         |
| `claude.wire-mcp` | `global` | `true`  | Wire the copilot-env MCP server + WebSearch deny into Claude on direct writes |

`claude.wire-mcp` is the opt-out for [web search](usage.md#web-search-for-claude-code).

### Claude Desktop

`claude.desktop` applies at the next `agent init`, `agent claude`, or `agent profile` wiring. Setting the key writes no Desktop file itself. After a wiring pass, quit and reopen Claude Desktop: it reads everything below at launch only, and lands on the GitHub Copilot gateway with no sign-in chooser.

One exception: a configuration you applied in the app yourself stays applied, since a wire never displaces it. `agent claude --check` names it, and the switch is `Developer > Configure Third-Party Inference...`.

| Setting                                             | Why                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the gateway entry, one per wired default or profile | provider `gateway`, credential from a helper script or the [static key](authentication.md#static-key), the model list (first row = default model, newest of the most capable family), the `copilot-env` MCP server |
| `"deploymentMode": "3p"`                            | the app boots third-party instead of asking "Continue with Gateway" or "sign in with Claude.ai"; other keys in the file are kept                                                                                   |
| `{"allowDevTools": true}`                           | the Developer menu, where saved entries are switched (`Developer > Configure Third-Party Inference...`)                                                                                                            |

The files these land in, what writes and removes them, and where they sit on each platform are in the [wiring write list](getting-started.md#what-a-wiring-pass-writes).

- **On:** a wiring pass ends with `Claude Desktop is ready to use.` once the default entry is wired, applied, and the app boots third-party; which passes write what is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Off:** the default entry stays in place as yours, named once and never rewritten; only `agent uninstall` removes it. Profile entries go, each with its credential-helper scripts under `~/.local/share/copilot-env/helpers/`; what the same writes remove is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Drift:** `agent claude --check` and `agent health` report an entry missing or stale with the key on, profile entries left behind after turning it off, which entry the app applies, and whether it will show the sign-in chooser or lacks the Developer menu.

## shell

| Key               | Scope    | Default | Effect                                                                            |
| ----------------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `shell.launchers` | `global` | `false` | Define the `cl` / `co` / `cx` (+ `clx` / `cox` / `cxx`) functions via `agent env` |

The functions are described under [launchers](usage.md#launchers).

## update

| Key                        | Scope    | Default                             | Effect                                                                                      |
| -------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `update.auto`              | `global` | `false`                             | Self-update once a day on `agent start` (`agent update --auto-status` shows the last check) |
| `update.cooldown`          | `global` | none by hand, `7` for `update.auto` | `agent update` cooldown in days; a release must be this old to be adopted                   |
| `update.verify-provenance` | `global` | `true`                              | Verify `agent update` downloads against the release's Sigstore attestation                  |

What `agent update` verifies is under [updating](getting-started.md#updating).

## cost

| Key                   | Scope    | Default                               | Effect                                                                                                                                                            |
| --------------------- | -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cost.pricing-url`    | `global` | `https://openrouter.ai/api/v1/models` | OpenRouter models API URL `agent cost` prices at (`agent cost --pricing-url` overrides one run)                                                                   |
| `cost.credits-target` | `global` | none                                  | Copilot AI credits (100 to the dollar) to stay under per month; `agent credits` paces against it (`COPILOT_CREDITS_TARGET` or `agent credits --target` overrides) |

What `agent cost` reads and stores is under [cost reporting](usage.md#cost-reporting).

## Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript entry points. Already-set shell variables win over that file, and env vars win over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: the managed-lifecycle idle window for this invocation. Beats the `daemon.idle-timeout` config key.
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a release, bypassing the cooldown and float bounds at install. `agent start` still refuses a proxy below the version floor, and the `daemon.version` config key is the persistent equivalent.
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: the cooldown window (`0` = no cooldown). Beats the `daemon.release-cooldown` config key.

Without a pin, the proxy float reads npm publish times, picks the newest version at least the cooldown window old, and clamps it to the bounds in `copilot-env.config`. The window is the env var, else `daemon.release-cooldown`, else the 7-day default that tracks `deno.json`'s `minimumDependencyAge`.
