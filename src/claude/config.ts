// Claude Code config writer for ~/.claude/settings.json (the Codex twin is src/codex/config.ts).
// apiKeyHelper is a shell command string, not a file path, so the wiring invokes bin/agent inline
// and no credential helper file exists anywhere. Claude's contract on that command:
//   stdout cached ~5 minutes, re-run on 401
//   stdout anything but the single credential line -> hard failure, so both resolvers keep their
//                                                     diagnostics on stderr
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentAdapter,
  type AgentRunAction,
  type ManagedWrite,
  runAgentConfig,
} from "../agents/configure.ts";
import { CLAUDE_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
} from "../agents/provider_mode.ts";
import { codexUserAgent, probeDirectIntegrationId } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
} from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  copilotApiResolvePort,
  matchesProxyOrigin,
  proxyLoopbackOrigin,
  wiringPortFor,
} from "../copilot_api/port.ts";
import { type Profile, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, readTextResult, type TextReadResult } from "../utils/fs.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { mkdirReported, removeReported, writeFileReported } from "../utils/report_write.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  proxyTokenArgs,
  proxyTokenCommand,
} from "../utils/root.ts";
import { removeClaudeDesktopEntry, syncClaudeDesktopWiring } from "./desktop.ts";
import { cmdHelperBody, shQuote, winQuote } from "./helper_body.ts";
import { registerClaudeMcpServer, removeClaudeMcpRegistration } from "./mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor, WIN } from "./paths.ts";

const logger = createStderrLogger();

// Copilot serving Claude is undocumented; CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is a knob proven
// by test, not by docs. The base URL literal lives in integration_identity.ts so the identity probe
// judges the same host the agents bake.
export const DIRECT_BASE_URL = DEFAULT_COPILOT_API_BASE;
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";
// Copilot Direct gates on an editor-client identity, and Claude has no http_headers knob: it reads
// extra request headers from this env var as newline-separated `Name: Value` pairs. The proxy
// speaks native Anthropic and needs none.
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** Body builders live in helper_body.ts (shared with the Desktop wiring); cmdHelperBody stays
 *  re-exported here for its existing test/import surface. */
export { cmdHelperBody };

function shToken(s: string): string {
  return /^[A-Za-z0-9_.:/=-]+$/.test(s) ? s : shQuote(s);
}

// Recognized by SHAPE, not byte-exact against this root: a sibling install's wiring (a dev checkout
// vs ~/.copilot-env) must still read as managed, or the verdict would depend on which copilot-env
// binary was asking. Each arm admits only spellings the writers produce.
//   bare POSIX path     -> shToken's charset only, so `evil;/bin/agent` never reads as managed
//   Windows -File path  -> always winQuote-quoted (a real path carries `\` and `:`), so no bare arm
const POSIX_LAUNCHER_SHAPE = String
  .raw`(?:'(?:[^']|'\\'')*/bin/agent'|[A-Za-z0-9_.:/=-]*/bin/agent)`;
// No line breaks inside the quotes: a value smuggling a second line must never read as managed. Raw
// `%` stays legal: the inline command is not a batch file, so the writer never doubles it.
const WIN_LAUNCHER_SHAPE = String
  .raw`powershell -NoProfile -ExecutionPolicy Bypass -File "[^"\r\n]*\\bin\\agent\.ps1"`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `win` is a parameter rather than the ambient platform so both shapes are testable on every CI
 *  runner. */
export function managedHelperShape(
  helperValue: string,
  subArgs: readonly string[],
  win: boolean = WIN,
): boolean {
  const argsLine = escapeRegExp(subArgs.map(win ? winQuote : shToken).join(" "));
  const launcher = win ? WIN_LAUNCHER_SHAPE : POSIX_LAUNCHER_SHAPE;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- our shapes, escaped args, our config value
  return new RegExp(`^${launcher} ${argsLine}$`).test(helperValue);
}

/** Claude runs apiKeyHelper through sh on POSIX and cmd on Windows, hence the two quoters. */
function helperCommandLine({ command, args }: { command: string; args: string[] }): string {
  return [command, ...args].map(WIN ? winQuote : shToken).join(" ");
}

export function directHelperCommand(profile: Profile = null): string {
  return helperCommandLine(agentLauncherCommand(agentAuthGetArgs(profile)));
}

export function proxyHelperCommand(profile: Profile = null): string {
  return helperCommandLine(proxyTokenCommand(profile));
}

/** Minted with providerMode by inspectClaudeWiring so consumers switch on it instead of
 *  re-deriving.
 *    "malformed"   -> settings present but not a JSON object
 *    "read-error"  -> settings exist but could not be read
 *    "custom"      -> a foreign apiKeyHelper or a custom base URL */
export type ClaudeOtherReason = "malformed" | "custom" | "read-error";

/**
 * Discriminated on providerMode so a pair the classifier never mints ("other" without a reason, a
 * managed mode without a helper) is unrepresentable. `wired` is computed here, in the owner, so
 * consumers never re-derive it from the mode.
 */
export type ClaudeWiringStatus =
  | {
    providerMode: "direct" | "proxy";
    settingsExists: true;
    wired: true;
    otherReason: null;
    /** The managed inline command: not a secret, safe to print. */
    helperPath: string;
    baseUrl: string | null;
    /** The proxy-port check; defaultSetupNeedsProxy keys off it (mode itself keys off apiKeyHelper
     *  alone). */
    baseUrlMatches: boolean;
  }
  | {
    providerMode: "none";
    /** False = no settings file at all; true = one with no relevant keys. */
    settingsExists: boolean;
    wired: false;
    otherReason: null;
    helperPath: null;
    baseUrl: null;
    baseUrlMatches: false;
  }
  | {
    providerMode: "other";
    settingsExists: true;
    wired: false;
    otherReason: ClaudeOtherReason;
    /** The foreign apiKeyHelper value; null when the file could not be read or parsed at all. */
    helperPath: string | null;
    baseUrl: string | null;
    baseUrlMatches: boolean;
  };

/** No path, unlike Codex's `/v1`; the grammar (trailing slash, localhost) is port.ts's. */
function claudeBaseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "");
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * The verdict authorizes `--check`, the uninstall strip, and the profile overwrite guard, so a
 * settings file that exists but cannot be read is "other", never "none": "none" would authorize
 * removal. Mode keys off apiKeyHelper alone; a user's similar-looking helper is never ours.
 */
export function inspectClaudeWiring(
  settings: TextReadResult | string | null,
  expectedPort: number,
  profile: Profile = null,
): ClaudeWiringStatus {
  const read: TextReadResult = typeof settings === "string"
    ? { kind: "text", text: settings }
    : settings ?? { kind: "absent" };
  const none = (settingsExists: boolean): ClaudeWiringStatus => ({
    providerMode: "none",
    settingsExists,
    wired: false,
    otherReason: null,
    helperPath: null,
    baseUrl: null,
    baseUrlMatches: false,
  });
  if (read.kind === "unreadable") {
    return {
      providerMode: "other",
      settingsExists: true,
      wired: false,
      otherReason: "read-error",
      helperPath: null,
      baseUrl: null,
      baseUrlMatches: false,
    };
  }
  if (read.kind === "absent" || read.text.trim() === "") return none(read.kind !== "absent");

  const doc = parseJsonRecord(read.text);
  if (doc === null) {
    return {
      providerMode: "other",
      settingsExists: true,
      wired: false,
      otherReason: "malformed",
      helperPath: null,
      baseUrl: null,
      baseUrlMatches: false,
    };
  }

  // apiKeyHelper is the command Claude runs, not a secret; keyed access (no literal
  // `.apiKeyHelper`) keeps secret scanners from flagging it as a logged credential.
  const helperPath = readStringField(doc, "apiKeyHelper");
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl = env ? readStringField(env, BASE_URL_ENV) : null;
  const baseUrlMatches = baseUrl !== null && claudeBaseUrlMatchesProxy(baseUrl, expectedPort);

  if (helperPath !== null && managedHelperShape(helperPath, agentAuthGetArgs(profile))) {
    return {
      providerMode: "direct",
      settingsExists: true,
      wired: true,
      otherReason: null,
      helperPath,
      baseUrl,
      baseUrlMatches,
    };
  }
  if (helperPath !== null && managedHelperShape(helperPath, proxyTokenArgs(profile))) {
    return {
      providerMode: "proxy",
      settingsExists: true,
      wired: true,
      otherReason: null,
      helperPath,
      baseUrl,
      baseUrlMatches,
    };
  }
  if (helperPath !== null || baseUrl !== null) {
    return {
      providerMode: "other",
      settingsExists: true,
      wired: false,
      otherReason: "custom",
      helperPath,
      baseUrl,
      baseUrlMatches,
    };
  }
  return none(true);
}

// --- config writes ----------------------------------------------------------

/**
 * Absence agrees with readTextResult's "absent" (ENOENT or ENOTDIR), so a caller that classified
 * the read as none can never throw here. A malformed file throws: settings we could not read are
 * never overwritten.
 */
function loadSettings(settingsPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    if (isEnoentOrNotdir(e)) return {};
    throw e;
  }
  if (text.trim() === "") return {};
  const doc = parseJsonRecord(text);
  if (doc === null) {
    throw new Error(`${settingsPath} is not valid JSON; refusing to overwrite it`);
  }
  return doc;
}

function saveSettings(settingsPath: string, doc: Record<string, unknown>, detail?: string): void {
  mkdirReported(path.dirname(settingsPath));
  writeFileReported(settingsPath, `${JSON.stringify(doc, null, 2)}\n`, { detail });
}

/** An emptied doc removes the file: never a lone `{}` left behind. */
function saveOrRemoveSettings(settingsPath: string, doc: Record<string, unknown>): void {
  if (Object.keys(doc).length === 0) removeReported(settingsPath);
  else saveSettings(settingsPath, doc);
}

/** Serialized from the same builder Codex Direct bakes as `http_headers`, so Copilot's
 *  editor-client allowlist accepts Claude the same way. */
function directCustomHeaders(integrationId?: string | null): string {
  return Object.entries(directClientHeaders(codexUserAgent(), integrationId))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** `claude --settings` layers a named profile's file over settings.json with a shallow env merge,
 *  so a named proxy profile must BLANK the direct-only keys where the default proxy write simply
 *  deletes them: a direct default underneath would otherwise bleed its headers through. */
function applyManagedEnv(
  doc: Record<string, unknown>,
  mode: ManagedAgentMode,
  baseUrl: string,
  profile: Profile = null,
  directIntegrationId?: string | null,
) {
  const env = isRecord(doc.env) ? doc.env : {};
  env[BASE_URL_ENV] = baseUrl;
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
 * Document mutations happen eagerly; the ledger record (and the registration removal on take-back)
 * runs in the returned commit AFTER a successful save, so a failed write leaves ledger and file
 * consistent and a retry can still recover.
 */
type WebSearchPairCommit = () => void;
const NO_COMMIT: WebSearchPairCommit = () => {};

/**
 * Ownership is the exact settings PATH the entry was added to: a deny the user already had, or one
 * in a different CLAUDE_CONFIG_DIR, is never claimed, so removal can only take back ours. A
 * malformed `permissions`/`deny` is warned about and left alone.
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
  // Present already: the user's own (never claimed) or ours from an earlier write (already
  // recorded).
  if (deny.includes(WEBSEARCH_DENY_RULE)) return NO_COMMIT;
  deny.push(WEBSEARCH_DENY_RULE);
  permissions.deny = deny;
  doc.permissions = permissions;
  // Post-save on purpose: a record without a saved deny would make a deny the USER adds later ours
  // to delete. The inverse (saved, record failed) merely orphans our one line: the acceptable
  // direction.
  return () => new OwnershipLedger().record("webSearchDeny", settingsPath);
}

function stripManagedWebSearchDeny(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPairCommit {
  const ledger = new OwnershipLedger();
  if (!ledger.owns("webSearchDeny", settingsPath)) return NO_COMMIT;
  const permissions = isRecord(doc.permissions) ? doc.permissions : null;
  if (permissions !== null && Array.isArray(permissions.deny)) {
    const filtered = permissions.deny.filter((rule) => rule !== WEBSEARCH_DENY_RULE);
    if (filtered.length > 0) permissions.deny = filtered;
    else delete permissions.deny;
    if (Object.keys(permissions).length === 0) delete doc.permissions;
  }
  return () => ledger.release("webSearchDeny", settingsPath);
}

/**
 * Registration first, and the deny stands only while the registration is confirmed: a machine is
 * never left with the builtin denied and no replacement. The proxy serves web search itself, so it
 * takes both back.
 *   `~/.claude.json` is global, deny rules UNION across layers -> default profile only; a named
 *                                                                proxy profile could never un-deny
 *                                                                a direct default's rule
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
  // Post-save too: a failed settings write keeps the consistent old state (deny + server) instead
  // of losing only the server half.
  return () => {
    commit();
    removeClaudeMcpRegistration();
  };
}

/**
 * Re-derive the web-search pair for the current default wiring: direct applies it (per `wire-mcp`),
 * proxy or none takes it back, a foreign settings.json is never touched. `agent mcp --remove`
 * stores `wire-mcp false` before calling this, which makes it a strip.
 */
export function syncDefaultWebSearchWiring(claudeHome = resolveClaudeHome()): void {
  const settingsPath = settingsPathFor(claudeHome);
  const status = inspectClaudeWiring(readTextResult(settingsPath), 0);
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

export type ClaudeWriteRequest = ManagedWrite & {
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
};

/**
 * A named profile's file is launched via `claude --settings`. Throws on an unwritable home,
 * malformed settings, or an unresolvable proxy port.
 */
export function configureClaudeConfig(claudeHome: string, request: ClaudeWriteRequest): void {
  const profile = request.profile ?? null;
  // read(), not resolve(): no `gh` spawn (runClaude already resolved and fail-fasted; this
  // backstops direct callers like --settings-for). read() is fail-closed, so a recorded provider
  // whose token is gone reads "none" and a broken slot is refused too.
  if (
    profile !== null &&
    request.mode === "direct" &&
    new Credential(undefined, profile).read().kind === "none"
  ) {
    throw new Error(
      `${profileLabel(profile)} has no credential of its own (a named profile never falls back ` +
        `to the default credential) - run \`agent auth --profile ${profile}\` first.`,
    );
  }
  try {
    mkdirReported(claudeHome);
  } catch (e) {
    throw new Error(`could not create Claude config directory ${claudeHome}: ${errMessage(e)}`);
  }

  const settingsPath = settingsPathFor(claudeHome, profile);
  const doc = loadSettings(settingsPath);
  // A named profile never takes over a pre-existing settings-<name>.json wired to something we do
  // not manage; the default settings.json keeps its contract that an explicit write reclaims even a
  // custom config.
  if (profile !== null) {
    const current = inspectClaudeWiring(JSON.stringify(doc), 0, profile);
    if (current.providerMode === "other") {
      throw new Error(
        `${settingsPath} is wired to something copilot-env does not manage; refusing to ` +
          `overwrite it (pick a different profile name or remove the file first)`,
      );
    }
  }

  if (request.mode === "direct") {
    doc.apiKeyHelper = directHelperCommand(profile);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL, profile, request.directIntegrationId);
    // Real Claude home only: the throwaway detect-probe home must not touch the machine-global
    // ~/.claude.json.
    const commit = profile === null && claudeHome === resolveClaudeHome()
      ? applyWebSearchPair(doc, "direct", settingsPath)
      : NO_COMMIT;
    saveSettings(settingsPath, doc, "Claude config, direct: GitHub Copilot");
    commit();
    return;
  }

  // wiringPortFor RESERVES the profile's port (a write path; read-only checks peek without
  // recording), so concurrent profile daemons never share one.
  const port = wiringPortFor(profile);
  doc.apiKeyHelper = proxyHelperCommand(profile);
  // No path, no trailing slash: the shape claudeBaseUrlMatchesProxy and env.ts's isLocalProxyUrl
  // expect.
  applyManagedEnv(doc, "proxy", proxyLoopbackOrigin(port), profile);
  const commit = profile === null && claudeHome === resolveClaudeHome()
    ? applyWebSearchPair(doc, "proxy", settingsPath)
    : NO_COMMIT;
  saveSettings(settingsPath, doc, `Claude config, proxy mode via port ${port}`);
  commit();
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
  const status = inspectClaudeWiring(readTextResult(settingsPath), Number(copilotApiResolvePort()));
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

/** Read-only; the uninstall plan resolves this once and renders it both ways (dry run and live). */
export function claudeProfileArtifacts(claudeHome: string, name: ProfileName): string[] {
  const settingsPath = settingsPathFor(claudeHome, name);
  return inspectClaudeWiring(readTextResult(settingsPath), 0, name).wired ? [settingsPath] : [];
}

/** Only artifacts whose wiring is ours; an "other" verdict (foreign, malformed, unreadable) leaves
 *  the user's file alone. */
export function removeClaudeProfile(
  claudeHome: string,
  name: ProfileName,
  artifacts: readonly string[] = claudeProfileArtifacts(claudeHome, name),
): void {
  for (const path of artifacts) removeReported(path);
}

/** What removeClaudeDefaultWiring left behind, for the caller to sequence on. */
export interface ClaudeDefaultWiringRemoval {
  /** The strip could not land (file unreadable, malformed, or unwritable), so the ledger still owns
   *  a deny here. While it stands the MCP registration must stay too: never a denied builtin with
   *  no replacement. */
  ownedDenyRemains: boolean;
}

/**
 * The managed keys are ours only while apiKeyHelper is still the managed helper; the owned deny is
 * the exception, since exact-path ownership proves it whatever the rest of the file holds.
 *   wired                     -> strip the keys and the owned deny; an emptied doc removes the file
 *   none, or parseable other  -> strip exactly the owned deny (best-effort write)
 *   unreadable or malformed   -> nothing; an owned deny stands, reported as ownedDenyRemains
 */
export function removeClaudeDefaultWiring(claudeHome: string): ClaudeDefaultWiringRemoval {
  const settingsPath = settingsPathFor(claudeHome);
  const wiring = inspectClaudeWiring(readTextResult(settingsPath), 0);
  const parseable = wiring.otherReason !== "malformed" && wiring.otherReason !== "read-error";
  if (wiring.wired) {
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
  } else if (parseable) {
    // An untouched doc is not rewritten, but the commit still releases a stale marker. An
    // unwritable file keeps its ownership record: never released while the entry may still stand.
    const doc = loadSettings(settingsPath);
    const before = JSON.stringify(doc);
    const commit = stripManagedWebSearchDeny(doc, settingsPath);
    let saved = true;
    if (JSON.stringify(doc) !== before) {
      try {
        saveOrRemoveSettings(settingsPath, doc);
      } catch {
        saved = false;
      }
    }
    if (saved) commit();
  }
  return { ownedDenyRemains: new OwnershipLedger().owns("webSearchDeny", settingsPath) };
}

/** Writes a throwaway direct config and runs `claude -p` against it (src/agents/live_probe.ts);
 *  false means the caller writes proxy. */
export function detectClaudeDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CLAUDE_PROBE,
    (tmpHome) => {
      configureClaudeConfig(tmpHome, { mode: "direct" });
    },
    deps,
  );
}

export function claudeAdapter(): AgentAdapter {
  return {
    id: "claude",
    label: "Claude",
    check: checkClaudeConfig,
    detectDirect: detectClaudeDirect,
    // The skeleton passes the token it already resolved so gh-cli is not spawned twice.
    resolveDirectIdentity: (ghToken) => probeDirectIntegrationId(null, ghToken),
    async configureDefault(write, ghToken) {
      configureClaudeConfig(resolveClaudeHome(), write);
      // Desktop reads its own config library, not settings.json, so every rewire reconciles it.
      await syncClaudeDesktopWiring({ ...write, profile: null, directToken: ghToken });
    },
    async configureProfile(name, write, options) {
      configureClaudeConfig(resolveClaudeHome(), { ...write, profile: name });
      await syncClaudeDesktopWiring({ ...write, profile: name, quiet: options.quiet });
    },
    removeProfile(name, options) {
      removeClaudeProfile(resolveClaudeHome(), name, options?.claudeArtifacts);
      if (!options?.keepDesktopEntry) removeClaudeDesktopEntry(name);
    },
  };
}

/** `agent claude`: the shared skeleton (runAgentConfig) over claudeAdapter. */
export async function runClaude(action: AgentRunAction): Promise<void> {
  return runAgentConfig(claudeAdapter(), action);
}
