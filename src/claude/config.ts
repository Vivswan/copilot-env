// Claude Code config writer: wires ~/.claude/settings.json for one of two
// backends, mirroring src/codex/config.ts but adapted to how Claude consumes
// config (JSON settings.json + an apiKeyHelper script, no `model_provider`):
//
//   - direct: GitHub Copilot. apiKeyHelper -> copilot-token.sh, which execs
//     `agent auth --get` (provider-driven: gh-cli -> gh, copilot/gh-token -> stored token)
//     and env.ANTHROPIC_BASE_URL = https://api.githubcopilot.com.
//   - proxy:  the local copilot-api proxy. apiKeyHelper -> copilot-proxy-token.sh
//     (prints the proxy key) and env.ANTHROPIC_BASE_URL = http://localhost:<port>.
//
// `agent env` re-exports ANTHROPIC_BASE_URL only for the proxy backend (to keep
// the shell aligned with the live proxy port); direct is driven entirely by
// settings.json. Mode is inferred from which managed apiKeyHelper (by EXACT path)
// settings.json points at. The merge is surgical: only the managed keys are
// touched; all other settings are preserved.
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import {
  assertSingleMode,
  CLAUDE_PROBE,
  type DirectProbeDeps,
  probeDirectWorks,
  resolveDirectMode,
} from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
} from "../utils/provider_mode.ts";
import { AGENT_AUTH_GET_ARGS, agentLauncherCommand } from "../utils/root.ts";

const logger = createStderrLogger();

// The direct (GitHub Copilot) contract. One block so it is easy to adjust if
// Copilot's Anthropic-compatible endpoint needs a different base URL/path or
// extra headers. NOTE: Copilot-serving-Claude is not officially documented;
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is treated as a tested knob.
export const DIRECT_BASE_URL = "https://api.githubcopilot.com";
export const DIRECT_HELPER_NAME = "copilot-token.sh";
export const PROXY_HELPER_NAME = "copilot-proxy-token.sh";
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";

/** Single-quote a string for safe embedding in a /bin/sh command line. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The direct apiKeyHelper body: print the Direct credential on stdout. Claude runs
 * apiKeyHelper via /bin/sh and uses its stdout as the credential. We exec
 * `agent auth --get`, the provider-driven resolver (gh-cli -> gh, else the stored token), so
 * the token is never baked into this script -- it lives only in the state store.
 */
function directHelperScript(): string {
  const { command, args } = agentLauncherCommand(AGENT_AUTH_GET_ARGS);
  const line = [command, ...args].map(shQuote).join(" ");
  return `#!/bin/sh\nexec ${line}\n`;
}

/**
 * True iff `helperBody` is exactly the managed direct helper (execs `agent auth
 * --get`). Health uses this to POSITIVELY confirm Direct resolves via the managed
 * launcher before deciding gh is unneeded -- a stale `gh auth token` helper, a
 * foreign script, or a missing file returns false and stays on the gh-checked path.
 */
export function directHelperResolvesViaAgent(helperBody: string | null): boolean {
  return helperBody !== null && helperBody === directHelperScript();
}

export interface ClaudeConfigArgs {
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
}

export interface ClaudeWiringStatus {
  /** settings.json exists. */
  settingsExists: boolean;
  /** Path to the configured `apiKeyHelper` script, for messaging (not a secret). */
  helperPath: string | null;
  /** `env.ANTHROPIC_BASE_URL`, if present. */
  baseUrl: string | null;
  /** Which backend the current settings select. */
  providerMode: AgentProviderMode;
}

// --- paths ------------------------------------------------------------------

/**
 * Resolve the effective Claude home: `$CLAUDE_CONFIG_DIR` (Claude Code's own
 * override), else `~/.claude` (`%USERPROFILE%\.claude` on Windows). This is the
 * single knob -- there is no per-command override flag.
 */
export function resolveClaudeHome(): string {
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
 *   - proxy:  apiKeyHelper === <home>/copilot-proxy-token.sh
 *   - other:  a foreign apiKeyHelper, a custom ANTHROPIC_BASE_URL, or malformed
 *             JSON (a config we must not clobber)
 *   - none:   no relevant keys (absent/empty) -- unconfigured; proxy is default
 */
export function inspectClaudeWiring(
  settingsText: string | null,
  claudeHome: string,
): ClaudeWiringStatus {
  const status: ClaudeWiringStatus = {
    settingsExists: settingsText !== null,
    helperPath: null,
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

  // `apiKeyHelper` in Claude's settings.json is a PATH to a token-printing script,
  // not a secret. Read it via readStringField (keyed access, no literal
  // `.apiKeyHelper` at the read site) so it isn't misclassified as a logged credential.
  const helperPath = readStringField(doc, "apiKeyHelper");
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl = env ? readStringField(env, BASE_URL_ENV) : null;
  status.helperPath = helperPath;
  status.baseUrl = baseUrl;

  if (helperPath === directHelperPath(claudeHome)) {
    status.providerMode = "direct";
  } else if (helperPath === proxyHelperPath(claudeHome)) {
    status.providerMode = "proxy";
  } else if (helperPath !== null || baseUrl !== null) {
    // A foreign apiKeyHelper or a custom base URL the user set -- not ours.
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
    // pass (e.g. Windows) -- the exec bit is best-effort.
  }
}

/** Set the managed `env` keys in place (preserving any other env vars). */
function applyManagedEnv(doc: Record<string, unknown>, mode: ManagedAgentMode, baseUrl: string) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
  // Disabling betas is a direct-only knob (the proxy speaks full Anthropic).
  if (mode === "direct") env[DISABLE_BETAS_ENV] = "1";
  else delete env[DISABLE_BETAS_ENV];
  doc.env = env;
}

/**
 * Apply the managed Claude wiring at `claudeHome`. Direct writes the apiKeyHelper
 * that execs `agent auth --get` (the single credential resolver) + the Copilot
 * base URL; proxy resolves the local proxy port + token, writes a helper that
 * prints that token, and points the base URL at localhost. Either way the merge
 * is surgical (only managed keys change) and the OTHER mode's settings are
 * overwritten so switching modes is clean. Throws on an unwritable home /
 * malformed settings.json / unresolvable proxy token.
 */
export function configureClaudeConfig(
  claudeHome: string,
  mode: ManagedAgentMode,
  quiet = false,
): void {
  try {
    fs.mkdirSync(claudeHome, { recursive: true });
  } catch (e) {
    throw new Error(`could not create Claude config directory ${claudeHome}: ${errMessage(e)}`);
  }

  const settingsPath = settingsPathFor(claudeHome);
  const doc = loadSettings(settingsPath);

  if (mode === "direct") {
    // The helper execs `agent auth --get`; the token is never baked here.
    writeHelperScript(directHelperPath(claudeHome), directHelperScript());
    doc.apiKeyHelper = directHelperPath(claudeHome);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL);
    saveSettings(settingsPath, doc);
    if (!quiet) {
      logger.log(`  ✓ Claude config written → ${settingsPath} (direct: GitHub Copilot)`);
    }
    return;
  }

  // proxy: resolve the local proxy endpoint + token and write a helper that
  // prints the token (kept out of settings.json, chmod 0700 like Codex's .env).
  const port = copilotApiResolvePort();
  let token: string;
  try {
    token = new CopilotApiConfig().ensureApiKey();
  } catch (e) {
    throw new Error(`failed to persist the proxy auth token: ${errMessage(e)}`);
  }
  writeHelperScript(proxyHelperPath(claudeHome), literalTokenHelperScript(token));
  doc.apiKeyHelper = proxyHelperPath(claudeHome);
  applyManagedEnv(doc, "proxy", `http://localhost:${port}`);
  saveSettings(settingsPath, doc);
  if (!quiet) {
    logger.log(`  ✓ Claude config written → ${settingsPath} (proxy mode → port ${port})`);
  }
}

// The managed literal-token helper shape: `#!/bin/sh` + a `printf '%s' '<token>'`
// line. Used for the PROXY helper (which prints the local proxy key verbatim);
// the direct helper instead execs `agent auth --get` (see directHelperScript).
const TOKEN_HELPER_PREFIX = "#!/bin/sh\nprintf '%s' '";

/** An apiKeyHelper that prints a literal token verbatim on stdout (the proxy key). */
function literalTokenHelperScript(token: string): string {
  const escaped = token.replace(/'/g, `'\\''`); // single-quote-safe for /bin/sh
  return `${TOKEN_HELPER_PREFIX}${escaped}'\n`;
}

// --- the `--check` provider report ------------------------------------------

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function providerModeDetail(mode: AgentProviderMode): string {
  switch (mode) {
    case "direct":
      return "GitHub Copilot Direct";
    case "proxy":
      return "local copilot-api proxy";
    case "other":
      return "custom Claude provider (not managed)";
    case "none":
      return "not configured (proxy is the default)";
  }
}

/** Exit-code contract for `--check`, consumed by the `cl` launcher. */
function checkClaudeConfig(): void {
  const claudeHome = resolveClaudeHome();
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome);
  console.log(
    `Claude provider mode: ${status.providerMode} (${providerModeDetail(status.providerMode)})`,
  );
  console.log(`settings.json: ${settingsPath}`);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    console.log(`apiKeyHelper: ${status.helperPath}`);
    console.log(`${BASE_URL_ENV}: ${status.baseUrl}`);
  }
  process.exitCode = providerModeExitCode(status.providerMode);
}

/**
 * Live auto-detect: does GitHub Copilot Direct work for Claude on this machine?
 * Writes a throwaway direct config (settings.json + gh apiKeyHelper) and runs
 * `claude -p` against it (see src/utils/direct_probe.ts). False => write proxy.
 */
export function detectClaudeDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CLAUDE_PROBE,
    (tmpHome) => {
      configureClaudeConfig(tmpHome, "direct", true);
    },
    deps,
  );
}

/**
 * `agent claude`: configure Claude Code's wiring at the effective Claude home
 * ($CLAUDE_CONFIG_DIR, else ~/.claude). `--direct` forces GitHub Copilot Direct,
 * `--proxy` forces the local proxy, and with no mode flag it auto-detects (live
 * `claude -p` probe, else the proxy). A GitHub token provisioned via `agent auth`
 * (in the shared store) selects Direct without probing when no mode flag is given.
 * `--check` reports the configured mode (exit 0 direct / 2 proxy|none / 1 other)
 * without a probe.
 */
export function runClaude(args: ClaudeConfigArgs): void {
  assertSingleMode(args);
  if (args.check) {
    checkClaudeConfig();
    return;
  }
  const claudeHome = resolveClaudeHome();
  // A configured credential (`agent auth`) selects Direct without a live probe.
  // Resolve it provider-aware (gh-cli -> gh, copilot/gh-token -> stored token, none ->
  // null); the helper re-resolves at fetch time via `agent auth --get`.
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args, ghToken, detectClaudeDirect);
  logger.log(
    `  Configuring Claude for ${direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"} …`,
  );
  configureClaudeConfig(claudeHome, direct ? "direct" : "proxy");
}

/** The configured Claude provider mode at the effective Claude home (read-only). */
export function effectiveClaudeProviderMode(): AgentProviderMode {
  const claudeHome = resolveClaudeHome();
  return inspectClaudeWiring(readTextOrNull(settingsPathFor(claudeHome)), claudeHome).providerMode;
}
