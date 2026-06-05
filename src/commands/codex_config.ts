import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createConsola } from "consola";
import { parse, stringify } from "smol-toml";

import { CopilotApiConfig } from "../copilot_api/config.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { CopilotApiState } from "../copilot_api/state.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// === config.toml management ===
//
// Load-mutate-stringify so user-added keys/sections survive. smol-toml does
// NOT preserve comments or whitespace formatting — TS has no battle-tested
// equivalent of Python's tomlkit. Unknown top-level keys are preserved.

const DEFAULT_CONFIG = `\
model_provider = "copilot-api"

[model_providers.copilot-api]
name = "copilot-api gateway"
base_url = "{base_url}"
env_key = "COPILOT_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[analytics]
enabled = false

[feedback]
enabled = false
`;

function formatDefaultConfig(baseUrl: string): string {
  return DEFAULT_CONFIG.replace("{base_url}", baseUrl);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Load the existing config at `hostConfig`, or fall back to the default
// template. A parse failure also falls back to the template.
function loadOrCreateConfig(hostConfig: string, baseUrl: string): Record<string, unknown> {
  try {
    if (fs.statSync(hostConfig).isFile()) {
      return parse(fs.readFileSync(hostConfig, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // fall through to the default template
  }
  return parse(formatDefaultConfig(baseUrl)) as Record<string, unknown>;
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

  let doc = loadOrCreateConfig(hostConfig, baseUrl);

  // Surgically set model_providers."copilot-api".base_url, replacing the
  // whole document only when our managed provider section is absent.
  const providers = doc.model_providers;
  if (!isRecord(providers) || !isRecord(providers["copilot-api"])) {
    doc = parse(formatDefaultConfig(baseUrl)) as Record<string, unknown>;
  } else {
    (providers["copilot-api"] as Record<string, unknown>).base_url = baseUrl;
  }

  fs.writeFileSync(hostConfig, stringify(doc));
  logger.info(`Codex App config written to ${hostConfig}`);

  const envFile = `${codexHome}/.env`;
  fs.writeFileSync(envFile, `COPILOT_API_KEY=${apiKey}\n`);
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
