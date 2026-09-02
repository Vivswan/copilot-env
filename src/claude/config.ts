// Claude Code config writer: wires ~/.claude/settings.json for one of two
// backends, mirroring src/codex/config.ts but adapted to how Claude consumes
// config (JSON settings.json + an apiKeyHelper command, no `model_provider`):
//
//   - direct: GitHub Copilot. apiKeyHelper invokes `agent auth --get` (provider-driven:
//     gh-cli -> gh, copilot/gh-token -> stored token) and
//     env.ANTHROPIC_BASE_URL = https://api.githubcopilot.com.
//   - proxy:  the local copilot-api proxy. apiKeyHelper invokes `agent proxy-token --yes`
//     (ensures the proxy, prints its key) and env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>.
//
// apiKeyHelper is a shell COMMAND STRING (sh-style on POSIX, cmd-style on Windows), not
// a file path, so the managed wiring invokes bin/agent directly -- no intermediate
// credential helper file exists anywhere. Claude caches the helper's stdout for ~5
// minutes and re-runs it on 401 (the same cadence Codex's refresh_interval_ms=300000
// gives auth.command), and hard-fails when stdout is anything but the single credential
// line -- which both resolvers guarantee (their diagnostics go to stderr).
//
// `agent env` re-exports ANTHROPIC_BASE_URL only for the proxy backend (to keep
// the shell aligned with the live proxy port); direct is driven entirely by
// settings.json. Mode is inferred from the EXACT apiKeyHelper value (the managed
// command string, or -- reader tolerance -- the retired helper-script path, accepted
// only while the file's body is exactly what those releases wrote). The merge is
// surgical: only the managed keys are touched; all other settings are preserved.
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentAdapter, type AgentConfigArgs, runAgentConfig } from "../agents/configure.ts";
import { CLAUDE_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
} from "../agents/provider_mode.ts";
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
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent, readTextOrNull } from "../utils/fs.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  PROJECT_ROOT,
  proxyTokenArgs,
  proxyTokenCommand,
} from "../utils/root.ts";
import { removeClaudeDesktopEntry, syncClaudeDesktopWiring } from "./desktop.ts";
import { cmdHelperBody, posixExecBody, shQuote, winQuote } from "./helper_body.ts";
import { registerClaudeMcpServer, removeClaudeMcpRegistration } from "./mcp_registration.ts";
import {
  directHelperPath,
  proxyHelperPath,
  resolveClaudeHome,
  settingsPathFor,
  WIN,
} from "./paths.ts";

const logger = createStderrLogger();

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

/** Body builders live in helper_body.ts (shared with the Desktop wiring); cmdHelperBody
 *  stays re-exported here for its existing test/import surface. */
export { cmdHelperBody };

/** Quote one token of a POSIX apiKeyHelper command string: bare when unambiguous
 *  (flags, subcommands, profile names), single-quoted otherwise (paths carry spaces). */
function shToken(s: string): string {
  return /^[A-Za-z0-9_.:/=-]+$/.test(s) ? s : shQuote(s);
}

// The managed inline command's SHAPE, root-agnostic: any copilot-env root's launcher
// (`<root>/bin/agent` on POSIX, the PowerShell -File invocation of `<root>\bin\agent.ps1`
// on Windows) followed by exactly one resolver's args. Mode INSPECTION must recognize a
// sibling install's wiring (a dev checkout vs ~/.copilot-env) as managed: the command
// resolves the same shared store from any root, and byte-exact-only matching made the
// verdict depend on WHICH copilot-env binary was asking. Writes still spell the current
// root. Each arm accepts ONLY spellings the writers can produce: the bare POSIX path is
// limited to shToken's bare charset (no shell metacharacters -- `evil;/bin/agent` must
// never classify as managed), and the Windows -File path is always winQuote-quoted (a
// real agent.ps1 path carries `\` and `:`), so there is no bare Windows arm at all.
const POSIX_LAUNCHER_SHAPE = String
  .raw`(?:'(?:[^']|'\\'')*/bin/agent'|[A-Za-z0-9_.:/=-]*/bin/agent)`;
// The -File path excludes line breaks (a Windows path cannot carry them, and a value
// smuggling a second line inside the apparent quotes must never read as managed);
// raw `%` stays legal HERE -- the inline command is not a batch file, so the writer
// never %%-doubles it (unlike the legacy .cmd bodies below).
const WIN_LAUNCHER_SHAPE = String
  .raw`powershell -NoProfile -ExecutionPolicy Bypass -File "[^"\r\n]*\\bin\\agent\.ps1"`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `helperValue` is the managed inline command for `subArgs` under ANY
 *  copilot-env root. `win` is a parameter (not the ambient platform) so both shapes
 *  are testable on every CI runner. */
export function managedHelperShape(
  helperValue: string,
  subArgs: readonly string[],
  win: boolean = WIN,
): boolean {
  const argsLine = escapeRegExp(subArgs.map(win ? winQuote : shToken).join(" "));
  const launcher = win ? WIN_LAUNCHER_SHAPE : POSIX_LAUNCHER_SHAPE;
  return new RegExp(`^${launcher} ${argsLine}$`).test(helperValue);
}

/** The inline apiKeyHelper command string for `{command, args}`: sh-style on POSIX,
 *  cmd-style on Windows -- the two shells Claude runs apiKeyHelper through. */
function helperCommandLine({ command, args }: { command: string; args: string[] }): string {
  return [command, ...args].map(WIN ? winQuote : shToken).join(" ");
}

/**
 * The managed DIRECT apiKeyHelper command for `profile`: invoke `agent auth --get
 * [--profile <name>]` (via the platform launcher), whose stdout is exactly the one
 * credential line (its catalog-refresh side work is stderr-only). Byte-exact on both
 * the write and inspect sides, like Codex's managed auth block.
 */
export function directHelperCommand(profile: Profile = null): string {
  return helperCommandLine(agentLauncherCommand(agentAuthGetArgs(profile)));
}

/** The managed PROXY apiKeyHelper command for `profile`: invoke `agent proxy-token
 *  --yes [--profile <name>]` -- the same resolver Codex's auth.command runs. */
export function proxyHelperCommand(profile: Profile = null): string {
  return helperCommandLine(proxyTokenCommand(profile));
}

// --- legacy helper-file tolerance ---------------------------------------------
//
// Reader tolerance (2026-08, the inline-apiKeyHelper move): releases before it wrote
// apiKeyHelper as the PATH of a managed helper-script file (copilot-token[-<name>].{sh,cmd},
// copilot-proxy-token[-<name>].{sh,cmd} -- src/claude/paths.ts still names them for
// this tolerance and for removal). The path arms in inspectClaudeWiring classify such
// a value as managed only while the file still carries a body a release actually
// wrote -- a missing, foreign, or hand-edited helper is NOT ours (it cannot produce
// the managed credential, and the classification authorizes the uninstall strip and
// the profile overwrite guard). Bodies are matched by SHAPE (any install root), like
// the inline arm's launcher shapes. Any wiring rewrite upgrades the config to the
// inline command -- self-healing, per the migrate-or-reader rule in AGENTS.md.
// Remove (with the path arms) once no supported install can still carry helper-file
// wiring.
//
// The released renderings, from tag history (only the install root varies):
//   direct (unchanged across releases; `git show v3.5.6:src/claude/config.ts`,
//   directHelperScript -- same shape at v3.3.17):
//     POSIX  #!/bin/sh\nexec '<root>/bin/agent' 'auth' '--get' ['--profile' '<n>']\n
//     WIN    @echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File
//            "<root>\bin\agent.ps1" auth --get [--profile <n>]\r\n
//   proxy, v3.5.x era (proxyHelperScript at v3.5.6): the src/scripts/proxy-token
//   forwarder, every POSIX token shQuote'd:
//     POSIX  #!/bin/sh\nexec '<root>/src/scripts/proxy-token.sh' '--yes' [...]\n
//     WIN    ... -File "<root>\src\scripts\proxy-token.ps1" --yes [--profile <n>]\r\n
//   proxy, v3.3.x era (proxyHelperScript at v3.3.17): POSIX spelled `--yes` BARE and
//   predates named profiles: #!/bin/sh\nexec '<root>/.../proxy-token.sh' --yes\n
//   (its WIN rendering equals the v3.5.x one). Unreleased mains briefly wrote the
//   proxy body through the launcher ('<root>/bin/agent' 'proxy-token' '--yes' ...);
//   accepted too -- it costs nothing and some installs are built from main.

/** A shQuote'd POSIX token whose content ends in `suffix` (a pre-escaped regex
 *  fragment): how every released POSIX helper rendered its command path. */
function posixQuotedSuffix(suffix: string): string {
  return String.raw`'(?:[^']|'\\'')*${suffix}'`;
}
const POSIX_BODY_LAUNCHER = posixQuotedSuffix(String.raw`/bin/agent`);
const POSIX_BODY_PROXY_SCRIPT = posixQuotedSuffix(String.raw`/src/scripts/proxy-token\.sh`);
// The legacy `.cmd` bodies' -File path: cmd.exe parses a batch file line by line (a
// quoted path cannot span CRLF -- an embedded line break would BE a second command),
// and cmdHelperBody %%-doubled every literal `%`, so raw `%` and line breaks are
// foreign here (stricter than the inline arm's path, where raw `%` is legal).
const WIN_CMD_PATH = String.raw`(?:[^"%\r\n]|%%)*`;
const WIN_BODY_LAUNCHER = String
  .raw`powershell -NoProfile -ExecutionPolicy Bypass -File "${WIN_CMD_PATH}\\bin\\agent\.ps1"`;
const WIN_BODY_PROXY_SCRIPT = String
  .raw`powershell -NoProfile -ExecutionPolicy Bypass -File "${WIN_CMD_PATH}\\src\\scripts\\proxy-token\.ps1"`;

/** Fixed args as the eras rendered them: every POSIX token shQuote'd; winQuote on
 *  Windows (flags and profile names stay bare there). */
function posixQuotedArgs(args: readonly string[]): string {
  return args.map((a) => escapeRegExp(shQuote(a))).join(" ");
}
function winArgs(args: readonly string[]): string {
  return escapeRegExp(args.map(winQuote).join(" "));
}

/** Whether `body` is one of the legacy exec `lines` inside the platform frame. */
function legacyBodyMatches(body: string | null, lines: string[], win: boolean): boolean {
  if (body === null) return false;
  return lines.some((line) =>
    new RegExp(win ? `^@echo off\r\n${line}\r\n$` : `^#!/bin/sh\nexec ${line}\n$`).test(body)
  );
}

/** v3.5.6's proxyTokenScriptArgs: the script forwarder's headless argv. */
function legacyProxyScriptArgs(profile: Profile): string[] {
  return profile === null ? ["--yes"] : ["--yes", "--profile", profile];
}

/** Whether `body` is a released DIRECT helper-file body for `profile`, from ANY
 *  install root. `win` is a parameter (not the ambient platform) so both shapes
 *  are testable on every CI runner, like managedHelperShape. */
export function legacyDirectHelperBodyMatches(
  body: string | null,
  profile: Profile = null,
  win: boolean = WIN,
): boolean {
  const args = agentAuthGetArgs(profile);
  const line = win
    ? `${WIN_BODY_LAUNCHER} ${winArgs(args)}`
    : `${POSIX_BODY_LAUNCHER} ${posixQuotedArgs(args)}`;
  return legacyBodyMatches(body, [line], win);
}

/** The proxy twin: any released PROXY helper-file body for `profile` -- both quoting
 *  eras of the script forwarder, plus unreleased mains' launcher spelling. */
export function legacyProxyHelperBodyMatches(
  body: string | null,
  profile: Profile = null,
  win: boolean = WIN,
): boolean {
  const scriptArgs = legacyProxyScriptArgs(profile);
  const lines = win
    ? [
      `${WIN_BODY_PROXY_SCRIPT} ${winArgs(scriptArgs)}`,
      `${WIN_BODY_LAUNCHER} ${winArgs(proxyTokenArgs(profile))}`,
    ]
    : [
      `${POSIX_BODY_PROXY_SCRIPT} ${posixQuotedArgs(scriptArgs)}`,
      // v3.3.x rendered `--yes` bare (and predates named profiles).
      ...(profile === null ? [`${POSIX_BODY_PROXY_SCRIPT} --yes`] : []),
      `${POSIX_BODY_LAUNCHER} ${posixQuotedArgs(proxyTokenArgs(profile))}`,
    ];
  return legacyBodyMatches(body, lines, win);
}

/** The newest RELEASED direct body (v3.5.6's rendering, at the CURRENT root; the
 *  matcher accepts it from any root) -- what test fixtures stage. */
export function legacyDirectHelperScript(profile: Profile = null): string {
  const { command, args } = agentLauncherCommand(agentAuthGetArgs(profile));
  return WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
}

/** The proxy twin: v3.5.6's rendering -- the src/scripts/proxy-token forwarder
 *  (which still ships), NOT today's `agent proxy-token` launcher spelling. */
export function legacyProxyHelperScript(profile: Profile = null): string {
  const scriptArgs = legacyProxyScriptArgs(profile);
  if (WIN) {
    const ps1 = path.join(PROJECT_ROOT, "src", "scripts", "proxy-token.ps1");
    return cmdHelperBody("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ps1,
      ...scriptArgs,
    ]);
  }
  return posixExecBody(path.join(PROJECT_ROOT, "src", "scripts", "proxy-token.sh"), scriptArgs);
}

/** The `agent claude` argument shape (the shared skeleton's, under this command's name). */
export type ClaudeConfigArgs = AgentConfigArgs;

export interface ClaudeWiringStatus {
  /** settings.json exists. */
  settingsExists: boolean;
  /** The configured `apiKeyHelper` value, for messaging (not a secret): the managed
   *  inline command, a legacy install's helper-script path, or a foreign value. */
  helperPath: string | null;
  /** `env.ANTHROPIC_BASE_URL`, if present. */
  baseUrl: string | null;
  /** Whether `baseUrl` points at the resolved local proxy (host+port): proxy mode's
   *  port check, and the mixed-config signal defaultSetupNeedsProxy keys off. */
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
 * profile = settings.json, named = settings-<name>.json). The caller passes the file
 * text (null = absent) plus the home, from which the two LEGACY helper paths are
 * derived; the only I/O is `readFile`, through which the legacy path arms verify the
 * helper file's body (never called for the inline arms) -- it defaults to the real
 * filesystem reader, and pure tests inject a fake. Mode is keyed off the EXACT
 * apiKeyHelper value so a user's own similar-looking helper is never mistaken for
 * ours -- the verdict authorizes `--check`, the uninstall strip, and the profile
 * overwrite guard:
 *   - direct: apiKeyHelper is the managed `agent auth --get` command (or, reader
 *             tolerance, the retired <home>/copilot-token[-<profile>] script path
 *             whose file body is one a release actually wrote, any install root)
 *   - proxy:  apiKeyHelper is the managed `agent proxy-token --yes` command (or the
 *             retired <home>/copilot-proxy-token[-<profile>] script path, same
 *             body condition)
 *   - other:  a foreign apiKeyHelper -- including a legacy helper path whose file
 *             is missing or rewritten -- a custom ANTHROPIC_BASE_URL, or malformed
 *             JSON (a config we must not clobber)
 *   - none:   no relevant keys (absent/empty) -- unconfigured; proxy is default
 */
export function inspectClaudeWiring(
  settingsText: string | null,
  claudeHome: string,
  expectedPort: number,
  profile: Profile = null,
  readFile: (path: string) => string | null = readTextOrNull,
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

  // The inline command is the managed contract, recognized by SHAPE (any root's
  // spelling); the path arms are the legacy helper-file tolerance, and classify as
  // ours only when the file's body is one a release actually wrote (any install
  // root) -- a missing/foreign body at the legacy path falls through to "other"
  // (see the legacy helper-file tolerance block for the dating, the released
  // renderings, and the removal condition).
  if (
    helperPath !== null && (
      managedHelperShape(helperPath, agentAuthGetArgs(profile)) ||
      (helperPath === directHelperPath(claudeHome, profile) &&
        legacyDirectHelperBodyMatches(readFile(helperPath), profile))
    )
  ) {
    status.providerMode = "direct";
  } else if (
    helperPath !== null && (
      managedHelperShape(helperPath, proxyTokenArgs(profile)) ||
      (helperPath === proxyHelperPath(claudeHome, profile) &&
        legacyProxyHelperBodyMatches(readFile(helperPath), profile))
    )
  ) {
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
 * Direct writes the inline apiKeyHelper command that invokes `agent auth --get
 * [--profile <name>]` (the credential resolver for the addressed slot) + the Copilot
 * base URL; proxy resolves the profile's proxy port, writes the inline command that
 * runs `agent proxy-token --yes`, and points the base URL at 127.0.0.1. Either way the
 * merge is surgical (only managed keys change) and the OTHER mode's settings are
 * overwritten so switching modes is clean. A named DIRECT profile requires its own
 * credential (named profiles never fall back to the default one). Throws on an
 * unwritable home / malformed settings / unresolvable proxy port.
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
    // The inline command invokes `agent auth --get`; the token is never baked here, and
    // no helper file is written (a legacy install's helper files are left alone --
    // orphaned but harmless -- until uninstall/profile-del removes them by name).
    doc.apiKeyHelper = directHelperCommand(profile);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL, profile, options.directIntegrationId);
    // The MCP + deny pair is machine-global (default profile, the REAL Claude home
    // only -- the throwaway detect-probe home must not touch ~/.claude.json).
    const commit = profile === null && claudeHome === resolveClaudeHome()
      ? applyWebSearchPair(doc, "direct", settingsPath)
      : NO_COMMIT;
    saveSettings(settingsPath, doc);
    commit();
    if (!quiet) {
      logger.log(`  ✓ Claude config written → ${settingsPath} (direct: GitHub Copilot)`);
    }
    return;
  }

  // proxy: the inline command runs the proxy-token resolver (ensures the proxy is up
  // per the managed-lifecycle rules, then prints its key). The key is resolved at
  // helper-run time (not baked in). A named profile RESERVES its stable port here via
  // wiringPortFor (this is a write path; read-only checks peek without recording) so
  // concurrent profile daemons never share a port.
  const port = wiringPortFor(profile);
  doc.apiKeyHelper = proxyHelperCommand(profile);
  // proxyLoopbackOrigin (no path, no trailing slash -- the shape claudeBaseUrlMatchesProxy
  // expects); env.ts's isLocalProxyUrl accepts it. Host rationale (127.0.0.1, never localhost)
  // on the helper in port.ts.
  applyManagedEnv(doc, "proxy", proxyLoopbackOrigin(port), profile);
  const commit = profile === null && claudeHome === resolveClaudeHome()
    ? applyWebSearchPair(doc, "proxy", settingsPath)
    : NO_COMMIT;
  saveSettings(settingsPath, doc);
  commit();
  if (!quiet) {
    logger.log(`  ✓ Claude config written → ${settingsPath} (proxy mode → port ${port})`);
  }
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
 * Remove a NAMED profile's managed Claude artifacts: its LEGACY helper scripts (ours
 * by name; the inline wiring writes none) and its settings-<name>.json -- the latter
 * only when it is actually OURS (managed direct/proxy wiring); a foreign same-named
 * file the user owns is left alone. Used by `agent profile --del`.
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
 * alone. LEGACY helper scripts are removed by name (the inline wiring writes none;
 * mirrors removeClaudeProfile). The
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
 * `claude -p` against it (see src/agents/live_probe.ts). False => write proxy.
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
 * The Claude AgentAdapter: the shared command skeleton's view of this file's
 * writers (see src/agents/configure.ts).
 */
export function claudeAdapter(): AgentAdapter {
  return {
    label: "Claude",
    check: checkClaudeConfig,
    detectDirect: detectClaudeDirect,
    async configureDefault(mode, ghToken) {
      // Direct bakes the client identity this credential is accepted under (shared with
      // Codex Direct); proxy needs none. Reuses the already-resolved token so gh-cli isn't
      // spawned twice.
      const directIntegrationId = mode === "direct"
        ? await probeDirectIntegrationId(null, ghToken)
        : undefined;
      configureClaudeConfig(resolveClaudeHome(), mode, { directIntegrationId });
      // Claude Desktop's chat surface reads its own config library, not settings.json;
      // every default rewire refreshes it too (best-effort, identity resolved above).
      await syncClaudeDesktopWiring({
        profile: null,
        mode,
        directIntegrationId,
        directToken: ghToken,
      });
    },
    async configureProfile(name, mode, options) {
      configureClaudeConfig(resolveClaudeHome(), mode, {
        quiet: options.quiet,
        profile: name,
        directIntegrationId: options.directIntegrationId,
      });
      await syncClaudeDesktopWiring({
        profile: name,
        mode,
        directIntegrationId: options.directIntegrationId,
        quiet: options.quiet,
      });
    },
    removeProfile(name) {
      removeClaudeProfile(resolveClaudeHome(), name);
      removeClaudeDesktopEntry(name);
    },
  };
}

/**
 * `agent claude`: configure Claude Code's wiring at the effective Claude home
 * ($CLAUDE_CONFIG_DIR, else ~/.claude). `--direct` forces GitHub Copilot Direct,
 * `--proxy` forces the local proxy, and with no mode flag it auto-detects (live
 * `claude -p` probe, else the proxy). A GitHub token provisioned via `agent auth`
 * (in the shared store) selects Direct without probing when no mode flag is given.
 * `--check` reports the configured mode (exit 0 direct / 2 proxy|none / 1 other)
 * without a probe. (Named profiles are managed by `agent profile`, not here.)
 * The body is the shared skeleton (runAgentConfig) over claudeAdapter.
 */
export async function runClaude(args: ClaudeConfigArgs): Promise<void> {
  return runAgentConfig(claudeAdapter(), args);
}
