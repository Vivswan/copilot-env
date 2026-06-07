import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createConsola } from "consola";
import { parse, stringify } from "smol-toml";

import { CopilotApiConfig } from "../copilot_api/config.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { CopilotApiState } from "../copilot_api/state.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// The Codex model-provider id we manage, and the env var the gateway token
// rides under. OPENAI_API_KEY is the same OpenAI-wire name `env.ts` already
// exports, so the single token has ONE name across the shell exports and the
// Codex `.env` — Codex's load_dotenv reads $CODEX_HOME/.env and resolves
// `env_key` from it.
const CODEX_PROVIDER_ID = "copilot-env";
const CODEX_ENV_KEY = "OPENAI_API_KEY";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
  fs.writeFileSync(envFile, `${CODEX_ENV_KEY}=${apiKey}\n`);
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // pass
  }

  return 0;
}

/**
 * Resolve baseUrl/apiKey from the local gateway and write the Codex config at
 * `codexHome`. Pure config write — the caller persists CODEX_HOME to state.
 * Shared by `runCodexConfig` and codex_host's `runCodexHost`.
 */
export function applyCodexConfig(codexHome: string): void {
  const port = copilotApiResolvePort();
  const baseUrl = `http://localhost:${port}/v1`;
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
export function runCodexConfig(args: { "codex-home"?: string }): void {
  const codexHome =
    args["codex-home"] ?? new CopilotApiState().read().codexHome ?? path.join(homedir(), ".codex");
  applyCodexConfig(codexHome);
}
