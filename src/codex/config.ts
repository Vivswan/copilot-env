// Codex config writer: points Codex at the local gateway and manages its .env token.
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

// The Codex model-provider id we manage, and the env var the gateway token
// rides under. OPENAI_API_KEY is the same OpenAI-wire name `env.ts` already
// exports, so the single token has ONE name across the shell exports and the
// Codex `.env` — Codex's load_dotenv reads $CODEX_HOME/.env and resolves
// `env_key` from it.
export const CODEX_PROVIDER_ID = "copilot-env";
export const CODEX_ENV_KEY = "OPENAI_API_KEY";

export interface CodexConfigArgs {
  "codex-home"?: string;
}

// === config.toml management ===
//
// Load-merge-stringify so user-added keys/sections survive (smol-toml does NOT
// preserve comments or whitespace — TS has no battle-tested tomlkit equivalent).
// configureCodexConfig ENFORCES every managed field on each run, so a renamed or
// added key (e.g. the env_key) propagates even into a pre-existing config.

// The single source of truth for our managed `[model_providers.copilot-env]`
// table. Re-applied on every run (managed keys win; any user-added key in the
// same table is preserved by the merge). The return type is inferred (precise
// string/boolean fields) — only the parsed user config below is `unknown`,
// because that TOML shape is arbitrary and we don't control it.
function managedProvider(baseUrl: string) {
  return {
    "name": CODEX_PROVIDER_ID,
    "base_url": baseUrl,
    "env_key": CODEX_ENV_KEY,
    "wire_api": "responses",
    "requires_openai_auth": false,
    "supports_websockets": false,
  };
}

// === wiring inspection (inverse of the write contract above) ===
//
// The read-only counterpart to configureCodexConfig: given a CODEX_HOME's raw
// config.toml/.env content, report whether Codex is wired to our local gateway.
// It lives HERE, next to managedProvider, so the provider id / env_key / table
// shape are defined once and `agent health` reuses them instead of re-parsing
// the TOML with its own copy of the contract.

export interface CodexWiringStatus {
  /** A config.toml exists at the home (false => the user never wired Codex). */
  configExists: boolean;
  /** Whatever `model_provider` is set to, for messaging. */
  modelProvider: string | null;
  /** `model_provider` selects our managed provider. */
  providerSelected: boolean;
  /** The managed provider table's `base_url`, if present. */
  baseUrl: string | null;
  /** `base_url` is a localhost URL whose effective port matches the gateway. */
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
 * Inspect raw config.toml + .env content against the managed contract. Pure (no
 * I/O): callers read the files and pass the strings (null = absent file), plus
 * whether OPENAI_API_KEY is set in the running environment (Codex's load_dotenv
 * reads $CODEX_HOME/.env, but a token already exported in the shell works too).
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
    const table = isRecord(providers) ? providers[CODEX_PROVIDER_ID] : undefined;
    const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
    status.modelProvider = modelProvider;
    status.providerSelected = modelProvider === CODEX_PROVIDER_ID;
    status.baseUrl = baseUrl;
    status.baseUrlMatches = baseUrl !== null && baseUrlMatchesGateway(baseUrl, expectedPort);
    status.envKeyMatches = isRecord(table) && table.env_key === CODEX_ENV_KEY;
    status.providerWired = status.providerSelected && status.baseUrlMatches && status.envKeyMatches;
  } catch {
    // Malformed TOML => leave everything but config/.env facts false.
  }
  return status;
}

// Seeded ONLY when no config.toml exists yet: select our gateway as the default
// provider and disable telemetry. The provider TABLE itself is injected by the
// merge (managedProvider), so it is intentionally absent here — no duplication,
// no drift.
const DEFAULT_CONFIG = `\
model_provider = "${CODEX_PROVIDER_ID}"

[analytics]
enabled = false

[feedback]
enabled = false
`;

// Load the existing config at `hostConfig`, or seed the default template when
// it is absent or unparseable.
function loadOrCreateConfig(hostConfig: string): Record<string, unknown> {
  try {
    if (fs.statSync(hostConfig).isFile()) {
      return parse(fs.readFileSync(hostConfig, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // fall through to the default template
  }
  return parse(DEFAULT_CONFIG) as Record<string, unknown>;
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

/**
 * Write the managed `config.toml` (provider section pointed at `baseUrl`) and a
 * `.env` (mode 0600) holding the API key, at `codexHome`. Returns 0 on success.
 * Exported for direct unit testing.
 */
export function configureCodexConfig(
  baseUrl: string,
  apiKey: string,
  codexHome?: string | null,
): number {
  const home = process.env.HOME || homedir();
  codexHome = codexHome || process.env.CODEX_HOME || `${home}/.codex`;

  if (!baseUrl) {
    logger.warn("Warning: base_url not provided, skipping Codex config");
    return 1;
  }

  if (!/^[A-Za-z0-9:/._-]+$/.test(baseUrl)) {
    logger.error("Error: base_url contains invalid characters");
    return 1;
  }

  try {
    fs.mkdirSync(codexHome, { recursive: true });
  } catch {
    logger.warn(`Warning: Could not create Codex config directory: ${codexHome}`);
    return 1;
  }

  const hostConfig = `${codexHome}/config.toml`;

  const doc = loadOrCreateConfig(hostConfig);

  // Enforce our managed contract on every run: select the gateway as the
  // default provider and (re)write EVERY managed field on its table —
  // overwriting a stale value (e.g. an old env_key) and filling any managed key
  // the file lacks. Spreading `existing` first preserves user-added keys in the
  // same table; other providers, the [analytics]/[feedback] sections, and any
  // unknown top-level keys are left untouched.
  doc.model_provider = CODEX_PROVIDER_ID;
  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  const existing = isRecord(providers[CODEX_PROVIDER_ID]) ? providers[CODEX_PROVIDER_ID] : {};
  providers[CODEX_PROVIDER_ID] = { ...existing, ...managedProvider(baseUrl) };
  doc.model_providers = providers;

  fs.writeFileSync(hostConfig, stringify(doc));
  logger.info(`Codex App config written to ${hostConfig}`);

  const envFile = `${codexHome}/.env`;
  writeEnvKey(envFile, apiKey);

  return 0;
}

/**
 * Resolve baseUrl/apiKey from the local gateway and write the Codex config at
 * `codexHome`. Pure config write — the caller persists CODEX_HOME to state.
 * Shared by `runCodexConfig` and codex_host's `runCodexHost`.
 */
export function applyCodexConfig(codexHome: string): void {
  const port = copilotApiResolvePort();
  const baseUrl = openaiBaseUrl(port);
  let apiKey: string;
  try {
    apiKey = new CopilotApiConfig().ensureApiKey();
  } catch (e: unknown) {
    throw new Error(`failed to persist auth token: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (configureCodexConfig(baseUrl, apiKey, codexHome) !== 0) {
    throw new Error("Codex config write failed");
  }
}

/**
 * `codex_config`: (re)write config at the active CODEX_HOME — an explicit
 * `--codex-home`, else the one `host_codex` set in state, else the default
 * `~/.codex`. Does NOT touch `state.codexHome`: it only refreshes config at the
 * active home, and the default `~/.codex` needs no `CODEX_HOME` override (only
 * `host_codex` sets/clears the active home). Produces no stdout.
 */
export function runCodexConfig(args: CodexConfigArgs): void {
  const codexHome =
    args["codex-home"] ?? new CopilotApiState().read().codexHome ?? path.join(homedir(), ".codex");
  applyCodexConfig(codexHome);
}
