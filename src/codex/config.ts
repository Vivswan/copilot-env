// Codex config writer: Copilot Direct by default, the local proxy as an explicit mode. Neither
// bakes a credential; `auth.command` resolves it at fetch time.
import * as fs from "node:fs";
import { parse } from "smol-toml";
import {
  type AgentAdapter,
  type AgentRunAction,
  type ManagedWrite,
  runAgentConfig,
} from "../agents/configure.ts";
import { CODEX_PROBE, type DirectProbeDeps, probeDirectWorks } from "../agents/live_probe.ts";
import { type AgentProviderMode, providerModeExitCode } from "../agents/provider_mode.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  resolveDirectIntegrationId,
} from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import {
  copilotApiResolvePort,
  matchesProxyOrigin,
  openaiBaseUrl,
  wiringPortFor,
} from "../copilot_api/port.ts";
import { type Profile, type ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { readTextResult, type TextReadResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { mkdirReported } from "../utils/report_write.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenCommand } from "../utils/root.ts";
import {
  type CatalogFileVerdict,
  type CodexCatalogDeps,
  codexUserAgentVersion,
  generateCodexModelCatalog,
  inspectCatalogFile,
  UNVERIFIED_SUFFIX,
} from "./catalog.ts";
import { resolvesToCatalogFile, syncCodexCatalogReference } from "./catalog_reference.ts";
import {
  codexHostDrift,
  codexHostDriftLine,
  effectiveCodexHome,
  knownCodexHomes,
  withCodexHostFarm,
} from "./host.ts";
import { CODEX_PROVIDER_ID, codexConfigPath, defaultCodexHome } from "./paths.ts";
import { type CodexTomlRead, readCodexToml, saveCodexToml } from "./toml_io.ts";

const logger = createStderrLogger();

// ONE provider, `copilot-env`, for BOTH direct and proxy: the mode is read from the table's
// CONTENTS (its base_url), not from the provider name. OPENAI_API_KEY is the same OpenAI-wire name
// `env.ts` exports; the inspector reports whether the user's `.env` or environment carries it as a
// fact about the home (no managed wiring needs it).
export const CODEX_ENV_KEY = "OPENAI_API_KEY";
// integration_identity.ts owns the literal: the identity probe's verdict must be rendered against
// the host the agents actually bake.
const DIRECT_BASE_URL = DEFAULT_COPILOT_API_BASE;
/** What one `agent auth --get` (the `gh` look, the token print, a due catalog refresh) has before
 *  Codex gives up. It sits in every install's config, so the refresh budgets bend to it (pinned by
 *  test). */
export const DIRECT_AUTH_TIMEOUT_MS = 30000;

/** A named profile is selected via Codex's NATIVE `[profiles.<name>]` table (`codex --profile
 *  <name>`), whose `model_provider` points here; the top-level default selection is never touched.
 */
export function codexProviderId(profile: Profile = null): string {
  return profile === null ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${profile}`;
}
/** Proxy ALWAYS carries a base URL: a proxy write without one is unrepresentable, so nothing
 *  downstream re-checks for it. */
type CodexModeRequest =
  | Extract<ManagedWrite, { mode: "direct" }>
  | (Extract<ManagedWrite, { mode: "proxy" }> & { baseUrl: string });

interface CodexWriteCommon {
  codexExecVersion?: string | null;
  /** Suppress the catalog-verdict warning (the direct probe's throwaway write). */
  quiet?: boolean;
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

/** Copilot's Anthropic surface REJECTS some models (claude-fable-5, verified live) for a
 *  version-LESS `codex_exec` UA while accepting any versioned form (the gate is the shape, not the
 *  value), so the managed identity must never go bare. A real release (npm-latest at pin time)
 *  keeps it plausible. */
export const FALLBACK_CODEX_UA_VERSION = "0.152.0";

export function codexUserAgent(version: string | null = codexUserAgentVersion()): string {
  return `${CODEX_EXEC_USER_AGENT}/${version ?? FALLBACK_CODEX_UA_VERSION}`;
}

/** The unified table doesn't encode mode in its name, so mode is read from base_url; anything but
 *  the Direct host or a localhost proxy on `expectedPort` is "other" (a half-written table). */
function codexTableMode(table: unknown, expectedPort: number): AgentProviderMode {
  if (!isRecord(table)) return "other";
  if (table.base_url === DIRECT_BASE_URL) return "direct";
  const baseUrl = typeof table.base_url === "string" ? table.base_url : null;
  if (baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort)) return "proxy";
  return "other";
}

// Codex re-runs `auth.command` every `refresh_interval_ms`, so the token tracks the current
// credential without ever being in the file. Re-applied on every direct run: managed keys win,
// user-added keys in the same table survive the merge.
function managedDirectProvider(
  codexExecVersion?: string | null,
  profile: Profile = null,
  directIntegrationId?: string | null,
) {
  const { command, args } = agentLauncherCommand(agentAuthGetArgs(profile));
  // Most credentials carry no integration id (the Codex UA suffices; the builder omits it when
  // null, keeping the default byte-identical), but a fine-grained PAT is only accepted under
  // `copilot-developer-cli`.
  const httpHeaders = directClientHeaders(codexUserAgent(codexExecVersion), directIntegrationId);
  return {
    "name": codexProviderId(profile),
    "base_url": DIRECT_BASE_URL,
    "wire_api": "responses",
    "supports_websockets": false,
    "requires_openai_auth": false,
    "http_headers": httpHeaders,
    "auth": {
      "command": command,
      "args": [...args],
      // The launcher may cold-start deno, and a due (at most daily) catalog refresh runs after the
      // token prints (AUTH_REFRESH_WORST_CASE_MS, src/codex/catalog.ts); warm calls take well under
      // a second, and Codex refreshes lazily.
      "timeout_ms": DIRECT_AUTH_TIMEOUT_MS,
      "refresh_interval_ms": 300000,
    },
  };
}

// `--yes` is the headless path. Codex forbids `auth` together with `env_key` on one provider, so
// proxy (like direct) resolves its key via the command, not an env var.
export function managedProxyProvider(baseUrl: string, profile: Profile = null) {
  const auth = proxyTokenCommand(profile);
  return {
    "name": codexProviderId(profile),
    "base_url": baseUrl,
    "wire_api": "responses",
    "requires_openai_auth": false,
    "supports_websockets": false,
    "auth": {
      "command": auth.command,
      "args": [...auth.args],
      // Cold-starting the proxy runs a full child `agent start`: runtime startup, the daemon's
      // readiness wait (up to a ~120s ceiling), THEN model-alias sync and version logging before
      // the key prints. The first auth attempt must not time out after the proxy is ready.
      "timeout_ms": 180000,
      "refresh_interval_ms": 300000,
    },
  };
}

function managedProviderForMode(
  request: CodexModeRequest,
  codexExecVersion?: string | null,
  profile: Profile = null,
) {
  if (request.mode === "direct") {
    return managedDirectProvider(codexExecVersion, profile, request.directIntegrationId);
  }
  return managedProxyProvider(request.baseUrl, profile);
}

// Codex rejects `auth` + `env_key` on one provider, so a managed table must never carry an env_key
// (whoever put it there). Derived from the factories so a new mode-specific managed key can never
// reintroduce cross-mode bleed on the shared table; the placeholder base URL is only embedded,
// never fetched.
const MANAGED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(managedDirectProvider(null)),
  ...Object.keys(managedProxyProvider("http://managed-keys.invalid")),
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

// === wiring inspection (inverse of the write contract above) ===
//
// Lives HERE, next to the managed provider tables, so `agent health` and `agent codex` share one
// contract instead of shell/TOML copies.

/** Minted with providerMode by inspectCodexWiring (mirrors ClaudeOtherReason).
 *    "malformed"   -> config.toml is present but not valid TOML
 *    "read-error"  -> config.toml exists but could not be read
 *    "custom"      -> a foreign `model_provider` is selected */
export type CodexOtherReason = "malformed" | "custom" | "read-error";

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
      /** The inspected selection's `model_provider` (the top-level key for the default, the
       *  `[profiles.<name>]` selector's value for a named profile); on "other", the foreign value,
       *  or null when unknowable. */
      modelProvider: string;
      providerSelected: true;
      /** Direct classification requires the exact Direct base URL, so both facts are pinned at the
       *  type. */
      baseUrl: typeof DIRECT_BASE_URL;
      baseUrlMatches: true;
      /** Direct carries no env_key contract, so only a named table's forbidden env_key (drift the
       *  writer never emits; Codex rejects `auth` + `env_key`) can make it false. */
      envKeyMatches: boolean;
      /** A named profile's auth block must be the managed one addressed at THAT profile (never a
       *  fallback). */
      providerWired: boolean;
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
      directUsesToken: false;
      otherReason: null;
    }
    | {
      providerMode: "other";
      configExists: true;
      modelProvider: string | null;
      providerSelected: false;
      baseUrl: null;
      baseUrlMatches: false;
      envKeyMatches: false;
      providerWired: false;
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
 *   a NAMED profile  -> Codex's own `[profiles.<name>]` -> `[model_providers.copilot-env-<name>]`,
 *                       with the top-level default selection playing no part
 *   `expectedPort`   -> the caller passes the selection's OWN reserved proxy port
 */
export function inspectCodexWiring(
  configToml: TextReadResult | string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
  profile: Profile = null,
): CodexWiringStatus {
  const read: TextReadResult = typeof configToml === "string"
    ? { kind: "text", text: configToml }
    : configToml ?? { kind: "absent" };
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
    directUsesToken: false,
    otherReason: null,
  });
  const other = (
    otherReason: CodexOtherReason,
    modelProvider: string | null,
  ): CodexWiringStatus => ({
    ...tokenFacts,
    providerMode: "other",
    configExists: true,
    modelProvider,
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    directUsesToken: false,
    otherReason,
  });
  if (read.kind === "absent") return none(false);
  if (read.kind === "unreadable") return other("read-error", null);
  let doc: unknown;
  try {
    doc = parse(read.text);
  } catch {
    return other("malformed", null);
  }
  // The selection fact mirrors what Codex itself reads: the top-level `model_provider` for the
  // default, the `[profiles.<name>]` table's for a named profile (`codex --profile <name>`).
  const profilesTable = isRecord(doc) ? doc.profiles : undefined;
  const selector = profile === null
    ? doc
    : isRecord(profilesTable)
    ? profilesTable[profile]
    : undefined;
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
    return {
      ...tokenFacts,
      providerMode: "direct",
      configExists: true,
      modelProvider,
      providerSelected: true,
      baseUrl: DIRECT_BASE_URL,
      baseUrlMatches: true,
      envKeyMatches,
      // The default direct selection needs no further conjunct (the health probe layers the store
      // question on top); a named direct profile requires the profile-addressed managed auth, since
      // default-addressed or foreign auth would resolve the wrong credential.
      providerWired: envKeyMatches && (profile === null || directUsesToken),
      directUsesToken,
      otherReason: null,
    };
  }
  // A selected-but-unrecognized table shape (tableMode "other") still counts as ours for messaging,
  // reported as proxy so the wiring facts below flag what's off.
  const proxyUsesManagedAuth = isRecord(table) && isManagedProxyAuth(table.auth, profile);
  const baseUrlMatches = baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort);
  const envKeyMatches = !namedTableCarriesEnvKey && proxyUsesManagedAuth;
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

// A present-but-UNPARSEABLE file throws rather than letting the caller clobber a config it could
// not read: a hand-edit typo must never cost the user their whole config.toml (mcp_servers, custom
// providers, model pins). Other read errors (EISDIR, permission) propagate raw from readCodexToml.
function loadOrCreateConfig(hostConfig: string): Record<string, unknown> {
  const read = readCodexToml(hostConfig);
  switch (read.kind) {
    case "absent":
      return defaultConfig();
    case "unparseable":
      throw new Error(`${hostConfig} is not valid TOML; refusing to overwrite it (${read.error})`);
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

function validateProxyOptions(request: { baseUrl: string }): CodexModeRequest {
  if (!request.baseUrl) {
    throw new Error("base_url not provided for the Codex proxy config");
  }
  if (!/^[A-Za-z0-9:/._-]+$/.test(request.baseUrl)) {
    throw new Error(`base_url contains invalid characters: ${request.baseUrl}`);
  }
  return { mode: "proxy", baseUrl: request.baseUrl };
}

/**
 * Throws when the write cannot proceed (unusable proxy options, uncreatable directory,
 * unparseable existing config).
 *
 * DEFAULT profile -> the top-level `model_provider` selects `copilot-env`, plus the top-level
 *                    managed keys (web_search, catalog reference)
 * NAMED profile   -> only `[model_providers.copilot-env-<name>]` and the native
 *                    `[profiles.<name>]` selector, so `codex --profile <name>` and plain `codex`
 *                    coexist
 * either, proxy   -> also the GLOBAL `sandbox_workspace_write.network_access`, which auth.command
 *                    needs
 */
export function configureCodexConfig(
  codexHome: string | null | undefined,
  request: CodexWriteRequest,
  catalogDeps: CodexCatalogDeps = {},
): void {
  codexHome = codexHome || defaultCodexHome();
  const profile = request.profile ?? null;
  const providerId = codexProviderId(profile);
  // The union guarantees a base URL exists; this rejects an empty or malformed one before anything
  // below sees it.
  const modeRequest: CodexModeRequest = request.mode === "proxy"
    ? validateProxyOptions(request)
    : request;

  try {
    mkdirReported(codexHome);
  } catch (e) {
    throw new Error(`could not create Codex config directory ${codexHome}: ${errMessage(e)}`);
  }

  const hostConfig = codexConfigPath(codexHome);

  // "Had content", not "existed": loadOrCreateConfig also seeds the template for an EMPTY file, and
  // the template's `model_provider` must not survive a named-profile write that never creates the
  // unsuffixed table.
  const configHadContent = (() => {
    try {
      return fs.readFileSync(hostConfig, "utf8").trim() !== "";
    } catch {
      return false;
    }
  })();
  const doc = loadOrCreateConfig(hostConfig);

  // Every managed field is (re)written on every run, so a stale value or a missing managed key
  // heals; other providers, [analytics]/[feedback], and unknown top-level keys are left untouched.
  // The top-level managed keys are the DEFAULT selection's alone.
  if (profile === null) {
    doc.model_provider = CODEX_PROVIDER_ID;
    doc.web_search = "live";
  } else if (!configHadContent) {
    // The template's default `model_provider` would point at a `copilot-env` table this write never
    // creates, and an unknown provider reference is a Codex startup error.
    delete doc.model_provider;
  }
  if (request.mode === "proxy") {
    // Codex's offline sandbox blocks loopback for its sandboxed subprocesses, the auth.command
    // included, so the proxy-token resolver's liveness probe is refused and auth exits 1.
    // workspace-write network access is the documented toggle (verified: it removes the
    // codex_sandbox_offline_block_loopback firewall rule), and codex has no finer exemption.
    //   global key, not provider-scoped -> the model's sandboxed shell reaches the network too
    const sandboxWrite = isRecord(doc.sandbox_workspace_write) ? doc.sandbox_workspace_write : {};
    sandboxWrite.network_access = true;
    doc.sandbox_workspace_write = sandboxWrite;
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
    if (verdict === "rejected" && !request.quiet) {
      logger.warn(
        `  ! the installed codex rejects ${catalogFile}; leaving it out of the config ` +
          "(regenerate with `agent codex`, or disable with " +
          "`agent config --set codex-model-catalog false`)",
      );
    }
    if (verdict === "accepted" || verdict === "unverifiable") {
      doc.model_catalog_json = catalogFile;
      catalogRef = "written";
      if (previousRef !== catalogFile) {
        catalogRefLine = `model_catalog_json = "${catalogFile}" set` +
          (verdict === "unverifiable" ? UNVERIFIED_SUFFIX : "");
      }
    } else {
      delete doc.model_catalog_json;
      catalogRef = "cleared";
      if (previousRef !== undefined) {
        catalogRefLine = `model_catalog_json removed, was "${String(previousRef)}"`;
      }
    }
  }

  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  const existing = isRecord(providers[providerId]) ? providers[providerId] : {};
  // Both modes share ONE table per profile, so every managed key is stripped BEFORE spreading:
  // toggling modes can never bleed the OTHER mode's keys. User-added keys survive.
  const userKeys = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !MANAGED_PROVIDER_KEYS.has(key)),
  );
  providers[providerId] = {
    ...userKeys,
    ...managedProviderForMode(modeRequest, request.codexExecVersion, profile),
  };
  doc.model_providers = providers;

  if (profile !== null) {
    // `codex --profile <name>` flips ONLY the provider; user keys in the same [profiles.<name>]
    // table (model pins etc.) survive.
    const profilesTable = isRecord(doc.profiles) ? doc.profiles : {};
    const existingProfile = isRecord(profilesTable[profile]) ? profilesTable[profile] : {};
    profilesTable[profile] = { ...existingProfile, "model_provider": providerId };
    doc.profiles = profilesTable;
  }

  const knownHome = knownCodexHomes().homes.includes(codexHome);
  // The write's own line carries what the write means and lands before the fallible ledger
  // bookkeeping. Every profile shares this one file and the seam names a path once per process, so
  // the detail says nothing profile-specific (`agent profile` prints the launch hint).
  saveCodexToml(hostConfig, doc, ["Codex config", catalogRefLine].filter(Boolean).join("; "));
  // Ownership lands only AFTER the successful save (the ledger's crash-direction contract), and
  // only for a KNOWN Codex home (the set the cleanup sweep visits), so detectCodexDirect's
  // throwaway probe home never enters the ledger. Recording on every enabled write also ADOPTS a
  // pre-ledger install's reference the next time it rewires; the cleared branch drops any claim,
  // ours or stale.
  if (catalogRef !== null && knownHome) {
    if (catalogRef === "written") new OwnershipLedger().record("codexCatalog", hostConfig);
    else new OwnershipLedger().release("codexCatalog", hostConfig);
  }
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
  // wiringPortFor RESERVES the addressed profile's stable port (a write path; read-only checks peek
  // without recording).
  const request: CodexWriteRequest = write.mode === "proxy"
    ? { mode: "proxy", profile, baseUrl: openaiBaseUrl(wiringPortFor(profile)) }
    : { ...write, profile };

  // Seeded (best-effort, unthrottled) BEFORE the config write, so the very first wiring can already
  // reference the file; the auth-time refresh (src/commands/auth.ts) keeps it fresh afterwards.
  // Account-wide, keyed to the default credential, so named-profile writes never touch it.
  if (profile === null) await generateCodexModelCatalog(write.mode, catalogDeps);

  configureCodexConfig(codexHome, request, catalogDeps);

  // When the catalog is disabled the write above only stripped the key in THIS home; the sync also
  // deletes the generated file and clears the throttle state, so a wiring pass finishes the
  // opt-out.
  if (profile === null) syncCodexCatalogReference(catalogDeps);
}

/** The `integration-id` config pin, else a live probe (integration_identity.ts). Throws when the
 *  credential is rejected under every known identity.
 *
 *  Claude           -> the result rides in ANTHROPIC_CUSTOM_HEADERS
 *  Codex            -> the same result rides in http_headers
 *  `token` supplied -> skips a redundant credential resolve */
export function probeDirectIntegrationId(
  profile: Profile = null,
  token?: string | null,
): Promise<string | null> {
  const resolved = token !== undefined ? token : new Credential(undefined, profile).resolve();
  return resolveDirectIntegrationId(resolved, codexUserAgent(), {
    pinned: new CopilotEnvConfig().pinnedIntegrationId(),
  });
}

function codexOtherDetail(otherReason: CodexOtherReason): string {
  switch (otherReason) {
    case "malformed":
      return "config.toml is present but not valid TOML";
    case "read-error":
      return "config.toml exists but could not be read";
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
    const codexHome = effectiveCodexHome();
    const configPath = codexConfigPath(codexHome);
    const read = readTextResult(configPath);
    const status = inspectCodexWiring(read, null, Number(copilotApiResolvePort()), false);
    console.log(`Codex provider mode: ${status.providerMode} (${providerModeDetail(status)})`);
    console.log(`CODEX_HOME: ${codexHome}`);
    console.log(`config.toml: ${configPath}`);
    const drift = codexHostDrift();
    if (drift !== null) console.log(codexHostDriftLine(drift));
    // "direct" was classified from this very text, so it parses.
    if (status.providerMode === "direct" && read.kind === "text") {
      console.log(
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
    return `"${tier}" (Copilot Direct rejects it; the opt-in codex-model-catalog stops Codex from ` +
      `sending any tier, else set service_tier = "default" or "flex" in config.toml)`;
  }
  if (typeof tier === "string" && COPILOT_ACCEPTED_SERVICE_TIERS.has(tier)) {
    return `"${tier}" (accepted by Copilot Direct)`;
  }
  return `"${String(tier)}" (unrecognized; left alone)`;
}

/** The `[profiles.<name>]` selector goes only while it still points at our provider id: a
 *  user-repointed selector is no longer ours to delete. A present-but-unparseable file throws. */
export function removeCodexProfile(codexHome: string, name: ProfileName): void {
  const configPath = codexConfigPath(codexHome);
  const doc = readConfigForRemoval(configPath);
  if (doc === null) return;
  const providerId = codexProviderId(name);
  let changed = false;
  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  if (providers[providerId] !== undefined) {
    delete providers[providerId];
    changed = true;
    if (Object.keys(providers).length === 0) delete doc.model_providers;
  }
  const profiles = isRecord(doc.profiles) ? doc.profiles : {};
  const selector = profiles[name];
  if (isRecord(selector) && selector.model_provider === providerId) {
    delete profiles[name];
    changed = true;
    if (Object.keys(profiles).length === 0) delete doc.profiles;
  }
  if (changed) saveCodexToml(configPath, doc);
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

/** Writes a throwaway direct config and runs `codex exec --sandbox read-only` against it
 *  (src/agents/live_probe.ts); false means the caller writes proxy. */
export function detectCodexDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CODEX_PROBE,
    (tmpHome) => {
      configureCodexConfig(tmpHome, { mode: "direct", quiet: true });
    },
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
    resolveDirectIdentity: (ghToken) => probeDirectIntegrationId(null, ghToken),
    async configureDefault(write, ghToken) {
      // The already-resolved credential feeds the catalog seed's direct fetch, so the gh-cli
      // provider isn't shelled out to a second time.
      const seedDeps = catalogDeps ?? (ghToken === null ? undefined : { directToken: ghToken });
      // The farm derivation decides the home the write lands in (and records it after).
      await withCodexHostFarm((codexHome) => applyCodexConfig(codexHome, write, seedDeps, null));
    },
    configureProfile(name, write, options) {
      const request: CodexWriteRequest = write.mode === "proxy"
        ? {
          mode: "proxy",
          profile: name,
          quiet: options.quiet,
          baseUrl: openaiBaseUrl(wiringPortFor(name)),
        }
        : { ...write, profile: name, quiet: options.quiet };
      configureCodexConfig(effectiveCodexHome(), request);
    },
    removeProfile(name) {
      removeCodexProfile(effectiveCodexHome(), name);
    },
  };
}

/** `agent codex`: the shared skeleton (runAgentConfig) over codexAdapter. */
export async function runCodex(
  action: AgentRunAction,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  return runAgentConfig(codexAdapter(catalogDeps), action);
}
