# Configuration

`agent config` is the typed preference store, and this page is its reference: every key, its default, and what it changes. Every read site applies the same precedence: **explicit flag/env (per-invocation) > stored config > built-in default**. The commands that read these keys are on the [usage page](usage.md).

```bash
agent config --get                    # print all preferences
agent config --set auto-start true    # set one
agent config --del idle-timeout       # revert one to its default
```

## Proxy daemon

| Key                     | Default           | Effect                                                                  |
| ----------------------- | ----------------- | ----------------------------------------------------------------------- |
| `auto-start`            | `false`           | Managed proxy lifecycle: auto-start on agent open + idle auto-stop      |
| `idle-timeout`          | `3600`            | Idle auto-stop window in seconds (`0` disables)                         |
| `min-port` / `max-port` | `1024` / `65535`  | Allowed proxy port range                                                |
| `port`                  | `4141`            | Default proxy port (then next free unless `strict-port`)                |
| `proxy-logs`            | `false`           | Proxy request logging under `<home>/logs` (`false` discards the writes) |
| `proxy-version`         | latest (floated)  | Pin the floated proxy to a version/tag                                  |
| `release-cooldown`      | `604800` (7 days) | Proxy float supply-chain cooldown in seconds                            |
| `strict-port`           | `false`           | Fail `start` when the default port is busy instead of auto-incrementing |

`auto-start` and `idle-timeout` are the [managed lifecycle](usage.md#managed-proxy-lifecycle-auto-start); `proxy-version` and `release-cooldown` are the [proxy float](#environment-overrides).

## Proxy features

| Key                            | Default      | Effect                                                                          |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| `alpha-search-codex-priority`  | `true`       | Prefer Codex for the proxy's `/alpha/search` endpoint                           |
| `alpha-search-model`           | `gpt-5-mini` | Native-Responses model for `/alpha/search` when the requested one cannot run it |
| `claude-auto-model`            | unset        | Model override for Claude Code's background security-monitor requests           |
| `claude-token-multiplier`      | `1.15`       | Multiplier the proxy applies when estimating Claude token usage                 |
| `message-websearch-model`      | `gpt-5-mini` | Web-search model id for the proxy's Messages path and the MCP `web_search`      |
| `messages-api`                 | `true`       | Proxy Messages-API (Anthropic-shaped) endpoint                                  |
| `responses-context-management` | `false`      | Proxy Responses-API server-side context management                              |
| `responses-websearch`          | `true`       | Proxy Responses-API web search                                                  |
| `responses-websocket`          | `true`       | Proxy Responses-API transport: WebSocket vs HTTP/SSE                            |
| `small-model`                  | `gpt-5-mini` | Small/fast model id the proxy uses                                              |

**Proxy-side keys** are projected into the proxy's own `config.json` at `agent start`, so changing one needs a daemon restart. That file sits in the daemon's profile home, `~/.local/share/copilot-env/profiles/<name>/config.json`, with `default` as the default profile's name.

- The keys: `small-model`, the `responses-*` and `messages-api` flags, `message-websearch-model`, the `alpha-search-*` pair, `claude-auto-model`, `claude-token-multiplier`.
- One exception: the MCP `web_search` tool reads `message-websearch-model` fresh on every call ([web search](usage.md#web-search-for-claude-code)).

## Credential

| Key              | Default                       | Effect                                                                                |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `integration-id` | `auto` (probe per credential) | Pin the Copilot client identity (`Copilot-Integration-Id`)                            |
| `passthrough`    | `auto`                        | PAT passthrough: `auto` / `on` / `off`                                                |
| `static-key`     | `none`                        | Whose config carries the credential value itself: `none` / `claude` / `codex` / `all` |

`integration-id` is surveyed and pinned by `agent auth --identities` / `--identity` ([client identity](authentication.md#client-identity)); `passthrough` is explained under [PAT passthrough](authentication.md#pat-passthrough) and `static-key` under [static key](authentication.md#static-key).

## Codex

| Key                   | Default | Effect                                                                    |
| --------------------- | ------- | ------------------------------------------------------------------------- |
| `codex-host`          | `false` | Per-host `CODEX_HOME` symlink farm, exported by `agent env` (Linux/macOS) |
| `codex-model-catalog` | `false` | Patched Codex model catalog serving Copilot's real context windows        |

### Codex model catalog

`codex-model-catalog` applies at the next Codex auth refresh (within ~5 minutes) or the next `agent codex` / `agent init` wiring. Turning it off also removes the generated `codex-model-catalog.json` and the managed `model_catalog_json` reference from the Codex config.

What the generated catalog holds:

- every model the installed `codex` bundles, with every field it ships, plus GitHub Copilot's real context window and prompt cap where Copilot serves the model;
- the OpenAI-family models Copilot serves on `/responses` that this Codex does not bundle, for example `gpt-5.3-codex`, `gpt-5.6-sol-fast`, or `gpt-6-astra` on an older Codex. They are added as clones of their closest bundled relative, with Copilot's name, limits, and reasoning levels, so they appear in Codex's model picker.

Codex parses that file strictly and treats it as a replacement for its bundled catalog. A Codex build that requires a field the file lacks fails at startup with `failed to parse model_catalog_json path ...`.

copilot-env guards the installed `codex`: before writing or referencing a catalog it asks that binary to parse it, and a catalog it rejects is left out of the config.

Other Codex consumers sharing `~/.codex`, such as an IDE extension's own codex-core or a desktop app, cannot be probed. If one reports that error, run `agent codex` to regenerate from the installed CLI, or `agent config --set codex-model-catalog false` to remove the catalog.

### Per-host CODEX_HOME

`codex-host` (Linux/macOS) is the per-host `CODEX_HOME` symlink farm switch. Setting it is refused on Windows.

```bash
agent config --set codex-host true    # false removes the farm again
```

- What builds the farm, what it holds, and what removes it are in the [write list](getting-started.md#what-a-wiring-pass-writes).
- `agent env` exports `CODEX_HOME` only while a wiring pass has built and activated the farm and the key is not off.
- `agent codex --check` / `agent health` report any drift between the key and the disk.

## Claude

| Key              | Default | Effect                                                                        |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `claude-desktop` | `true`  | Keep Claude Desktop's config library wired while the app is installed         |
| `wire-mcp`       | `true`  | Wire the copilot-env MCP server + WebSearch deny into Claude on direct writes |

`wire-mcp` is the opt-out for [web search](usage.md#web-search-for-claude-code).

### Claude Desktop

`claude-desktop` applies at the next `agent init`, `agent claude`, or `agent profile` wiring. Setting the key writes no Desktop file itself. After a wiring pass, quit and reopen Claude Desktop: it reads everything below at launch only, and lands on the GitHub Copilot gateway with no sign-in chooser.

One exception: a configuration you applied in the app yourself stays applied, since a wire never displaces it. `agent claude --check` names it, and the switch is `Developer > Configure Third-Party Inference...`.

| Setting                                             | Why                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the gateway entry, one per wired default or profile | provider `gateway`, credential from a helper script or the [static key](authentication.md#static-key), the model list (first row = default model, newest of the most capable family), the `copilot-env` MCP server |
| `"deploymentMode": "3p"`                            | the app boots third-party instead of asking "Continue with Gateway" or "sign in with Claude.ai"; other keys in the file are kept                                                                                   |
| `{"allowDevTools": true}`                           | the Developer menu, where saved entries are switched (`Developer > Configure Third-Party Inference...`)                                                                                                            |

The files these land in, what writes and removes them, and where they sit on each platform are in the [wiring write list](getting-started.md#what-a-wiring-pass-writes).

- **On:** a wiring pass ends with `Claude Desktop is ready to use.` once the default entry is wired, applied, and the app boots third-party; which passes write what is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Off:** the default entry stays in place as yours, named once and never rewritten; only `agent uninstall` removes it. What the same writes remove is in the [write list](getting-started.md#what-a-wiring-pass-writes).
- **Drift:** `agent claude --check` and `agent health` report an entry missing or stale with the key on, profile entries left behind after turning it off, which entry the app applies, and whether it will show the sign-in chooser or lacks the Developer menu.

## Shell

| Key         | Default | Effect                                                                            |
| ----------- | ------- | --------------------------------------------------------------------------------- |
| `launchers` | `false` | Define the `cl` / `co` / `cx` (+ `clx` / `cox` / `cxx`) functions via `agent env` |

The functions are described under [launchers](usage.md#launchers).

## Updates

| Key                 | Default                             | Effect                                                                                      |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `auto-update`       | `false`                             | Self-update once a day on `agent start` (`agent update --auto-status` shows the last check) |
| `update-cooldown`   | none by hand, `7` for `auto-update` | `agent update` cooldown in days; a release must be this old to be adopted                   |
| `verify-provenance` | `true`                              | Verify `agent update` downloads against the release's Sigstore attestation                  |

What `agent update` verifies is under [updating](getting-started.md#updating).

## Cost

| Key              | Default                               | Effect                                                                                                                                                            |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing-url`    | `https://openrouter.ai/api/v1/models` | OpenRouter models API URL `agent cost` prices at (`agent cost --pricing-url` overrides one run)                                                                   |
| `credits-target` | none                                  | Copilot AI credits (100 to the dollar) to stay under per month; `agent credits` paces against it (`COPILOT_CREDITS_TARGET` or `agent credits --target` overrides) |

What `agent cost` reads and stores is under [cost reporting](usage.md#cost-reporting).

## Environment overrides

copilot-env loads local defaults from root `.env` when running its TypeScript entry points. Already-set shell variables win over that file, and env vars win over stored `agent config` values.

- `COPILOT_API_IDLE_TIMEOUT=<seconds>`: the managed-lifecycle idle window for this invocation. Beats the `idle-timeout` config key.
- `COPILOT_API_VERSION=<version|tag>`: pin the proxy to a release, bypassing the cooldown and float bounds at install. `agent start` still refuses a proxy below the version floor, and the `proxy-version` config key is the persistent equivalent.
- `COPILOT_API_MIN_RELEASE_AGE=<seconds>`: the cooldown window (`0` = no cooldown). Beats the `release-cooldown` config key.

Without a pin, the proxy float reads npm publish times, picks the newest version at least the cooldown window old, and clamps it to the bounds in `copilot-env.config`. The window is the env var, else `release-cooldown`, else the 7-day default that tracks `deno.json`'s `minimumDependencyAge`.
