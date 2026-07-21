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
import {
  copilotApiResolvePort,
  proxyLoopbackOrigin,
  reserveProfilePort,
} from "../copilot_api/port.ts";
import { type Profile, profileLabel } from "../copilot_api/profile.ts";
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
  agentAuthGetArgs,
  agentLauncherCommand,
  PROXY_TOKEN_SCRIPT_SH,
  proxyTokenCommand,
  proxyTokenScriptArgs,
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
// exact-path match in inspectClaudeWiring -- therefore carry the platform extension. A
// NAMED profile suffixes the stem (`copilot-token-work.sh`), keeping the default names
// (external contracts) byte-identical.
const HELPER_EXT = WIN ? "cmd" : "sh";
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
 * and uses its stdout as the credential. We exec `agent auth --get` (with `--profile <name>`
 * for a named profile), the provider-driven resolver (gh-cli -> gh, else the stored token), so
 * the token is never baked into this script -- it lives only in the state store. POSIX emits a
 * `#!/bin/sh` script; Windows emits a `.cmd` that runs the same resolver via PowerShell
 * (agentLauncherCommand wraps it as `powershell -File ...`).
 */
function directHelperScript(profile: Profile = null): string {
  const { command, args } = agentLauncherCommand(agentAuthGetArgs(profile));
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

/** The profile's filename suffix: `""` for the default, `-<name>` for a named profile. */
function profileSuffix(profile: Profile): string {
  return profile === null ? "" : `-${profile}`;
}

/** `settings.json`, or `settings-<name>.json` for a named profile. Launch a named
 *  profile with `claude --settings <this path>` (the `cl --profile <name>` launcher
 *  resolves it via `agent profile --settings-for <name>`). */
export function settingsPathFor(claudeHome: string, profile: Profile = null): string {
  return path.join(claudeHome, `settings${profileSuffix(profile)}.json`);
}

function directHelperPath(claudeHome: string, profile: Profile = null): string {
  if (profile === null) return path.join(claudeHome, DIRECT_HELPER_NAME);
  return path.join(claudeHome, `copilot-token-${profile}.${HELPER_EXT}`);
}

function proxyHelperPath(claudeHome: string, profile: Profile = null): string {
  if (profile === null) return path.join(claudeHome, PROXY_HELPER_NAME);
  return path.join(claudeHome, `copilot-proxy-token-${profile}.${HELPER_EXT}`);
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * Inspect raw settings content against the managed contract for `profile` (default
 * profile = settings.json, named = settings-<name>.json). Pure (no I/O): the caller
 * passes the file text (null = absent) plus the home, from which the two managed
 * helper paths are derived. Mode is keyed off the EXACT apiKeyHelper path so a
 * user's own same-named helper is never mistaken for ours:
 *   - direct: apiKeyHelper === <home>/copilot-token[-<profile>].sh
 *   - proxy:  apiKeyHelper === <home>/copilot-proxy-token[-<profile>].sh
 *   - other:  a foreign apiKeyHelper, a custom ANTHROPIC_BASE_URL, or malformed
 *             JSON (a config we must not clobber)
 *   - none:   no relevant keys (absent/empty) -- unconfigured; proxy is default
 */
export function inspectClaudeWiring(
  settingsText: string | null,
  claudeHome: string,
  expectedPort: number,
  profile: Profile = null,
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

  if (helperPath === directHelperPath(claudeHome, profile)) {
    status.providerMode = "direct";
  } else if (helperPath === proxyHelperPath(claudeHome, profile)) {
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

/** Set the managed `env` keys in place (preserving any other env vars). A NAMED
 *  profile's settings file is LAYERED over the user's settings.json by `claude
 *  --settings`, and Claude merges env shallowly -- so where the default proxy write
 *  can simply delete the direct-only keys, a named proxy profile must explicitly
 *  BLANK them, or a direct default underneath would bleed its headers through. */
function applyManagedEnv(
  doc: Record<string, unknown>,
  mode: ManagedAgentMode,
  baseUrl: string,
  profile: Profile = null,
) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
  // Disabling betas and the editor-client headers are direct-only knobs (the proxy
  // speaks full Anthropic and needs neither).
  if (mode === "direct") {
    env[DISABLE_BETAS_ENV] = "1";
    env[CUSTOM_HEADERS_ENV] = directCustomHeaders();
  } else if (profile === null) {
    delete env[DISABLE_BETAS_ENV];
    delete env[CUSTOM_HEADERS_ENV];
  } else {
    env[DISABLE_BETAS_ENV] = "";
    env[CUSTOM_HEADERS_ENV] = "";
  }
  doc.env = env;
}

/**
 * Apply the managed Claude wiring at `claudeHome` for `profile` (default =
 * settings.json; named = settings-<name>.json, launched via `claude --settings`).
 * Direct writes the apiKeyHelper that execs `agent auth --get [--profile <name>]`
 * (the credential resolver for the addressed slot) + the Copilot base URL; proxy
 * resolves the profile's proxy port, writes a helper that runs the shared
 * proxy-token resolver, and points the base URL at 127.0.0.1. Either way the merge
 * is surgical (only managed keys change) and the OTHER mode's settings are
 * overwritten so switching modes is clean. A named DIRECT profile requires its own
 * credential (named profiles never fall back to the default one). Throws on an
 * unwritable home / malformed settings / unresolvable proxy token.
 */
/** Options for configureClaudeConfig (mirrors ConfigureCodexConfigOptions). */
export interface ConfigureClaudeConfigOptions {
  /** Suppress the "config written" info line (used by the temp-config probe). */
  quiet?: boolean;
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
}

export function configureClaudeConfig(
  claudeHome: string,
  mode: ManagedAgentMode,
  options: ConfigureClaudeConfigOptions = {},
): void {
  const quiet = options.quiet ?? false;
  const profile = options.profile ?? null;
  // Cheap provider-presence gate (no `gh` spawn -- runClaude already did the full resolve
  // and fail-fasts on it; this backstops direct API callers like --settings-for).
  if (
    profile !== null &&
    mode === "direct" &&
    new Credential(undefined, profile).provider() === null
  ) {
    throw new Error(
      `${profileLabel(profile)} has no credential of its own (a named profile never falls back ` +
        `to the default credential) — run \`agent auth --profile ${profile}\` first.`,
    );
  }
  try {
    fs.mkdirSync(claudeHome, { recursive: true });
  } catch (e) {
    throw new Error(`could not create Claude config directory ${claudeHome}: ${errMessage(e)}`);
  }

  const settingsPath = settingsPathFor(claudeHome, profile);
  const doc = loadSettings(settingsPath);
  // NAMED profiles only: never take over a pre-existing settings-<name>.json wired to
  // something we don't manage -- a foreign apiKeyHelper OR a custom base URL (the user's
  // own file that predates the profile). The DEFAULT settings.json keeps its historical
  // contract: an explicit mode write reclaims even a custom config.
  if (profile !== null) {
    const current = inspectClaudeWiring(JSON.stringify(doc), claudeHome, 0, profile);
    if (current.providerMode === "other") {
      throw new Error(
        `${settingsPath} is wired to something copilot-env does not manage; refusing to ` +
          `overwrite it (pick a different profile name or remove the file first)`,
      );
    }
  }

  if (mode === "direct") {
    // The helper execs `agent auth --get`; the token is never baked here.
    writeHelperScript(directHelperPath(claudeHome, profile), directHelperScript(profile));
    doc.apiKeyHelper = directHelperPath(claudeHome, profile);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL, profile);
    saveSettings(settingsPath, doc);
    if (!quiet) {
      logger.log(`  ✓ Claude config written → ${settingsPath} (direct: GitHub Copilot)`);
    }
    return;
  }

  // proxy: write a helper that runs the shared proxy-token resolver (ensures the proxy is
  // up per the managed-lifecycle rules, then prints its key). The key is resolved at
  // helper-run time (not baked in). A named profile RESERVES its stable port here (this is
  // a write path; read-only checks peek without recording) so concurrent profile daemons
  // never share a port.
  const port = profile === null ? copilotApiResolvePort() : String(reserveProfilePort(profile));
  writeHelperScript(proxyHelperPath(claudeHome, profile), proxyHelperScript(profile));
  doc.apiKeyHelper = proxyHelperPath(claudeHome, profile);
  // proxyLoopbackOrigin (no path, no trailing slash -- the shape claudeBaseUrlMatchesProxy
  // expects); env.ts's isLocalProxyUrl accepts it. Host rationale (127.0.0.1, never localhost)
  // on the helper in port.ts.
  applyManagedEnv(doc, "proxy", proxyLoopbackOrigin(port), profile);
  saveSettings(settingsPath, doc);
  if (!quiet) {
    logger.log(`  ✓ Claude config written → ${settingsPath} (proxy mode → port ${port})`);
  }
}

/**
 * The proxy apiKeyHelper body: run the SHARED proxy-token resolver (`src/scripts/proxy-token.sh
 * --yes [--profile <name>]`, or `.ps1` on Windows via proxyTokenCommand), which (per the
 * managed-lifecycle rules) ensures the addressed proxy is up then prints its key. `--yes` is
 * the headless path (never prompt) -- Claude runs this on a timer. The same resolver backs
 * Codex's `auth.command`; the key is resolved at run time (nothing is baked in here). POSIX
 * emits a `#!/bin/sh` script; Windows a `.cmd` that invokes PowerShell against the `.ps1` twin.
 */
function proxyHelperScript(profile: Profile = null): string {
  if (WIN) {
    const { command, args } = proxyTokenCommand(profile);
    return cmdHelperBody(command, args);
  }
  const line = [PROXY_TOKEN_SCRIPT_SH, ...proxyTokenScriptArgs(profile)].map(shQuote).join(" ");
  return `#!/bin/sh\nexec ${line}\n`;
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
 * Remove a NAMED profile's managed Claude artifacts: its helper scripts (ours by
 * name) and its settings-<name>.json -- the latter only when it is actually OURS
 * (managed direct/proxy wiring); a foreign same-named file the user owns is left
 * alone. Used by `agent profile --del`.
 */
export function removeClaudeProfile(claudeHome: string, name: string): void {
  const settingsPath = settingsPathFor(claudeHome, name);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome, 0, name);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    fs.rmSync(settingsPath, { force: true });
  }
  fs.rmSync(directHelperPath(claudeHome, name), { force: true });
  fs.rmSync(proxyHelperPath(claudeHome, name), { force: true });
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
      configureClaudeConfig(tmpHome, "direct", { quiet: true });
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
 * without a probe. (Named profiles are managed by `agent profile`, not here.)
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
