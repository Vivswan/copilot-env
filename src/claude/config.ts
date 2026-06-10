// Claude Code config writer: wires ~/.claude/settings.json for one of two
// backends, mirroring src/codex/config.ts but adapted to how Claude consumes
// config (JSON settings.json + an apiKeyHelper script, no `model_provider`):
//
//   - direct: GitHub Copilot. apiKeyHelper -> copilot-token.sh (`gh auth token`)
//     and env.ANTHROPIC_BASE_URL = https://api.githubcopilot.com.
//   - proxy:  the local copilot-api gateway. apiKeyHelper -> copilot-gateway-token.sh
//     (prints the gateway key) and env.ANTHROPIC_BASE_URL = http://localhost:<port>.
//
// `agent env` no longer exports ANTHROPIC_*, so BOTH backends are driven entirely
// by settings.json (the gateway is Claude's default — a never-configured `cl`
// gets proxy wiring written for it). Mode is inferred from which managed
// apiKeyHelper (by EXACT path) settings.json points at. The merge is surgical:
// only the managed keys are touched; all other settings are preserved.
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createConsola } from "consola";

import { CopilotApiConfig } from "../copilot_api/config.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// The direct (GitHub Copilot) contract. One block so it is easy to adjust if
// Copilot's Anthropic-compatible endpoint needs a different base URL/path or
// extra headers. NOTE: Copilot-serving-Claude is not officially documented;
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is treated as a tested knob.
export const DIRECT_BASE_URL = "https://api.githubcopilot.com";
export const DIRECT_HELPER_NAME = "copilot-token.sh";
export const PROXY_HELPER_NAME = "copilot-gateway-token.sh";
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";

// The direct apiKeyHelper: print a GitHub token on stdout. Claude runs
// apiKeyHelper via /bin/sh and uses its stdout as the credential.
const DIRECT_HELPER_SCRIPT = "#!/bin/sh\nexec gh auth token\n";

export type ClaudeProviderMode = "direct" | "proxy" | "other" | "none";
export type ManagedClaudeMode = Extract<ClaudeProviderMode, "direct" | "proxy">;

export interface ClaudeConfigArgs {
  "claude-home"?: string;
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
}

export interface ClaudeWiringStatus {
  /** settings.json exists. */
  settingsExists: boolean;
  /** Whatever `apiKeyHelper` is set to, for messaging. */
  apiKeyHelper: string | null;
  /** `env.ANTHROPIC_BASE_URL`, if present. */
  baseUrl: string | null;
  /** Which backend the current settings select. */
  providerMode: ClaudeProviderMode;
}

// --- paths ------------------------------------------------------------------

/**
 * Resolve the effective Claude home: an explicit `--claude-home`, else
 * $CLAUDE_CONFIG_DIR (Claude Code's own override), else ~/.claude
 * (%USERPROFILE%\.claude on Windows).
 */
export function resolveClaudeHome(arg?: string | null): string {
  if (arg) return arg;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(process.env.HOME || homedir(), ".claude");
}

function settingsPathFor(claudeHome: string): string {
  return path.join(claudeHome, "settings.json");
}

function directHelperPath(claudeHome: string): string {
  return path.join(claudeHome, DIRECT_HELPER_NAME);
}

function proxyHelperPath(claudeHome: string): string {
  return path.join(claudeHome, PROXY_HELPER_NAME);
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * Inspect raw settings.json content against the managed contract. Pure (no I/O):
 * the caller passes the file text (null = absent) plus the home, from which the
 * two managed helper paths are derived. Mode is keyed off the EXACT apiKeyHelper
 * path so a user's own same-named helper is never mistaken for ours:
 *   - direct: apiKeyHelper === <home>/copilot-token.sh
 *   - proxy:  apiKeyHelper === <home>/copilot-gateway-token.sh
 *   - other:  a foreign apiKeyHelper, a custom ANTHROPIC_BASE_URL, or malformed
 *             JSON (a config we must not clobber)
 *   - none:   no relevant keys (absent/empty) — unconfigured; gateway is default
 */
export function inspectClaudeWiring(
  settingsText: string | null,
  claudeHome: string,
): ClaudeWiringStatus {
  const status: ClaudeWiringStatus = {
    settingsExists: settingsText !== null,
    apiKeyHelper: null,
    baseUrl: null,
    providerMode: "none",
  };
  if (settingsText === null || settingsText.trim() === "") return status;

  const doc = parseJsonRecord(settingsText);
  if (doc === null) {
    // Present but unparseable: we can't manage it, so leave it alone (other).
    status.providerMode = "other";
    return status;
  }

  const apiKeyHelper = typeof doc.apiKeyHelper === "string" ? doc.apiKeyHelper : null;
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl =
    env && typeof env[BASE_URL_ENV] === "string" ? (env[BASE_URL_ENV] as string) : null;
  status.apiKeyHelper = apiKeyHelper;
  status.baseUrl = baseUrl;

  if (apiKeyHelper === directHelperPath(claudeHome)) {
    status.providerMode = "direct";
  } else if (apiKeyHelper === proxyHelperPath(claudeHome)) {
    status.providerMode = "proxy";
  } else if (apiKeyHelper !== null || baseUrl !== null) {
    // A foreign apiKeyHelper or a custom base URL the user set — not ours.
    status.providerMode = "other";
  }
  return status;
}

// --- config writes ----------------------------------------------------------

/**
 * Load settings.json as a record. Missing or empty => {}. A present-but-malformed
 * file throws rather than letting us clobber settings we couldn't read.
 */
function loadSettings(settingsPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    throw e;
  }
  if (text.trim() === "") return {};
  const doc = parseJsonRecord(text);
  if (doc === null) {
    throw new Error(`${settingsPath} is not valid JSON; refusing to overwrite it`);
  }
  return doc;
}

function saveSettings(settingsPath: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Write a managed apiKeyHelper script (prints a token on stdout), chmod 0700. */
function writeHelperScript(helperPath: string, script: string): void {
  fs.writeFileSync(helperPath, script);
  try {
    fs.chmodSync(helperPath, 0o700);
  } catch {
    // pass (e.g. Windows) — the exec bit is best-effort.
  }
}

/** Set the managed `env` keys in place (preserving any other env vars). */
function applyManagedEnv(doc: Record<string, unknown>, mode: ManagedClaudeMode, baseUrl: string) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
  // Disabling betas is a direct-only knob (the gateway speaks full Anthropic).
  if (mode === "direct") env[DISABLE_BETAS_ENV] = "1";
  else delete env[DISABLE_BETAS_ENV];
  doc.env = env;
}

/**
 * Apply the managed Claude wiring at `claudeHome`. Direct writes the gh-token
 * helper + the Copilot base URL; proxy resolves the local gateway port + token,
 * writes a helper that prints that token, and points the base URL at localhost.
 * Either way the merge is surgical (only managed keys change) and the OTHER
 * mode's settings are overwritten so switching modes is clean. Throws on an
 * unwritable home / malformed settings.json / unresolvable gateway token.
 */
export function configureClaudeConfig(claudeHome: string, mode: ManagedClaudeMode): void {
  try {
    fs.mkdirSync(claudeHome, { recursive: true });
  } catch (e) {
    throw new Error(
      `could not create Claude config directory ${claudeHome}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const settingsPath = settingsPathFor(claudeHome);
  const doc = loadSettings(settingsPath);

  if (mode === "direct") {
    writeHelperScript(directHelperPath(claudeHome), DIRECT_HELPER_SCRIPT);
    doc.apiKeyHelper = directHelperPath(claudeHome);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL);
    saveSettings(settingsPath, doc);
    logger.info(`Claude config written to ${settingsPath} (direct: GitHub Copilot)`);
    return;
  }

  // proxy: resolve the local gateway endpoint + token and write a helper that
  // prints the token (kept out of settings.json, chmod 0700 like Codex's .env).
  const port = copilotApiResolvePort();
  let token: string;
  try {
    token = new CopilotApiConfig().ensureApiKey();
  } catch (e) {
    throw new Error(
      `failed to persist the gateway auth token: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  writeHelperScript(proxyHelperPath(claudeHome), proxyHelperScript(token));
  doc.apiKeyHelper = proxyHelperPath(claudeHome);
  applyManagedEnv(doc, "proxy", `http://localhost:${port}`);
  saveSettings(settingsPath, doc);
  logger.info(`Claude config written to ${settingsPath} (proxy: local gateway on port ${port})`);
}

/** The proxy apiKeyHelper: print the resolved gateway token verbatim on stdout. */
function proxyHelperScript(token: string): string {
  const escaped = token.replace(/'/g, `'\\''`); // single-quote-safe for /bin/sh
  return `#!/bin/sh\nprintf '%s' '${escaped}'\n`;
}

// --- the `--check` provider report ------------------------------------------

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function providerModeDetail(mode: ClaudeProviderMode): string {
  switch (mode) {
    case "direct":
      return "GitHub Copilot Direct";
    case "proxy":
      return "local copilot-api gateway";
    case "other":
      return "custom Claude provider (not managed)";
    case "none":
      return "not configured (gateway is the default)";
  }
}

/** Exit-code contract for `--check`, consumed by the `cl` launcher. */
function checkExitCode(mode: ClaudeProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "other") return 1; // custom — the cl launcher does NOT launch
  return 2; // proxy or none — gateway (the default backend)
}

function checkClaudeConfig(args: Pick<ClaudeConfigArgs, "claude-home">): void {
  const claudeHome = resolveClaudeHome(args["claude-home"]);
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome);
  console.log(
    `Claude provider mode: ${status.providerMode} (${providerModeDetail(status.providerMode)})`,
  );
  console.log(`settings.json: ${settingsPath}`);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    console.log(`apiKeyHelper: ${status.apiKeyHelper}`);
    console.log(`${BASE_URL_ENV}: ${status.baseUrl}`);
  }
  process.exitCode = checkExitCode(status.providerMode);
}

/**
 * `setup-claude-config`: configure Claude Code's wiring at the effective Claude
 * home. `--direct` forces GitHub Copilot Direct, `--proxy` forces the gateway,
 * `--check` reports the mode (exit 0 direct / 2 proxy|none / 1 other). With no
 * flag (the `cl` pre-launch refresh): re-assert the current managed mode, and
 * default a never-configured home to proxy — the gateway is Claude's default
 * backend. A custom (foreign) config is left untouched.
 */
export function runClaudeConfig(args: ClaudeConfigArgs): void {
  if (args.proxy && args.direct) {
    throw new Error("--proxy and --direct are mutually exclusive");
  }
  if (args.check) {
    checkClaudeConfig(args);
    return;
  }
  const claudeHome = resolveClaudeHome(args["claude-home"]);
  if (args.direct) {
    configureClaudeConfig(claudeHome, "direct");
    return;
  }
  if (args.proxy) {
    configureClaudeConfig(claudeHome, "proxy");
    return;
  }
  // No flag: idempotent refresh. Re-assert the active managed mode; a never-
  // configured home defaults to proxy (gateway); a custom config is left alone.
  const mode = inspectClaudeWiring(
    readTextOrNull(settingsPathFor(claudeHome)),
    claudeHome,
  ).providerMode;
  if (mode === "direct") configureClaudeConfig(claudeHome, "direct");
  else if (mode === "proxy" || mode === "none") configureClaudeConfig(claudeHome, "proxy");
}
