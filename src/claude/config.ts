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
import * as path from "node:path";
import { codexUserAgent, probeDirectIntegrationId } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
} from "../copilot_api/integration_identity.ts";
import {
  copilotApiResolvePort,
  matchesProxyOrigin,
  proxyLoopbackOrigin,
  wiringPortFor,
} from "../copilot_api/port.ts";
import { type Profile, type ProfileName, profileLabel } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import {
  CLAUDE_PROBE,
  type DirectProbeDeps,
  probeDirectWorks,
  resolveDirectMode,
} from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent, readTextOrNull } from "../utils/fs.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
  type RequestedMode,
} from "../utils/provider_mode.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  PROXY_TOKEN_SCRIPT_SH,
  proxyTokenCommand,
  proxyTokenScriptArgs,
} from "../utils/root.ts";
import { registerClaudeMcpServer, removeClaudeMcpRegistration } from "./mcp_registration.ts";
import { directHelperPath, proxyHelperPath, resolveClaudeHome, settingsPathFor } from "./paths.ts";

const logger = createStderrLogger();

const WIN = process.platform === "win32";

// The direct (GitHub Copilot) contract. One block so it is easy to adjust if
// Copilot's Anthropic-compatible endpoint needs a different base URL/path or
// extra headers. NOTE: Copilot-serving-Claude is not officially documented;
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is treated as a tested knob.
// The base URL literal is owned by integration_identity.ts (the identity probe
// must render its verdict against the same host the agents bake).
export const DIRECT_BASE_URL = DEFAULT_COPILOT_API_BASE;
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
  /** `--direct`/`--proxy`, parsed once at the CLI boundary (auto = neither). */
  mode: RequestedMode;
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
 *  slash and accepts `localhost` too (the shared grammar in port.ts, next to the writers). */
function claudeBaseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "");
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
    if (isEnoent(e)) return {};
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

/** Persist a STRIPPED settings doc: a doc emptied entirely removes the file
 *  itself (never a lone `{}` left behind), anything else is saved. */
function saveOrRemoveSettings(settingsPath: string, doc: Record<string, unknown>): void {
  if (Object.keys(doc).length === 0) fs.rmSync(settingsPath, { force: true });
  else saveSettings(settingsPath, doc);
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
 * newline-separated `Name: Value` pairs, serialized from the SAME builder Codex Direct bakes
 * as `http_headers` (directClientHeaders) so Copilot's editor-client allowlist accepts Claude
 * the same way -- the User-Agent is derived from the installed codex binary (codexUserAgent),
 * falling back to the newest @openai/codex npm release, then to a versionless `codex_exec`.
 * `integrationId` (the probed client identity) is included only when set -- most credentials
 * need none, but a fine-grained PAT is only accepted under `copilot-developer-cli`.
 */
function directCustomHeaders(integrationId?: string | null): string {
  return Object.entries(directClientHeaders(codexUserAgent(), integrationId))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
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
  directIntegrationId?: string | null,
) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
  // Disabling betas and the editor-client headers are direct-only knobs (the proxy
  // speaks full Anthropic and needs neither).
  if (mode === "direct") {
    env[DISABLE_BETAS_ENV] = "1";
    env[CUSTOM_HEADERS_ENV] = directCustomHeaders(directIntegrationId);
  } else if (profile === null) {
    delete env[DISABLE_BETAS_ENV];
    delete env[CUSTOM_HEADERS_ENV];
  } else {
    env[DISABLE_BETAS_ENV] = "";
    env[CUSTOM_HEADERS_ENV] = "";
  }
  doc.env = env;
}

/** The builtin tool denied on Direct (Copilot's host 400s it; the MCP tool replaces it). */
export const WEBSEARCH_DENY_RULE = "WebSearch";

/**
 * Deferred state writes for the web-search pair. The document mutations happen
 * eagerly, but the ownership record in the copilot-env state (and the registration
 * removal on the take-back path) must only land once the settings doc is actually
 * persisted -- run the returned commit AFTER a successful save, so a failed write
 * leaves store and file consistent and a retry can still recover.
 */
type WebSearchPairCommit = () => void;
const NO_COMMIT: WebSearchPairCommit = () => {};

/**
 * Add `WebSearch` to `permissions.deny`. Ownership is recorded (post-save) as the
 * exact settings PATH the entry was added to -- a deny the user already had, or one
 * living in a different CLAUDE_CONFIG_DIR, is never claimed, so the removal path can
 * only ever take back ours. Preserves every other permissions entry (allow, foreign
 * deny rules, order); a malformed `permissions`/`deny` is warned about and left
 * alone, never replaced.
 */
function addManagedWebSearchDeny(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPairCommit {
  if (doc.permissions !== undefined && !isRecord(doc.permissions)) {
    logger.warn("settings.json permissions is not an object; leaving it alone (no WebSearch deny)");
    return NO_COMMIT;
  }
  const permissions = isRecord(doc.permissions) ? doc.permissions : {};
  if (permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
    logger.warn("settings.json permissions.deny is not an array; leaving permissions alone");
    return NO_COMMIT;
  }
  const deny: unknown[] = Array.isArray(permissions.deny) ? permissions.deny : [];
  // Already present: either the user's own rule (never claim it) or ours from an
  // earlier write (the ownership record already says so).
  if (deny.includes(WEBSEARCH_DENY_RULE)) return NO_COMMIT;
  deny.push(WEBSEARCH_DENY_RULE);
  permissions.deny = deny;
  doc.permissions = permissions;
  // The record lands post-save on purpose: if the settings write fails, an
  // unclaimed marker would let a deny the USER adds later become ours to delete.
  // The inverse failure (save ok, record write fails) merely orphans OUR entry --
  // the user removes one line by hand -- which is the acceptable direction.
  return () => new CopilotEnvState().addWebSearchDenyOwnedPath(settingsPath);
}

/** Remove OUR `WebSearch` deny entry (ownership-gated by exact settings path),
 *  dropping emptied objects; the ownership record clears post-save. */
function stripManagedWebSearchDeny(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPairCommit {
  const state = new CopilotEnvState();
  if (!state.ownsWebSearchDeny(settingsPath)) return NO_COMMIT;
  const permissions = isRecord(doc.permissions) ? doc.permissions : null;
  if (permissions !== null && Array.isArray(permissions.deny)) {
    const filtered = permissions.deny.filter((rule) => rule !== WEBSEARCH_DENY_RULE);
    if (filtered.length > 0) permissions.deny = filtered;
    else delete permissions.deny;
    if (Object.keys(permissions).length === 0) delete doc.permissions;
  }
  return () => state.removeWebSearchDenyOwnedPath(settingsPath);
}

/**
 * The web-search pair for the DEFAULT profile: the `copilot-env` MCP server
 * registration (in Claude's global `~/.claude.json`) and the builtin-WebSearch
 * deny (in the settings doc). They move together as one unit -- registration
 * FIRST, and the deny only stands while the registration is confirmed, so a
 * machine is never left with the builtin denied and no replacement (a failed
 * registration takes an existing managed deny back OUT). Direct with `wire-mcp`
 * on wires the pair; proxy, or `wire-mcp` off, takes both back (the floated
 * proxy serves web search itself, so the builtin works there).
 *
 * Default profile only by nature: `~/.claude.json` is global and deny rules
 * UNION across settings layers (a named proxy profile over a direct default
 * could never un-deny), so named profiles never carry the pair -- when the
 * default is direct, their sessions inherit it from the default layer.
 *
 * Returns the post-save commit (see WebSearchPairCommit).
 */
function applyWebSearchPair(
  doc: Record<string, unknown>,
  mode: ManagedAgentMode,
  settingsPath: string,
): WebSearchPairCommit {
  if (mode === "direct" && new CopilotEnvConfig().wireMcpEnabled()) {
    if (registerClaudeMcpServer()) {
      return addManagedWebSearchDeny(doc, settingsPath);
    }
    logger.warn(
      "copilot-env MCP registration failed; removing the managed WebSearch deny so the " +
        "builtin stays reachable (it will 400 on Copilot Direct) - fix ~/.claude.json, " +
        "then rewire with `agent claude --direct`",
    );
    return stripManagedWebSearchDeny(doc, settingsPath);
  }
  const commit = stripManagedWebSearchDeny(doc, settingsPath);
  // The registration is removed post-save too: if the settings write fails, the
  // machine keeps the consistent old state (deny + server) instead of losing only
  // the server half.
  return () => {
    commit();
    removeClaudeMcpRegistration();
  };
}

/**
 * Re-derive the web-search pair for the CURRENT default wiring: ours-and-direct
 * applies it (per `wire-mcp`), proxy/none takes it back, a foreign settings.json
 * is never touched. The load-modify-save is skipped when nothing changed.
 * Shared by the 3.5.2 migration (existing installs never rewire on update) and
 * `agent mcp --remove` (which stores `wire-mcp false` first, making this strip).
 */
export function syncDefaultWebSearchWiring(claudeHome = resolveClaudeHome()): void {
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome, 0);
  if (status.providerMode === "other") return;
  const doc = loadSettings(settingsPath);
  const before = JSON.stringify(doc);
  const commit = applyWebSearchPair(
    doc,
    status.providerMode === "direct" ? "direct" : "proxy",
    settingsPath,
  );
  if (JSON.stringify(doc) !== before) {
    saveOrRemoveSettings(settingsPath, doc);
  }
  commit();
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
/** Options for configureClaudeConfig (mirrors the Codex writer's common knobs). */
export interface ConfigureClaudeConfigOptions {
  /** Suppress the "config written" info line (used by the temp-config probe). */
  quiet?: boolean;
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
  /** Direct mode: the probed `Copilot-Integration-Id` to bake, or null to send none. */
  directIntegrationId?: string | null;
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
        `to the default credential) - run \`agent auth --profile ${profile}\` first.`,
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
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL, profile, options.directIntegrationId);
    // The MCP + deny pair is machine-global (default profile, the REAL Claude home
    // only -- the throwaway detect-probe home must not touch ~/.claude.json).
    const commit =
      profile === null && claudeHome === resolveClaudeHome()
        ? applyWebSearchPair(doc, "direct", settingsPath)
        : NO_COMMIT;
    saveSettings(settingsPath, doc);
    commit();
    if (!quiet) {
      logger.log(`  ✓ Claude config written → ${settingsPath} (direct: GitHub Copilot)`);
    }
    return;
  }

  // proxy: write a helper that runs the shared proxy-token resolver (ensures the proxy is
  // up per the managed-lifecycle rules, then prints its key). The key is resolved at
  // helper-run time (not baked in). A named profile RESERVES its stable port here via
  // wiringPortFor (this is a write path; read-only checks peek without recording) so
  // concurrent profile daemons never share a port.
  const port = wiringPortFor(profile);
  writeHelperScript(proxyHelperPath(claudeHome, profile), proxyHelperScript(profile));
  doc.apiKeyHelper = proxyHelperPath(claudeHome, profile);
  // proxyLoopbackOrigin (no path, no trailing slash -- the shape claudeBaseUrlMatchesProxy
  // expects); env.ts's isLocalProxyUrl accepts it. Host rationale (127.0.0.1, never localhost)
  // on the helper in port.ts.
  applyManagedEnv(doc, "proxy", proxyLoopbackOrigin(port), profile);
  const commit =
    profile === null && claudeHome === resolveClaudeHome()
      ? applyWebSearchPair(doc, "proxy", settingsPath)
      : NO_COMMIT;
  saveSettings(settingsPath, doc);
  commit();
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
export function removeClaudeProfile(claudeHome: string, name: ProfileName): void {
  const settingsPath = settingsPathFor(claudeHome, name);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome, 0, name);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    fs.rmSync(settingsPath, { force: true });
  }
  fs.rmSync(directHelperPath(claudeHome, name), { force: true });
  fs.rmSync(proxyHelperPath(claudeHome, name), { force: true });
}

/**
 * Remove the DEFAULT profile's managed Claude artifacts: the managed settings.json
 * keys (apiKeyHelper + the managed env vars + OUR WebSearch deny entry, when the
 * ownership record says we added it), stripped only while apiKeyHelper still
 * points at the managed helper (inspectClaudeWiring reports direct/proxy) --
 * that helper is what makes the whole managed key set ours, exactly as an explicit
 * mode write would reclaim it; a foreign apiKeyHelper (`other`) leaves settings.json
 * alone. Helper scripts are removed by name (mirrors removeClaudeProfile). The
 * strip is surgical so every other user setting (model, hooks, the user's own
 * permissions entries) survives; an emptied env object is dropped, and a doc
 * emptied entirely removes settings.json itself. Used by `agent uninstall`.
 */
export function removeClaudeDefaultWiring(claudeHome: string): void {
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextOrNull(settingsPath), claudeHome, 0);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    const doc = loadSettings(settingsPath);
    delete doc.apiKeyHelper;
    const env = isRecord(doc.env) ? doc.env : {};
    delete env[BASE_URL_ENV];
    delete env[DISABLE_BETAS_ENV];
    delete env[CUSTOM_HEADERS_ENV];
    if (Object.keys(env).length === 0) delete doc.env;
    const commit = stripManagedWebSearchDeny(doc, settingsPath);
    saveOrRemoveSettings(settingsPath, doc);
    commit();
  }
  fs.rmSync(directHelperPath(claudeHome), { force: true });
  fs.rmSync(proxyHelperPath(claudeHome), { force: true });
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
export async function runClaude(args: ClaudeConfigArgs): Promise<void> {
  if (args.check) {
    checkClaudeConfig();
    return;
  }
  const claudeHome = resolveClaudeHome();
  // A configured credential (`agent auth`) selects Direct without a live probe.
  // Resolve it provider-aware (gh-cli -> gh, copilot/gh-token -> stored token, none ->
  // null); the helper re-resolves at fetch time via `agent auth --get`.
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args.mode, ghToken, detectClaudeDirect);
  logger.log(
    `  Configuring Claude for ${direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"} ...`,
  );
  // Direct bakes the client identity this credential is accepted under (shared with
  // Codex Direct); proxy needs none. Reuses the already-resolved token so gh-cli isn't
  // spawned twice.
  const directIntegrationId = direct ? await probeDirectIntegrationId(null, ghToken) : undefined;
  configureClaudeConfig(claudeHome, direct ? "direct" : "proxy", { directIntegrationId });
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
