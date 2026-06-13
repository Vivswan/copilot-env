// Codex config writer: points Codex at GitHub Copilot directly by default, with
// the local copilot-api proxy available as an explicit proxy mode. Direct mode
// fetches its bearer at runtime via an `auth.command` that runs `agent auth --get`
// (provider-driven: gh-cli -> gh, copilot/gh-token -> the stored token) -- nothing is baked
// into the config or `.env`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse, stringify } from "smol-toml";
import { Credential } from "../copilot_api/credential.ts";
import { copilotApiResolvePort, openaiBaseUrl } from "../copilot_api/port.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { cliSpawn } from "../utils/command.ts";
import {
  assertSingleMode,
  CODEX_PROBE,
  type DirectProbeDeps,
  probeDirectWorks,
  resolveDirectMode,
} from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
} from "../utils/provider_mode.ts";
import { AGENT_AUTH_GET_ARGS, agentLauncherCommand, proxyTokenCommand } from "../utils/root.ts";

const logger = createStderrLogger();

// The Codex model-provider id we manage: ONE provider, `copilot-env`, for BOTH
// direct and proxy -- the mode is read from the table's CONTENTS (base_url + an
// `auth` block vs an `env_key`), not from the provider name. OPENAI_API_KEY is the
// same OpenAI-wire name `env.ts` already exports, so the single proxy token has ONE
// name across the shell exports and the Codex `.env`. (The pre-unification
// `github-copilot-direct` provider is handled ONLY by the 3.3.3 migration, which
// rewrites existing configs to `copilot-env`; nothing here knows that legacy name.)
export const CODEX_PROVIDER_ID = "copilot-env";
export const CODEX_ENV_KEY = "OPENAI_API_KEY";
const DIRECT_BASE_URL = "https://api.githubcopilot.com";
// Legacy: an older copilot-env baked the Direct bearer into this .env key. Direct
// mode no longer bakes a token (it resolves at runtime via `agent auth --get`), so
// this name now exists ONLY so configureCodexConfig can scrub a token left at rest
// by an older release. Deliberately NOT a standard name like GITHUB_TOKEN/GH_TOKEN:
// those are read by gh/git, so a leftover under a standard name could
// re-authenticate tool subprocesses as the token's account.
export const DIRECT_ENV_KEY = "COPILOT_ENV_GH_TOKEN";

export interface CodexConfigArgs {
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
}

interface ConfigureCodexConfigOptions {
  proxy?: boolean;
  baseUrl?: string;
  codexExecVersion?: string | null;
  /** Suppress the "config written" info line (used by the temp-config probe). */
  quiet?: boolean;
}

interface ProxyConfigOptions {
  baseUrl: string;
}

// === config.toml management ===
//
// Load-merge-stringify so user-added keys/sections survive (smol-toml does NOT
// preserve comments or whitespace -- TS has no battle-tested tomlkit equivalent).
// configureCodexConfig ENFORCES every managed field on each run, so a renamed or
// added key (e.g. the env_key) propagates even into a pre-existing config.

// The single source of truth for our managed direct Copilot provider table.
// Re-applied on every direct-mode run (managed keys win; any user-added key in
// the same table is preserved by the merge).
function parseCodexVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

let cachedCodexVersion: string | null | undefined;

function installedCodexVersion(): string | null {
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  // cliSpawn routes through cmd.exe on Windows so a codex.cmd shim is launchable.
  const s = cliSpawn("codex", ["--version"]);
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
    shell: s.shell,
  });
  cachedCodexVersion =
    result.error || result.status !== 0
      ? null
      : parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return cachedCodexVersion;
}

export function codexUserAgent(version: string | null = installedCodexVersion()): string {
  return version ? `codex_exec/${version}` : "codex_exec";
}

/**
 * Derive the mode from our managed provider TABLE's contents (the unified `copilot-env`
 * table doesn't encode mode in its name): a Direct base_url -> direct, a localhost proxy
 * base_url or our `env_key` -> proxy, anything else -> "other" (e.g. a half-written
 * table). `expectedPort` is the running proxy port used to validate a proxy base_url.
 */
function codexTableMode(table: unknown, expectedPort: number): AgentProviderMode {
  if (!isRecord(table)) return "other";
  if (table.base_url === DIRECT_BASE_URL) return "direct";
  const baseUrl = typeof table.base_url === "string" ? table.base_url : null;
  if (
    (baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort)) ||
    table.env_key === CODEX_ENV_KEY
  ) {
    return "proxy";
  }
  return "other";
}

function isManagedProviderMode(mode: AgentProviderMode): mode is ManagedAgentMode {
  return mode === "direct" || mode === "proxy";
}

// The managed direct (GitHub Copilot) provider table. The bearer is fetched via
// `auth.command` -> `agent auth --get` (provider-driven: gh-cli -> `gh auth token`,
// copilot/gh-token -> the stored token), so the token is never baked into the config.
// Codex re-runs the command on `refresh_interval_ms`, so it always tracks the
// current credential. Re-applied on every direct-mode run (managed keys win; any
// user-added key in the same table is preserved by the merge).
function managedDirectProvider(codexExecVersion?: string | null) {
  const { command, args } = agentLauncherCommand(AGENT_AUTH_GET_ARGS);
  return {
    "name": CODEX_PROVIDER_ID,
    "base_url": DIRECT_BASE_URL,
    "wire_api": "responses",
    "supports_websockets": false,
    "requires_openai_auth": false,
    "http_headers": {
      "Openai-Intent": "conversation-edits",
      "User-Agent": codexUserAgent(codexExecVersion),
    },
    "auth": {
      "command": command,
      "args": [...args],
      // Generous vs the old `gh` path (5s): the launcher may cold-start bun. The
      // common warm case returns in well under a second; Codex refreshes lazily.
      "timeout_ms": 15000,
      "refresh_interval_ms": 300000,
    },
  };
}

// The single source of truth for our managed `[model_providers.copilot-env]`
// table. Re-applied on every run (managed keys win; any user-added key in the
// same table is preserved by the merge). The return type is inferred (precise
// string/boolean fields) -- only the parsed user config below is `unknown`,
// because that TOML shape is arbitrary and we don't control it.
//
// `auth.command` runs the shared `src/scripts/proxy-token.sh --yes` (`.ps1` on Windows, via
// `proxyTokenCommand`): it ensures the proxy is up (auto-starting it when the managed
// lifecycle is on, `agent init --auto-start`) and then prints the proxy key. `--yes` is the
// headless path (never prompt). Codex forbids `auth` together with `env_key` on one
// provider, so proxy (like direct) resolves its key via the command, not an env var.
function managedProxyProvider(baseUrl: string) {
  const auth = proxyTokenCommand();
  return {
    "name": CODEX_PROVIDER_ID,
    "base_url": baseUrl,
    "wire_api": "responses",
    "requires_openai_auth": false,
    "supports_websockets": false,
    "auth": {
      "command": auth.command,
      "args": [...auth.args],
      // Cold-starting the proxy runs a full child `agent start`: bun startup, the daemon's
      // readiness wait (up to a ~120s ceiling), THEN model-alias sync + version logging
      // before the key is printed. Give the first auth attempt headroom past all of that, so
      // it does not time out after the proxy is ready but before `auth --print-proxy-token`.
      "timeout_ms": 180000,
      "refresh_interval_ms": 300000,
    },
  };
}

function managedProviderForMode(
  mode: ManagedAgentMode,
  proxyOptions: ProxyConfigOptions | null,
  codexExecVersion?: string | null,
) {
  if (mode === "direct") return managedDirectProvider(codexExecVersion);
  if (proxyOptions === null) throw new Error("proxy options are required for proxy mode");
  return managedProxyProvider(proxyOptions.baseUrl);
}

/** True iff `auth` is OUR managed auth block for the given launcher args. */
function isManagedAuth(auth: unknown, expectedArgs: readonly string[]): boolean {
  if (!isRecord(auth)) return false;
  const expected = agentLauncherCommand([...expectedArgs]);
  return (
    auth.command === expected.command &&
    Array.isArray(auth.args) &&
    auth.args.length === expected.args.length &&
    auth.args.every((a, i) => a === expected.args[i])
  );
}

/** True iff `auth` is OUR managed direct auth block (`agent auth --get`). */
function isManagedDirectAuth(auth: unknown): boolean {
  return isManagedAuth(auth, AGENT_AUTH_GET_ARGS);
}

/** True iff `auth` is OUR managed proxy auth block (runs the shared proxy-token script). */
function isManagedProxyAuth(auth: unknown): boolean {
  if (!isRecord(auth)) return false;
  const expected = proxyTokenCommand();
  return (
    auth.command === expected.command &&
    Array.isArray(auth.args) &&
    auth.args.length === expected.args.length &&
    auth.args.every((a, i) => a === expected.args[i])
  );
}

// === wiring inspection (inverse of the write contract above) ===
//
// The read-only counterpart to configureCodexConfig: given a CODEX_HOME's raw
// config.toml/.env content, report whether Codex is direct, proxy-backed, or
// custom. It lives HERE, next to the managed provider tables, so `agent health`
// and `agent codex` reuse the same contract instead of shell/TOML copies.

export interface CodexWiringStatus {
  /** A config.toml exists at the home (false => the user never wired Codex). */
  configExists: boolean;
  /** Whatever `model_provider` is set to, for messaging. */
  modelProvider: string | null;
  /** Which provider family the current config selects. */
  providerMode: AgentProviderMode;
  /** `model_provider` selects one of our managed providers. */
  providerSelected: boolean;
  /** The managed provider table's `base_url`, if present. */
  baseUrl: string | null;
  /** `base_url` matches the selected provider contract. */
  baseUrlMatches: boolean;
  /** The managed provider table's `env_key` is OPENAI_API_KEY. */
  envKeyMatches: boolean;
  /** All of: provider selected, base_url matches, env_key matches. */
  providerWired: boolean;
  /** A `.env` file exists at the home. */
  envFilePresent: boolean;
  /** `.env` defines the OPENAI_API_KEY token. */
  envKeyInDotenv: boolean;
  /** OPENAI_API_KEY is exported in the running process environment. */
  envKeyInEnviron: boolean;
  /** The token is resolvable from .env OR the environment (Codex needs one). */
  tokenAvailable: boolean;
  /**
   * Direct mode only: true when the direct provider carries a managed
   * `auth.command` (it resolves the bearer via `agent auth --get`). Always false
   * outside direct mode. Whether a `gh` login is needed is a STORE question, not a
   * config one -- the health probe decides that separately.
   */
  directUsesToken: boolean;
}

/**
 * True when `baseUrl` matches the managed proxy contract: an http localhost
 * URL on `expectedPort` whose path is `/v1` (what configureCodexConfig writes via
 * openaiBaseUrl). A bare host, https, or a non-/v1 path is NOT a match.
 */
function baseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  try {
    const u = new URL(baseUrl);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const path = u.pathname.replace(/\/$/, ""); // tolerate a trailing slash
    return u.protocol === "http:" && isLocal && u.port === String(expectedPort) && path === "/v1";
  } catch {
    return false;
  }
}

/**
 * Inspect raw config.toml + .env content against the managed contracts. Pure
 * (no I/O): callers read the files and pass the strings (null = absent file),
 * plus whether OPENAI_API_KEY is set in the running environment (proxy mode
 * needs a token; direct mode uses its auth command).
 */
export function inspectCodexWiring(
  configToml: string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
): CodexWiringStatus {
  const envKeyInDotenv =
    envText !== null &&
    new RegExp(`^\\s*(?:export\\s+)?${CODEX_ENV_KEY}\\s*=\\s*\\S`, "m").test(envText);
  const status: CodexWiringStatus = {
    configExists: configToml !== null,
    modelProvider: null,
    providerMode: "none",
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    envFilePresent: envText !== null,
    envKeyInDotenv,
    envKeyInEnviron,
    tokenAvailable: envKeyInDotenv || envKeyInEnviron,
    directUsesToken: false,
  };
  if (configToml === null) return status;
  try {
    const doc = parse(configToml);
    const modelProvider =
      isRecord(doc) && typeof doc.model_provider === "string" ? doc.model_provider : null;
    const providers = isRecord(doc) ? doc.model_providers : undefined;
    // We select our single provider by name, but read the MODE from its table's
    // contents -- the unified `copilot-env` table no longer encodes mode in its name.
    const selected = modelProvider === CODEX_PROVIDER_ID;
    const table = selected && isRecord(providers) ? providers[CODEX_PROVIDER_ID] : undefined;
    const tableMode = selected ? codexTableMode(table, expectedPort) : "other";
    // A selected-but-unrecognized table shape ("other") still counts as one of ours for
    // messaging; report it as proxy so the wiring checks below flag what's off.
    const providerMode: AgentProviderMode = selected
      ? isManagedProviderMode(tableMode)
        ? tableMode
        : "proxy"
      : modelProvider === null
        ? "none"
        : "other";
    const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
    status.modelProvider = modelProvider;
    status.providerMode = providerMode;
    status.providerSelected = selected;
    status.baseUrl = baseUrl;
    status.baseUrlMatches =
      baseUrl !== null &&
      (providerMode === "proxy"
        ? baseUrlMatchesProxy(baseUrl, expectedPort)
        : providerMode === "direct" && baseUrl === DIRECT_BASE_URL);
    // Proxy mode resolves its key (and auto-starts the proxy) via the managed
    // `auth.command` (the shared proxy-token script), so it needs no `env_key`. A legacy
    // proxy config still using `env_key` is also accepted (back-compat).
    const proxyUsesManagedAuth =
      providerMode === "proxy" && isRecord(table) && isManagedProxyAuth(table.auth);
    status.envKeyMatches =
      providerMode === "direct" ||
      proxyUsesManagedAuth ||
      (isRecord(table) && table.env_key === CODEX_ENV_KEY);
    // Direct mode resolves its bearer via the managed `auth.command` (agent auth
    // --get). Positively identify OUR launcher (command + args), not just any
    // auth.command -- a stale `gh auth token` block must NOT read as managed. Whether
    // a `gh` login is actually needed depends on the store (a token there means no
    // gh) -- the health probe decides that from the store, not the static config.
    status.directUsesToken =
      providerMode === "direct" && isRecord(table) && isManagedDirectAuth(table.auth);
    status.providerWired =
      status.providerSelected &&
      status.baseUrlMatches &&
      status.envKeyMatches &&
      (providerMode === "direct" || proxyUsesManagedAuth || status.tokenAvailable);
  } catch {
    // Malformed TOML => leave everything but config/.env facts false.
  }
  return status;
}

// Seeded ONLY when no config.toml exists yet: select the requested provider and
// disable telemetry. Provider TABLES are injected by the merge functions, so
// they are intentionally absent here -- no duplication, no drift.
function defaultConfig(mode: ManagedAgentMode): Record<string, unknown> {
  return {
    "model_provider": CODEX_PROVIDER_ID,
    ...(mode === "direct" ? { "web_search": "live" } : {}),
    "analytics": { "enabled": false },
    "feedback": { "enabled": false },
  };
}

// Load the existing config at `hostConfig`, or seed the default template when
// it is absent or unparseable.
function loadOrCreateConfig(hostConfig: string, mode: ManagedAgentMode): Record<string, unknown> {
  try {
    if (fs.statSync(hostConfig).isFile()) {
      return parse(fs.readFileSync(hostConfig, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // fall through to the default template
  }
  return defaultConfig(mode);
}

// Remove `key` from `$CODEX_HOME/.env` (any `export`-prefixed or duplicate
// assignment), preserving everything else. No-op when the file is absent or the
// key isn't present, so it never creates or rewrites a file needlessly. Used to
// scrub the baked direct token (COPILOT_ENV_GH_TOKEN) when reverting to gh-direct.
function removeEnvKey(envFile: string, key: string): void {
  let existing: string;
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return; // nothing to scrub
    throw e;
  }
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = existing.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  const kept = lines.filter((line) => !matcher.test(line));
  if (kept.length === lines.length) return; // key absent -- leave the file untouched
  fs.writeFileSync(envFile, kept.length ? `${kept.join("\n")}\n` : "");
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // pass
  }
}

function validateProxyOptions(options: ConfigureCodexConfigOptions): ProxyConfigOptions | null {
  if (!options.baseUrl) {
    logger.warn("Warning: base_url not provided, skipping Codex config");
    return null;
  }
  if (!/^[A-Za-z0-9:/._-]+$/.test(options.baseUrl)) {
    logger.error(`Error: base_url contains invalid characters: ${options.baseUrl}`);
    return null;
  }
  return { baseUrl: options.baseUrl };
}

/**
 * Write the managed `config.toml` at `codexHome`. Direct mode is the default and
 * touches `.env` only when a `--gh-token` is baked in (writing COPILOT_ENV_GH_TOKEN,
 * mode 0600); a gh-direct write (no token) scrubs any leftover COPILOT_ENV_GH_TOKEN.
 * Proxy mode writes a `.env` holding the proxy API key. Returns 0 on success.
 * Exported for unit testing.
 */
export function configureCodexConfig(
  codexHome?: string | null,
  options: ConfigureCodexConfigOptions = {},
): number {
  const home = process.env.HOME || homedir();
  codexHome = codexHome || process.env.CODEX_HOME || `${home}/.codex`;
  // Low-level writer: absence of `proxy` means write a Direct config. The
  // never-silent-Direct guarantee lives UPSTREAM at resolveDirectMode() -- callers
  // must pass an already-resolved mode (an explicit flag or a passing probe);
  // the only intentional bare-Direct use is the throwaway probe config itself.
  const mode: ManagedAgentMode = options.proxy ? "proxy" : "direct";
  const proxyOptions = mode === "proxy" ? validateProxyOptions(options) : null;
  if (mode === "proxy" && proxyOptions === null) return 1;

  try {
    fs.mkdirSync(codexHome, { recursive: true });
  } catch (e) {
    logger.warn(`Warning: Could not create Codex config directory ${codexHome}: ${errMessage(e)}`);
    return 1;
  }

  const hostConfig = `${codexHome}/config.toml`;

  const doc = loadOrCreateConfig(hostConfig, mode);

  // Enforce our managed contract on every run: select the requested provider
  // as the default and (re)write EVERY managed field on its table --
  // overwriting a stale value (e.g. an old env_key) and filling any managed key
  // the file lacks. Spreading `existing` first preserves user-added keys in the
  // same table; other providers, the [analytics]/[feedback] sections, and any
  // unknown top-level keys are left untouched.
  doc.model_provider = CODEX_PROVIDER_ID;
  if (mode === "direct") {
    doc.web_search = "live";
    // Direct (GitHub Copilot) doesn't serve image generation; disable the feature
    // so the app doesn't offer it. Merge so other [features] keys are preserved.
    const features = isRecord(doc.features) ? doc.features : {};
    features.image_generation = false;
    doc.features = features;
  } else if (isRecord(doc.features)) {
    // Proxy: image generation works via the proxy, so drop the direct-only
    // disable (and the whole [features] table if it has nothing else).
    delete doc.features.image_generation;
    if (Object.keys(doc.features).length === 0) delete doc.features;
  }

  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  const existing = isRecord(providers[CODEX_PROVIDER_ID]) ? providers[CODEX_PROVIDER_ID] : {};
  const merged: Record<string, unknown> = {
    ...existing,
    ...managedProviderForMode(mode, proxyOptions, options.codexExecVersion),
  };
  // Both modes share ONE `copilot-env` table, so the `...existing` spread would bleed
  // the OTHER mode's managed keys when toggling. Both modes resolve via `auth.command`
  // and carry NO `env_key` (Codex also forbids `auth` + `env_key` on one provider), so
  // always scrub `env_key`; `http_headers` is direct-only, so proxy scrubs it too.
  // `auth` itself is set by both managed providers (the spread overwrites it).
  delete merged.env_key;
  if (mode !== "direct") {
    delete merged.http_headers;
  }
  providers[CODEX_PROVIDER_ID] = merged;
  doc.model_providers = providers;

  fs.writeFileSync(hostConfig, stringify(doc));
  if (!options.quiet) logger.log(`  ✓ Codex config written → ${hostConfig}`);

  // Both modes resolve their key via the managed `auth.command` (proxy: the shared
  // proxy-token script; direct: `agent auth --get`), so nothing is ever baked into `.env`.
  // Scrub the legacy baked keys: a proxy `OPENAI_API_KEY` from the old env_key wiring,
  // and a direct `COPILOT_ENV_GH_TOKEN` from a still-older baked-token release.
  removeEnvKey(`${codexHome}/.env`, CODEX_ENV_KEY);
  removeEnvKey(`${codexHome}/.env`, DIRECT_ENV_KEY);

  return 0;
}

/**
 * Resolve baseUrl/apiKey from the local proxy and write the Codex config at
 * `codexHome`. Pure config write -- the caller persists CODEX_HOME to state.
 * Shared by `runCodexConfig` and codex_host's `runCodexHost`. Direct mode fetches
 * the bearer at runtime via `agent auth --get`; nothing is baked into the config.
 */
export function applyCodexConfig(
  codexHome: string,
  args: Pick<CodexConfigArgs, "proxy"> = {},
): void {
  // Caller passes an already-resolved mode; bare {} => Direct (see
  // configureCodexConfig). The never-silent-Direct guarantee is upstream at resolveDirectMode().
  const mode: ManagedAgentMode = args.proxy ? "proxy" : "direct";
  let options: ConfigureCodexConfigOptions = {};

  if (mode === "proxy") {
    // The key is resolved at request time by the `auth.command` (the shared proxy-token
    // script), so we only need the local proxy base URL here.
    options = { proxy: true, baseUrl: openaiBaseUrl(copilotApiResolvePort()) };
  }

  if (configureCodexConfig(codexHome, options) !== 0) {
    throw new Error(
      `Codex config write failed for ${codexHome} (see the logged warning above for the cause)`,
    );
  }
}

export function effectiveCodexHome(): string {
  return (
    new CopilotEnvRunState().read().codexHome ??
    process.env.CODEX_HOME ??
    path.join(homedir(), ".codex")
  );
}

interface EffectiveCodexConfig {
  codexHome: string;
  configPath: string;
  configExists: boolean;
  providerMode: AgentProviderMode;
}

function inspectEffectiveCodexConfig(): EffectiveCodexConfig {
  const codexHome = effectiveCodexHome();
  const configPath = path.join(codexHome, "config.toml");
  try {
    const status = inspectCodexWiring(
      fs.readFileSync(configPath, "utf8"),
      null,
      Number(copilotApiResolvePort()),
      false,
    );
    return {
      codexHome,
      configPath,
      configExists: status.configExists,
      providerMode: status.providerMode,
    };
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
    return { codexHome, configPath, configExists: false, providerMode: "none" };
  }
}

function providerModeDetail(mode: AgentProviderMode, configExists: boolean): string {
  switch (mode) {
    case "proxy":
      return "local copilot-api proxy";
    case "direct":
      return "GitHub Copilot Direct";
    case "none":
      return configExists ? "no model_provider configured" : "no config.toml found";
    case "other":
      return "custom or unsupported provider";
  }
}

function checkCodexConfig(): void {
  try {
    const { codexHome, configPath, configExists, providerMode } = inspectEffectiveCodexConfig();
    console.log(
      `Codex provider mode: ${providerMode} (${providerModeDetail(providerMode, configExists)})`,
    );
    console.log(`CODEX_HOME: ${codexHome}`);
    console.log(`config.toml: ${configPath}`);
    process.exitCode = providerModeExitCode(providerMode);
  } catch (e) {
    logger.error(`Codex provider check failed: ${errMessage(e)}`);
    process.exitCode = 1;
  }
}

/**
 * Live auto-detect: does GitHub Copilot Direct work for Codex on this machine?
 * Writes a throwaway direct config and runs `codex exec --sandbox read-only`
 * against it (see src/utils/direct_probe.ts). False => the caller writes proxy.
 */
export function detectCodexDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CODEX_PROBE,
    (tmpHome) => {
      configureCodexConfig(tmpHome, { quiet: true });
    },
    deps,
  );
}

/**
 * `agent codex`: configure Codex at the active CODEX_HOME -- the one a `--host`
 * farm set in state, else `$CODEX_HOME`, else the default `~/.codex`. `--direct`
 * forces GitHub Copilot Direct, `--proxy` forces the local proxy, and with no
 * mode flag it auto-detects (live read-only probe, else the proxy). `--check`
 * reports the configured mode (exit 0 direct / 2 proxy|none / 1 other) without a
 * probe. Does NOT touch `state.codexHome` (only `--host` sets/clears that).
 *
 * A GitHub token provisioned via `agent auth` (in the shared store) is used as the
 * Direct credential automatically; with no mode flag, its presence selects Direct
 * without probing.
 */
export function runCodex(args: CodexConfigArgs): void {
  assertSingleMode(args);
  if (args.check) {
    checkCodexConfig();
    return;
  }
  // A configured credential (`agent auth`) selects Direct without a live probe.
  // Resolve it provider-aware (gh-cli -> gh, copilot/gh-token -> stored token, none ->
  // null) so a recorded-but-broken provider correctly falls through to the probe.
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args, ghToken, detectCodexDirect);
  logger.log(
    `  Configuring Codex for ${direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"} …`,
  );
  applyCodexConfig(effectiveCodexHome(), { proxy: !direct });
}

/** The configured Codex provider mode at the effective CODEX_HOME (read-only). */
export function effectiveCodexProviderMode(): AgentProviderMode {
  return inspectEffectiveCodexConfig().providerMode;
}
