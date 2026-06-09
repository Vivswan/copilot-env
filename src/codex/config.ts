// Codex config writer: points Codex at GitHub Copilot directly by default, with
// the local gateway provider available as an explicit proxy mode.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createConsola } from "consola";
import { parse, stringify } from "smol-toml";

import { CopilotApiConfig } from "../copilot_api/config.ts";
import { copilotApiResolvePort, openaiBaseUrl } from "../copilot_api/port.ts";
import { CopilotApiState } from "../copilot_api/state.ts";
import { isRecord } from "../utils/json.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// The Codex model-provider ids we manage. CODEX_PROVIDER_ID is the proxy
// provider contract used by the gateway health inspector. OPENAI_API_KEY is the
// same OpenAI-wire name `env.ts` already exports, so the single gateway token
// has ONE name across the shell exports and the Codex `.env`.
const DIRECT_PROVIDER_ID = "github-copilot-direct";
const DIRECT_BASE_URL = "https://api.githubcopilot.com";
export const CODEX_PROVIDER_ID = "copilot-env";
export const CODEX_ENV_KEY = "OPENAI_API_KEY";

export type CodexProviderMode = "direct" | "proxy" | "other" | "none";
type ManagedCodexProviderMode = Extract<CodexProviderMode, "direct" | "proxy">;

export interface CodexConfigArgs {
  "codex-home"?: string;
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
}

interface ConfigureCodexConfigOptions {
  proxy?: boolean;
  baseUrl?: string;
  apiKey?: string;
  codexExecVersion?: string | null;
}

interface ProxyConfigOptions {
  baseUrl: string;
  apiKey: string;
}

// === config.toml management ===
//
// Load-merge-stringify so user-added keys/sections survive (smol-toml does NOT
// preserve comments or whitespace — TS has no battle-tested tomlkit equivalent).
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
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
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

function providerModeFromModelProvider(modelProvider: string | null): CodexProviderMode {
  if (modelProvider === CODEX_PROVIDER_ID) return "proxy";
  if (modelProvider === DIRECT_PROVIDER_ID) return "direct";
  if (modelProvider === null) return "none";
  return "other";
}

function isManagedProviderMode(mode: CodexProviderMode): mode is ManagedCodexProviderMode {
  return mode === "direct" || mode === "proxy";
}

function providerIdForMode(mode: ManagedCodexProviderMode): string {
  return mode === "proxy" ? CODEX_PROVIDER_ID : DIRECT_PROVIDER_ID;
}

function managedDirectProvider(codexExecVersion?: string | null) {
  return {
    "name": "GitHub Copilot Direct",
    "base_url": DIRECT_BASE_URL,
    "wire_api": "responses",
    "supports_websockets": false,
    "requires_openai_auth": false,
    "http_headers": {
      "Openai-Intent": "conversation-edits",
      "User-Agent": codexUserAgent(codexExecVersion),
    },
    "auth": {
      "command": "gh",
      "args": ["auth", "token"],
      "timeout_ms": 5000,
      "refresh_interval_ms": 300000,
    },
  };
}

// The single source of truth for our managed `[model_providers.copilot-env]`
// table. Re-applied on every run (managed keys win; any user-added key in the
// same table is preserved by the merge). The return type is inferred (precise
// string/boolean fields) — only the parsed user config below is `unknown`,
// because that TOML shape is arbitrary and we don't control it.
function managedProxyProvider(baseUrl: string) {
  return {
    "name": CODEX_PROVIDER_ID,
    "base_url": baseUrl,
    "env_key": CODEX_ENV_KEY,
    "wire_api": "responses",
    "requires_openai_auth": false,
    "supports_websockets": false,
  };
}

function managedProviderForMode(
  mode: ManagedCodexProviderMode,
  proxyOptions: ProxyConfigOptions | null,
  codexExecVersion?: string | null,
) {
  if (mode === "direct") return managedDirectProvider(codexExecVersion);
  if (proxyOptions === null) throw new Error("proxy options are required for proxy mode");
  return managedProxyProvider(proxyOptions.baseUrl);
}

// === wiring inspection (inverse of the write contract above) ===
//
// The read-only counterpart to configureCodexConfig: given a CODEX_HOME's raw
// config.toml/.env content, report whether Codex is direct, proxy-backed, or
// custom. It lives HERE, next to the managed provider tables, so `agent health`
// and `setup-codex-config` reuse the same contract instead of shell/TOML copies.

export interface CodexWiringStatus {
  /** A config.toml exists at the home (false => the user never wired Codex). */
  configExists: boolean;
  /** Whatever `model_provider` is set to, for messaging. */
  modelProvider: string | null;
  /** Which provider family the current config selects. */
  providerMode: CodexProviderMode;
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
}

/**
 * True when `baseUrl` matches the managed gateway contract: an http localhost
 * URL on `expectedPort` whose path is `/v1` (what configureCodexConfig writes via
 * openaiBaseUrl). A bare host, https, or a non-/v1 path is NOT a match.
 */
function baseUrlMatchesGateway(baseUrl: string, expectedPort: number): boolean {
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
  };
  if (configToml === null) return status;
  try {
    const doc = parse(configToml);
    const modelProvider =
      isRecord(doc) && typeof doc.model_provider === "string" ? doc.model_provider : null;
    const providers = isRecord(doc) ? doc.model_providers : undefined;
    const providerMode = providerModeFromModelProvider(modelProvider);
    const providerId = isManagedProviderMode(providerMode) ? providerIdForMode(providerMode) : null;
    const table = providerId !== null && isRecord(providers) ? providers[providerId] : undefined;
    const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
    status.modelProvider = modelProvider;
    status.providerMode = providerMode;
    status.providerSelected = isManagedProviderMode(providerMode);
    status.baseUrl = baseUrl;
    status.baseUrlMatches =
      baseUrl !== null &&
      (providerMode === "proxy"
        ? baseUrlMatchesGateway(baseUrl, expectedPort)
        : providerMode === "direct" && baseUrl === DIRECT_BASE_URL);
    status.envKeyMatches =
      providerMode === "direct" || (isRecord(table) && table.env_key === CODEX_ENV_KEY);
    status.providerWired =
      status.providerSelected &&
      status.baseUrlMatches &&
      status.envKeyMatches &&
      (providerMode === "direct" || status.tokenAvailable);
  } catch {
    // Malformed TOML => leave everything but config/.env facts false.
  }
  return status;
}

// Seeded ONLY when no config.toml exists yet: select the requested provider and
// disable telemetry. Provider TABLES are injected by the merge functions, so
// they are intentionally absent here — no duplication, no drift.
function defaultConfig(mode: ManagedCodexProviderMode): Record<string, unknown> {
  return {
    "model_provider": providerIdForMode(mode),
    ...(mode === "direct" ? { "web_search": "live" } : {}),
    "analytics": { "enabled": false },
    "feedback": { "enabled": false },
  };
}

// Load the existing config at `hostConfig`, or seed the default template when
// it is absent or unparseable.
function loadOrCreateConfig(
  hostConfig: string,
  mode: ManagedCodexProviderMode,
): Record<string, unknown> {
  try {
    if (fs.statSync(hostConfig).isFile()) {
      return parse(fs.readFileSync(hostConfig, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // fall through to the default template
  }
  return defaultConfig(mode);
}

// Set the gateway key in `$CODEX_HOME/.env` WITHOUT clobbering the rest of the
// file: replace an existing OPENAI_API_KEY assignment in place (dropping any
// duplicates so our value is unambiguous regardless of dotenvy precedence), or
// append it when absent. Comments, blank lines, and any other vars the user
// keeps there survive. The file is (re)created mode 0600. Line endings are
// normalized to "\n" (matching what we've always written).
function writeEnvKey(envFile: string, apiKey: string): void {
  const assignment = `${CODEX_ENV_KEY}=${apiKey}`;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${CODEX_ENV_KEY}\\s*=`);
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch (e) {
    // Only a missing file means "create fresh". Any other error (e.g. EACCES, a
    // present-but-unreadable .env) must propagate rather than let us blindly
    // overwrite a file we couldn't read.
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  const lines = existing ? existing.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  const out: string[] = [];
  let written = false;
  for (const line of lines) {
    if (matcher.test(line)) {
      if (!written) {
        out.push(assignment); // replace the first occurrence in place
        written = true;
      }
      continue; // drop this (and any later duplicate) assignment
    }
    out.push(line);
  }
  if (!written) out.push(assignment);
  fs.writeFileSync(envFile, `${out.join("\n")}\n`);
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
  if (!options.apiKey) {
    logger.warn("Warning: api_key not provided, skipping Codex config");
    return null;
  }
  if (!/^[A-Za-z0-9:/._-]+$/.test(options.baseUrl)) {
    logger.error("Error: base_url contains invalid characters");
    return null;
  }
  return { baseUrl: options.baseUrl, apiKey: options.apiKey };
}

/**
 * Write the managed `config.toml` at `codexHome`. Direct mode is the default
 * and does not touch `.env`; proxy mode also writes a `.env` (mode 0600)
 * holding the gateway API key. Returns 0 on success. Exported for unit testing.
 */
export function configureCodexConfig(
  codexHome?: string | null,
  options: ConfigureCodexConfigOptions = {},
): number {
  const home = process.env.HOME || homedir();
  codexHome = codexHome || process.env.CODEX_HOME || `${home}/.codex`;
  const mode: ManagedCodexProviderMode = options.proxy ? "proxy" : "direct";
  const proxyOptions = mode === "proxy" ? validateProxyOptions(options) : null;
  if (mode === "proxy" && proxyOptions === null) return 1;

  try {
    fs.mkdirSync(codexHome, { recursive: true });
  } catch {
    logger.warn(`Warning: Could not create Codex config directory: ${codexHome}`);
    return 1;
  }

  const hostConfig = `${codexHome}/config.toml`;

  const doc = loadOrCreateConfig(hostConfig, mode);

  // Enforce our managed contract on every run: select the requested provider
  // as the default and (re)write EVERY managed field on its table —
  // overwriting a stale value (e.g. an old env_key) and filling any managed key
  // the file lacks. Spreading `existing` first preserves user-added keys in the
  // same table; other providers, the [analytics]/[feedback] sections, and any
  // unknown top-level keys are left untouched.
  const providerId = providerIdForMode(mode);
  doc.model_provider = providerId;
  if (mode === "direct") doc.web_search = "live";

  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  const existing = isRecord(providers[providerId]) ? providers[providerId] : {};
  providers[providerId] = {
    ...existing,
    ...managedProviderForMode(mode, proxyOptions, options.codexExecVersion),
  };
  doc.model_providers = providers;

  fs.writeFileSync(hostConfig, stringify(doc));
  logger.info(`Codex App config written to ${hostConfig}`);

  if (proxyOptions !== null) {
    const envFile = `${codexHome}/.env`;
    writeEnvKey(envFile, proxyOptions.apiKey);
  }

  return 0;
}

/**
 * Resolve baseUrl/apiKey from the local gateway and write the Codex config at
 * `codexHome`. Pure config write — the caller persists CODEX_HOME to state.
 * Shared by `runCodexConfig` and codex_host's `runCodexHost`.
 */
export function applyCodexConfig(
  codexHome: string,
  args: Pick<CodexConfigArgs, "proxy"> = {},
): void {
  const mode: ManagedCodexProviderMode = args.proxy ? "proxy" : "direct";
  let options: ConfigureCodexConfigOptions = {};

  if (mode === "proxy") {
    const port = copilotApiResolvePort();
    try {
      options = {
        proxy: true,
        baseUrl: openaiBaseUrl(port),
        apiKey: new CopilotApiConfig().ensureApiKey(),
      };
    } catch (e: unknown) {
      throw new Error(
        `failed to persist auth token: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (configureCodexConfig(codexHome, options) !== 0) {
    throw new Error("Codex config write failed");
  }
}

function effectiveCodexHome(args: Pick<CodexConfigArgs, "codex-home">): string {
  return (
    args["codex-home"] ??
    new CopilotApiState().read().codexHome ??
    process.env.CODEX_HOME ??
    path.join(homedir(), ".codex")
  );
}

interface EffectiveCodexConfig {
  codexHome: string;
  configPath: string;
  configExists: boolean;
  providerMode: CodexProviderMode;
}

function inspectEffectiveCodexConfig(
  args: Pick<CodexConfigArgs, "codex-home">,
): EffectiveCodexConfig {
  const codexHome = effectiveCodexHome(args);
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

function providerModeDetail(mode: CodexProviderMode, configExists: boolean): string {
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

function checkExitCode(mode: CodexProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "proxy") return 2;
  return 1;
}

function checkCodexConfig(args: Pick<CodexConfigArgs, "codex-home">): void {
  try {
    const { codexHome, configPath, configExists, providerMode } = inspectEffectiveCodexConfig(args);
    console.log(
      `Codex provider mode: ${providerMode} (${providerModeDetail(providerMode, configExists)})`,
    );
    console.log(`CODEX_HOME: ${codexHome}`);
    console.log(`config.toml: ${configPath}`);
    process.exitCode = checkExitCode(providerMode);
  } catch (e) {
    logger.error(`Codex provider check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

function resolveWriteMode(currentMode: CodexProviderMode): ManagedCodexProviderMode | null {
  if (currentMode === "direct") return "direct";
  if (currentMode === "proxy") return "proxy";
  return "direct";
}

function resolveForcedWriteMode(
  args: Pick<CodexConfigArgs, "direct" | "proxy">,
): ManagedCodexProviderMode | null {
  if (args.proxy) return "proxy";
  if (args.direct) return "direct";
  return null;
}

/**
 * `codex_config`: (re)write config at the active CODEX_HOME — an explicit
 * `--codex-home`, else the one `host_codex` set in state, else the default
 * `~/.codex`. Does NOT touch `state.codexHome`: it only refreshes config at the
 * active home, and the default `~/.codex` needs no `CODEX_HOME` override (only
 * `host_codex` sets/clears the active home). Produces no stdout.
 */
export function runCodexConfig(args: CodexConfigArgs): void {
  if (args.proxy && args.direct) {
    throw new Error("--proxy and --direct are mutually exclusive");
  }
  if (args.check) {
    checkCodexConfig(args);
    return;
  }
  const forcedMode = resolveForcedWriteMode(args);
  if (forcedMode !== null) {
    applyCodexConfig(effectiveCodexHome(args), { proxy: forcedMode === "proxy" });
    return;
  }
  const { codexHome, providerMode } = inspectEffectiveCodexConfig(args);
  const writeMode = resolveWriteMode(providerMode);
  if (writeMode === null) return;
  applyCodexConfig(codexHome, { proxy: writeMode === "proxy" });
}
