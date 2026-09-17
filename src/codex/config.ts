// Codex config writer for config.toml (the Claude twin is src/claude/config.ts): Copilot Direct or
// the local proxy. By default no credential is baked (`auth.command` resolves it at fetch time);
// with `static-key` covering Codex the value rides as a static `http_headers.Authorization` and
// no `auth` table is written.
import { parse, stringify } from "smol-toml";
import {
  type AgentAdapter,
  type CredentialWiring,
  directNeedsCredentialError,
  type DirectWiring,
  directWiring,
  type ManagedWrite,
  reservePlannedPort,
} from "../agents/configure.ts";
import { CODEX_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import {
  applyPatch,
  type Doc,
  dottedKey,
  type FilePlan,
  type PatchOp,
  planPatch,
  remove,
  set,
  textVerdict,
  type WritePlan,
} from "../agents/write_plan.ts";
import { type AgentProviderMode, providerModeExitCode } from "../agents/provider_mode.ts";
import { Credential } from "../copilot_api/credential.ts";
import { directOverlay, landDirectPair } from "../copilot_api/direct_pair.ts";
import { directSmoke, type EndpointSmoke } from "../copilot_api/endpoint_smoke.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { isReducedGpt } from "../copilot_api/models.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  isDirectBaseUrl,
  selectDirectIdentityAndHost,
} from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, matchesProxyOrigin, openaiBaseUrl } from "../copilot_api/port.ts";
import { agentStartCommand, type Profile, type ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { readTextResult, type TextReadResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { mkdirReported, removeReported } from "../utils/report_write.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenCommand } from "../utils/root.ts";
import { printWrapped } from "../utils/table.ts";
import {
  type CatalogFileVerdict,
  type CodexCatalogDeps,
  generateCodexModelCatalog,
  inspectCatalogFile,
  parseCopilotModels,
  UNVERIFIED_SUFFIX,
} from "./catalog.ts";
import { resolvesToCatalogFile, syncCodexCatalogReference } from "./catalog_reference.ts";
import {
  codexHostDrift,
  codexHostDriftLine,
  effectiveCodexHome,
  knownCodexHomes,
  narrateCodexHome,
  resolveCodexHome,
  withCodexHostFarm,
} from "./host.ts";
import { CODEX_PROVIDER_ID, codexConfigPath, codexProfileConfigPath } from "./paths.ts";
import { type CodexTomlRead, readCodexToml, saveCodexToml } from "./toml_io.ts";
import { codexUserAgent } from "./user_agent.ts";

const logger = createStderrLogger();

// ONE provider, `copilot-env`, for BOTH direct and proxy: the mode is read from the table's
// CONTENTS (its base_url), not from the provider name. OPENAI_API_KEY is the same OpenAI-wire name
// `env.ts` exports; the inspector reports whether the user's `.env` or environment carries it as a
// fact about the home (no managed wiring needs it).
export const CODEX_ENV_KEY = "OPENAI_API_KEY";
/** What one `agent auth --get` (the `gh` look, the token print, a due catalog refresh) has before
 *  Codex gives up. It sits in every install's config, so the refresh budgets bend to it (pinned by
 *  test). */
export const DIRECT_AUTH_TIMEOUT_MS = 30000;

/** A named profile is selected by its own `<name>.config.toml` (`codex --profile <name>` layers it
 *  over config.toml), whose top-level `model_provider` points here; config.toml's default selection
 *  is never touched. */
export function codexProviderId(profile: Profile = null): string {
  return profile === null ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${profile}`;
}
/** Proxy ALWAYS carries a base URL: a proxy write without one is unrepresentable, so nothing
 *  downstream re-checks for it. */
type CodexModeRequest =
  | Extract<ManagedWrite, { mode: "direct" }>
  | (Extract<ManagedWrite, { mode: "proxy" }> & { baseUrl: string });

interface CodexWriteCommon {
  /** Wire a NAMED profile's tables instead of the default selection. */
  profile?: Profile;
}

/** Spelled as a top-level union so the discriminant narrows at every consumer. */
export type CodexWriteRequest =
  | (Extract<CodexModeRequest, { mode: "direct" }> & CodexWriteCommon)
  | (Extract<CodexModeRequest, { mode: "proxy" }> & CodexWriteCommon);

// === config.toml management ===
//
// smol-toml does NOT preserve comments or whitespace (TS has no battle-tested tomlkit equivalent),
// so load-merge-stringify is the best the writer can do. Every managed field is ENFORCED on each
// run, so a renamed or added key propagates even into a pre-existing config.

/** The unified table doesn't encode mode in its name, so mode is read from base_url's SHAPE: an https
 *  origin is Direct whatever the host (isDirectBaseUrl), a localhost proxy on `expectedPort` is proxy,
 *  anything else is "other" (a half-written table). */
function codexTableMode(table: unknown, expectedPort: number): AgentProviderMode {
  if (!isRecord(table)) return "other";
  const baseUrl = typeof table.base_url === "string" ? table.base_url : null;
  if (baseUrl !== null && isDirectBaseUrl(baseUrl)) return "direct";
  if (baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort)) return "proxy";
  return "other";
}

/** The header a static write carries; Codex sends `http_headers` verbatim, so the value is the
 *  full `Bearer <token>` (the one header name Codex would otherwise fill from `auth`/`env_key`). */
const AUTHORIZATION_HEADER = "Authorization";
const STATIC_AUTHORIZATION_SHAPE = /^Bearer \S+$/;

/** The `auth` table (command shape) or the static bearer header, never both: Codex would send the
 *  header AND run the command. */
function credentialTables(
  credential: CredentialWiring,
  auth: { command: string; args: readonly string[]; timeoutMs: number },
  httpHeaders: Record<string, string> = {},
): { http_headers?: Record<string, string>; auth?: Record<string, unknown> } {
  if (credential.kind === "static") {
    return {
      "http_headers": { ...httpHeaders, [AUTHORIZATION_HEADER]: `Bearer ${credential.token}` },
    };
  }
  return {
    ...(Object.keys(httpHeaders).length > 0 ? { "http_headers": httpHeaders } : {}),
    "auth": {
      "command": auth.command,
      "args": [...auth.args],
      "timeout_ms": auth.timeoutMs,
      "refresh_interval_ms": 300000,
    },
  };
}

// The command shape re-runs `auth.command` every `refresh_interval_ms`, so the token tracks the
// current credential; the static shape carries it in the table. Re-applied on every direct run:
// managed keys win, user-added keys in the same table survive the merge.
function managedDirectProvider(
  credential: CredentialWiring,
  profile: Profile = null,
  directIntegrationId?: string | null,
  // Resolved per WRITE (a default parameter runs at the call), so importing this module spawns
  // nothing; MANAGED_PROVIDER_KEYS below passes a placeholder for the same reason.
  userAgent: string = codexUserAgent(),
  directBaseUrl: string = DEFAULT_COPILOT_API_BASE,
) {
  const { command, args } = agentLauncherCommand(agentAuthGetArgs(profile));
  // Most credentials carry no integration id (the Codex UA suffices; the builder omits it when
  // null, keeping the default byte-identical), but a fine-grained PAT is only accepted under
  // `copilot-developer-cli`.
  const httpHeaders = directClientHeaders(userAgent, directIntegrationId);
  return {
    "name": codexProviderId(profile),
    "base_url": directBaseUrl,
    "wire_api": "responses",
    "supports_websockets": false,
    "requires_openai_auth": false,
    // The launcher may cold-start deno, and a due (at most daily) catalog refresh runs after the
    // token prints (AUTH_REFRESH_WORST_CASE_MS, src/codex/catalog.ts); warm calls take well under
    // a second, and Codex refreshes lazily.
    ...credentialTables(
      credential,
      { command, args, timeoutMs: DIRECT_AUTH_TIMEOUT_MS },
      httpHeaders,
    ),
  };
}

// `--yes` is the headless path. Codex forbids `auth` together with `env_key` on one provider, so
// proxy (like direct) resolves its key via the command, not an env var.
export function managedProxyProvider(
  baseUrl: string,
  profile: Profile = null,
  credential: CredentialWiring,
) {
  const auth = proxyTokenCommand(profile);
  return {
    "name": codexProviderId(profile),
    "base_url": baseUrl,
    "wire_api": "responses",
    "requires_openai_auth": false,
    "supports_websockets": false,
    // Cold-starting the proxy runs a full child `agent start`: runtime startup, the daemon's
    // readiness wait (up to a ~120s ceiling), THEN model-alias sync and version logging before
    // the key prints. The first auth attempt must not time out after the proxy is ready.
    ...credentialTables(credential, { command: auth.command, args: auth.args, timeoutMs: 180000 }),
  };
}

function managedProviderForMode(request: CodexModeRequest, profile: Profile = null) {
  if (request.mode === "direct") {
    return managedDirectProvider(
      request.credential,
      profile,
      request.direct?.directIntegrationId ?? null,
      codexUserAgent(),
      request.direct?.directBaseUrl,
    );
  }
  return managedProxyProvider(request.baseUrl, profile, request.credential);
}

// Codex rejects `auth` + `env_key` on one provider, so a managed table must never carry an env_key
// (whoever put it there). Derived from the factories so a new mode-specific managed key can never
// reintroduce cross-mode bleed on the shared table; the placeholder base URL is only embedded,
// never fetched. The command shape emits every managed key (a static write then strips a stale
// `auth`, a command write a stale static `http_headers`).
const COMMAND_SHAPE: CredentialWiring = { kind: "command" };
const MANAGED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(managedDirectProvider(COMMAND_SHAPE, null, undefined, "codex_exec/0")),
  ...Object.keys(managedProxyProvider("http://managed-keys.invalid", null, COMMAND_SHAPE)),
  "env_key",
]);

function authMatches(
  auth: unknown,
  expected: { command: string; args: readonly string[] },
): boolean {
  if (!isRecord(auth)) return false;
  return (
    auth.command === expected.command &&
    Array.isArray(auth.args) &&
    auth.args.length === expected.args.length &&
    auth.args.every((a, i) => a === expected.args[i])
  );
}

function isManagedDirectAuth(auth: unknown, profile: Profile = null): boolean {
  return authMatches(auth, agentLauncherCommand(agentAuthGetArgs(profile)));
}

function isManagedProxyAuth(auth: unknown, profile: Profile = null): boolean {
  return authMatches(auth, proxyTokenCommand(profile));
}

/** The static shape: a bearer in `http_headers` and NO `auth` table (a table carrying both would
 *  make Codex run the command as well, which no writer of ours produces). */
function isStaticAuthorization(table: unknown): boolean {
  if (!isRecord(table) || table.auth !== undefined) return false;
  const headers = table.http_headers;
  return isRecord(headers) && typeof headers[AUTHORIZATION_HEADER] === "string" &&
    STATIC_AUTHORIZATION_SHAPE.test(headers[AUTHORIZATION_HEADER]);
}

/** Which managed credential shape the table carries; "none" is a foreign or missing one. */
export type CodexManagedCredential = "command" | "static" | "none";

/** The bearer a static write baked into `profile`'s provider table, for the health freshness
 *  compare only (the inspector never carries the value). Null unless the file parses and the table
 *  holds the static shape. */
export function bakedCodexToken(
  configToml: TextReadResult,
  profile: Profile = null,
): string | null {
  if (configToml.kind !== "text") return null;
  let doc: unknown;
  try {
    doc = parse(configToml.text);
  } catch {
    return null;
  }
  const providers = isRecord(doc) ? doc.model_providers : undefined;
  const table = isRecord(providers) ? providers[codexProviderId(profile)] : undefined;
  if (!isStaticAuthorization(table) || !isRecord(table) || !isRecord(table.http_headers)) {
    return null;
  }
  return String(table.http_headers[AUTHORIZATION_HEADER]).slice("Bearer ".length);
}

// === wiring inspection (inverse of the write contract above) ===
//
// Lives HERE, next to the managed provider tables, so `agent health` and `agent codex` share one
// contract instead of shell/TOML copies.

/** Minted with providerMode by inspectCodexWiring (mirrors ClaudeOtherReason). The profile-
 *  prefixed pair names `<name>.config.toml`, so a named repair points at the right file; the
 *  legacy pair is Codex (>= 0.134) refusing the launch outright, whatever the wiring says.
 *    "malformed"             -> config.toml is present but not valid TOML
 *    "read-error"            -> config.toml exists but could not be read
 *    "profile-malformed"     -> `<name>.config.toml` is present but not valid TOML
 *    "profile-read-error"    -> `<name>.config.toml` exists but could not be read
 *    "legacy-profile-key"    -> config.toml carries a top-level `profile`: every launch refuses
 *    "legacy-profile-table"  -> config.toml carries `[profiles.<name>]`: `--profile <name>` refuses
 *    "custom"                -> a foreign `model_provider` is selected */
export type CodexOtherReason =
  | "malformed"
  | "read-error"
  | "profile-malformed"
  | "profile-read-error"
  | "legacy-profile-key"
  | "legacy-profile-table"
  | "custom";

/** What selects the inspected wiring: config.toml's top-level key for the default, and for a
 *  named profile the top-level key of its `<name>.config.toml`, read alongside config.toml. A
 *  named inspection without its profile read is unrepresentable. */
export type CodexSelectionRead =
  | { profile: null }
  | { profile: ProfileName; profileToml: TextReadResult };

/** Read from different files than config.toml, so independent of how it classifies. A named
 *  profile's provider never reads an env var (managed auth.command only), so envKeyInDotenv,
 *  envKeyInEnviron, and tokenAvailable are false for it; envFilePresent still reports the file. */
interface CodexTokenFacts {
  envFilePresent: boolean;
  envKeyInDotenv: boolean;
  envKeyInEnviron: boolean;
  /** Resolvable from .env OR the environment. */
  tokenAvailable: boolean;
}

/** Discriminated on providerMode so a pair the classifier never mints (a wired "none", a direct
 *  table without the Direct base URL, a direct-auth verdict outside direct mode) is
 *  unrepresentable. The shared fields are documented once, on the direct arm. */
export type CodexWiringStatus =
  & CodexTokenFacts
  & (
    | {
      providerMode: "direct";
      configExists: true;
      /** The inspected selection's `model_provider` (config.toml's top-level key for the default,
       *  `<name>.config.toml`'s for a named profile); on "other", the foreign value, or null when
       *  unknowable. */
      modelProvider: string;
      providerSelected: true;
      /** Direct classification requires a Copilot host (isDirectBaseUrl), so the match is pinned
       *  at the type and the host itself rides along. */
      baseUrl: string;
      baseUrlMatches: true;
      /** Direct carries no env_key contract, so only a named table's forbidden env_key (drift the
       *  writer never emits; Codex rejects `auth` + `env_key`) can make it false. */
      envKeyMatches: boolean;
      /** A named profile's credential shape must be the managed one addressed at THAT profile
       *  (never a fallback), or the static bearer. */
      providerWired: boolean;
      /** The managed credential shape the table carries. */
      credential: CodexManagedCredential;
      /** The table carries the managed `auth.command`. Whether a `gh` login is needed is a STORE
       *  question the health probe answers. */
      directUsesToken: boolean;
      otherReason: null;
    }
    | {
      providerMode: "proxy";
      configExists: true;
      modelProvider: string;
      providerSelected: true;
      baseUrl: string | null;
      baseUrlMatches: boolean;
      envKeyMatches: boolean;
      providerWired: boolean;
      credential: CodexManagedCredential;
      directUsesToken: false;
      otherReason: null;
    }
    | {
      providerMode: "none";
      /** False = no config.toml at all; true = a config with no `model_provider`. */
      configExists: boolean;
      modelProvider: null;
      providerSelected: false;
      baseUrl: null;
      baseUrlMatches: false;
      envKeyMatches: false;
      providerWired: false;
      credential: "none";
      directUsesToken: false;
      otherReason: null;
    }
    | {
      providerMode: "other";
      /** False only for a named inspection whose `<name>.config.toml` is broken while config.toml
       *  is absent: presence stays a fact of its own, apart from the classification. */
      configExists: boolean;
      modelProvider: string | null;
      providerSelected: false;
      baseUrl: null;
      baseUrlMatches: false;
      envKeyMatches: false;
      providerWired: false;
      credential: "none";
      directUsesToken: false;
      otherReason: CodexOtherReason;
    }
  );

/** Path `/v1`, what openaiBaseUrl writes; the grammar lives in port.ts next to the writers. */
function baseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "/v1");
}

/**
 * An UNREADABLE or unparseable config is "other", never "none": "none" would let a best-effort
 * caller write over a config it could not read.
 *
 *   a NAMED profile  -> `<name>.config.toml`'s `model_provider` -> config.toml's
 *                       `[model_providers.copilot-env-<name>]`, with the default selection playing
 *                       no part; a profile file without the key selects nothing of its own
 *   `expectedPort`   -> the caller passes the selection's OWN reserved proxy port
 */
export function inspectCodexWiring(
  configToml: TextReadResult | string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
  selection: CodexSelectionRead = { profile: null },
): CodexWiringStatus {
  const read: TextReadResult = typeof configToml === "string"
    ? { kind: "text", text: configToml }
    : configToml ?? { kind: "absent" };
  const profile = selection.profile;
  const providerId = codexProviderId(profile);
  const envKeyInDotenv = profile === null &&
    envText !== null &&
    new RegExp(`^\\s*(?:export\\s+)?${CODEX_ENV_KEY}\\s*=\\s*\\S`, "m").test(envText);
  const envKeyExported = profile === null && envKeyInEnviron;
  const tokenFacts: CodexTokenFacts = {
    envFilePresent: envText !== null,
    envKeyInDotenv,
    envKeyInEnviron: envKeyExported,
    tokenAvailable: envKeyInDotenv || envKeyExported,
  };
  const none = (configExists: boolean): CodexWiringStatus => ({
    ...tokenFacts,
    providerMode: "none",
    configExists,
    modelProvider: null,
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    credential: "none",
    directUsesToken: false,
    otherReason: null,
  });
  const other = (
    otherReason: CodexOtherReason,
    modelProvider: string | null,
    configExists = true,
  ): CodexWiringStatus => ({
    ...tokenFacts,
    providerMode: "other",
    configExists,
    modelProvider,
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    credential: "none",
    directUsesToken: false,
    otherReason,
  });
  if (read.kind === "unreadable") return other("read-error", null);
  let doc: unknown = null;
  if (read.kind === "text") {
    try {
      doc = parse(read.text);
    } catch {
      return other("malformed", null);
    }
  }
  // The selection fact mirrors what Codex itself reads: config.toml's top-level `model_provider`
  // for the default, `<name>.config.toml`'s for a named profile (`codex --profile <name>`), which
  // Codex refuses as a whole when either file is unparseable. The profile file is judged before
  // config.toml's absence, so a broken one is never hidden behind "no config".
  let selector: unknown = doc;
  if (selection.profile !== null) {
    const profileRead = selection.profileToml;
    const configExists = read.kind !== "absent";
    if (profileRead.kind === "unreadable") {
      return other("profile-read-error", null, configExists);
    }
    if (profileRead.kind === "text") {
      try {
        selector = parse(profileRead.text);
      } catch {
        return other("profile-malformed", null, configExists);
      }
    }
  }
  if (read.kind === "absent") return none(false);
  // Codex refuses the launch on the profile-v1 shapes before any provider is read (verified on
  // 0.153.4), so a layout that still carries them must never read as wired, nor as "none" (whose
  // repair, a re-add, writes the profile file and leaves the shape in place). hasOwn: a profile
  // named like an Object.prototype property must not find the prototype's.
  if (isRecord(doc) && doc.profile !== undefined) return other("legacy-profile-key", null);
  if (
    selection.profile !== null && isRecord(doc) && isRecord(doc.profiles) &&
    Object.hasOwn(doc.profiles, selection.profile)
  ) {
    return other("legacy-profile-table", null);
  }
  if (selection.profile !== null && selection.profileToml.kind === "absent") return none(true);
  const modelProvider = isRecord(selector) && typeof selector.model_provider === "string"
    ? selector.model_provider
    : null;
  if (modelProvider === null) return none(true);
  if (modelProvider !== providerId) return other("custom", modelProvider);

  const providers = isRecord(doc) ? doc.model_providers : undefined;
  const table = isRecord(providers) ? providers[providerId] : undefined;
  const tableMode = codexTableMode(table, expectedPort);
  const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
  // The writer strips env_key from a named table (MANAGED_PROVIDER_KEYS) and Codex rejects `auth` +
  // `env_key` on one provider, so a present one is drift the writer would never produce.
  const namedTableCarriesEnvKey = profile !== null && isRecord(table) &&
    table.env_key !== undefined;

  if (tableMode === "direct") {
    const envKeyMatches = !namedTableCarriesEnvKey;
    // Positively identify OUR launcher (command + args), not just any auth.command: a stale `gh
    // auth token` block must NOT read as managed.
    const directUsesToken = isRecord(table) && isManagedDirectAuth(table.auth, profile);
    const credential: CodexManagedCredential = directUsesToken
      ? "command"
      : isStaticAuthorization(table)
      ? "static"
      : "none";
    return {
      ...tokenFacts,
      providerMode: "direct",
      configExists: true,
      modelProvider,
      providerSelected: true,
      // A direct table always carries a string base_url (codexTableMode); the fallback is unreachable.
      baseUrl: baseUrl ?? DEFAULT_COPILOT_API_BASE,
      baseUrlMatches: true,
      envKeyMatches,
      // The default direct selection needs no further conjunct (the health probe layers the store
      // question on top); a named direct profile requires the profile-addressed managed auth or the
      // static bearer, since default-addressed or foreign auth would resolve the wrong credential.
      providerWired: envKeyMatches && (profile === null || credential !== "none"),
      credential,
      directUsesToken,
      otherReason: null,
    };
  }
  // A selected-but-unrecognized table shape (tableMode "other") still counts as ours for messaging,
  // reported as proxy so the wiring facts below flag what's off.
  const credential: CodexManagedCredential =
    isRecord(table) && isManagedProxyAuth(table.auth, profile)
      ? "command"
      : isStaticAuthorization(table)
      ? "static"
      : "none";
  const baseUrlMatches = baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort);
  const envKeyMatches = !namedTableCarriesEnvKey && credential !== "none";
  return {
    ...tokenFacts,
    providerMode: "proxy",
    configExists: true,
    modelProvider,
    providerSelected: true,
    baseUrl,
    baseUrlMatches,
    envKeyMatches,
    providerWired: baseUrlMatches && envKeyMatches,
    credential,
    directUsesToken: false,
    otherReason: null,
  };
}

// Seeded when config.toml is absent OR empty (readCodexToml reads a whitespace-only file as
// absent). Provider tables and the managed top-level keys
// (web_search) are absent on purpose: the merge injects the former and the writer force-writes the
// latter right after loading, so there is nothing to drift.
function defaultConfig(): Record<string, unknown> {
  return {
    "model_provider": CODEX_PROVIDER_ID,
    "analytics": { "enabled": false },
    "feedback": { "enabled": false },
  };
}

/** A named profile's `<name>.config.toml` as the writer merges into it: the user's own keys stay,
 *  a missing file starts empty, and a present-but-unparseable one throws like config.toml does
 *  (never clobber what could not be read). */
function loadProfileConfig(codexHome: string, name: ProfileName): Record<string, unknown> {
  const profilePath = codexProfileConfigPath(codexHome, name);
  const read = readCodexToml(profilePath);
  switch (read.kind) {
    case "absent":
      return {};
    case "unparseable":
      throw new Error(`${profilePath} is not valid TOML; refusing to overwrite it (${read.error})`);
    case "ok":
      return read.doc;
    default:
      return assertNever(read);
  }
}

/** The removal paths delete keys and write back, so a file that exists but cannot be read or parsed
 *  throws: they must never blind-write over a config they could not fully read. */
function readConfigForRemoval(configPath: string): Record<string, unknown> | null {
  let read: CodexTomlRead;
  try {
    read = readCodexToml(configPath);
  } catch (e) {
    throw new Error(`${configPath} is not readable/valid TOML: ${errMessage(e)}`);
  }
  if (read.kind === "absent") return null;
  if (read.kind === "unparseable") {
    throw new Error(`${configPath} is not readable/valid TOML: ${read.error}`);
  }
  return read.doc;
}

function validateProxyOptions(
  request: { baseUrl: string; credential: CredentialWiring },
): CodexModeRequest {
  if (!request.baseUrl) {
    throw new Error("base_url not provided for the Codex proxy config");
  }
  if (!/^[A-Za-z0-9:/._-]+$/.test(request.baseUrl)) {
    throw new Error(`base_url contains invalid characters: ${request.baseUrl}`);
  }
  return { mode: "proxy", baseUrl: request.baseUrl, credential: request.credential };
}

/**
 * The write, computed but not performed: every managed key is a patch over config.toml (and a named
 * profile's `<name>.config.toml`), folded into the plan's rows and applied to the in-memory
 * documents the returned step saves, so no key can be written without appearing in the plan.
 * A named profile's selector lives in `<name>.config.toml`, never at the top level of config.toml,
 * so `codex --profile <name>` and plain `codex` coexist.
 */
export function planCodexConfig(
  codexHome: string,
  request: CodexWriteRequest,
  catalogDeps: CodexCatalogDeps = {},
): WritePlan {
  const profile = request.profile ?? null;
  const providerId = codexProviderId(profile);
  // The union guarantees a base URL exists; this rejects an empty or malformed one before anything
  // below sees it.
  const modeRequest: CodexModeRequest = request.mode === "proxy"
    ? validateProxyOptions(request)
    : request;

  const hostConfig = codexConfigPath(codexHome);
  const hostText = readTextResult(hostConfig);
  // A present-but-UNPARSEABLE file throws rather than letting the caller clobber a config it could
  // not read: a hand-edit typo must never cost the user their whole config.toml (mcp_servers,
  // custom providers, model pins). Other read errors (EISDIR, permission) propagate raw.
  const hostRead = readCodexToml(hostConfig);
  if (hostRead.kind === "unparseable") {
    throw new Error(
      `${hostConfig} is not valid TOML; refusing to overwrite it (${hostRead.error})`,
    );
  }
  // A blank file is seeded like a missing one (readCodexToml reads it as absent), and the plan then
  // compares against nothing, so every seeded key shows as set.
  const current: Doc | null = hostRead.kind === "ok" ? hostRead.doc : null;
  const doc: Doc = current ?? defaultConfig();
  // Loaded BEFORE anything is saved, so a profile file this write refuses to clobber fails the
  // write whole rather than after config.toml already changed.
  const profileFile = profile === null ? null : {
    path: codexProfileConfigPath(codexHome, profile),
    text: readTextResult(codexProfileConfigPath(codexHome, profile)),
    doc: loadProfileConfig(codexHome, profile),
  };

  const ops: PatchOp[] = [];
  // The template's keys are a fresh file's plan; re-applied over the seeded document they change
  // nothing.
  if (current === null) {
    for (const [key, value] of Object.entries(defaultConfig())) ops.push(set([key], value));
  }
  // Every managed field is (re)written on every run, so a stale value or a missing managed key
  // heals; other providers, [analytics]/[feedback], and unknown top-level keys are left untouched.
  // The top-level managed keys are the DEFAULT selection's alone.
  if (profile === null) {
    ops.push(set(["model_provider"], CODEX_PROVIDER_ID));
    ops.push(set(["web_search"], "live"));
  } else if (current === null) {
    // The template's default `model_provider` would point at a `copilot-env` table this write never
    // creates, and an unknown provider reference is a Codex startup error.
    ops.push(remove(["model_provider"]));
  }
  if (request.mode === "proxy") {
    // Codex's offline sandbox blocks loopback for its sandboxed subprocesses, the auth.command
    // included, so the proxy-token resolver's liveness probe is refused and auth exits 1.
    // workspace-write network access is the documented toggle (verified: it removes the
    // codex_sandbox_offline_block_loopback firewall rule), and codex has no finer exemption.
    //   global key, not provider-scoped -> the model's sandboxed shell reaches the network too
    ops.push(set(["sandbox_workspace_write", "network_access"], true));
  }

  // `model_catalog_json` REPLACES Codex's bundled catalog, and a missing, empty, unparseable, or
  // schema-rejected file is a Codex STARTUP error: the key is written only when opted in, usable,
  // and not rejected by the installed codex (re-judged on every write, so `agent codex` recovers
  // from a codex upgrade); otherwise scrubbed, even over a user-pinned path. Only the DEFAULT write
  // owns it.
  let catalogRef: "written" | "cleared" | null = null;
  let catalogRefLine: string | null = null;
  if (profile === null) {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    const previousRef = doc.model_catalog_json;
    const verdict: CatalogFileVerdict | "disabled" =
      new CopilotEnvConfig().codexModelCatalogEnabled()
        ? inspectCatalogFile(catalogFile, catalogDeps)
        : "disabled";
    if (verdict === "rejected") {
      logger.warn(
        `  ! the installed codex rejects ${catalogFile}; leaving it out of the config ` +
          "(regenerate with `agent codex`, or disable with " +
          `\`${configSetCommand("codex.model-catalog", "false")}\`)`,
      );
    }
    if (verdict === "accepted" || verdict === "unverifiable") {
      ops.push(set(["model_catalog_json"], catalogFile));
      catalogRef = "written";
      if (previousRef !== catalogFile) {
        catalogRefLine = `model_catalog_json = "${catalogFile}" set` +
          (verdict === "unverifiable" ? UNVERIFIED_SUFFIX : "");
      }
    } else {
      ops.push(remove(["model_catalog_json"]));
      catalogRef = "cleared";
      if (previousRef !== undefined) {
        catalogRefLine = `model_catalog_json removed, was "${String(previousRef)}"`;
      }
    }
  }

  // Both modes share ONE table per profile, so every managed key is stripped BEFORE the mode's own
  // land: toggling modes can never bleed the OTHER mode's keys, and the managed keys settle after
  // the user's own, which survive.
  const table = ["model_providers", providerId];
  for (const key of MANAGED_PROVIDER_KEYS) ops.push(remove([...table, key]));
  for (const [key, value] of Object.entries(managedProviderForMode(modeRequest, profile))) {
    ops.push(set([...table, key], value));
  }
  const secrets = new Set([dottedKey([...table, "http_headers", AUTHORIZATION_HEADER])]);
  const hostRows = planPatch(current, ops, secrets);
  applyPatch(doc, ops);

  // `codex --profile <name>` flips ONLY the provider; the user's own keys in the profile file
  // (model pins etc.) survive.
  const profileOps = [set(["model_provider"], providerId)];
  const profileRows = profileFile === null
    ? []
    : planPatch(profileFile.text.kind === "text" ? profileFile.doc : null, profileOps);
  if (profileFile !== null) applyPatch(profileFile.doc, profileOps);

  const files: FilePlan[] = [{
    path: hostConfig,
    verdict: textVerdict(hostText.kind === "text" ? hostText.text : null, stringify(doc)),
    attributes: hostRows,
  }];
  if (profileFile !== null) {
    files.push({
      path: profileFile.path,
      verdict: textVerdict(
        profileFile.text.kind === "text" ? profileFile.text.text : null,
        stringify(profileFile.doc),
      ),
      attributes: profileRows,
    });
  }

  const knownHome = knownCodexHomes().homes.includes(codexHome);
  // The write's own line carries what the write means and lands before the fallible ledger
  // bookkeeping. Every profile shares this one file and the seam names a path once per process, so
  // the detail says nothing profile-specific (`agent profile` prints the launch hint).
  const credentialLine = request.credential.kind === "command"
    ? null
    : request.mode === "direct"
    ? "static key"
    : `static key, start the proxy yourself (${agentStartCommand(profile)}, or the cx launcher)`;
  const detail = ["Codex config", credentialLine, catalogRefLine].filter(Boolean).join("; ");

  return {
    files,
    apply() {
      try {
        mkdirReported(codexHome);
      } catch (e) {
        throw new Error(`could not create Codex config directory ${codexHome}: ${errMessage(e)}`);
      }
      saveCodexToml(hostConfig, doc, detail);
      // Saved after config.toml so the selector never lands ahead of the table it points at.
      if (profileFile !== null) {
        saveCodexToml(profileFile.path, profileFile.doc, "Codex profile config");
      }
      // Ownership lands only AFTER the successful save (the ledger's crash-direction contract), and
      // only for a KNOWN Codex home (the set the cleanup sweep visits), so a write to a foreign home
      // never enters the ledger. Recording on every enabled write keeps the claim current; the cleared
      // branch drops any claim, ours or stale.
      if (catalogRef !== null && knownHome) {
        if (catalogRef === "written") new OwnershipLedger().record("codexCatalog", hostConfig);
        else new OwnershipLedger().release("codexCatalog", hostConfig);
      }
    },
  };
}

/** planCodexConfig, performed. */
export function configureCodexConfig(
  codexHome: string,
  request: CodexWriteRequest,
  catalogDeps: CodexCatalogDeps = {},
): void {
  planCodexConfig(codexHome, request, catalogDeps).apply();
}

/** The request for `profile`'s write. A proxy write PEEKS the profile's port (copilotApiResolvePort)
 *  so planning writes nothing; the caller reserves it (reservePlannedPort) right before the apply. */
function codexWriteRequest(
  write: ManagedWrite,
  profile: Profile,
): { port: string | null; request: CodexWriteRequest } {
  if (write.mode !== "proxy") return { port: null, request: { ...write, profile } };
  const port = copilotApiResolvePort(profile);
  return {
    port,
    request: { mode: "proxy", profile, baseUrl: openaiBaseUrl(port), credential: write.credential },
  };
}

/**
 * The caller persists CODEX_HOME to state and, for direct, has already resolved the client identity
 * carried in the write (this function never probes). Throws with the cause when the write cannot
 * proceed.
 */
export async function applyCodexConfig(
  codexHome: string,
  write: ManagedWrite,
  catalogDeps?: CodexCatalogDeps,
  profile: Profile = null,
): Promise<void> {
  // The plan PEEKS the profile's port; the reservation (a write path) lands with the apply
  // (reservePlannedPort), so a plan that throws leaves no reservation behind.
  const { port, request } = codexWriteRequest(write, profile);

  // Seeded (best-effort, unthrottled) BEFORE the config write, so the very first wiring can already
  // reference the file; the auth-time refresh (src/commands/auth.ts) keeps it fresh afterwards.
  // Account-wide, keyed to the default credential, so named-profile writes never touch it.
  if (profile === null) await generateCodexModelCatalog(write.mode, catalogDeps);

  const plan = planCodexConfig(codexHome, request, catalogDeps);
  if (port !== null) reservePlannedPort(profile, port);
  plan.apply();

  // When the catalog is disabled the write above only stripped the key in THIS home; the sync also
  // deletes the generated file and clears the throttle state, so a wiring pass finishes the
  // opt-out.
  if (profile === null) syncCodexCatalogReference(catalogDeps);
}

/** The Direct facts a write bakes, resolved ONCE on the host in use: the `identity` pin, else
 *  identity selection on that host, then the `host` literal, else the host probe under that
 *  identity; a host `auto` moves to re-runs the selection there. Throws when the credential is
 *  rejected under every known identity.
 *
 *  Claude           -> the result rides in ANTHROPIC_BASE_URL + ANTHROPIC_CUSTOM_HEADERS
 *  Codex            -> the same result rides in base_url + http_headers
 *  `token` supplied -> skips a redundant credential resolve */
export async function probeDirectWiring(
  profile: Profile = null,
  token?: string | null,
): Promise<DirectWiring> {
  const resolved = token !== undefined ? token : new Credential(undefined, profile).resolve();
  if (resolved === null) throw directNeedsCredentialError(profile);
  const overlay = directOverlay(profile);
  // The one identity-then-host rule (selectDirectIdentityAndHost): a literal skips the HOST probe,
  // never the identity selection, and a host `auto` moved to re-runs the selection there.
  const { integrationId, apiBase } = await selectDirectIdentityAndHost(resolved, codexUserAgent(), {
    pinned: overlay.pinned,
    fixedHost: overlay.literal,
  });
  return directWiring(integrationId, apiBase);
}

/** The LANDING: landDirectPair (src/copilot_api/direct_pair.ts, the one probe-and-store owner) as
 *  the branded wiring the writers take. Only the commands that land a credential or wire a slot
 *  holding no pair reach it (`agent profile --add`, `agent auth --profile`, an import, and a named
 *  profile's re-render whose slot holds no pair; the default's landing probes per agent and
 *  stores through commitDefaultWiring in configure_defaults.ts once both agents' files are
 *  written); a listing such as `agent models --direct` probes without it (probeDirectWiring), so a
 *  transient answer there can never overwrite the stored pair. */
export async function landDirectWiring(
  profile: Profile = null,
  token?: string | null,
): Promise<DirectWiring> {
  const resolved = token !== undefined ? token : new Credential(undefined, profile).resolve();
  if (resolved === null) throw directNeedsCredentialError(profile);
  const landed = await landDirectPair(profile, resolved, codexUserAgent(), directOverlay(profile));
  return directWiring(landed.integrationId, landed.apiBase);
}

function codexOtherDetail(otherReason: CodexOtherReason): string {
  switch (otherReason) {
    case "malformed":
      return "config.toml is present but not valid TOML";
    case "read-error":
      return "config.toml exists but could not be read";
    case "profile-malformed":
      return "the profile's config.toml is present but not valid TOML";
    case "profile-read-error":
      return "the profile's config.toml exists but could not be read";
    case "legacy-profile-key":
      return "config.toml carries a legacy top-level `profile` key (Codex refuses every launch)";
    case "legacy-profile-table":
      return "config.toml carries a legacy [profiles.<name>] table (Codex refuses the profile)";
    case "custom":
      return "custom or unsupported provider";
    default:
      return assertNever(otherReason);
  }
}

/** Takes the status whole (not mode + reason separately) so an impossible pair can never render. */
function providerModeDetail(status: CodexWiringStatus): string {
  switch (status.providerMode) {
    case "proxy":
      return "local copilot-api proxy";
    case "direct":
      return "GitHub Copilot Direct";
    case "none":
      return status.configExists ? "no model_provider configured" : "no config.toml found";
    case "other":
      return codexOtherDetail(status.otherReason);
    default:
      return assertNever(status);
  }
}

function checkCodexConfig(): void {
  try {
    const codexHome = narrateCodexHome(resolveCodexHome());
    const configPath = codexConfigPath(codexHome);
    const read = readTextResult(configPath);
    const status = inspectCodexWiring(read, null, Number(copilotApiResolvePort()), false);
    printWrapped(`Codex provider mode: ${status.providerMode} (${providerModeDetail(status)})`);
    printWrapped(`CODEX_HOME: ${codexHome}`);
    printWrapped(`config.toml: ${configPath}`);
    const drift = codexHostDrift();
    if (drift !== null) printWrapped(codexHostDriftLine(drift));
    // "direct" was classified from this very text, so it parses.
    if (status.providerMode === "direct" && read.kind === "text") {
      printWrapped(
        `service_tier: ${serviceTierDetail(parse(read.text) as Record<string, unknown>)}`,
      );
    }
    process.exitCode = providerModeExitCode(status.providerMode);
  } catch (e) {
    logger.error(`Codex provider check failed: ${errMessage(e)}`);
    process.exitCode = 1;
  }
}

// Copilot Direct's answer to Codex's `service_tier`: `default` and `flex` are accepted, `priority`
// (Codex's fast-mode default) is rejected ("service_tier is not supported").
const COPILOT_ACCEPTED_SERVICE_TIERS: ReadonlySet<string> = new Set(["default", "flex"]);
const COPILOT_REJECTED_SERVICE_TIER = "priority";

/** The line is the user's knob and is never rewritten; with the opt-in catalog on, its stripped
 *  tier advertisements make Codex send no tier at all, whatever the line says. */
function serviceTierDetail(doc: Record<string, unknown>): string {
  const tier = doc.service_tier;
  if (tier === undefined) return "not pinned";
  if (tier === COPILOT_REJECTED_SERVICE_TIER) {
    return `"${tier}" (Copilot Direct rejects it; the opt-in codex.model-catalog stops Codex from ` +
      `sending any tier, else set service_tier = "default" or "flex" in config.toml)`;
  }
  if (typeof tier === "string" && COPILOT_ACCEPTED_SERVICE_TIERS.has(tier)) {
    return `"${tier}" (accepted by Copilot Direct)`;
  }
  return `"${String(tier)}" (unrecognized; left alone)`;
}

/** The provider table goes by name; `<name>.config.toml`'s selector goes only while it still points
 *  at our provider id (a user-repointed one is no longer ours), and the file itself only when
 *  nothing of the user's remains in it. A present-but-unparseable file throws. */
export function removeCodexProfile(codexHome: string, name: ProfileName): void {
  const providerId = codexProviderId(name);
  const configPath = codexConfigPath(codexHome);
  const profilePath = codexProfileConfigPath(codexHome, name);
  // Both reads before either save: a profile file that throws must leave config.toml as it was,
  // never a selector whose provider table is already gone.
  const doc = readConfigForRemoval(configPath);
  const profileDoc = readConfigForRemoval(profilePath);
  if (doc !== null) {
    const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
    if (providers[providerId] !== undefined) {
      delete providers[providerId];
      if (Object.keys(providers).length === 0) delete doc.model_providers;
      saveCodexToml(configPath, doc);
    }
  }
  if (profileDoc === null || profileDoc.model_provider !== providerId) return;
  delete profileDoc.model_provider;
  if (Object.keys(profileDoc).length === 0) removeReported(profilePath);
  else saveCodexToml(profilePath, profileDoc);
}

/**
 * Only what is still provably ours goes; a present-but-unparseable file throws (never blind-write).
 *   [model_providers.copilot-env]  -> ours by name
 *   model_provider                 -> only while it still points at our id
 *   model_catalog_json             -> only when it denotes the generated catalog the caller is
 *                                     about to delete (a dangling reference is a startup error)
 *   web_search                     -> only the managed "live", and only when the selector was ours
 */
export function removeCodexDefaultWiring(codexHome: string): void {
  const configPath = codexConfigPath(codexHome);
  const doc = readConfigForRemoval(configPath);
  if (doc !== null) {
    let changed = false;
    const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
    if (providers[CODEX_PROVIDER_ID] !== undefined) {
      delete providers[CODEX_PROVIDER_ID];
      changed = true;
      if (Object.keys(providers).length === 0) delete doc.model_providers;
    }
    let selectorWasOurs = false;
    if (doc.model_provider === CODEX_PROVIDER_ID) {
      delete doc.model_provider;
      selectorWasOurs = true;
      changed = true;
    }
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    let catalogWasReferenced = false;
    if (
      doc.model_catalog_json === catalogFile ||
      // "yes" only, since an UNKNOWN resolve is no proof the key is ours; the cleanup sweep
      // refuses on "unknown" the same way.
      //   strip on doubt  -> a user-owned key silently deleted
      //   leave on doubt  -> a dangling reference, and only when it WAS ours: loud and fixable
      resolvesToCatalogFile(doc.model_catalog_json, catalogFile) === "yes"
    ) {
      delete doc.model_catalog_json;
      catalogWasReferenced = true;
      changed = true;
    }
    if (selectorWasOurs && doc.web_search === "live") {
      delete doc.web_search;
      changed = true;
    }
    if (changed) saveCodexToml(configPath, doc);
    // Never claim-drop before the artifact write actually landed.
    if (catalogWasReferenced) new OwnershipLedger().release("codexCatalog", configPath);
  }
}

/** `codexServable` is the catalog's own "codex can drive it" mark (chat, picker-enabled, served on
 *  /responses), so the smoke pings a model the generated catalog would offer; a reduced tier first,
 *  for the same reason cheapestClaudeModel gives. */
export const CODEX_ENDPOINT_SMOKE: EndpointSmoke = {
  wire: "responses",
  pickModel: (body) => {
    const servable = [...parseCopilotModels(body)]
      .filter(([, model]) => model.codexServable)
      .map(([id]) => id);
    return servable.find(isReducedGpt) ?? servable[0] ?? null;
  },
};

/** The throwaway config's selector, NOT the managed id. The table's `auth.command` runs `agent auth
 *  --get` in the child, and with neither Codex-home key set (the default) that child's Codex home is
 *  $CODEX_HOME = the throwaway home (defaultCodexHome; codex.home or a codex.host farm wins over it).
 *  Its catalog self-heal (src/codex/catalog_reference.ts) adds `model_catalog_json` to, and ledgers,
 *  any config there that selects the managed provider: the next attempt would then run under the
 *  user's catalog, and the ledger would keep a path removeScratchDir deletes. A foreign selector is
 *  left alone by that self-heal's own contract. */
const CODEX_PROBE_PROVIDER_ID = `${CODEX_PROVIDER_ID}-probe`;

/** The detect probe's throwaway config: the Direct provider table and its selector, nothing else.
 *  The real write's top-level extras (`web_search`, the generated `model_catalog_json`) belong to
 *  the user's wiring, not to Direct, and a catalog file produced under another credential would
 *  colour the verdict. Shares managedDirectProvider, so the table is byte-identical to the real one. */
function writeCodexProbeConfig(tmpHome: string, direct: DirectWiring): void {
  saveCodexToml(codexConfigPath(tmpHome), {
    ...defaultConfig(),
    "model_provider": CODEX_PROBE_PROVIDER_ID,
    "model_providers": {
      [CODEX_PROBE_PROVIDER_ID]: managedDirectProvider(
        COMMAND_SHAPE,
        null,
        direct.directIntegrationId,
        codexUserAgent(),
        direct.directBaseUrl,
      ),
    },
  }, "Codex probe config");
}

/** Writes a throwaway direct config and runs `codex exec --model <catalog pick> --sandbox
 *  read-only` against it (src/agents/live_probe.ts); with no codex CLI on the machine the endpoint
 *  smoke judges the credential instead. False means the caller writes proxy. */
export function detectCodexDirect(
  direct: DirectWiring,
  ghToken: string | null,
  deps?: DirectProbeDeps,
): Promise<boolean> {
  return probeDirectWorks(
    CODEX_PROBE,
    (tmpHome) => writeCodexProbeConfig(tmpHome, direct),
    ghToken === null ? null : directSmoke(
      CODEX_ENDPOINT_SMOKE,
      ghToken,
      codexUserAgent(),
      direct.directIntegrationId,
      direct.directBaseUrl,
      { fetchImpl: deps?.fetchImpl },
    ),
    deps,
  );
}

/** `catalogDeps` is runCodex's test seam only; `agent profile` builds the adapter without it. */
export function codexAdapter(catalogDeps?: CodexCatalogDeps): AgentAdapter {
  return {
    id: "codex",
    label: "Codex",
    check: checkCodexConfig,
    detectDirect: detectCodexDirect,
    resolveDirectWiring: (ghToken) => probeDirectWiring(null, ghToken),
    async configureDefault(write, ghToken) {
      // The already-resolved credential feeds the catalog seed's direct fetch, so the gh-cli
      // provider isn't shelled out to a second time.
      const seedDeps = catalogDeps ?? (ghToken === null ? undefined : { directToken: ghToken });
      // The farm derivation decides the home the write lands in (and records it after).
      await withCodexHostFarm((codexHome) => applyCodexConfig(codexHome, write, seedDeps, null));
    },
    configureProfile(name, write) {
      const { port, request } = codexWriteRequest(write, name);
      const plan = planCodexConfig(effectiveCodexHome(), request);
      if (port !== null) reservePlannedPort(name, port);
      plan.apply();
    },
    removeProfile(name) {
      removeCodexProfile(effectiveCodexHome(), name);
    },
  };
}
