// Claude Code config writer for ~/.claude/settings.json (the Codex twin is src/codex/config.ts).
// apiKeyHelper is a shell command string, not a file path, so the wiring invokes bin/agent inline
// and no credential helper file exists anywhere. Claude's contract on that command:
//   stdout cached ~5 minutes, re-run on 401
//   stdout anything but the single credential line -> hard failure, so both resolvers keep their
//                                                     diagnostics on stderr
// With `static-key` covering Claude, the value rides in env.ANTHROPIC_AUTH_TOKEN instead and no
// apiKeyHelper is written: Claude prefers that variable over the helper, so a command-shape write
// takes it out (applyManagedCredential).
import * as path from "node:path";
import {
  type AgentAdapter,
  type CredentialWiring,
  type DirectWiring,
  type ManagedWrite,
  reservePlannedPort,
  resolvedDirectToken,
} from "../agents/configure.ts";
import { CLAUDE_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import {
  type AgentProviderMode,
  MANAGED_MODE_DETAIL,
  type ManagedAgentMode,
  providerModeExitCode,
} from "../agents/provider_mode.ts";
import { probeDirectWiring } from "../codex/config.ts";
import { codexUserAgent } from "../codex/user_agent.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { directSmoke, type EndpointSmoke, probeModelPin } from "../copilot_api/endpoint_smoke.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  isDirectBaseUrl,
} from "../copilot_api/integration_identity.ts";
import {
  cheapestClaudeModel,
  newestClaudeModel,
  parseCatalogModels,
} from "../copilot_api/models.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  copilotApiResolvePort,
  matchesProxyOrigin,
  parseLoopbackProxyUrl,
  proxyLoopbackOrigin,
} from "../copilot_api/port.ts";
import {
  agentStartCommand,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, WIN } from "../utils/fs.ts";
import type { TextReadResult } from "../utils/fs_facade.ts";
import * as fs from "../utils/fs_facade.ts";
import { escapeRegExp } from "../utils/regexp.ts";
import { type ManagedEnvValue, quotePosix } from "../utils/shell_quote.ts";
import { printKeyValue } from "../utils/table.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  proxyTokenArgs,
  proxyTokenCommand,
} from "../utils/root.ts";
import { removeClaudeDesktopEntry, syncClaudeDesktopWiring } from "./desktop.ts";
import { winQuote } from "./helper_body.ts";
import { prepareClaudeMcpRemoval, registerClaudeMcpServer } from "./mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "./paths.ts";

const logger = createStderrLogger();

// Copilot serving Claude is undocumented; CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is a knob proven
// by test, not by docs. The Copilot hosts live in integration_identity.ts so the identity probe
// judges the same host the agents bake.
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const DISABLE_BETAS_ENV = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";
// Copilot Direct gates on an editor-client identity, and Claude has no http_headers knob: it reads
// extra request headers from this env var as newline-separated `Name: Value` pairs. The proxy
// speaks native Anthropic and needs none.
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";
// The static-key carrier: Claude sends it as `Authorization: Bearer`, which Copilot Direct and the
// proxy both accept.
export const AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

function shToken(s: string): string {
  return /^[A-Za-z0-9_.:/=-]+$/.test(s) ? s : quotePosix(s);
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

/** How a managed file obtains the credential: the `static-key` preference at its write time. */
export type ClaudeManagedCredential =
  /** The managed inline command: not a secret, safe to print. */
  | { credential: "command"; helperPath: string }
  /** `env.ANTHROPIC_AUTH_TOKEN` carries the value; the inspector never surfaces it. */
  | { credential: "static"; helperPath: null };

/**
 * Discriminated on providerMode so a pair the classifier never mints ("other" without a reason, a
 * managed mode without a credential shape) is unrepresentable. `wired` is computed here, in the
 * owner, so consumers never re-derive it from the mode.
 */
export type ClaudeWiringStatus =
  | (ClaudeManagedCredential & {
    providerMode: "direct" | "proxy";
    settingsExists: true;
    wired: true;
    otherReason: null;
    baseUrl: string | null;
    /** The proxy-port check; defaultSetupNeedsProxy keys off it (mode itself keys off the
     *  credential shape alone). */
    baseUrlMatches: boolean;
  })
  | {
    providerMode: "none";
    /** False = no settings file at all; true = one with no relevant keys. */
    settingsExists: boolean;
    wired: false;
    otherReason: null;
    credential: null;
    helperPath: null;
    baseUrl: null;
    baseUrlMatches: false;
  }
  | {
    providerMode: "other";
    settingsExists: true;
    wired: false;
    otherReason: ClaudeOtherReason;
    credential: null;
    /** The foreign apiKeyHelper value; null when the file could not be read or parsed at all. */
    helperPath: string | null;
    baseUrl: string | null;
    baseUrlMatches: boolean;
  };

/** The Direct client headers Claude carries (directCustomHeaders' output), recognized by the one
 *  line no other wiring writes: the codex_exec User-Agent. */
function directHeadersShape(customHeaders: string | null): boolean {
  return customHeaders !== null &&
    customHeaders.split("\n").some((line) =>
      line.startsWith(`User-Agent: ${CODEX_EXEC_USER_AGENT}/`)
    );
}

/** The baked ANTHROPIC_AUTH_TOKEN of a settings file, for the health freshness compare only: the
 *  inspector never carries the value, so no status object or report can print it. Null unless the
 *  file parses and holds a non-empty token. */
export function bakedClaudeToken(settings: TextReadResult): string | null {
  if (settings.kind !== "text") return null;
  const doc = parseJsonRecord(settings.text);
  const env = doc !== null && isRecord(doc.env) ? doc.env : null;
  const token = env === null ? null : readStringField(env, AUTH_TOKEN_ENV);
  return token === null || token === "" ? null : token;
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * The verdict authorizes `--check`, the uninstall strip, and the profile overwrite guard, so a
 * settings file that exists but cannot be read is "other", never "none": "none" would authorize
 * removal. Mode keys off the credential shape alone: a managed apiKeyHelper, else (with no helper at
 * all) a baked ANTHROPIC_AUTH_TOKEN beside the env keys only our Direct or proxy write produces. A
 * user's similar-looking helper is never ours.
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
    credential: null,
    helperPath: null,
    baseUrl: null,
    baseUrlMatches: false,
  });
  const other = (
    otherReason: ClaudeOtherReason,
    helperPath: string | null = null,
    baseUrl: string | null = null,
    baseUrlMatches = false,
  ): ClaudeWiringStatus => ({
    providerMode: "other",
    settingsExists: true,
    wired: false,
    otherReason,
    credential: null,
    helperPath,
    baseUrl,
    baseUrlMatches,
  });
  if (read.kind === "unreadable") return other("read-error");
  if (read.kind === "absent" || read.text.trim() === "") return none(read.kind !== "absent");

  const doc = parseJsonRecord(read.text);
  if (doc === null) return other("malformed");

  // apiKeyHelper is the command Claude runs, not a secret; keyed access (no literal
  // `.apiKeyHelper`) keeps secret scanners from flagging it as a logged credential.
  const helperPath = readStringField(doc, "apiKeyHelper");
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl = env ? readStringField(env, BASE_URL_ENV) : null;
  // No path, unlike Codex's `/v1`; the grammar (trailing slash, localhost) is port.ts's.
  const baseUrlMatches = baseUrl !== null && matchesProxyOrigin(baseUrl, expectedPort, "");
  const wired = (
    providerMode: "direct" | "proxy",
    shape: ClaudeManagedCredential,
  ): ClaudeWiringStatus => ({
    ...shape,
    providerMode,
    settingsExists: true,
    wired: true,
    otherReason: null,
    baseUrl,
    baseUrlMatches,
  });

  if (helperPath !== null && managedHelperShape(helperPath, agentAuthGetArgs(profile))) {
    return wired("direct", { credential: "command", helperPath });
  }
  if (helperPath !== null && managedHelperShape(helperPath, proxyTokenArgs(profile))) {
    return wired("proxy", { credential: "command", helperPath });
  }
  const staticToken = env ? readStringField(env, AUTH_TOKEN_ENV) : null;
  if (helperPath === null && env !== undefined && staticToken !== null && staticToken !== "") {
    if (
      baseUrl !== null && isDirectBaseUrl(baseUrl) && env[DISABLE_BETAS_ENV] === "1" &&
      directHeadersShape(readStringField(env, CUSTOM_HEADERS_ENV))
    ) {
      return wired("direct", { credential: "static", helperPath: null });
    }
    // Any loopback port: the port fact travels as baseUrlMatches, like the command shape.
    if (baseUrl !== null && parseLoopbackProxyUrl(baseUrl)?.path === "") {
      return wired("proxy", { credential: "static", helperPath: null });
    }
  }
  if (helperPath !== null || baseUrl !== null || staticToken !== null) {
    return other("custom", helperPath, baseUrl, baseUrlMatches);
  }
  return none(true);
}

// --- config writes ----------------------------------------------------------

/**
 * Absence agrees with fs.readTextResult's "absent" (ENOENT or ENOTDIR), so a caller that classified
 * the read as none can never throw here. A malformed file throws: settings we could not read are
 * never overwritten. Read through the facade, so a dry run's planned content answers.
 */
function loadSettings(settingsPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readText(settingsPath);
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

function settingsText(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The settings leaves a dry run redacts; every writer of a profile's settings file declares them. */
export const SETTINGS_SECRETS: readonly string[] = [`env.${AUTH_TOKEN_ENV}`];

/** In place, as Claude Code itself writes it: a user's symlinked settings.json stays a link, and an
 *  unwritable file refuses the write instead of being replaced beside its permissions. */
function saveSettings(settingsPath: string, doc: Record<string, unknown>, detail?: string): void {
  fs.mkdir(path.dirname(settingsPath));
  fs.writeText(settingsPath, settingsText(doc), {
    atomic: false,
    detail,
    secretKeys: SETTINGS_SECRETS,
  });
}

/** An emptied doc removes the file: never a lone `{}` left behind. A directory at the path is the
 *  seam's own refusal. */
function saveOrRemoveSettings(settingsPath: string, doc: Record<string, unknown>): void {
  if (Object.keys(doc).length > 0) {
    saveSettings(settingsPath, doc);
    return;
  }
  fs.assertNotDirectory(settingsPath);
  fs.rm(settingsPath, { force: true });
}

/** Serialized from the same builder Codex Direct bakes as `http_headers`, so Copilot's
 *  editor-client allowlist accepts Claude the same way. */
function directCustomHeaders(integrationId?: string | null): string {
  return Object.entries(directClientHeaders(codexUserAgent(), integrationId))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** `env` is ours to shape: a non-object in its way is replaced, as the writers always did. */
function envTable(doc: Record<string, unknown>): Record<string, unknown> {
  const env = isRecord(doc.env) ? doc.env : {};
  doc.env = env;
  return env;
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
): void {
  const env = envTable(doc);
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
}

/** The ONE credential carrier per shape, the other's always removed: `apiKeyHelper` for the command,
 *  `env.ANTHROPIC_AUTH_TOKEN` for the value. Claude prefers the variable over the helper, so the
 *  command shape must take it out of the layered result:
 *    default file  -> deleted
 *    named file    -> blanked to "", like the direct-only keys: `claude --settings` merges env per
 *                     key, so a static default underneath would otherwise hand its token to the
 *                     profile session, over the profile's own helper
 *  Follows applyManagedEnv, which owns `env`. */
function applyManagedCredential(
  doc: Record<string, unknown>,
  credential: CredentialWiring,
  helperCommand: string,
  profile: Profile,
): void {
  if (credential.kind === "command") {
    doc.apiKeyHelper = helperCommand;
    const env = envTable(doc);
    if (profile === null) delete env[AUTH_TOKEN_ENV];
    else env[AUTH_TOKEN_ENV] = "";
    return;
  }
  delete doc.apiKeyHelper;
  envTable(doc)[AUTH_TOKEN_ENV] = credential.token;
}

/** The write-report clause that says how the credential rides; the proxy static case also says
 *  what the resolver command used to do for the user. */
function credentialDetail(
  credential: CredentialWiring,
  mode: ManagedAgentMode,
  profile: Profile,
): string {
  if (credential.kind === "command") return "";
  return mode === "direct"
    ? "; static key"
    : `; static key, start the proxy yourself (${agentStartCommand(profile)}, or the cl launcher)`;
}

/** The builtin tool denied on Direct (Copilot's host 400s it; the MCP tool replaces it). */
export const WEBSEARCH_DENY_RULE = "WebSearch";

/**
 * The web-search pair around the settings save: `before` runs once the home exists and before the
 * save (the registration, whose answer the deny depends on), `after` a file write the save must
 * precede (the registration removal on take-back), `commit` the ledger record or release (store
 * bookkeeping). `after` and `commit` run only after a successful save, so a failed write leaves
 * ledger and files consistent and a retry can still recover.
 */
type WebSearchPairStep = () => void;
const NO_STEP: WebSearchPairStep = () => {};
interface WebSearchPair {
  before: WebSearchPairStep;
  commit: WebSearchPairStep;
  after: WebSearchPairStep;
}
const NO_PAIR: WebSearchPair = { before: NO_STEP, commit: NO_STEP, after: NO_STEP };

/**
 * Ownership is the exact settings PATH the entry was added to: a deny the user already had, or one
 * in a different CLAUDE_CONFIG_DIR, is never claimed, so removal can only take back ours. A
 * malformed `permissions`/`deny` is warned about and left alone.
 */
function applyManagedWebSearchDeny(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPair {
  if (doc.permissions !== undefined && !isRecord(doc.permissions)) {
    logger.warn("settings.json permissions is not an object; leaving it alone (no WebSearch deny)");
    return NO_PAIR;
  }
  const permissions = isRecord(doc.permissions) ? doc.permissions : {};
  if (permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
    logger.warn("settings.json permissions.deny is not an array; leaving permissions alone");
    return NO_PAIR;
  }
  const deny: unknown[] = Array.isArray(permissions.deny) ? permissions.deny : [];
  // Present already: the user's own (never claimed) or ours from an earlier write (already
  // recorded).
  if (deny.includes(WEBSEARCH_DENY_RULE)) return NO_PAIR;
  doc.permissions = permissions;
  permissions.deny = [...deny, WEBSEARCH_DENY_RULE];
  return {
    before: NO_STEP,
    // Post-save on purpose: a record without a saved deny would make a deny the USER adds later
    // ours to delete. The inverse (saved, record failed) merely orphans our one line: the
    // acceptable direction.
    commit: () => new OwnershipLedger().record("webSearchDeny", settingsPath),
    after: NO_STEP,
  };
}

function stripManagedWebSearchDeny(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPair {
  const ledger = new OwnershipLedger();
  if (!ledger.owns("webSearchDeny", settingsPath)) return NO_PAIR;
  const permissions = isRecord(doc.permissions) ? doc.permissions : null;
  if (permissions !== null && Array.isArray(permissions.deny)) {
    const filtered = permissions.deny.filter((rule) => rule !== WEBSEARCH_DENY_RULE);
    const denyAlone = Object.keys(permissions).every((k) => k === "deny");
    if (filtered.length > 0) permissions.deny = filtered;
    else delete permissions.deny;
    if (filtered.length === 0 && denyAlone) delete doc.permissions;
  }
  return {
    before: NO_STEP,
    commit: () => ledger.release("webSearchDeny", settingsPath),
    after: NO_STEP,
  };
}

/**
 * Registration first, and the deny stands only while the registration is confirmed: a machine is
 * never left with the builtin denied and no replacement. The proxy serves web search itself, so it
 * takes both back. Default profile only: `~/.claude.json` is global and deny rules UNION across
 * layers, so a named proxy profile could never un-deny a direct default's rule.
 *
 * Direct: the registration is written in `before` (after the home exists, before the settings
 * save) and the deny is patched onto `doc` from its answer. Proxy: the removal is looked at now
 * and written in `after`, so a failed settings save keeps the consistent old state (deny +
 * server) instead of losing only the server half.
 */
function prepareWebSearchPair(
  doc: Record<string, unknown>,
  mode: ManagedAgentMode,
  settingsPath: string,
): WebSearchPair {
  if (mode === "direct" && new CopilotEnvConfig().wireMcpEnabled()) {
    let landed: WebSearchPair = NO_PAIR;
    return {
      before() {
        if (registerClaudeMcpServer()) {
          landed = applyManagedWebSearchDeny(doc, settingsPath);
          return;
        }
        logger.warn(
          "copilot-env MCP registration failed; removing the managed WebSearch deny so the " +
            "builtin stays reachable (it will 400 on Copilot Direct) - fix ~/.claude.json, " +
            "then rewire with `agent init --direct`",
        );
        landed = stripManagedWebSearchDeny(doc, settingsPath);
      },
      after: () => landed.after(),
      commit: () => landed.commit(),
    };
  }
  const strip = stripManagedWebSearchDeny(doc, settingsPath);
  const remove = prepareClaudeMcpRemoval();
  return { before: NO_STEP, commit: strip.commit, after: () => void remove() };
}

/**
 * Re-derive the web-search pair for the current default wiring: direct applies it (per
 * `claude.wire-mcp`), proxy or none takes it back, a foreign settings.json is never touched.
 * `agent profile mcp --remove` stores `claude.wire-mcp false` before running this, which makes it a strip.
 */
export function syncDefaultWebSearch(claudeHome = resolveClaudeHome()): void {
  const settingsPath = settingsPathFor(claudeHome);
  // The default slot's recorded mode decides whether the pair is APPLIED (direct); whether it is
  // STRIPPED is the ownership ledger's decision alone (stripManagedWebSearchDeny owns nothing,
  // strips nothing), so a default with no recorded mode takes the strip arm like proxy: a deny we
  // wrote before the record was cleared is still ours to take back.
  const mode = new CopilotEnvState().readProfileSlot(null).mode ?? "proxy";
  const doc = loadSettings(settingsPath);
  const before = JSON.stringify(doc);
  const pair = prepareWebSearchPair(doc, mode, settingsPath);
  pair.before();
  if (JSON.stringify(doc) !== before) saveOrRemoveSettings(settingsPath, doc);
  pair.after();
  pair.commit();
}

export type ClaudeWriteRequest = ManagedWrite & {
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
};

/**
 * The write: the managed env, credential carrier, and web-search pair over the settings file,
 * landed through the facade (a dry run previews it there). A named profile's file is launched via
 * `claude --settings`. Throws on malformed settings, an unresolvable proxy port, or an unwritable
 * home.
 */
export function configureClaudeConfig(claudeHome: string, request: ClaudeWriteRequest): void {
  const profile = request.profile ?? null;
  // read(), not resolve(): no `gh` spawn (runClaude already resolved and fail-fasted; this
  // backstops the `cl --profile` launcher's re-render). read() is fail-closed, so a recorded provider
  // whose token is gone reads "none" and a broken slot is refused too.
  if (
    profile !== null &&
    request.mode === "direct" &&
    new Credential(undefined, profile).read().kind === "none"
  ) {
    throw new Error(
      `${profileLabel(profile)} has no credential of its own (a named profile never falls back ` +
        `to the default credential) - run \`agent profile ${profile} auth\` first.`,
    );
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

  let detail: string;
  // The text PEEKS the profile's port; the write RESERVES it (reservePlannedPort), so the baked
  // base URL is the one computed.
  let plannedPort: string | null = null;
  if (request.mode === "direct") {
    applyManagedEnv(
      doc,
      "direct",
      request.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
      profile,
      request.direct?.directIntegrationId ?? null,
    );
    applyManagedCredential(doc, request.credential, directHelperCommand(profile), profile);
    detail = `Claude config, direct: GitHub Copilot${
      credentialDetail(request.credential, "direct", profile)
    }`;
  } else {
    plannedPort = copilotApiResolvePort(profile);
    // No path, no trailing slash: the shape inspectClaudeWiring's proxy-origin check and
    // parseLoopbackProxyUrl expect.
    applyManagedEnv(doc, "proxy", proxyLoopbackOrigin(plannedPort), profile);
    applyManagedCredential(doc, request.credential, proxyHelperCommand(profile), profile);
    detail = `Claude config, proxy mode via port ${plannedPort}${
      credentialDetail(request.credential, "proxy", profile)
    }`;
  }
  // Real Claude home only: the throwaway detect-probe home must not touch the machine-global
  // ~/.claude.json. The proxy arm's look at it comes before any write; the Direct arm's
  // registration write follows the home's mkdir, so a home that cannot be made leaves it untouched.
  const pair = profile === null && claudeHome === resolveClaudeHome()
    ? prepareWebSearchPair(doc, request.mode, settingsPath)
    : NO_PAIR;
  if (plannedPort !== null) reservePlannedPort(profile, plannedPort);
  try {
    fs.mkdir(claudeHome);
  } catch (e) {
    throw new Error(`could not create Claude config directory ${claudeHome}: ${errMessage(e)}`);
  }
  pair.before();
  saveSettings(settingsPath, doc, detail);
  pair.after();
  pair.commit();
}

// --- the `--check` provider report ------------------------------------------

function providerModeDetail(mode: AgentProviderMode): string {
  switch (mode) {
    case "direct":
    case "proxy":
      return MANAGED_MODE_DETAIL[mode];
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
    fs.readTextResult(settingsPath),
    Number(copilotApiResolvePort()),
  );
  printKeyValue(
    "Claude provider mode",
    `${status.providerMode} (${providerModeDetail(status.providerMode)})`,
  );
  printKeyValue("settings.json", settingsPath);
  if (status.providerMode === "direct" || status.providerMode === "proxy") {
    if (status.credential === "command") printKeyValue("apiKeyHelper", status.helperPath);
    else printKeyValue("credential", `static ${AUTH_TOKEN_ENV} (static-key; no apiKeyHelper)`);
    printKeyValue(BASE_URL_ENV, String(status.baseUrl));
  }
  process.exitCode = providerModeExitCode(status.providerMode);
}

/** Read-only; the uninstall plan resolves this once and renders it both ways (dry run and live). */
export function claudeProfileArtifacts(claudeHome: string, name: ProfileName): string[] {
  const settingsPath = settingsPathFor(claudeHome, name);
  return inspectClaudeWiring(fs.readTextResult(settingsPath), 0, name).wired ? [settingsPath] : [];
}

/** Only artifacts whose wiring is ours; an "other" verdict (foreign, malformed, unreadable) leaves
 *  the user's file alone. A directory at an artifact's path is the seam's own refusal. */
export function removeClaudeProfile(
  claudeHome: string,
  name: ProfileName,
  artifacts: readonly string[] = claudeProfileArtifacts(claudeHome, name),
): void {
  for (const path of artifacts) {
    fs.assertNotDirectory(path);
    fs.rm(path, { force: true });
  }
}

/** What removeClaudeDefaultWiring left behind, for the caller to sequence on. */
export interface ClaudeDefaultWiringRemoval {
  /** The strip could not land (file unreadable, malformed, or unwritable), so the ledger still owns
   *  a deny here. While it stands the MCP registration must stay too: never a denied builtin with
   *  no replacement. */
  ownedDenyRemains: boolean;
}

/**
 * The managed keys are ours only while the credential shape is still ours (the managed helper, or
 * the baked token beside our env keys); the owned deny is the exception, since exact-path ownership
 * proves it whatever the rest of the file holds.
 *   wired                     -> strip the keys and the owned deny; an emptied doc removes the file
 *   none, or parseable other  -> strip exactly the owned deny (best-effort write)
 *   unreadable or malformed   -> nothing; an owned deny stands, reported as ownedDenyRemains
 */
export function removeClaudeDefaultWiring(claudeHome: string): ClaudeDefaultWiringRemoval {
  const settingsPath = settingsPathFor(claudeHome);
  const wiring = inspectClaudeWiring(fs.readTextResult(settingsPath), 0);
  const parseable = wiring.otherReason !== "malformed" && wiring.otherReason !== "read-error";
  if (wiring.wired) {
    const doc = loadSettings(settingsPath);
    delete doc.apiKeyHelper;
    const env = isRecord(doc.env) ? doc.env : {};
    delete env[BASE_URL_ENV];
    delete env[DISABLE_BETAS_ENV];
    delete env[CUSTOM_HEADERS_ENV];
    delete env[AUTH_TOKEN_ENV];
    if (Object.keys(env).length === 0) delete doc.env;
    const strip = stripManagedWebSearchDeny(doc, settingsPath);
    saveOrRemoveSettings(settingsPath, doc);
    strip.commit();
  } else if (parseable) {
    // An untouched doc is not rewritten, but the commit still releases a stale marker. An
    // unwritable file keeps its ownership record: never released while the entry may still stand.
    const doc = loadSettings(settingsPath);
    const before = JSON.stringify(doc);
    const strip = stripManagedWebSearchDeny(doc, settingsPath);
    let saved = true;
    if (JSON.stringify(doc) !== before) {
      try {
        saveOrRemoveSettings(settingsPath, doc);
      } catch {
        saved = false;
      }
    }
    if (saved) strip.commit();
  }
  return { ownedDenyRemains: new OwnershipLedger().owns("webSearchDeny", settingsPath) };
}

/** The CLI's own alias for its haiku model, resolved inside the CLI to an id it recognises: the
 *  CLI sends `output_config.effort` for any model id it does not recognise, and Copilot rejects
 *  that for a model without the capability, so a Copilot catalog id can fail the smoke while
 *  Direct itself works. */
export const CLAUDE_HAIKU_ALIAS = "haiku";

/** The cheapest advertised claude model proves the messages wire (cheapestClaudeModel says why);
 *  the CLI smoke's hops are the haiku alias, then the newest catalog model (probeDirectWorks
 *  walks them). */
export const CLAUDE_ENDPOINT_SMOKE: EndpointSmoke = {
  wire: "messages",
  pickModel: (body) => cheapestClaudeModel(parseCatalogModels(body)),
  cliAlias: CLAUDE_HAIKU_ALIAS,
  cliFallback: (body) => newestClaudeModel(parseCatalogModels(body)),
};

/** Writes a throwaway direct config and runs `claude -p --model <catalog pick>` against it
 *  (src/agents/live_probe.ts); with no claude CLI on the machine the endpoint smoke judges the
 *  credential instead. False means the caller writes proxy. */
export function detectClaudeDirect(
  direct: DirectWiring,
  ghToken: string | null,
  deps?: DirectProbeDeps,
): Promise<boolean> {
  return probeDirectWorks(
    CLAUDE_PROBE,
    (tmpHome) => {
      // The scratch config is the probe's own: under a scratch dir the seam writes and plans nothing.
      configureClaudeConfig(tmpHome, { mode: "direct", direct, credential: { kind: "command" } });
    },
    ghToken === null ? null : directSmoke(
      CLAUDE_ENDPOINT_SMOKE,
      ghToken,
      codexUserAgent(),
      direct.directIntegrationId,
      direct.directBaseUrl,
      { fetchImpl: deps?.fetchImpl, pinnedModel: probeModelPin("probe.claude-model", null) },
    ),
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
    resolveDirectWiring: (ghToken) => probeDirectWiring(null, ghToken),
    async configureProfile(profile, write, options) {
      configureClaudeConfig(resolveClaudeHome(), { ...write, profile });
      // Desktop reads its own config library, not settings.json, so every rewire reconciles it.
      // The default's caller hands over the credential it resolved; a static write already holds
      // the token: either way Desktop's discovery must not resolve it again.
      await syncClaudeDesktopWiring({
        ...write,
        profile,
        quiet: options.quiet,
        directToken: options.directToken !== undefined
          ? options.directToken
          : resolvedDirectToken(write.mode, write.credential),
      });
    },
    removeProfile(name, options) {
      removeClaudeProfile(resolveClaudeHome(), name, options?.claudeArtifacts);
      if (!options?.keepDesktopEntry) removeClaudeDesktopEntry(name);
    },
  };
}

/** Read-only, from copilot-env's own state: the slot's recorded mode (the default's, or the named
 *  profile's) and the profile's resolved port, never reserving one; the settings file is an output
 *  and is not read. Shared by `agent profile env` and the launch verb. Direct, or nothing wired: a
 *  loopback URL in the shell is ours to clear whatever its port or path (a stale one on an old port
 *  must still read as ours); anything else is the user's. */
export function managedClaudeBaseUrl(profile: Profile): ManagedEnvValue {
  const mode = new CopilotEnvState().readProfileSlot(profile).mode;
  if (mode === "proxy") return { value: proxyLoopbackOrigin(copilotApiResolvePort(profile)) };
  const current = process.env[BASE_URL_ENV];
  if (current && parseLoopbackProxyUrl(current) !== null) return { unset: true };
  return null;
}
