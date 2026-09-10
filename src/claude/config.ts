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
// command string). The merge is surgical: only the managed keys are touched; all
// other settings are preserved.
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
// never %%-doubles it.
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

/** Why an "other" classification is not ours -- minted together with
 *  providerMode by inspectClaudeWiring, so consumers switch on it instead of
 *  re-deriving the classifier's reasoning:
 *    - "malformed":           settings present but not a JSON object
 *    - "read-error":          settings exist but could not be read
 *    - "custom":              a foreign apiKeyHelper or a custom base URL */
export type ClaudeOtherReason = "malformed" | "custom" | "read-error";

/**
 * The read-only counterpart to configureClaudeConfig, discriminated on
 * providerMode so a combination the classifier can never mint ("other" without
 * its reason, a reason outside "other", a managed mode without an apiKeyHelper)
 * is unrepresentable rather than re-checked downstream. `wired` -- "the settings
 * select a managed backend" -- is computed HERE, in the owner, so consumers
 * never re-derive it from the mode pair.
 */
export type ClaudeWiringStatus =
  | {
    providerMode: "direct" | "proxy";
    settingsExists: true;
    wired: true;
    otherReason: null;
    /** The managed `apiKeyHelper` value, for messaging (not a secret): the
     *  managed inline command. */
    helperPath: string;
    /** `env.ANTHROPIC_BASE_URL`, if present. */
    baseUrl: string | null;
    /** Whether `baseUrl` points at the resolved local proxy (host+port): proxy
     *  mode's port check, and the mixed-config signal defaultSetupNeedsProxy
     *  keys off (Claude's MODE keys off apiKeyHelper alone). */
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
    /** Which classifier arm minted the "other" (see ClaudeOtherReason). */
    otherReason: ClaudeOtherReason;
    /** The foreign/unverified apiKeyHelper value (null when the file could not
     *  be read or parsed at all). */
    helperPath: string | null;
    baseUrl: string | null;
    baseUrlMatches: boolean;
  };

/** Whether `baseUrl` is the managed Claude proxy URL for `expectedPort`:
 *  `http://127.0.0.1:<port>` (loopback, no path -- unlike Codex's `/v1`). Tolerates a trailing
 *  slash and accepts `localhost` too (the shared grammar in port.ts, next to the writers). */
function claudeBaseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "");
}

// --- wiring inspection (pure) -----------------------------------------------

/**
 * Classify raw settings content for `profile` (default = settings.json, named =
 * settings-<name>.json). Pure: the caller passes a TextReadResult (a plain string means
 * text, null means absent). Mode is keyed off the EXACT apiKeyHelper value so a user's own
 * similar-looking helper is never mistaken for ours; the verdict authorizes `--check`, the
 * uninstall strip, and the profile overwrite guard. "other" carries WHY in `otherReason`
 * (see ClaudeOtherReason); a settings file that exists but cannot be read is "other", never
 * "none", since "none" would authorize removal. "none" = unconfigured (proxy is default).
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
    // Present but unparseable: we can't manage it, so leave it alone (other).
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

  // `apiKeyHelper` in Claude's settings.json is the COMMAND Claude runs for a token,
  // not a secret. Read it via readStringField (keyed access, no literal
  // `.apiKeyHelper` at the read site) so it isn't misclassified as a logged credential.
  const helperPath = readStringField(doc, "apiKeyHelper");
  const env = isRecord(doc.env) ? doc.env : undefined;
  const baseUrl = env ? readStringField(env, BASE_URL_ENV) : null;
  const baseUrlMatches = baseUrl !== null && claudeBaseUrlMatchesProxy(baseUrl, expectedPort);

  // The inline command is the managed contract, recognized by SHAPE (any root's
  // spelling).
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
    // A foreign apiKeyHelper or a custom base URL the user set -- not ours.
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
 * Load settings.json as a record. Missing or empty => {}. Absence means the same
 * thing readTextResult's "absent" does (ENOENT or ENOTDIR -- nothing there), so
 * a caller that classified the read as absent/none can never throw here. A
 * present-but-malformed file throws rather than letting us clobber settings we
 * couldn't read.
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

/** Persist a STRIPPED settings doc: a doc emptied entirely removes the file
 *  itself (never a lone `{}` left behind), anything else is saved. */
function saveOrRemoveSettings(settingsPath: string, doc: Record<string, unknown>): void {
  if (Object.keys(doc).length === 0) removeReported(settingsPath);
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
 * eagerly, but the ownership record in the ledger (and the registration
 * removal on the take-back path) must only land once the settings doc is actually
 * persisted -- run the returned commit AFTER a successful save, so a failed write
 * leaves ledger and file consistent and a retry can still recover.
 */
type WebSearchPairCommit = () => void;
const NO_COMMIT: WebSearchPairCommit = () => {};

/**
 * Add `WebSearch` to `permissions.deny`. Ownership is recorded (post-save) in the
 * ledger as the exact settings PATH the entry was added to -- a deny the user
 * already had, or one living in a different CLAUDE_CONFIG_DIR, is never claimed,
 * so the removal path can only ever take back ours. Preserves every other
 * permissions entry (allow, foreign deny rules, order); a malformed
 * `permissions`/`deny` is warned about and left alone, never replaced.
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
  return () => new OwnershipLedger().record("webSearchDeny", settingsPath);
}

/** Remove OUR `WebSearch` deny entry (ownership-gated by exact settings path),
 *  dropping emptied objects; the ledger record clears post-save. */
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
 * The DEFAULT profile's web-search pair: the `copilot-env` MCP registration (Claude's
 * global `~/.claude.json`) and the builtin-WebSearch deny (the settings doc). Registration
 * FIRST, and the deny stands only while the registration is confirmed, so a machine is
 * never left with the builtin denied and no replacement. Direct with `wire-mcp` on wires
 * the pair; proxy, or `wire-mcp` off, takes both back (the proxy serves web search itself).
 * Default profile only: `~/.claude.json` is global and deny rules UNION across settings
 * layers (a named proxy profile over a direct default could never un-deny). Returns the
 * post-save commit (see WebSearchPairCommit).
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

/** One managed Claude settings write: the SHARED mode variant (ManagedWrite, so
 *  the mode/identity pairing is enforced at the type) plus this writer's common
 *  knobs -- the Claude twin of CodexWriteRequest. */
export type ClaudeWriteRequest = ManagedWrite & {
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
};

/**
 * Apply the managed Claude wiring at `claudeHome` for `profile` (default = settings.json;
 * named = settings-<name>.json, launched via `claude --settings`). Direct writes the inline
 * `agent auth --get [--profile <name>]` apiKeyHelper + the Copilot base URL; proxy writes
 * the `agent proxy-token --yes` helper and points the base URL at the profile's proxy port.
 * The merge is surgical (only managed keys change) and the OTHER mode's keys are overwritten
 * so switching modes is clean. Throws on an unwritable home, malformed settings, or an
 * unresolvable proxy port.
 */
export function configureClaudeConfig(claudeHome: string, request: ClaudeWriteRequest): void {
  const profile = request.profile ?? null;
  // Cheap credential-presence gate (no `gh` spawn -- runClaude already did the full
  // resolve and fail-fasts on it; this backstops direct API callers like
  // --settings-for). The parsed union is fail-closed: a recorded provider whose
  // token is gone reads as "none", so a broken slot is refused here too.
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
  // NAMED profiles only: never take over a pre-existing settings-<name>.json wired to
  // something we don't manage -- a foreign apiKeyHelper OR a custom base URL (the user's
  // own file that predates the profile). The DEFAULT settings.json keeps its historical
  // contract: an explicit mode write reclaims even a custom config.
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
    // The inline command invokes `agent auth --get`; the token is never baked here, and
    // no helper file is written.
    doc.apiKeyHelper = directHelperCommand(profile);
    applyManagedEnv(doc, "direct", DIRECT_BASE_URL, profile, request.directIntegrationId);
    // The MCP + deny pair is machine-global (default profile, the REAL Claude home
    // only -- the throwaway detect-probe home must not touch ~/.claude.json).
    const commit = profile === null && claudeHome === resolveClaudeHome()
      ? applyWebSearchPair(doc, "direct", settingsPath)
      : NO_COMMIT;
    saveSettings(settingsPath, doc, "Claude config, direct: GitHub Copilot");
    commit();
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

/** The file removeClaudeProfile would remove for `name` right now: the settings file,
 *  when its wiring is ours. Read-only; an uninstall plan resolves this once and renders
 *  it both ways. */
export function claudeProfileArtifacts(claudeHome: string, name: ProfileName): string[] {
  const settingsPath = settingsPathFor(claudeHome, name);
  return inspectClaudeWiring(readTextResult(settingsPath), 0, name).wired ? [settingsPath] : [];
}

/**
 * Remove a NAMED profile's managed Claude artifact, its settings-<name>.json -- but
 * only when the wiring is actually OURS (managed direct/proxy). An "other"
 * classification (foreign wiring, malformed JSON, or a settings file that exists
 * but cannot be read -- the classifier's read-error arm, minted precisely so
 * ownership we cannot verify is never read as "none") leaves the file alone: it
 * is the user's. Used by `agent profile --del`.
 */
export function removeClaudeProfile(
  claudeHome: string,
  name: ProfileName,
  artifacts: readonly string[] = claudeProfileArtifacts(claudeHome, name),
): void {
  for (const path of artifacts) removeReported(path);
}

/** What removeClaudeDefaultWiring left behind, for the caller to sequence on. */
export interface ClaudeDefaultWiringRemoval {
  /** The ledger still owns a WebSearch deny at the default settings path: the
   *  file could not be read, parsed, or rewritten, so the strip could not land.
   *  While it stands, the MCP registration (the deny's web-search replacement)
   *  must stay too -- never a denied builtin with no replacement. */
  ownedDenyRemains: boolean;
}

/**
 * Remove the DEFAULT profile's managed settings.json keys (apiKeyHelper, the managed env
 * vars, OUR WebSearch deny), but only while apiKeyHelper is still the managed helper: that
 * helper is what makes the key set ours, so a foreign apiKeyHelper ("other") leaves them.
 * The exact-path-OWNED deny is the one exception: ownership proves it is ours whatever the
 * rest of the file is, so any PARSEABLE doc gets the ownership-gated strip. Only a file the
 * strip cannot land on (unreadable, malformed, unwritable) leaves an owned deny standing,
 * reported as `ownedDenyRemains` so the caller keeps the MCP registration in its place.
 * Every other user setting survives; a doc emptied entirely removes settings.json itself.
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
    // "none", or a parseable "other": the managed keys are not ours to touch
    // here, but an owned deny still is -- strip exactly it (an untouched doc is
    // not rewritten; the commit still releases a stale ownership marker). The
    // write is best-effort on a file that is not otherwise ours: an unwritable
    // one keeps its deny AND its ownership record (never released while the
    // entry may still stand), reported via ownedDenyRemains below.
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

/**
 * Live auto-detect: does GitHub Copilot Direct work for Claude on this machine?
 * Writes a throwaway direct config (settings.json + gh apiKeyHelper) and runs
 * `claude -p` against it (see src/agents/live_probe.ts). False => write proxy.
 */
export function detectClaudeDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CLAUDE_PROBE,
    (tmpHome) => {
      configureClaudeConfig(tmpHome, { mode: "direct" });
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
    id: "claude",
    label: "Claude",
    check: checkClaudeConfig,
    detectDirect: detectClaudeDirect,
    // The shared identity resolution (baked identically by Codex Direct); the
    // skeleton reuses the already-resolved token so gh-cli isn't spawned twice.
    resolveDirectIdentity: (ghToken) => probeDirectIntegrationId(null, ghToken),
    async configureDefault(write, ghToken) {
      configureClaudeConfig(resolveClaudeHome(), write);
      // Claude Desktop's chat surface reads its own config library, not settings.json;
      // every default rewire reconciles its entry from the `claude-desktop` key
      // (best-effort), baking the SAME write.
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

/**
 * `agent claude`: configure Claude Code's wiring at the effective Claude home
 * ($CLAUDE_CONFIG_DIR, else ~/.claude). A `check` action reports the configured mode
 * (exit 0 direct / 2 proxy|none / 1 other) without a probe; a `configure` action carries
 * the requested mode (`--direct`/`--proxy` forced, "auto" = live `claude -p` probe, else
 * the proxy). A GitHub token provisioned via `agent auth` selects Direct on "auto" without
 * probing. Named profiles belong to `agent profile`. The body is the shared skeleton
 * (runAgentConfig) over claudeAdapter.
 */
export async function runClaude(action: AgentRunAction): Promise<void> {
  return runAgentConfig(claudeAdapter(), action);
}
