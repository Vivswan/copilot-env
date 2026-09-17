---
title: Architecture
group: Internals
order: 1
---

# Architecture

How copilot-env's code is arranged: the decisions a reader would otherwise reverse, each as one diagram over real files, then the layer map. Not a user guide (the other pages are), and the checks behind it prove existence only: every path a box names exists, every symbol after a path is exported by that file, and every `Demonstrated by:` link resolves. No check tests the claim a diagram makes.

Every concept diagram starts at what the flow reads and ends at what it writes or launches. A cylinder is a file or store on this machine, a double-edged box is a network endpoint or a process, and a plain box is code; `{name}`, `{host}`, `{top}` stand for the profile, the Copilot host, and the install root.

## The two wiring modes and the one credential

```mermaid
flowchart TD
  credfile[("~/.local/share/copilot-env/credentials.json")]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  store["src/copilot_api/env_state.ts<br>CopilotEnvState StoredCredential ProvisionedCredential"]
  cred["src/copilot_api/credential.ts<br>Credential"]
  wiring["src/agents/configure.ts<br>resolveCredentialWiring() CredentialWiring ManagedMode ManagedWrite"]
  resolver["src/utils/root.ts<br>agentAuthGetArgs() proxyTokenCommand()"]
  direct["Direct: the agent config names the Copilot host and a resolver command"]
  proxy["proxy: the agent config names the local daemon, which holds the token in memory"]
  daemon["src/copilot_api/launch.ts<br>resolveLaunchCredential() DaemonLaunchAuth"]
  proxycfg[("~/.local/share/copilot-env/profiles/{name}/config.json<br>the daemon's own auth.apiKeys")]
  codexw["src/codex/config.ts<br>configureCodexConfig()"]
  claudew["src/claude/config.ts<br>configureClaudeConfig()"]
  codexfile[("~/.codex/config.toml")]
  claudefile[("~/.claude/settings.json")]
  daemonenv[["the daemon's env: COPILOT_ENV_DAEMON_GH_TOKEN, COPILOT_ENV_DAEMON_INTEGRATION_ID, COPILOT_ENV_DAEMON_COPILOT_HOST"]]
  credfile -->|"reads the slot: gh-cli, a stored token, or none"| store
  prefs -->|"reads static-key"| wiring
  proxycfg -->|"static-key on a proxy write: ensureApiKey() reads a key, minting one when absent"| wiring
  store --> cred
  cred -->|"resolve(): the token, or null for a none slot"| wiring
  wiring -->|"kind command"| resolver
  wiring -->|"mode direct"| direct
  wiring -->|"mode proxy"| proxy
  direct -->|"base_url https://{host}, http_headers with the Copilot-Integration-Id"| codexw
  direct -->|"the host, plus env.ANTHROPIC_CUSTOM_HEADERS"| claudew
  proxy -->|"base_url http://127.0.0.1:{port}/v1"| codexw
  proxy -->|"the loopback base URL"| claudew
  codexw -->|"writes model_providers.copilot-env: base_url, http_headers, auth.command"| codexfile
  claudew -->|"writes env.ANTHROPIC_BASE_URL and apiKeyHelper"| claudefile
  cred --> daemon
  daemon -->|"DaemonCredential: the token rides in env, spliced into argv in-process"| daemonenv
```

- **No implicit `gh` fallback:** a `none` slot resolves to null and the caller asks (`agent auth`); a named profile's reason names the profile.
- **`static-key` is the one opt-in that bakes the value:** `resolveCredentialWiring()` resolves it once per agent at the write, and the file then carries the value (`http_headers.Authorization` for Codex, `env.ANTHROPIC_AUTH_TOKEN` for Claude) instead of the resolver command. An unresolvable static credential is a failed write, never a silent return to the command shape.

Demonstrated by: [test/configure.test.ts](../test/configure.test.ts), [test/auth.test.ts](../test/auth.test.ts), [test/codex_config.test.ts](../test/codex_config.test.ts).

## Identity and host: one pair, one replay rule

```mermaid
flowchart TD
  prefs[("~/.local/share/copilot-env/preferences.json")]
  slotin[("~/.local/share/copilot-env/credentials.json<br>the profile slot, as last written")]
  models[["GET https://{host}/models"]]
  user[["GET https://api.github.com/copilot_internal/user"]]
  config["src/copilot_api/env_config.ts<br>CopilotEnvConfig"]
  rule["src/copilot_api/env_state.ts<br>replayableIdentity() ReplayableIdentity CachedCopilotHost expectedDirectHost()"]
  persist["src/agents/profile_wiring.ts<br>resolveAndPersistDirectWiring()"]
  probe["src/codex/config.ts<br>probeDirectWiring()"]
  select["src/copilot_api/integration_identity.ts<br>selectDirectIdentityAndHost() selectPassthroughIdentityAndHost() IdentityAndHost probeIntegrationIdentityCached()"]
  launch["src/copilot_api/launch.ts<br>resolveLaunchCredential()"]
  slotout[("~/.local/share/copilot-env/credentials.json<br>the profile slot, rewritten")]
  prefs -->|"reads integration-id, copilot-host"| config
  slotin -->|"reads integrationIdentity, copilotHost, copilotHostIdentity, copilotHostSource"| rule
  config -->|"integration-id pin, copilot-host literal"| rule
  rule -->|"replay: bake the cached pair, no request"| persist
  rule -->|"preferred or probe"| probe
  probe --> select
  models -->|"first 2xx wins, per identity, on the host in use"| select
  user -->|"endpoints.api: the account's designated host"| select
  select -->|"identity on the host in use, then the host under it, then re-select where auto moved"| persist
  persist -->|"setProfileIntegrationIdentity(): writes the verdict and the host it was accepted on, keyed to the credential"| slotout
  launch -->|"the passthrough twin: the daemon's host pin"| select
```

- **The probe memo is process-lifetime and never invalidated** (`probeIntegrationIdentityCached()`): a CLI run ends in seconds, and the MCP server keeps its verdict until the transport closes. Injected I/O and a caller deadline bypass it.
- **A pin is configuration, never a verdict:** the slot keeps what it held, so `--identity auto` returns to it; a credential change clears the slot.

Demonstrated by: [test/integration_identity.test.ts](../test/integration_identity.test.ts), [test/copilot_host.test.ts](../test/copilot_host.test.ts).

## Profiles are atomic units

```mermaid
flowchart LR
  credfile[("~/.local/share/copilot-env/credentials.json")]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  slot["src/copilot_api/env_state.ts<br>ProfileSlot ProfileMode partialSlotGap() assertProfileSlot()"]
  wire["src/agents/profile_wiring.ts<br>bothAgents() wireBothAgents()"]
  adapter["src/agents/configure.ts<br>AgentAdapter"]
  claude["src/claude/config.ts<br>claudeAdapter() configureClaudeConfig()"]
  codex["src/codex/config.ts<br>codexAdapter() configureCodexConfig()"]
  claudefile[("~/.claude/settings-{name}.json<br>settings.json for the default")]
  desktop[("Claude Desktop's files: {Claude-3p data dir}/configLibrary/{uuid}.json and _meta.json, claude_desktop_config.json, developer_settings.json<br>plus the helper under ~/.local/share/copilot-env/helpers and the claim in ownership.json")]
  codexfile[("~/.codex/{name}.config.toml and ~/.codex/config.toml<br>config.toml alone for the default")]
  credfile -->|"reads profiles.{name}: credential + mode"| slot
  prefs -->|"reads claude-desktop"| claude
  slot -->|"one credential + one mode"| wire
  wire -->|"configureProfile on every adapter, even after one throws"| adapter
  adapter --> claude
  adapter --> codex
  claude -->|"writes env.ANTHROPIC_BASE_URL and the credential carrier"| claudefile
  claude -->|"reconciles the entry it owns: reads _meta.json and ownership.json, then writes the entry, its row, the claim, and the app files"| desktop
  codex -->|"writes model_provider, and the model_providers table: copilot-env-{name}, copilot-env for the default"| codexfile
```

- **No fallback** ([authentication: profiles](authentication.md#profiles) owns the rule): `Credential.resolveWithReason()` names the profile in its reason, and a launch on a partial slot reports `partialSlotGap()` instead of guessing.
- **The default is a profile too,** under the reserved `default` key. For a named profile `mode` is the truth its artifacts derive from; for the default, `mode` records what the wiring last wrote (`recordDefaultModeFromWiring()` in `src/agents/configure_defaults.ts`) and the artifacts stay the live truth.

Demonstrated by: [test/profiles.test.ts](../test/profiles.test.ts), [test/codex_profile_wiring.test.ts](../test/codex_profile_wiring.test.ts).

## The proxy floats; runtime needs are preload shims

```mermaid
flowchart LR
  registry[["GET https://registry.npmjs.org/@jeffreycao%2Fcopilot-api"]]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  float["src/proxy_float.ts<br>floatProxy() selectProxyVersion() writeResolvedVersionRecord() readResolvedVersionRecord()"]
  shims["src/copilot_api/shims.ts<br>DAEMON_SHIM_FILES shimPath() allShimPaths()"]
  spawn["src/copilot_api/process.ts<br>DaemonSpec daemonArgv() daemonEnvironment() launchDaemon()"]
  preloads["src/scripts/node_compat_preload.ts<br>src/scripts/daemon_lock_preload.ts<br>src/scripts/token_argv_preload.ts<br>src/scripts/daemon_runtime_preload.ts<br>src/scripts/copilot_host_preload.ts<br>src/scripts/pat_passthrough_preload.ts<br>src/scripts/idle_watchdog_preload.ts<br>src/scripts/log_mute_preload.ts"]
  cache[("~/.local/share/copilot-env/deno/cache<br>the daemon's DENO_DIR")]
  record[("~/.local/share/copilot-env/proxy/resolved-version.json")]
  dcfg[("~/.local/share/copilot-env/proxy/deno.json and deno.lock<br>the daemon's import map and transitive pins")]
  daemonproc[["the daemon: deno run --config ... --preload ... npm:@jeffreycao/copilot-api@{version}, COPILOT_API_HOME=~/.local/share/copilot-env/profiles/{name}"]]
  registry -->|"reads versions and publish times"| float
  prefs -->|"reads proxy-version, release-cooldown"| float
  shims -->|"every shim, warmed into the cache"| float
  float -->|"writes this build's import map, then deno cache pins the lock"| dcfg
  float -->|"deno cache: the package and the shims"| cache
  float -->|"writes the version, its DENO_DIR, the build fingerprint"| record
  record -->|"reads the daemon's entry"| spawn
  dcfg -->|"reads --config"| spawn
  shims -->|"the subset DaemonSpec derives"| spawn
  spawn -->|"--preload, in order"| preloads
  spawn -->|"launchDaemon(): COPILOT_ENV_ROOT_HOME, COPILOT_ENV_DAEMON_KEEP_PORT, --cached-only"| daemonproc
  preloads -->|"run inside it before the package's entry"| daemonproc
```

- **We never patch the package:** every shim wraps a runtime seam (`globalThis.fetch`, `fs.createWriteStream`, `process.argv`) and touches none of copilot-api's files, so none of them pins the floated version.
- **`--cached-only` at spawn gives no second chance,** which is why the float warms the cache; the spawn's subset means a credential-less daemon carries no token shim.
- **The secret-carrying shims stay import-free** (`test/lint/no_shim_imports.ts`): a runtime import would drag CLI modules into the daemon process.

Demonstrated by: [test/proxy_float.test.ts](../test/proxy_float.test.ts), [test/daemon_spawn.test.ts](../test/daemon_spawn.test.ts), [test/daemon_env_keys.test.ts](../test/daemon_env_keys.test.ts).

## The config store: flag, then stored, then default

```mermaid
flowchart LR
  flag[("an explicit flag or env var: agent update --no-verify here, COPILOT_API_VERSION for the proxy pin")]
  cmd["src/commands/config.ts<br>runConfig() configTable()"]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  store["src/copilot_api/env_config.ts<br>CopilotEnvConfig CONFIG_REGISTRY ConfigKeyDef"]
  dflt["src/copilot_api/env_config.ts<br>configDefaultValue() configDefaultBoolean() configDefaultNumber() configDefaultString()"]
  site["src/autoupdate/apply.ts<br>resolveProvenanceDecision()"]
  cmd -->|"--set, --del, --get"| store
  store -->|"set(), del(): writes the whole document"| prefs
  prefs -->|"read()"| store
  flag -->|"1. wins when given"| site
  store -->|"2. the stored value"| site
  dflt -->|"3. the built-in default"| site
```

- **Every read site applies the precedence itself;** `resolveProvenanceDecision()` is one of them, taking the flag and the resolved key as two arguments so no stage re-derives the answer.
- **`CopilotEnvConfig.read()` is strict:** an unreadable store throws, because wiring, the proxy pin, and the port knobs must never act on an unproven empty. The three accessors the daemon-side gates reach read degraded instead (`autoStartEnabled()`, `autoUpdateEnabled()`, `idleTimeoutSeconds()`): a throw there would kill the serving daemon, and their flatten is the safe direction (lifecycle off, default window, no self-update).
- **One registry** (`CONFIG_REGISTRY`) owns each key's CLI name, storage key, parser, default, and description; [docs/configuration.md](configuration.md) is pinned against it by `test/docs_config.test.ts`.

Demonstrated by: [test/env_config.test.ts](../test/env_config.test.ts), [test/update_apply.test.ts](../test/update_apply.test.ts).

## Install, update, provenance

```mermaid
flowchart TD
  assets[("the binary's embedded assets<br>materialized: the bin and shell payloads, the daemon shims<br>read in place: deno.json, .dvmrc, copilot-env.config")]
  releases[["GET https://api.github.com/repos/Vivswan/copilot-env/releases?per_page=100"]]
  download[["https://github.com/Vivswan/copilot-env/releases/download/{tag}: copilot-env-{triple} (.exe on Windows), checksums.txt, attestation.json"]]
  tuf[["https://tuf-repo-cdn.sigstore.dev: the Sigstore trust root"]]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  autostate[("{top}/.autoupdate/state.json")]
  root["src/utils/root.ts<br>rootMode() RootMode isProtectedRoot() looksLikeInstallRoot()"]
  install["src/install/installer.ts<br>buildInstallPlan() applyInstallPlan() runInstall() pointCurrentAt()"]
  update["src/commands/update.ts<br>runUpdate() recheckVerdict()"]
  preflight["src/autoupdate/preflight.ts<br>runPreflight()"]
  release["src/install/resolve-release.ts<br>resolveTarget() pickAged()"]
  apply["src/autoupdate/apply.ts<br>applyUpdate() resolveProvenanceDecision() ProvenanceDecision"]
  prov["src/install/provenance.ts<br>verifyReleaseProvenance() TUF_MIRROR_URL"]
  att["src/install/attestation.ts<br>RELEASE_SIGNER_POLICY parseStatement() assertSubjectsAttested()"]
  layout[("{top}/versions/vX.Y.Z, {top}/current, {top}/bin/agent and agent.ps1")]
  rcfile[("~/.bashrc, ~/.zshrc, or the PowerShell $PROFILE")]
  root -->|"checkout or compiled, decided once"| install
  root -->|"a checkout refuses without --force"| update
  assets -->|"reads at plan time, materializes the payloads into the version root"| install
  prefs -->|"reads auto-update, update-cooldown, verify-provenance"| preflight
  autostate -->|"reads lastCheckMs: once per cooldown"| preflight
  update --> release
  preflight --> release
  releases -->|"reads tags and publish dates"| release
  release --> apply
  download -->|"reads the binary, checksums.txt, attestation.json"| apply
  apply -->|"sha256 against checksums.txt, then the attestation"| prov
  tuf -->|"reads the trusted root"| prov
  prov --> att
  apply -->|"stage, provision with the new binary's install --assets-only, commit by flipping current"| install
  install -->|"writes versions/vX.Y.Z whole, then flips current"| layout
  install -->|"writes the block that sources agents.bashrc or agents.ps1"| rcfile
  preflight -->|"writes lastCheckMs, lastResult"| autostate
```

- **Trust on first use:** the installer never verifies the release it was fetched from (that would be circular). `agent update` proves origin with Sigstore and fails closed; `--no-verify` and the `verify-provenance` key are the two opt-outs, and the skip warning names the way back.
- **Nothing before the commit is best-effort;** past the `current` flip the install has moved forward, so `agent migrate` and the GC (one previous version kept) may fail without stranding it.

Demonstrated by: [test/installer.test.ts](../test/installer.test.ts), [test/update_apply.test.ts](../test/update_apply.test.ts), [test/provenance.test.ts](../test/provenance.test.ts).

## The launch path

```mermaid
flowchart LR
  rcfile[("~/.bashrc, ~/.zshrc, or the PowerShell $PROFILE")]
  settings[("~/.claude/settings.json<br>settings-{name}.json for a profile")]
  prefs[("~/.local/share/copilot-env/preferences.json")]
  env["src/commands/env.ts<br>launcherFunctionLines() runEnv()"]
  rc["shell/agents.bashrc<br>shell/agents.ps1"]
  bin["bin/agent<br>bin/agent.ps1"]
  cli["src/cli.ts"]
  launch["src/commands/launch.ts<br>parseLaunchAction() prepareLaunch() commandDeps() runLaunch() LaunchPlan"]
  token["src/commands/proxy_token.ts<br>resolveProxyToken() launchProxy()"]
  wire["src/agents/profile_wiring.ts<br>wireBothAgents()"]
  daemonproc[["agent start, a child, when the proxy is down"]]
  configs[("~/.codex/config.toml and ~/.claude/settings.json<br>the profile's pair for a named launch")]
  agentcli[["the agent CLI: claude, codex, or copilot, a child with inherited stdio"]]
  rcfile -->|"the copilot-env block sources it"| rc
  settings -->|"reads the wired base URL: managedClaudeBaseUrl()"| env
  prefs -->|"reads codex-home, codex-host, launchers"| env
  env -->|"the only output the agent function evals: CODEX_HOME, ANTHROPIC_BASE_URL, the cl co cx functions"| rc
  rc -->|"cl runs agent launch claude with the arguments"| bin
  bin --> cli
  cli --> launch
  launch -->|"ensureProxy"| token
  launch -->|"syncProfileWiring"| wire
  token -->|"launchProxy(): spawns it"| daemonproc
  wire -->|"rewrites"| configs
  launch -->|"LaunchPlan: command, args, env, scrub"| agentcli
```

- **The managed values are re-read after wiring, never taken from the shell:** the wiring step may have moved a port or built the Codex host farm, and nothing refreshes the shell's env between wiring and exec inside one process. The rest of the environment passes through.
- **No execve:** the agent runs as a child and its exit code (or 128 + signal) passes through; the wiring's write reports are deferred until the agent hands the terminal back.

Demonstrated by: [test/launch.test.ts](../test/launch.test.ts), [test/env.test.ts](../test/env.test.ts), [test/shell_integration.test.ts](../test/shell_integration.test.ts).

## The module map

Each node is one layer, labelled with the paths it owns; an arrow means the layer imports the other. Rendered from `architecture.json` by `deno task docs:arch` (`--check` fails on drift), and the lint in `test/architecture.test.ts` keeps that declaration equal to the import graph under `src/`:

| Lint message                                                                     | What to do                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `forbidden import a -> b: src/a/x.ts -> src/b/y.ts; move it or declare the edge` | Move the import, or add `b` under `edges.a` when the dependency is right   |
| `stale allowance a -> b: no file draws it; remove it from architecture.json`     | Delete `b` from `edges.a`; the declaration lists only edges the code draws |
| `src/z.ts belongs to no layer in architecture.json`                              | Add the file to a layer or to `exclude`; nothing is dropped silently       |
| `layer a names src/a/, which owns no file of the graph`                          | Fix the path, or delete it from `layers`                                   |

An edge is any relative import: runtime, type-only, re-export, side-effect, or a string-literal `import()`. Imports inside one layer are not edges, and a layer absent from `edges` imports nothing outside itself.

<!-- BEGIN GENERATED: architecture-map (deno task docs:arch; derived from architecture.json) -->

```mermaid
graph TD
  cli["src/cli.ts"]
  commands["src/commands/"]
  agents["src/agents/"]
  claude["src/claude/"]
  codex["src/codex/"]
  copilot_api["src/copilot_api/"]
  proxy_float["src/proxy_float.ts"]
  health["src/health/"]
  install["src/install/"]
  autoupdate["src/autoupdate/"]
  usage["src/usage/"]
  shell["src/shell/"]
  mcp["src/mcp/"]
  migrations["src/migrations/"]
  scripts["src/scripts/"]
  utils["src/utils/"]
  cli --> agents
  cli --> claude
  cli --> codex
  cli --> commands
  cli --> copilot_api
  cli --> install
  cli --> migrations
  cli --> usage
  cli --> utils
  commands --> agents
  commands --> autoupdate
  commands --> claude
  commands --> codex
  commands --> copilot_api
  commands --> health
  commands --> install
  commands --> mcp
  commands --> proxy_float
  commands --> scripts
  commands --> shell
  commands --> usage
  commands --> utils
  agents --> claude
  agents --> codex
  agents --> copilot_api
  agents --> utils
  claude --> agents
  claude --> codex
  claude --> copilot_api
  claude --> mcp
  claude --> utils
  codex --> agents
  codex --> autoupdate
  codex --> copilot_api
  codex --> utils
  copilot_api --> autoupdate
  copilot_api --> proxy_float
  copilot_api --> scripts
  copilot_api --> utils
  proxy_float --> agents
  proxy_float --> copilot_api
  proxy_float --> utils
  health --> agents
  health --> autoupdate
  health --> claude
  health --> codex
  health --> copilot_api
  health --> migrations
  health --> proxy_float
  health --> scripts
  health --> shell
  health --> utils
  install --> copilot_api
  install --> shell
  install --> utils
  autoupdate --> copilot_api
  autoupdate --> install
  autoupdate --> utils
  usage --> claude
  usage --> codex
  usage --> copilot_api
  usage --> utils
  shell --> utils
  mcp --> copilot_api
  mcp --> utils
  migrations --> agents
  migrations --> autoupdate
  migrations --> claude
  migrations --> codex
  migrations --> copilot_api
  migrations --> proxy_float
  migrations --> shell
  migrations --> utils
  scripts --> copilot_api
  scripts --> utils
  utils --> copilot_api
```

<!-- END GENERATED: architecture-map -->
