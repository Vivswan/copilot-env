// Claude Code config writer: points Claude Code at GitHub Copilot directly by
// default (a managed apiKeyHelper + ANTHROPIC_BASE_URL in ~/.claude/settings.json),
// with the local copilot-api gateway available as the implicit "proxy" mode.
//
// Mirrors src/codex/config.ts, but adapts to how Claude Code consumes config:
//   - Claude reads JSON settings.json (not TOML), so the surgical merge is JSON.
//   - There is no Codex-style `model_provider` selector, so "direct" is detected
//     by the presence of OUR managed apiKeyHelper (basename copilot-token.sh).
//   - Claude's shell env wins over settings.json `env`, and the local gateway is
//     Claude's default backend, so the not-direct/not-foreign state is "proxy"
//     (a never-configured user still gets the gateway via the `cl` launcher).
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createConsola } from "consola";

import { isRecord, parseJsonRecord } from "../utils/json.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// The direct (GitHub Copilot) contract. These live in one block so they are easy
// to adjust if Copilot's Anthropic-compatible endpoint needs a different base
// URL/path or extra headers. NOTE: Copilot-serving-Claude is not officially
// documented; CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is treated as a tested knob.
export const DIRECT_BASE_URL = "https://api.githubcopilot.com";
export const MANAGED_HELPER_NAME = "copilot-token.sh";
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";

// The managed apiKeyHelper script: prints a GitHub token on stdout. Claude runs
// apiKeyHelper via /bin/sh and uses its stdout as the credential (sent as both
// Authorization: Bearer and X-Api-Key).
const HELPER_SCRIPT = "#!/bin/sh\nexec gh auth token\n";

export type ClaudeProviderMode = "direct" | "proxy" | "other";
export type ManagedClaudeMode = Extract<ClaudeProviderMode, "direct" | "proxy">;

export interface ClaudeConfigArgs {
  "claude-home"?: string;
  check?: boolean;
  direct?: boolean;
  proxy?: boolean;
}

export interface ClaudeWiringStatus {
  /** settings.json exists (false => Claude never wired => proxy default). */
  settingsExists: boolean;
  /** Whatever `apiKeyHelper` is set to, for messaging. */
  apiKeyHelper: string | null;
  /** `apiKeyHelper` is OUR managed copilot-token.sh. */
  helperIsManaged: boolean;
  /** `env.ANTHROPIC_BASE_URL`, if present. */
  baseUrl: string | null;
  /** `env.ANTHROPIC_BASE_URL` is the managed Copilot endpoint. */
  baseUrlIsManaged: boolean;
  /** Which provider family the current settings select. */
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

export function claudeHelperPath(claudeHome: string): string {
  return path.join(claudeHome, MANAGED_HELPER_NAME);
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * Inspect raw settings.json content against the managed contract. Pure (no I/O):
 * the caller reads the file and passes the string (null = absent file) plus the
 * exact managed helper path (`<home>/copilot-token.sh`). "direct" is OUR managed
 * apiKeyHelper at that exact path; a foreign apiKeyHelper (even one that happens
 * to share the basename) or a non-managed ANTHROPIC_BASE_URL is "other"; anything
 * else (incl. absent/empty) is "proxy" (the gateway is Claude's default backend).
 * Malformed JSON reads as "other" so we never treat a file we can't manage as wired.
 */
export function inspectClaudeWiring(
  settingsText: string | null,
  managedHelperPath: string,
): ClaudeWiringStatus {
  const status: ClaudeWiringStatus = {
    settingsExists: settingsText !== null,
    apiKeyHelper: null,
    helperIsManaged: false,
    baseUrl: null,
    baseUrlIsManaged: false,
    providerMode: "proxy",
  };
  if (settingsText === null || settingsText.trim() === "") return status;

  const doc = parseJsonRecord(settingsText);
  if (doc === null) {
    // Present but unparseable: we can't manage it, so report it as foreign.
    status.providerMode = "other";
    return status;
  }

  const apiKeyHelper = typeof doc.apiKeyHelper === "string" ? doc.apiKeyHelper : null;
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl =
    env && typeof env[BASE_URL_ENV] === "string" ? (env[BASE_URL_ENV] as string) : null;

  status.apiKeyHelper = apiKeyHelper;
  // Exact-path match: a user's own /opt/.../copilot-token.sh is NOT ours.
  status.helperIsManaged = apiKeyHelper !== null && apiKeyHelper === managedHelperPath;
  status.baseUrl = baseUrl;
  status.baseUrlIsManaged = baseUrl === DIRECT_BASE_URL;

  if (status.helperIsManaged) {
    status.providerMode = "direct";
  } else if (apiKeyHelper !== null || (baseUrl !== null && !status.baseUrlIsManaged)) {
    // A foreign apiKeyHelper, or a non-managed ANTHROPIC_BASE_URL the user set —
    // leave it alone (don't clobber a custom provider).
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

/**
 * Apply the managed Claude wiring at `claudeHome`. Direct mode writes the managed
 * apiKeyHelper + the copilot-token.sh script + the managed `env` keys; proxy mode
 * REMOVES only those managed keys (the gateway env exported by the shell drives
 * proxy at runtime, and shell env wins over settings.json). Every unrelated
 * setting is preserved. Throws on an unwritable home / malformed settings.json.
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
  const helperPath = claudeHelperPath(claudeHome);
  const doc = loadSettings(settingsPath);

  if (mode === "direct") {
    doc.apiKeyHelper = helperPath;
    const env = isRecord(doc.env) ? doc.env : {};
    env[BASE_URL_ENV] = DIRECT_BASE_URL;
    env[DISABLE_BETAS_ENV] = "1";
    doc.env = env;
    saveSettings(settingsPath, doc);

    // The token helper: print a gh token on stdout. Re-written on every direct
    // run (idempotent). chmod failures (e.g. Windows) are non-fatal.
    fs.writeFileSync(helperPath, HELPER_SCRIPT);
    try {
      fs.chmodSync(helperPath, 0o700);
    } catch {
      // pass
    }
    logger.info(`Claude config written to ${settingsPath} (direct: GitHub Copilot)`);
    return;
  }

  // proxy: strip only OUR managed direct markers (exact helper-path match, so a
  // user's own same-named helper is never deleted); leave everything else (and the
  // helper script on disk, which is harmless).
  if (typeof doc.apiKeyHelper === "string" && doc.apiKeyHelper === helperPath) {
    delete doc.apiKeyHelper;
  }
  if (isRecord(doc.env)) {
    if (doc.env[BASE_URL_ENV] === DIRECT_BASE_URL) delete doc.env[BASE_URL_ENV];
    if (doc.env[DISABLE_BETAS_ENV] === "1") delete doc.env[DISABLE_BETAS_ENV];
    if (Object.keys(doc.env).length === 0) delete doc.env;
  }
  saveSettings(settingsPath, doc);
  logger.info(
    `Claude config set to gateway (proxy) at ${settingsPath}; removed managed direct wiring`,
  );
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
      return "local copilot-api gateway (default)";
    case "other":
      return "custom Claude provider (not managed)";
  }
}

/** Exit-code contract for `--check`, consumed by the `cl` launcher. */
function checkExitCode(mode: ClaudeProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "proxy") return 2;
  return 1; // other / custom — the cl launcher does NOT launch on this
}

function checkClaudeConfig(args: Pick<ClaudeConfigArgs, "claude-home">): void {
  const claudeHome = resolveClaudeHome(args["claude-home"]);
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHelperPath(claudeHome));
  console.log(
    `Claude provider mode: ${status.providerMode} (${providerModeDetail(status.providerMode)})`,
  );
  console.log(`settings.json: ${settingsPath}`);
  if (status.providerMode === "direct") {
    console.log(`apiKeyHelper: ${claudeHelperPath(claudeHome)}`);
    console.log(`${BASE_URL_ENV}: ${DIRECT_BASE_URL}`);
  }
  process.exitCode = checkExitCode(status.providerMode);
}

/**
 * `setup-claude-config`: configure Claude Code's wiring at the effective Claude
 * home. `--direct` forces GitHub Copilot Direct, `--proxy` forces the gateway
 * (removing managed direct markers), `--check` reports the mode (exit 0 direct /
 * 2 proxy / 1 other). With no flag (the `cl` pre-launch refresh): re-assert
 * managed direct fields when already direct, otherwise do nothing — Claude's
 * default backend is the gateway, so a never-configured user is left as proxy.
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
  // No flag: idempotent refresh. Only re-assert when already direct; leave proxy
  // and custom configs untouched (gateway is the default, custom isn't ours).
  const mode = inspectClaudeWiring(
    readTextOrNull(settingsPathFor(claudeHome)),
    claudeHelperPath(claudeHome),
  ).providerMode;
  if (mode === "direct") configureClaudeConfig(claudeHome, "direct");
}
