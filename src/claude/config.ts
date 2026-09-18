// Claude Code config writer for ~/.claude/settings.json (the Codex twin is src/codex/config.ts).
// apiKeyHelper is a shell command string, not a file path, so the wiring invokes bin/agent inline
// and no credential helper file exists anywhere. Claude's contract on that command:
//   stdout cached ~5 minutes, re-run on 401
//   stdout anything but the single credential line -> hard failure, so both resolvers keep their
//                                                     diagnostics on stderr
// With `static-key` covering Claude, the value rides in env.ANTHROPIC_AUTH_TOKEN instead and no
// apiKeyHelper is written: Claude prefers that variable over the helper, so a command-shape write
// takes it out (applyManagedCredential).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentAdapter,
  type CredentialWiring,
  type DirectWiring,
  landWithReservedPort,
  type ManagedWrite,
  resolvedDirectToken,
} from "../agents/configure.ts";
import { CLAUDE_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import { applyPatch, type PatchOp, planPatch, remove, set } from "../agents/write_plan.ts";
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
import { directSmoke, type EndpointSmoke } from "../copilot_api/endpoint_smoke.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  isDirectBaseUrl,
} from "../copilot_api/integration_identity.ts";
import { cheapestClaudeModel, parseCatalogModels } from "../copilot_api/models.ts";
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
import { isEnoentOrNotdir, readTextResult, type TextReadResult } from "../utils/fs.ts";
import { escapeRegExp } from "../utils/regexp.ts";
import { printKeyValue } from "../utils/table.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { mkdirReported, removeReported, writeFileReported } from "../utils/report_write.ts";
import {
  dottedKey,
  type FilePlan,
  filePlan,
  landPlan,
  NO_WRITE,
  readPlannedText,
  shadowedText,
  textVerdict,
  type WritePlan,
} from "../utils/write_session.ts";
import {
  agentAuthGetArgs,
  agentLauncherCommand,
  proxyTokenArgs,
  proxyTokenCommand,
} from "../utils/root.ts";
import { planClaudeDesktopSync, planRemoveClaudeDesktopEntry } from "./desktop.ts";
import { cmdHelperBody, shQuote, winQuote } from "./helper_body.ts";
import { planClaudeMcpRegistration, planClaudeMcpRemoval } from "./mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor, WIN } from "./paths.ts";

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

/** No path, unlike Codex's `/v1`; the grammar (trailing slash, localhost) is port.ts's. */
function claudeBaseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "");
}

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
  if (read.kind === "unreadable") {
    return {
      providerMode: "other",
      settingsExists: true,
      wired: false,
      otherReason: "read-error",
      credential: null,
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
      credential: null,
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
    return {
      providerMode: "other",
      settingsExists: true,
      wired: false,
      otherReason: "custom",
      credential: null,
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
  const planned = shadowedText(settingsPath);
  if (planned !== undefined) {
    if (planned === null) return {};
    text = planned;
  } else {
    try {
      text = fs.readFileSync(settingsPath, "utf8");
    } catch (e) {
      if (isEnoentOrNotdir(e)) return {};
      throw e;
    }
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
function managedEnvOps(
  mode: ManagedAgentMode,
  baseUrl: string,
  profile: Profile = null,
  directIntegrationId?: string | null,
): PatchOp[] {
  const ops = [set(["env", BASE_URL_ENV], baseUrl)];
  if (mode === "direct") {
    ops.push(set(["env", DISABLE_BETAS_ENV], "1"));
    ops.push(set(["env", CUSTOM_HEADERS_ENV], directCustomHeaders(directIntegrationId)));
  } else if (profile === null) {
    ops.push(remove(["env", DISABLE_BETAS_ENV]));
    ops.push(remove(["env", CUSTOM_HEADERS_ENV]));
  } else {
    ops.push(set(["env", DISABLE_BETAS_ENV], ""));
    ops.push(set(["env", CUSTOM_HEADERS_ENV], ""));
  }
  return ops;
}

/** The ONE credential carrier per shape, the other's always removed: `apiKeyHelper` for the command,
 *  `env.ANTHROPIC_AUTH_TOKEN` for the value. Claude prefers the variable over the helper, so the
 *  command shape must take it out of the layered result:
 *    default file  -> deleted
 *    named file    -> blanked to "", like the direct-only keys: `claude --settings` merges env per
 *                     key, so a static default underneath would otherwise hand its token to the
 *                     profile session, over the profile's own helper
 *  Follows managedEnvOps, which owns `env`. */
function managedCredentialOps(
  credential: CredentialWiring,
  helperCommand: string,
  profile: Profile,
): PatchOp[] {
  if (credential.kind === "command") {
    return [
      set(["apiKeyHelper"], helperCommand),
      profile === null ? remove(["env", AUTH_TOKEN_ENV]) : set(["env", AUTH_TOKEN_ENV], ""),
    ];
  }
  return [remove(["apiKeyHelper"]), set(["env", AUTH_TOKEN_ENV], credential.token)];
}

/** The one Claude value a preview must redact. */
const SETTINGS_SECRETS: ReadonlySet<string> = new Set([dottedKey(["env", AUTH_TOKEN_ENV])]);

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
 * The pair as a patch plus what follows the settings save: `commit` is the ledger record or
 * release (store bookkeeping, landed in a dry run too), `after` a file write the save must precede
 * (the registration removal on take-back). Both run only after a successful save, so a failed
 * write leaves ledger and files consistent and a retry can still recover.
 */
type WebSearchPairStep = () => void;
const NO_STEP: WebSearchPairStep = () => {};
interface WebSearchPairPatch {
  ops: PatchOp[];
  commit: WebSearchPairStep;
  after: WebSearchPairStep;
}
const NO_PAIR: WebSearchPairPatch = { ops: [], commit: NO_STEP, after: NO_STEP };

/**
 * Ownership is the exact settings PATH the entry was added to: a deny the user already had, or one
 * in a different CLAUDE_CONFIG_DIR, is never claimed, so removal can only take back ours. A
 * malformed `permissions`/`deny` is warned about and left alone.
 */
function managedWebSearchDenyPatch(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPairPatch {
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
  return {
    ops: [set(["permissions", "deny"], [...deny, WEBSEARCH_DENY_RULE])],
    // Post-save on purpose: a record without a saved deny would make a deny the USER adds later
    // ours to delete. The inverse (saved, record failed) merely orphans our one line: the
    // acceptable direction.
    commit: () => new OwnershipLedger().record("webSearchDeny", settingsPath),
    after: NO_STEP,
  };
}

function stripManagedWebSearchDenyPatch(
  doc: Record<string, unknown>,
  settingsPath: string,
): WebSearchPairPatch {
  const ledger = new OwnershipLedger();
  if (!ledger.owns("webSearchDeny", settingsPath)) return NO_PAIR;
  const ops: PatchOp[] = [];
  const permissions = isRecord(doc.permissions) ? doc.permissions : null;
  if (permissions !== null && Array.isArray(permissions.deny)) {
    const filtered = permissions.deny.filter((rule) => rule !== WEBSEARCH_DENY_RULE);
    if (filtered.length > 0) ops.push(set(["permissions", "deny"], filtered));
    else ops.push(remove(["permissions", "deny"]));
    if (filtered.length === 0 && Object.keys(permissions).every((k) => k === "deny")) {
      ops.push(remove(["permissions"]));
    }
  }
  return { ops, commit: () => ledger.release("webSearchDeny", settingsPath), after: NO_STEP };
}

/**
 * Registration first, and the deny stands only while the registration is confirmed: a machine is
 * never left with the builtin denied and no replacement. The proxy serves web search itself, so it
 * takes both back. Default profile only: `~/.claude.json` is global and deny rules UNION across
 * layers, so a named proxy profile could never un-deny a direct default's rule.
 */
interface WebSearchPairPlan {
  /** The `.claude.json` files the pair touches, either way. */
  files: FilePlan[];
  predicted: WebSearchPairPatch;
  land(): WebSearchPairPatch;
}

function planWebSearchPair(
  doc: Record<string, unknown>,
  mode: ManagedAgentMode,
  settingsPath: string,
): WebSearchPairPlan {
  if (mode === "direct" && new CopilotEnvConfig().wireMcpEnabled()) {
    const registration = planClaudeMcpRegistration();
    const patch = (registered: boolean): WebSearchPairPatch => {
      if (registered) return managedWebSearchDenyPatch(doc, settingsPath);
      logger.warn(
        "copilot-env MCP registration failed; removing the managed WebSearch deny so the " +
          "builtin stays reachable (it will 400 on Copilot Direct) - fix ~/.claude.json, " +
          "then rewire with `agent claude --direct`",
      );
      return stripManagedWebSearchDenyPatch(doc, settingsPath);
    };
    const predicted = patch(registration.inPlace);
    return {
      files: registration.files,
      predicted,
      land() {
        const registered = registration.apply();
        return registered === registration.inPlace ? predicted : patch(registered);
      },
    };
  }
  const removal = planClaudeMcpRemoval();
  const strip = stripManagedWebSearchDenyPatch(doc, settingsPath);
  // Post-save too: a failed settings write keeps the consistent old state (deny + server)
  // instead of losing only the server half.
  const predicted: WebSearchPairPatch = {
    ops: strip.ops,
    commit: strip.commit,
    after: () => void removal.apply(),
  };
  return { files: removal.files, predicted, land: () => predicted };
}

/**
 * Re-derive the web-search pair for the current default wiring, as a plan: direct applies it (per
 * `claude.wire-mcp`), proxy or none takes it back, a foreign settings.json is never touched.
 * `agent mcp --remove` stores `claude.wire-mcp false` before landing this, which makes it a strip.
 */
export function planDefaultWebSearchSync(claudeHome = resolveClaudeHome()): WritePlan {
  const settingsPath = settingsPathFor(claudeHome);
  // The default slot's recorded mode decides whether the pair is APPLIED (direct); whether it is
  // STRIPPED is the ownership ledger's decision alone (stripManagedWebSearchDenyPatch owns nothing,
  // strips nothing), so a default with no recorded mode takes the strip arm like proxy: a deny we
  // wrote before the record was cleared is still ours to take back.
  const mode = new CopilotEnvState().readProfileSlot(null).mode ?? "proxy";
  const currentText = readPlannedText(settingsPath);
  const doc = loadSettings(settingsPath);
  const pair = planWebSearchPair(doc, mode, settingsPath);
  const settingsFile = (ops: PatchOp[]): FilePlan | null => {
    const next = applyPatch(structuredClone(doc), ops);
    if (JSON.stringify(next) === JSON.stringify(doc)) return null;
    const before = currentText.kind === "text" ? currentText.text : null;
    if (Object.keys(next).length === 0) return filePlan(settingsPath, "delete", { before });
    const text = `${JSON.stringify(next, null, 2)}\n`;
    return {
      path: settingsPath,
      verdict: textVerdict(before, text),
      attributes: planPatch(doc, ops),
      before,
      content: text,
    };
  };
  const predicted = settingsFile(pair.predicted.ops);
  let landed = pair.predicted;
  return {
    files: [...(predicted === null ? [] : [predicted]), ...pair.files],
    apply() {
      landed = pair.land();
      if (settingsFile(landed.ops) !== null) {
        saveOrRemoveSettings(settingsPath, applyPatch(structuredClone(doc), landed.ops));
      }
      landed.after();
    },
    commit: () => landed.commit(),
  };
}

export type ClaudeWriteRequest = ManagedWrite & {
  /** Wire a NAMED profile's settings-<name>.json instead of the default settings.json. */
  profile?: Profile;
};

/**
 * The write, computed but not performed: the managed env, credential carrier, and web-search pair
 * as one patch over the settings file, folded into the plan's rows and applied by the returned
 * step, so no key can be written without appearing in the plan. A named profile's file is launched
 * via `claude --settings`. Throws on malformed settings or an unresolvable proxy port; an
 * unwritable home throws from the apply.
 */
export function planClaudeConfig(claudeHome: string, request: ClaudeWriteRequest): ClaudeWritePlan {
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

  const settingsPath = settingsPathFor(claudeHome, profile);
  const currentText = readPlannedText(settingsPath);
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

  let ops: PatchOp[];
  let detail: string;
  // The plan PEEKS the profile's port; the apply RESERVES it (reservePlannedPort), so the baked base
  // URL is the planned one.
  let plannedPort: string | null = null;
  if (request.mode === "direct") {
    ops = [
      ...managedEnvOps(
        "direct",
        request.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
        profile,
        request.direct?.directIntegrationId ?? null,
      ),
      ...managedCredentialOps(request.credential, directHelperCommand(profile), profile),
    ];
    detail = `Claude config, direct: GitHub Copilot${
      credentialDetail(request.credential, "direct", profile)
    }`;
  } else {
    plannedPort = copilotApiResolvePort(profile);
    // No path, no trailing slash: the shape claudeBaseUrlMatchesProxy and env.ts's isLocalProxyUrl
    // expect.
    ops = [
      ...managedEnvOps("proxy", proxyLoopbackOrigin(plannedPort), profile),
      ...managedCredentialOps(request.credential, proxyHelperCommand(profile), profile),
    ];
    detail = `Claude config, proxy mode via port ${plannedPort}${
      credentialDetail(request.credential, "proxy", profile)
    }`;
  }
  // Real Claude home only: the throwaway detect-probe home must not touch the machine-global
  // ~/.claude.json.
  const pair = profile === null && claudeHome === resolveClaudeHome()
    ? planWebSearchPair(doc, request.mode, settingsPath)
    : null;
  const predicted = pair === null ? NO_PAIR : pair.predicted;
  const settingsText = (pairOps: PatchOp[]): string =>
    `${JSON.stringify(applyPatch(structuredClone(doc), [...ops, ...pairOps]), null, 2)}\n`;
  const before = currentText.kind === "text" ? currentText.text : null;
  // The pair as landed (the registration's answer at apply time); until then the prediction, which
  // is what a dry run's commit records.
  let landed = predicted;

  return {
    plannedPort,
    files: [
      {
        path: settingsPath,
        verdict: textVerdict(before, settingsText(predicted.ops)),
        attributes: planPatch(
          currentText.kind === "text" ? doc : null,
          [...ops, ...predicted.ops],
          SETTINGS_SECRETS,
        ),
        before,
        content: settingsText(predicted.ops),
      },
      ...(pair?.files ?? []),
    ],
    apply() {
      try {
        mkdirReported(claudeHome);
      } catch (e) {
        throw new Error(`could not create Claude config directory ${claudeHome}: ${errMessage(e)}`);
      }
      landed = pair === null ? NO_PAIR : pair.land();
      writeFileReported(settingsPath, settingsText(landed.ops), { detail });
      landed.after();
    },
    commit: () => landed.commit(),
  };
}

/** A settings plan with the proxy port it peeked (null for Direct), for the caller to reserve as
 *  it lands (landWithReservedPort). */
export type ClaudeWritePlan = WritePlan & { plannedPort: string | null };

/** planClaudeConfig, landed with its port reserved (landWithReservedPort: applied and committed,
 *  or recorded by a dry run). */
export function configureClaudeConfig(claudeHome: string, request: ClaudeWriteRequest): void {
  const plan = planClaudeConfig(claudeHome, request);
  landWithReservedPort(plan, request.profile ?? null, plan.plannedPort);
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
  const status = inspectClaudeWiring(readTextResult(settingsPath), Number(copilotApiResolvePort()));
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
  return inspectClaudeWiring(readPlannedText(settingsPath), 0, name).wired ? [settingsPath] : [];
}

/** Only artifacts whose wiring is ours; an "other" verdict (foreign, malformed, unreadable) leaves
 *  the user's file alone. Computed, not performed. */
export function planRemoveClaudeProfile(
  claudeHome: string,
  name: ProfileName,
  artifacts: readonly string[] = claudeProfileArtifacts(claudeHome, name),
): WritePlan {
  return {
    files: artifacts.map((path) => filePlan(path, "delete")),
    apply() {
      for (const path of artifacts) removeReported(path);
    },
  };
}

/** planRemoveClaudeProfile, landed. */
export function removeClaudeProfile(
  claudeHome: string,
  name: ProfileName,
  artifacts?: readonly string[],
): void {
  landPlan(planRemoveClaudeProfile(claudeHome, name, artifacts));
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
  const wiring = inspectClaudeWiring(readTextResult(settingsPath), 0);
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
    const strip = stripManagedWebSearchDenyPatch(doc, settingsPath);
    applyPatch(doc, strip.ops);
    saveOrRemoveSettings(settingsPath, doc);
    strip.commit();
  } else if (parseable) {
    // An untouched doc is not rewritten, but the commit still releases a stale marker. An
    // unwritable file keeps its ownership record: never released while the entry may still stand.
    const doc = loadSettings(settingsPath);
    const before = JSON.stringify(doc);
    const strip = stripManagedWebSearchDenyPatch(doc, settingsPath);
    applyPatch(doc, strip.ops);
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

/** The cheapest advertised claude model proves the messages wire (cheapestClaudeModel says why). */
export const CLAUDE_ENDPOINT_SMOKE: EndpointSmoke = {
  wire: "messages",
  pickModel: (body) => cheapestClaudeModel(parseCatalogModels(body)),
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
      // Applied, never landed: the scratch config is the probe's own, not part of any plan.
      planClaudeConfig(tmpHome, {
        mode: "direct",
        direct,
        credential: { kind: "command" },
      }).apply();
    },
    ghToken === null ? null : directSmoke(
      CLAUDE_ENDPOINT_SMOKE,
      ghToken,
      codexUserAgent(),
      direct.directIntegrationId,
      direct.directBaseUrl,
      { fetchImpl: deps?.fetchImpl },
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
    async configureDefault(write, ghToken) {
      configureClaudeConfig(resolveClaudeHome(), write);
      // Desktop reads its own config library, not settings.json, so every rewire reconciles it.
      const desktop = await planClaudeDesktopSync({
        ...write,
        profile: null,
        directToken: ghToken,
      });
      landWithReservedPort(desktop, null, desktop.plannedPort);
    },
    async configureProfile(name, write, options) {
      configureClaudeConfig(resolveClaudeHome(), { ...write, profile: name });
      // A static write already holds the token: Desktop's discovery must not resolve it again.
      const desktop = await planClaudeDesktopSync({
        ...write,
        profile: name,
        quiet: options.quiet,
        directToken: resolvedDirectToken(write.mode, write.credential),
      });
      landWithReservedPort(desktop, name, desktop.plannedPort);
    },
    planRemoveProfile(name, options) {
      const files = planRemoveClaudeProfile(resolveClaudeHome(), name, options?.claudeArtifacts);
      const entry = options?.keepDesktopEntry ? NO_WRITE : planRemoveClaudeDesktopEntry(name);
      return {
        files: [...files.files, ...entry.files],
        apply() {
          files.apply();
          entry.apply();
        },
        commit: () => entry.commit?.(),
      };
    },
  };
}
