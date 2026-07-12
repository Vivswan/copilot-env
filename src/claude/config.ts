// Claude Code config writer: wires ~/.claude/settings.json for one of two
// backends, mirroring src/codex/config.ts but adapted to how Claude consumes
// config (JSON settings.json + an apiKeyHelper script, no `model_provider`):
//
//   - direct: GitHub Copilot. apiKeyHelper -> copilot-token.{sh,cmd}, which execs
//     `agent auth --get` (provider-driven: gh-cli -> gh, copilot/gh-token -> stored token)
//     and env.ANTHROPIC_BASE_URL = https://api.githubcopilot.com.
//   - proxy:  the local copilot-api proxy. apiKeyHelper -> copilot-proxy-token.{sh,cmd}
//     (prints the proxy key) and env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>.
//
// The helper is a script FILE whose path Claude stores in apiKeyHelper (so health can read
// it back and mode detection keys off the exact path). It must be runnable by bare path:
// a POSIX `#!/bin/sh` script, or -- on Windows, where a `.sh` is not executable -- a `.cmd`
// (cmd.exe runs it by path) that shells into PowerShell to reach the same resolver Codex uses.
//
// `agent env` re-exports ANTHROPIC_BASE_URL only for the proxy backend (to keep
// the shell aligned with the live proxy port); direct is driven entirely by
// settings.json. Mode is inferred from which managed apiKeyHelper (by EXACT path)
// settings.json points at. The merge is surgical: only the managed keys are
// touched; all other settings are preserved.
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { codexUserAgent } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { assertNever } from "../utils/assert.ts";
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
import {
  AGENT_AUTH_GET_ARGS,
  agentLauncherCommand,
  PROXY_TOKEN_SCRIPT_SH,
  proxyTokenCommand,
} from "../utils/root.ts";

const logger = createStderrLogger();

const WIN = process.platform === "win32";

// The direct (GitHub Copilot) contract. One block so it is easy to adjust if
// Copilot's Anthropic-compatible endpoint needs a different base URL/path or
// extra headers. NOTE: Copilot-serving-Claude is not officially documented;
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is treated as a tested knob.
export const DIRECT_BASE_URL = "https://api.githubcopilot.com";
// Helper file basenames. On Windows a `.sh` is not runnable by bare path, so the managed
// helper is a `.cmd` (which cmd.exe executes). The path stored in apiKeyHelper -- and the
// exact-path match in inspectClaudeWiring -- therefore carry the platform extension.
export const DIRECT_HELPER_NAME = WIN ? "copilot-token.cmd" : "copilot-token.sh";
export const PROXY_HELPER_NAME = WIN ? "copilot-proxy-token.cmd" : "copilot-proxy-token.sh";
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";
// Direct only: GitHub Copilot's endpoint gates on an editor-client identity, so Direct mode
// sends the same `Openai-Intent` + `codex_exec` User-Agent that Codex Direct does (see
// src/codex/config.ts managedDirectProvider). Claude has no `http_headers` knob; it reads custom
// request headers from this env var, newline-separated `Name: Value` pairs (the proxy speaks
// native Anthropic and needs none, so proxy mode scrubs it).
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** Single-quote a string for safe embedding in a /bin/sh command line. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote an argument for a Windows `.cmd` line: bare for plain flags/words, else double-quoted
 *  (paths carry `:` and `\`). cmd.exe runs a quoted path fine; our args never contain a `"`. */
function winQuote(s: string): string {
  return /^[-A-Za-z0-9_.]+$/.test(s) ? s : `"${s}"`;
}

/** A Windows `.cmd` helper body: run `command args...` so its stdout is the credential. `@echo
 *  off` keeps the command itself off stdout; CRLF endings so cmd.exe parses it reliably. Literal
 *  `%` is doubled to `%%` -- in a batch file `%` triggers variable expansion even inside quotes,
 *  so a checkout path containing `%` would otherwise be mangled. (`!` needs no escaping: we never
 *  `setlocal enabledelayedexpansion`, so delayed expansion is off.) Exported for tests. */
export function cmdHelperBody(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(winQuote).join(" ").replace(/%/g, "%%");
  return `@echo off\r\n${line}\r\n`;
}

/**
 * The direct apiKeyHelper body: print the Direct credential on stdout. Claude runs apiKeyHelper
 * and uses its stdout as the credential. We exec `agent auth --get`, the provider-driven
 * resolver (gh-cli -> gh, else the stored token), so the token is never baked into this script --
 * it lives only in the state store. POSIX emits a `#!/bin/sh` script; Windows emits a `.cmd` that
 * runs the same resolver via PowerShell (agentLauncherCommand wraps it as `powershell -File ...`).
 */
function directHelperScript(): string {
  const { command, args } = agentLauncherCommand(AGENT_AUTH_GET_ARGS);
  if (WIN) return cmdHelperBody(command, args);
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
  /** In proxy mode, whether `baseUrl` points at the resolved local proxy (host+port). */
  baseUrlMatches: boolean;
  /** Which backend the current settings select. */
  providerMode: AgentProviderMode;
}

/** Whether `baseUrl` is the managed Claude proxy URL for `expectedPort`:
 *  `http://127.0.0.1:<port>` (loopback, no path -- unlike Codex's `/v1`). Tolerates a trailing
 *  slash and accepts `localhost` too. */
function claudeBaseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  try {
    const u = new URL(baseUrl);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const path = u.pathname.replace(/\/$/, ""); // tolerate a trailing slash
    return u.protocol === "http:" && isLocal && u.port === String(expectedPort) && path === "";
  } catch {
    return false;
  }
}

// --- paths ------------------------------------------------------------------

/**
 * Resolve the effective Claude home: `$CLAUDE_CONFIG_DIR` (Claude Code's own
 * override), else `~/.claude` (`%USERPROFILE%\.claude` on Windows). This is the
 * single knob -- there is no per-command override flag.
 */
export function resolveClaudeHome(): string {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  // Use homedir() WITHOUT a process.env.HOME override, matching the codex-side contract
  // (src/codex/config.ts): on Windows homedir() is %USERPROFILE% (where Claude Code reads),
  // whereas HOME may be a Git-for-Windows/MSYS path -- the two must not diverge or `init`
  // writes settings.json where Claude never looks. On POSIX homedir() already honors $HOME.
  return path.join(homedir(), ".claude");
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
  expectedPort: number,
): ClaudeWiringStatus {
  const status: ClaudeWiringStatus = {
    settingsExists: settingsText !== null,
    helperPath: null,
    baseUrl: null,
    baseUrlMatches: false,
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
  status.baseUrlMatches = baseUrl !== null && claudeBaseUrlMatchesProxy(baseUrl, expectedPort);

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

/** Write a managed apiKeyHelper script (prints a token on stdout), chmod 0700. The chmod is the
 *  POSIX exec bit; on Windows it is a harmless near-no-op (a `.cmd` runs without it). */
function writeHelperScript(helperPath: string, script: string): void {
  fs.writeFileSync(helperPath, script);
  try {
    fs.chmodSync(helperPath, 0o700);
  } catch {
    // pass (e.g. Windows) -- the exec bit is best-effort.
  }
}

/**
 * The Direct (GitHub Copilot) custom-headers value: an `ANTHROPIC_CUSTOM_HEADERS` string of
 * newline-separated `Name: Value` pairs. Matches Codex Direct's `http_headers` exactly so
 * Copilot's editor-client allowlist accepts Claude the same way -- the User-Agent is derived
 * from the installed codex binary (codexUserAgent), falling back to a versionless `codex_exec`.
 */
function directCustomHeaders(): string {
  return [`Openai-Intent: conversation-edits`, `User-Agent: ${codexUserAgent()}`].join("\n");
}

/** Set the managed `env` keys in place (preserving any other env vars). */
function applyManagedEnv(doc: Record<string, unknown>, mode: ManagedAgentMode, baseUrl: string) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
  // Disabling betas and the editor-client headers are direct-only knobs (the proxy
  // speaks full Anthropic and needs neither).
  if (mode === "direct") {
    env[DISABLE_BETAS_ENV] = "1";
    env[CUSTOM_HEADERS_ENV] = directCustomHeaders();
  } else {
    delete env[DISABLE_BETAS_ENV];
    delete env[CUSTOM_HEADERS_ENV];
  }
  doc.env = env;
}

/**
 * Apply the managed Claude wiring at `claudeHome`. Direct writes the apiKeyHelper
 * that execs `agent auth --get` (the single credential resolver) + the Copilot
 * base URL; proxy resolves the local proxy port + token, writes a helper that
 * prints that token, and points the base URL at 127.0.0.1. Either way the merge
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

  // proxy: write a helper that runs the shared proxy-token resolver (ensures the proxy is
  // up per the managed-lifecycle rules, then prints its key). The key is resolved at
  // helper-run time (not baked in).
  const port = copilotApiResolvePort();
  writeHelperScript(proxyHelperPath(claudeHome), proxyHelperScript());
  doc.apiKeyHelper = proxyHelperPath(claudeHome);
  // 127.0.0.1, not `localhost`: the daemon binds IPv4, and on Windows the Claude CLI resolves
  // `localhost` to ::1 first with no IPv4 fallback -> ECONNREFUSED while health reads green.
  // In lockstep with openaiBaseUrl(); env.ts's isLocalProxyUrl already accepts 127.0.0.1.
  applyManagedEnv(doc, "proxy", `http://127.0.0.1:${port}`);
  saveSettings(settingsPath, doc);
  if (!quiet) {
    logger.log(`  ✓ Claude config written → ${settingsPath} (proxy mode → port ${port})`);
  }
}

/**
 * The proxy apiKeyHelper body: run the SHARED proxy-token resolver (`src/scripts/proxy-token.sh
 * --yes`, or `.ps1` on Windows via proxyTokenCommand), which (per the managed-lifecycle rules)
 * ensures the proxy is up then prints its key. `--yes` is the headless path (never prompt) --
 * Claude runs this on a timer. The same resolver backs Codex's `auth.command`; the key is
 * resolved at run time (nothing is baked in here). POSIX emits a `#!/bin/sh` script; Windows a
 * `.cmd` that invokes PowerShell against the `.ps1` twin.
 */
function proxyHelperScript(): string {
  if (WIN) {
    const { command, args } = proxyTokenCommand();
    return cmdHelperBody(command, args);
  }
  return `#!/bin/sh\nexec ${shQuote(PROXY_TOKEN_SCRIPT_SH)} --yes\n`;
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
    default:
      return assertNever(mode);
  }
}

/** Exit-code contract for `--check`, consumed by the `cl` launcher. */
function checkClaudeConfig(): void {
  const claudeHome = resolveClaudeHome();
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(
    readTextOrNull(settingsPath),
    claudeHome,
    Number(copilotApiResolvePort()),
  );
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
  return inspectClaudeWiring(
    readTextOrNull(settingsPathFor(claudeHome)),
    claudeHome,
    Number(copilotApiResolvePort()),
  ).providerMode;
}
