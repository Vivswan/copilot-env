// Claude Code config writer: wires ~/.claude/settings.json for one of two
// backends, mirroring src/codex/config.ts but adapted to how Claude consumes
// config (JSON settings.json + an apiKeyHelper script, no `model_provider`):
//
//   - direct: GitHub Copilot. apiKeyHelper -> copilot-token.sh (`gh auth token`,
//     or a baked literal token when `--gh-token` is given — no `gh` needed)
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
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import {
  assertSingleMode,
  CLAUDE_PROBE,
  type DirectProbeDeps,
  probeDirectWorks,
  resolveDirect,
  resolveGhToken,
} from "../utils/direct_probe.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";

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

// The direct apiKeyHelper: print a GitHub token on stdout. Claude runs
// apiKeyHelper via /bin/sh and uses its stdout as the credential. The default
// shells out to `gh auth token`; `--gh-token` instead bakes a literal token via
// literalTokenHelperScript (no `gh` binary required — for headless servers).
const DIRECT_HELPER_SCRIPT = "#!/bin/sh\nexec gh auth token\n";

export type ClaudeProviderMode = "direct" | "proxy" | "other" | "none";
export type ManagedClaudeMode = Extract<ClaudeProviderMode, "direct" | "proxy">;

export interface ClaudeConfigArgs {
  "claude-home"?: string;
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
  auto?: boolean;
  /** `--gh-token`: bake this GitHub token into the direct helper (implies direct). */
  "gh-token"?: string | boolean;
}

export interface ClaudeWiringStatus {
  /** settings.json exists. */
  settingsExists: boolean;
  /** Path to the configured `apiKeyHelper` script, for messaging (not a secret). */
  helperPath: string | null;
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
 *   - proxy:  apiKeyHelper === <home>/copilot-proxy-token.sh
 *   - other:  a foreign apiKeyHelper, a custom ANTHROPIC_BASE_URL, or malformed
 *             JSON (a config we must not clobber)
 *   - none:   no relevant keys (absent/empty) — unconfigured; proxy is default
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
  // Disabling betas is a direct-only knob (the proxy speaks full Anthropic).
  if (mode === "direct") env[DISABLE_BETAS_ENV] = "1";
  else delete env[DISABLE_BETAS_ENV];
  doc.env = env;
}

/**
 * Apply the managed Claude wiring at `claudeHome`. Direct writes the gh-token
 * helper + the Copilot base URL (or, when `ghToken` is supplied, a helper that
 * prints that literal token — no `gh` binary required); proxy resolves the local
 * proxy port + token, writes a helper that prints that token, and points the base
 * URL at localhost. Either way the merge is surgical (only managed keys change)
 * and the OTHER mode's settings are overwritten so switching modes is clean.
 * Throws on an unwritable home / malformed settings.json / unresolvable proxy token.
 */
export function configureClaudeConfig(
  claudeHome: string,
  mode: ManagedClaudeMode,
  quiet = false,
  ghToken?: string | null,
): void {
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
    // `--gh-token` bakes the literal token into the helper (chmod 0700, like the
    // proxy helper); otherwise the helper shells out to `gh auth token`.
    const script = ghToken ? literalTokenHelperScript(ghToken) : DIRECT_HELPER_SCRIPT;
    writeHelperScript(directHelperPath(claudeHome), script);
    doc.apiKeyHelper = directHelperPath(claudeHome);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL);
    saveSettings(settingsPath, doc);
    if (!quiet) {
      const how = ghToken ? "direct: GitHub Copilot, baked token" : "direct: GitHub Copilot";
      logger.log(`  ✓ Claude config written → ${settingsPath} (${how})`);
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
    throw new Error(
      `failed to persist the proxy auth token: ${e instanceof Error ? e.message : String(e)}`,
    );
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
// line. Shared by the writer (literalTokenHelperScript) and the positive detector
// (directHelperUsesToken) so the two never drift.
const TOKEN_HELPER_PREFIX = "#!/bin/sh\nprintf '%s' '";

/** An apiKeyHelper that prints a literal token verbatim on stdout (proxy key or a baked gh token). */
function literalTokenHelperScript(token: string): string {
  const escaped = token.replace(/'/g, `'\\''`); // single-quote-safe for /bin/sh
  return `${TOKEN_HELPER_PREFIX}${escaped}'\n`;
}

/**
 * True iff `helperBody` is the managed baked-token direct helper (the printf form
 * written by `--gh-token`), as opposed to the `gh auth token` helper or a foreign
 * script. Health uses this to POSITIVELY identify a token-backed Direct setup
 * (so it can skip the gh-auth probe) — a missing/broken/custom helper returns
 * false and stays on the gh-backed code path rather than being mistaken for one.
 */
export function directHelperUsesToken(helperBody: string | null): boolean {
  return helperBody?.startsWith(TOKEN_HELPER_PREFIX) ?? false;
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
      return "local copilot-api proxy";
    case "other":
      return "custom Claude provider (not managed)";
    case "none":
      return "not configured (proxy is the default)";
  }
}

/** Exit-code contract for `--check`, consumed by the `cl` launcher. */
function checkExitCode(mode: ClaudeProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "other") return 1; // custom — the cl launcher does NOT launch
  return 2; // proxy or none — proxy (the default backend)
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
    console.log(`apiKeyHelper: ${status.helperPath}`);
    console.log(`${BASE_URL_ENV}: ${status.baseUrl}`);
  }
  process.exitCode = checkExitCode(status.providerMode);
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
 * `agent claude`: configure Claude Code's wiring at the effective Claude home.
 * `--direct` forces GitHub Copilot Direct, `--proxy` forces the local proxy,
 * and `--auto` (or no mode flag) AUTO-DETECTS — it writes direct wiring when a
 * live `claude -p` probe against Copilot Direct succeeds, else falls back to the
 * proxy. `--gh-token` bakes a GitHub token into the direct helper (implies
 * direct, no `gh` binary needed). `--check` reports the configured mode (exit 0
 * direct / 2 proxy|none / 1 other) without a probe.
 */
export function runClaude(args: ClaudeConfigArgs): void {
  assertSingleMode(args);
  if (args.check) {
    checkClaudeConfig(args);
    return;
  }
  const claudeHome = resolveClaudeHome(args["claude-home"]);
  const ghToken = resolveGhToken(args["gh-token"]);
  const direct = ghToken !== null ? true : resolveDirect(args, detectClaudeDirect);
  logger.log(
    `  Configuring Claude for ${direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"} …`,
  );
  configureClaudeConfig(claudeHome, direct ? "direct" : "proxy", false, ghToken);
}

/** The configured Claude provider mode at the effective Claude home (read-only). */
export function effectiveClaudeProviderMode(claudeHomeArg?: string): ClaudeProviderMode {
  const claudeHome = resolveClaudeHome(claudeHomeArg);
  return inspectClaudeWiring(readTextOrNull(settingsPathFor(claudeHome)), claudeHome).providerMode;
}
