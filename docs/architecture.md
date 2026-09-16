# Architecture

How copilot-env's code is arranged: the decisions a reader would otherwise reverse, each as one diagram over real files, then the layer map. Not a user guide (the other pages are), and the checks behind it prove existence only: every path a box names exists, every symbol after a path is exported by that file, and every `Demonstrated by:` link resolves. No check tests the claim a diagram makes.

## The two wiring modes and the one credential

```mermaid
flowchart TD
  store["src/copilot_api/env_state.ts<br>CopilotEnvState StoredCredential ProvisionedCredential"]
  cred["src/copilot_api/credential.ts<br>Credential"]
  wiring["src/agents/configure.ts<br>resolveCredentialWiring() CredentialWiring ManagedMode ManagedWrite"]
  resolver["src/utils/root.ts<br>agentAuthGetArgs() proxyTokenCommand()"]
  direct["Direct: the agent config names the Copilot host and a resolver command"]
  proxy["proxy: the agent config names the local daemon, which holds the token in memory"]
  daemon["src/copilot_api/launch.ts<br>resolveLaunchCredential() DaemonLaunchAuth"]
  store --> cred
  cred -->|"resolve(): the token, or null for a none slot"| wiring
  wiring -->|"kind command"| resolver
  wiring -->|"mode direct"| direct
  wiring -->|"mode proxy"| proxy
  cred --> daemon
  daemon -->|"DaemonCredential: the token rides in env, spliced into argv in-process"| proxy
```

- **No implicit `gh` fallback:** a `none` slot resolves to null and the caller asks (`agent auth`); a named profile's reason names the profile.
- **`static-key` is the one opt-in that bakes the value:** `resolveCredentialWiring()` resolves it once per agent at the write, and an unresolvable static credential is a failed write, never a silent return to the command shape.

Demonstrated by: [test/configure.test.ts](../test/configure.test.ts), [test/auth.test.ts](../test/auth.test.ts), [test/codex_config.test.ts](../test/codex_config.test.ts).

## Identity and host: one pair, one replay rule

```mermaid
flowchart TD
  config["src/copilot_api/env_config.ts<br>CopilotEnvConfig"]
  slot["the profile slot: the identity name and the host it was accepted on, keyed to the credential"]
  rule["src/copilot_api/env_state.ts<br>replayableIdentity() ReplayableIdentity CachedCopilotHost expectedDirectHost()"]
  persist["src/agents/profile_wiring.ts<br>resolveAndPersistDirectWiring()"]
  probe["src/codex/config.ts<br>probeDirectWiring()"]
  select["src/copilot_api/integration_identity.ts<br>selectDirectIdentityAndHost() selectPassthroughIdentityAndHost() IdentityAndHost probeIntegrationIdentityCached()"]
  launch["src/copilot_api/launch.ts<br>resolveLaunchCredential()"]
  config -->|"integration-id pin, copilot-host literal"| rule
  slot --> rule
  rule -->|"replay: bake the cached pair, no request"| persist
  rule -->|"preferred or probe"| probe
  probe --> select
  select -->|"identity on the host in use, then the host under it, then re-select where auto moved"| persist
  persist -->|"setProfileIntegrationIdentity(), keyed to the credential the probe ran under"| slot
  launch -->|"the passthrough twin: the daemon's host pin"| select
```

- **The probe memo is process-lifetime and never invalidated** (`probeIntegrationIdentityCached()`): a CLI run ends in seconds, and the MCP server keeps its verdict until the transport closes. Injected I/O and a caller deadline bypass it.
- **A pin is configuration, never a verdict:** the slot keeps what it held, so `--identity auto` returns to it; a credential change clears the slot.

Demonstrated by: [test/integration_identity.test.ts](../test/integration_identity.test.ts), [test/copilot_host.test.ts](../test/copilot_host.test.ts).

## Profiles are atomic units

```mermaid
flowchart LR
  slot["src/copilot_api/env_state.ts<br>ProfileSlot ProfileMode partialSlotGap() assertProfileSlot()"]
  wire["src/agents/profile_wiring.ts<br>bothAgents() wireBothAgents()"]
  adapter["src/agents/configure.ts<br>AgentAdapter"]
  claude["src/claude/config.ts<br>claudeAdapter() configureClaudeConfig()"]
  codex["src/codex/config.ts<br>codexAdapter() configureCodexConfig()"]
  slot -->|"one credential + one mode"| wire
  wire -->|"configureProfile on every adapter, even after one throws"| adapter
  adapter --> claude
  adapter --> codex
```

- **A named profile never falls back to the default credential:** `Credential.resolveWithReason()` says so in its reason, and a launch on a partial slot reports `partialSlotGap()` instead of guessing.
- **The default is a profile too,** under the reserved `default` key. For a named profile `mode` is the truth its artifacts derive from; for the default, `mode` records what the wiring last wrote (`recordDefaultModeFromWiring()` in `src/agents/configure_defaults.ts`) and the artifacts stay the live truth.

Demonstrated by: [test/profiles.test.ts](../test/profiles.test.ts), [test/codex_profile_wiring.test.ts](../test/codex_profile_wiring.test.ts).

## The proxy floats; runtime needs are preload shims

```mermaid
flowchart LR
  registry["the npm registry: versions and publish times"]
  float["src/proxy_float.ts<br>floatProxy() selectProxyVersion() writeResolvedVersionRecord() readResolvedVersionRecord()"]
  shims["src/copilot_api/shims.ts<br>DAEMON_SHIM_FILES shimPath() allShimPaths()"]
  spawn["src/copilot_api/process.ts<br>DaemonSpec daemonArgv() daemonEnvironment() launchDaemon()"]
  preloads["src/scripts/node_compat_preload.ts<br>src/scripts/daemon_lock_preload.ts<br>src/scripts/token_argv_preload.ts<br>src/scripts/daemon_runtime_preload.ts<br>src/scripts/copilot_host_preload.ts<br>src/scripts/pat_passthrough_preload.ts<br>src/scripts/idle_watchdog_preload.ts<br>src/scripts/log_mute_preload.ts"]
  registry -->|"release-cooldown, or a proxy-version pin"| float
  shims -->|"every shim, warmed into the cache"| float
  float -->|"resolved-version.json: the daemon's entry"| spawn
  shims -->|"the subset DaemonSpec derives"| spawn
  spawn -->|"--preload, in order"| preloads
```

- **We never patch the package:** every shim wraps a runtime seam (`globalThis.fetch`, `fs.createWriteStream`, `process.argv`) and touches none of copilot-api's files, so none of them pins the floated version.
- **The float warms every shim** because `--cached-only` at spawn gives no second chance; the spawn loads only the subset the `DaemonSpec` derives, so a credential-less daemon carries no token shim.
- **The secret-carrying shims stay import-free** (`test/lint/no_shim_imports.ts`): a runtime import would drag CLI modules into the daemon process.

Demonstrated by: [test/proxy_float.test.ts](../test/proxy_float.test.ts), [test/daemon_spawn.test.ts](../test/daemon_spawn.test.ts), [test/daemon_env_keys.test.ts](../test/daemon_env_keys.test.ts).

## The config store: flag, then stored, then default

```mermaid
flowchart LR
  cmd["src/commands/config.ts<br>runConfig() configTable()"]
  flag["an explicit flag or env var"]
  store["src/copilot_api/env_config.ts<br>CopilotEnvConfig CONFIG_REGISTRY ConfigKeyDef"]
  dflt["src/copilot_api/env_config.ts<br>configDefaultValue() configDefaultBoolean() configDefaultNumber() configDefaultString()"]
  site["src/autoupdate/apply.ts<br>resolveProvenanceDecision()"]
  cmd -->|"--set, --del, --get"| store
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
  root["src/utils/root.ts<br>rootMode() RootMode isProtectedRoot() looksLikeInstallRoot()"]
  install["src/install/installer.ts<br>buildInstallPlan() applyInstallPlan() runInstall() adoptVersionedLayout()"]
  layout["the versioned layout: versions vX.Y.Z, a current link, bin shims dispatching through current"]
  update["src/commands/update.ts<br>runUpdate() recheckVerdict()"]
  preflight["src/autoupdate/preflight.ts<br>runPreflight()"]
  release["src/install/resolve-release.ts<br>resolveTarget() pickAged()"]
  apply["src/autoupdate/apply.ts<br>applyUpdate() resolveProvenanceDecision() ProvenanceDecision"]
  prov["src/install/provenance.ts<br>verifyReleaseProvenance() TUF_MIRROR_URL"]
  att["src/install/attestation.ts<br>RELEASE_SIGNER_POLICY parseStatement() assertSubjectsAttested()"]
  root -->|"checkout or compiled, decided once"| install
  root -->|"a checkout refuses without --force"| update
  update --> release
  preflight -->|"the auto-update key, once per cooldown"| release
  release --> apply
  apply -->|"sha256 against checksums.txt, then the attestation"| prov
  prov --> att
  apply -->|"stage, provision with the new binary's install --assets-only, commit by flipping current"| install
  install --> layout
```

- **Trust on first use:** the installer never verifies the release it was fetched from (that would be circular). `agent update` proves origin with Sigstore and fails closed; `--no-verify` and the `verify-provenance` key are the two opt-outs, and the skip warning names the way back.
- **Nothing before the commit is best-effort;** past the `current` flip the install has moved forward, so `agent migrate` and the GC (one previous version kept) may fail without stranding it.

Demonstrated by: [test/installer.test.ts](../test/installer.test.ts), [test/update_apply.test.ts](../test/update_apply.test.ts), [test/provenance.test.ts](../test/provenance.test.ts).

## The launch path

```mermaid
flowchart LR
  env["src/commands/env.ts<br>launcherFunctionLines() runEnv()"]
  rc["shell/agents.bashrc<br>shell/agents.ps1"]
  bin["bin/agent<br>bin/agent.ps1"]
  cli["src/cli.ts"]
  launch["src/commands/launch.ts<br>parseLaunchAction() prepareLaunch() commandDeps() runLaunch() LaunchPlan"]
  token["src/commands/proxy_token.ts<br>resolveProxyToken() launchProxy()"]
  wire["src/agents/profile_wiring.ts<br>wireBothAgents()"]
  agentcli["the agent CLI: claude, codex, or copilot, with inherited stdio"]
  env -->|"the only output the agent function evals"| rc
  rc -->|"cl runs agent launch claude with the arguments"| bin
  bin --> cli
  cli --> launch
  launch -->|"ensureProxy"| token
  launch -->|"syncProfileWiring"| wire
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
  migrations --> install
  migrations --> proxy_float
  migrations --> scripts
  migrations --> shell
  migrations --> utils
  scripts --> copilot_api
  scripts --> utils
  utils --> copilot_api
```

<!-- END GENERATED: architecture-map -->
