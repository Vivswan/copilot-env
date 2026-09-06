// Codex config writer: points Codex at GitHub Copilot directly by default, with
// the local copilot-api proxy available as an explicit proxy mode. Direct mode
// fetches its bearer at runtime via an `auth.command` that runs `agent auth --get`
// (provider-driven: gh-cli -> gh, copilot/gh-token -> the stored token) -- nothing is baked
// into the config or `.env`.
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

// The Codex model-provider id we manage: ONE provider, `copilot-env`, for BOTH
// direct and proxy -- the mode is read from the table's CONTENTS (its base_url),
// not from the provider name. OPENAI_API_KEY is the same OpenAI-wire name `env.ts`
// already exports; the wiring inspector reports whether the user's `.env` or
// environment carries it, as a fact about the home (no managed wiring needs it).
export const CODEX_ENV_KEY = "OPENAI_API_KEY";
// Direct mode's base_url: the same individual-plan host the identity probe hits
// (integration_identity.ts owns the literal -- the probe's verdict must be
// rendered against the host the agents actually bake).
const DIRECT_BASE_URL = DEFAULT_COPILOT_API_BASE;
/** The managed direct provider's `auth.timeout_ms`: what one `agent auth --get` (the
 *  `gh` look, the token print, a due catalog refresh) has before Codex gives up. It sits
 *  in every install's config, so the refresh budgets bend to it (pinned by test). */
export const DIRECT_AUTH_TIMEOUT_MS = 30000;

/** The managed provider id for `profile`: the unsuffixed `copilot-env` contract for the
 *  default, `copilot-env-<name>` for a named profile. A named profile is selected via
 *  Codex's NATIVE `[profiles.<name>]` table (`codex --profile <name>`), whose
 *  `model_provider` points here -- the top-level default selection is never touched. */
export function codexProviderId(profile: Profile = null): string {
  return profile === null ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${profile}`;
}
/** The mode-dependent half of a Codex config write: the SHARED ManagedWrite
 *  variants (src/agents/configure.ts), with the Codex-only fact that proxy
 *  ALWAYS carries a base URL -- a proxy write without one is unrepresentable,
 *  so nothing downstream re-checks for it. */
type CodexModeRequest =
  | Extract<ManagedWrite, { mode: "direct" }>
  | (Extract<ManagedWrite, { mode: "proxy" }> & { baseUrl: string });

/** The mode-independent knobs of a Codex config write. */
interface CodexWriteCommon {
  codexExecVersion?: string | null;
  /** Suppress the catalog-verdict warning (the direct probe's throwaway write). */
  quiet?: boolean;
  /** Wire a NAMED profile's tables instead of the default selection. */
  profile?: Profile;
}

/** One managed Codex config write: the mode variant plus the common knobs (spelled as a
 *  top-level union so the discriminant narrows at every consumer). */
export type CodexWriteRequest =
  | (Extract<CodexModeRequest, { mode: "direct" }> & CodexWriteCommon)
  | (Extract<CodexModeRequest, { mode: "proxy" }> & CodexWriteCommon);

// === config.toml management ===
//
// Load-merge-stringify so user-added keys/sections survive (smol-toml does NOT
// preserve comments or whitespace -- TS has no battle-tested tomlkit equivalent).
// configureCodexConfig ENFORCES every managed field on each run, so a renamed or
// added key propagates even into a pre-existing config.

/** Last-resort UA version when neither the installed codex CLI nor npm can name one
 *  (fully offline). Copilot's Anthropic surface REJECTS some models (claude-fable-5,
 *  verified live) for a version-LESS `codex_exec` UA while accepting any versioned
 *  form -- the gate is the shape, not the value -- so the managed identity must never
 *  go bare. A real release (npm-latest at pin time) keeps the advertised identity
 *  plausible; the two live lookups above it keep it current when reachable. */
export const FALLBACK_CODEX_UA_VERSION = "0.152.0";

export function codexUserAgent(version: string | null = codexUserAgentVersion()): string {
  return `${CODEX_EXEC_USER_AGENT}/${version ?? FALLBACK_CODEX_UA_VERSION}`;
}

/**
 * Derive the mode from our managed provider TABLE's contents (the unified `copilot-env`
 * table doesn't encode mode in its name): a Direct base_url -> direct, a localhost proxy
 * base_url -> proxy, anything else -> "other" (e.g. a half-written table).
 * `expectedPort` is the running proxy port used to validate a proxy base_url.
 */
function codexTableMode(table: unknown, expectedPort: number): AgentProviderMode {
  if (!isRecord(table)) return "other";
  if (table.base_url === DIRECT_BASE_URL) return "direct";
  const baseUrl = typeof table.base_url === "string" ? table.base_url : null;
  if (baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort)) return "proxy";
  return "other";
}

// The managed direct (GitHub Copilot) provider table. The bearer is fetched via
// `auth.command` -> `agent auth --get [--profile <name>]` (provider-driven: gh-cli ->
// `gh auth token`, copilot/gh-token -> the stored token), so the token is never baked into
// the config. Codex re-runs the command on `refresh_interval_ms`, so it always tracks the
// current credential. Re-applied on every direct-mode run (managed keys win; any
// user-added key in the same table is preserved by the merge).
function managedDirectProvider(
  codexExecVersion?: string | null,
  profile: Profile = null,
  directIntegrationId?: string | null,
) {
  const { command, args } = agentLauncherCommand(agentAuthGetArgs(profile));
  // The client-identity headers, via the shared builder the probe validates
  // (integration_identity.ts): most credentials carry no integration id (the Codex
  // UA suffices; the builder omits it when null, keeping the default byte-identical),
  // but a fine-grained PAT is only accepted under `copilot-developer-cli`.
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
      // Generous vs the old `gh` path (5s): the launcher may cold-start deno, and a
      // due (at most daily) model-catalog refresh runs after the token prints
      // (AUTH_REFRESH_WORST_CASE_MS, src/codex/catalog.ts). Warm calls take well
      // under a second; Codex refreshes lazily.
      "timeout_ms": DIRECT_AUTH_TIMEOUT_MS,
      "refresh_interval_ms": 300000,
    },
  };
}

// The single source of truth for our managed `[model_providers.copilot-env]`
// table. Re-applied on every run (managed keys win; any user-added key in the
// same table is preserved by the merge). The return type is inferred (precise
// string/boolean fields) -- only the parsed user config below is `unknown`,
// because that TOML shape is arbitrary and we don't control it.
//
// `auth.command` runs the resolver subcommand, `agent proxy-token --yes [--profile <name>]`
// (via `proxyTokenCommand`): it ensures the proxy is up (auto-starting it when the managed
// lifecycle is on, the `auto-start` config key) and then prints the proxy key. `--yes` is the
// headless path (never prompt). Codex forbids `auth` together with `env_key` on one
// provider, so proxy (like direct) resolves its key via the command, not an env var.
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
      // readiness wait (up to a ~120s ceiling), THEN model-alias sync + version logging
      // before the key is printed. Give the first auth attempt headroom past all of that, so
      // it does not time out after the proxy is ready but before `auth --print-proxy-token`.
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

// Every key either managed provider table sets, plus `env_key`: Codex rejects
// `auth` + `env_key` on one provider, so a managed table must never carry one
// (whoever put it there). Derived from the factories so a new mode-specific
// managed key can never reintroduce cross-mode bleed on the shared table. (The
// proxy baseUrl argument is only embedded in the returned object, never
// validated or fetched, so any placeholder string is safe; only Object.keys is
// used.)
const MANAGED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(managedDirectProvider(null)),
  ...Object.keys(managedProxyProvider("http://managed-keys.invalid")),
  "env_key",
]);

/** True iff `auth` is OUR managed auth block: its command+args match `expected`. */
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

/** True iff `auth` is OUR managed direct auth block for `profile` (`agent auth --get`,
 *  with `--profile <name>` for a named profile -- what managedDirectProvider writes). */
function isManagedDirectAuth(auth: unknown, profile: Profile = null): boolean {
  return authMatches(auth, agentLauncherCommand(agentAuthGetArgs(profile)));
}

/** True iff `auth` is OUR managed proxy auth block for `profile`: the resolver
 *  subcommand (`agent proxy-token --yes`, addressed at the profile -- what
 *  managedProxyProvider writes). */
function isManagedProxyAuth(auth: unknown, profile: Profile = null): boolean {
  return authMatches(auth, proxyTokenCommand(profile));
}

// === wiring inspection (inverse of the write contract above) ===
//
// The read-only counterpart to configureCodexConfig: given a CODEX_HOME's raw
// config.toml/.env content, report whether Codex is direct, proxy-backed, or
// custom. It lives HERE, next to the managed provider tables, so `agent health`
// and `agent codex` reuse the same contract instead of shell/TOML copies.

/** Why a Codex "other" classification is not ours -- minted together with
 *  providerMode by inspectCodexWiring (mirrors ClaudeOtherReason):
 *    - "malformed":  config.toml is present but not valid TOML
 *    - "read-error": config.toml exists but could not be read
 *    - "custom":     a foreign `model_provider` is selected */
export type CodexOtherReason = "malformed" | "custom" | "read-error";

/** The `.env`/environment half of the Codex wiring facts, independent of how
 *  config.toml classifies (they are read from different files). */
interface CodexTokenFacts {
  /** A `.env` file exists at the home. */
  envFilePresent: boolean;
  /** `.env` defines the OPENAI_API_KEY token. Always false for a named profile
   *  (its provider never reads an env var; managed auth.command only). */
  envKeyInDotenv: boolean;
  /** OPENAI_API_KEY is exported in the running process environment. Always false
   *  for a named profile (same reason as envKeyInDotenv). */
  envKeyInEnviron: boolean;
  /** The token is resolvable from .env OR the environment. Always false for a
   *  named profile. */
  tokenAvailable: boolean;
}

/**
 * The read-only counterpart to configureCodexConfig, discriminated on
 * providerMode so a flag combination the classifier can never mint (a wired
 * "none", a direct table without the Direct base URL, a direct-auth verdict
 * outside direct mode) is unrepresentable rather than re-checked downstream.
 * Field meanings:
 *   - modelProvider: the inspected selection's `model_provider`, for messaging
 *     (the top-level key for the default, the `[profiles.<name>]` selector's
 *     value for a named profile). Ours on the managed arms; the foreign value
 *     (or null when unknowable: malformed/read-error) on "other"; null on "none".
 *   - envKeyMatches: the key-resolution half is compatible -- the managed proxy
 *     auth.command. Direct carries no env_key contract, so only a named table's
 *     forbidden env_key (drift the writer never emits; Codex rejects `auth` +
 *     `env_key`) can make it false there.
 *   - providerWired: provider selected + base_url matches + key resolution
 *     satisfied -- and for a named profile the auth block must be the managed
 *     one addressed at THAT profile (named profiles hard-fail, never fall back).
 *   - directUsesToken (direct only): the direct provider carries the managed
 *     `auth.command` (resolves the bearer via `agent auth --get`). Whether a
 *     `gh` login is needed is a STORE question the health probe answers.
 */
export type CodexWiringStatus =
  & CodexTokenFacts
  & (
    | {
      providerMode: "direct";
      configExists: true;
      modelProvider: string;
      providerSelected: true;
      /** Direct classification requires the exact Direct base URL, so both facts
       *  are pinned at the type. */
      baseUrl: typeof DIRECT_BASE_URL;
      baseUrlMatches: true;
      envKeyMatches: boolean;
      providerWired: boolean;
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

/**
 * True when `baseUrl` matches the managed proxy contract: an http localhost
 * URL on `expectedPort` whose path is `/v1` (what configureCodexConfig writes via
 * openaiBaseUrl; the shared grammar lives in port.ts next to the writers). A bare
 * host, https, or a non-/v1 path is NOT a match.
 */
function baseUrlMatchesProxy(baseUrl: string, expectedPort: number): boolean {
  return matchesProxyOrigin(baseUrl, expectedPort, "/v1");
}

/**
 * Inspect the raw config.toml read + .env content against the managed contracts
 * for `profile` (null = the default selection, mirroring inspectClaudeWiring).
 * Pure (no I/O): callers pass the config as a TextReadResult (readTextResult
 * keeps absent and unreadable apart; a plain string means text, null means
 * absent, for callers reading through a string-or-null seam), the .env text
 * (null = absent), and whether OPENAI_API_KEY is set in the running environment
 * (reported as facts; the managed auth.command wiring needs neither). `expectedPort`
 * is the port the inspected
 * selection's proxy base URL must carry -- the profile's own reserved port for
 * a named profile.
 *
 * An UNREADABLE config classifies as other/read-error, never as "none": it
 * exists but is unknown, and "none" would authorize a best-effort caller to
 * write over a config it could not read. A present-but-unparseable one is
 * other/malformed for the same reason (the writer separately refuses to
 * overwrite it).
 *
 * A NAMED profile is selected via Codex's native `[profiles.<name>]` table
 * pointing at `[model_providers.copilot-env-<name>]` (exactly what
 * configureCodexConfig writes); the top-level default selection plays no part.
 * Named wiring resolves its key via the managed auth.command alone -- the
 * writer never emits an env_key for one -- so the OPENAI_API_KEY facts
 * (envKeyInDotenv/envKeyInEnviron/tokenAvailable) read false for a named
 * profile.
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
  // The selection fact mirrors what Codex itself reads: the top-level
  // `model_provider` for the default, the `[profiles.<name>]` table's
  // `model_provider` for a named profile (`codex --profile <name>`).
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

  // We select our provider (per profile) by name, but read the MODE from its
  // table's contents -- the unified table doesn't encode mode in its name.
  const providers = isRecord(doc) ? doc.model_providers : undefined;
  const table = isRecord(providers) ? providers[providerId] : undefined;
  const tableMode = codexTableMode(table, expectedPort);
  const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
  // A named profile's table must carry NO env_key at all: the writer strips it
  // (MANAGED_PROVIDER_KEYS) and Codex rejects `auth` + `env_key` on one provider,
  // so a present env_key is drift the writer would never produce.
  const namedTableCarriesEnvKey = profile !== null && isRecord(table) &&
    table.env_key !== undefined;

  if (tableMode === "direct") {
    const envKeyMatches = !namedTableCarriesEnvKey;
    // Direct mode resolves its bearer via the managed `auth.command` (agent auth
    // --get, with --profile for a named profile). Positively identify OUR launcher
    // (command + args), not just any auth.command -- a stale `gh auth token` block
    // must NOT read as managed.
    const directUsesToken = isRecord(table) && isManagedDirectAuth(table.auth, profile);
    return {
      ...tokenFacts,
      providerMode: "direct",
      configExists: true,
      modelProvider,
      providerSelected: true,
      // tableMode "direct" means table.base_url IS the Direct base URL.
      baseUrl: DIRECT_BASE_URL,
      baseUrlMatches: true,
      envKeyMatches,
      // The default direct selection needs no further conjunct (the health probe
      // layers the store question on top); a named direct profile requires the
      // profile-addressed managed auth -- default-addressed or foreign auth would
      // resolve the wrong credential, so it must not read as wired.
      providerWired: envKeyMatches && (profile === null || directUsesToken),
      directUsesToken,
      otherReason: null,
    };
  }
  // Proxy -- including a selected-but-unrecognized table shape (tableMode
  // "other"): it still counts as one of ours for messaging, reported as proxy so
  // the wiring facts below flag what's off. Proxy mode resolves its key (and
  // auto-starts the proxy) via the managed `auth.command` (the proxy-token
  // resolver, addressed at the profile), so it needs no `env_key`.
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

// Seeded ONLY when no config.toml exists yet: select the requested provider and
// disable telemetry. Provider TABLES are injected by the merge functions, and the
// writer force-writes the managed top-level keys (web_search) right after loading,
// so both are intentionally absent here -- no duplication, no drift.
function defaultConfig(): Record<string, unknown> {
  return {
    "model_provider": CODEX_PROVIDER_ID,
    "analytics": { "enabled": false },
    "feedback": { "enabled": false },
  };
}

// Load the existing config at `hostConfig`, or seed the default template when it is absent
// or empty. A present-but-UNPARSEABLE file throws rather than letting the caller clobber a
// config it could not read -- a hand-edit typo must never cost the user their whole
// config.toml (mcp_servers, custom providers, model pins). Mirrors the Claude side's
// loadSettings refuse-to-overwrite contract. (Other read errors -- EISDIR, permission --
// propagate raw from readCodexToml: fail loudly, don't overwrite blindly.)
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

/** Removal-path read shared by removeCodexProfile/removeCodexDefaultWiring: absent ->
 *  null (nothing to remove), while a file that exists but cannot be read or parsed
 *  throws -- these paths delete keys and write back, so they must never blind-write
 *  over a config they could not fully read. */
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

/** Parse step for the proxy variant: reject an empty or malformed base URL before
 *  anything is written, returning the validated variant the provider factory consumes. */
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
 * Write the managed `config.toml` at `codexHome` for the given (already-resolved)
 * write request (mode + its mode-dependent fields). Neither mode bakes a credential --
 * both resolve it at fetch time via `auth.command`.
 *
 * DEFAULT profile: selects `copilot-env` via the top-level `model_provider` and owns the
 * top-level managed keys (web_search, catalog reference). NAMED profile
 * (`request.profile`): writes ONLY `[model_providers.copilot-env-<name>]` plus the native
 * `[profiles.<name>]` selector -- the top-level default selection is never touched, so
 * `codex --profile <name>` and plain `codex` coexist. Throws when the write cannot
 * proceed (unusable proxy options, an uncreatable config directory, an unparseable
 * existing config). Exported for unit testing.
 */
export function configureCodexConfig(
  codexHome: string | null | undefined,
  request: CodexWriteRequest,
  catalogDeps: CodexCatalogDeps = {},
): void {
  codexHome = codexHome || defaultCodexHome();
  const profile = request.profile ?? null;
  const providerId = codexProviderId(profile);
  // Parse the proxy variant up front (the union already guarantees a base URL exists;
  // this rejects an empty/malformed one) so nothing below sees an unvalidated URL.
  const modeRequest: CodexModeRequest = request.mode === "proxy"
    ? validateProxyOptions(request)
    : request;

  try {
    mkdirReported(codexHome);
  } catch (e) {
    throw new Error(`could not create Codex config directory ${codexHome}: ${errMessage(e)}`);
  }

  const hostConfig = codexConfigPath(codexHome);

  // "Had content" (not just "existed"): loadOrCreateConfig also seeds the default
  // template for an EMPTY/whitespace file, and the template's `model_provider` must not
  // survive a named-profile write that never creates the unsuffixed table.
  const configHadContent = (() => {
    try {
      return fs.readFileSync(hostConfig, "utf8").trim() !== "";
    } catch {
      return false;
    }
  })();
  const doc = loadOrCreateConfig(hostConfig);

  // Enforce our managed contract on every run: select the requested provider
  // as the default and (re)write EVERY managed field on its table --
  // overwriting a stale value and filling any managed key
  // the file lacks. Spreading `existing` first preserves user-added keys in the
  // same table; other providers, the [analytics]/[feedback] sections, and any
  // unknown top-level keys are left untouched. The top-level managed keys are the
  // DEFAULT selection's alone -- a named-profile write leaves them be.
  if (profile === null) {
    doc.model_provider = CODEX_PROVIDER_ID;
    doc.web_search = "live";
  } else if (!configHadContent) {
    // A named-profile write that had to seed a fresh config must not leave the
    // template's default `model_provider` pointing at a `copilot-env` table this
    // write never creates -- an unknown provider reference is a Codex startup error.
    delete doc.model_provider;
  }
  if (request.mode === "proxy") {
    // The proxy listens on loopback (127.0.0.1). Codex's native sandbox blocks loopback +
    // outbound for its sandboxed subprocesses (including the auth.command) in "offline" mode, so
    // the proxy-token resolver's liveness probe is refused and auth fails with exit 1. Enabling
    // workspace-write network access is the documented toggle that stops those offline block
    // rules (verified: it removes the codex_sandbox_offline_block_loopback firewall rule). This
    // is a global sandbox key, not provider-scoped, so it also lets the model's sandboxed shell
    // commands reach the network -- codex has no finer-grained per-command exemption. Direct mode
    // needs no loopback, so it leaves this key untouched. Merge-preserve other keys in the table.
    const sandboxWrite = isRecord(doc.sandbox_workspace_write) ? doc.sandbox_workspace_write : {};
    sandboxWrite.network_access = true;
    doc.sandbox_workspace_write = sandboxWrite;
  }

  // `model_catalog_json` REPLACES Codex's bundled catalog, and a missing, empty,
  // unparseable, or schema-rejected file is a Codex STARTUP error: reference the
  // generated catalog only when opted in, usable, and not rejected by the
  // installed codex (re-judged on every write, so `agent codex` recovers from a
  // codex upgrade); otherwise scrub the key -- disabled means "no catalog key",
  // even over a user-pinned path. Account-wide: only the DEFAULT write owns it.
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
  // Both modes share ONE table per profile: strip every managed key from the
  // existing table BEFORE spreading, so toggling modes can never bleed the
  // OTHER mode's keys. User-added keys survive; managed keys are re-derived
  // from the factories each run.
  const userKeys = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !MANAGED_PROVIDER_KEYS.has(key)),
  );
  providers[providerId] = {
    ...userKeys,
    ...managedProviderForMode(modeRequest, request.codexExecVersion, profile),
  };
  doc.model_providers = providers;

  if (profile !== null) {
    // The native profile selector: `codex --profile <name>` flips ONLY the provider;
    // user keys in the same [profiles.<name>] table (model pins etc.) survive.
    const profilesTable = isRecord(doc.profiles) ? doc.profiles : {};
    const existingProfile = isRecord(profilesTable[profile]) ? profilesTable[profile] : {};
    profilesTable[profile] = { ...existingProfile, "model_provider": providerId };
    doc.profiles = profilesTable;
  }

  const knownHome = knownCodexHomes().homes.includes(codexHome);
  // The write's own line carries what the write means (which config, and a changed
  // catalog reference); it lands before the fallible ledger bookkeeping. Every
  // profile shares this one file and the seam names a path once per process, so the
  // detail says nothing profile-specific (`agent profile` prints the launch hint).
  saveCodexToml(hostConfig, doc, ["Codex config", catalogRefLine].filter(Boolean).join("; "));
  // Ownership lands only AFTER the successful save (the ledger's crash-direction
  // contract), and only for a KNOWN Codex home -- the set the cleanup sweep
  // visits -- so detectCodexDirect's throwaway probe home never enters the
  // ledger (the Claude pair's real-home gate, in Codex's many-homes shape).
  // Recording on every enabled write also ADOPTS a pre-ledger install's
  // reference the next time it rewires; the cleared branch drops any claim on
  // this config, ours or stale.
  if (catalogRef !== null && knownHome) {
    if (catalogRef === "written") new OwnershipLedger().record("codexCatalog", hostConfig);
    else new OwnershipLedger().release("codexCatalog", hostConfig);
  }
}

/**
 * Turn a shared ManagedWrite into the Codex write at `codexHome` for `profile`
 * (null = the default selection); throws with the cause when the write cannot
 * proceed. The caller persists CODEX_HOME to state, and -- for direct -- has
 * already resolved the client identity carried in the write (this function never
 * probes). The codexAdapter's default-selection write.
 */
export async function applyCodexConfig(
  codexHome: string,
  write: ManagedWrite,
  catalogDeps?: CodexCatalogDeps,
  profile: Profile = null,
): Promise<void> {
  // The proxy key is resolved at request time by the `auth.command` (the shared
  // proxy-token resolver), so proxy only needs the local base URL -- reserving the
  // addressed profile's stable port via wiringPortFor (this is a write path;
  // read-only checks peek without recording).
  const request: CodexWriteRequest = write.mode === "proxy"
    ? { mode: "proxy", profile, baseUrl: openaiBaseUrl(wiringPortFor(profile)) }
    : { ...write, profile };

  // Seed the patched model catalog (best-effort, unthrottled) BEFORE the config
  // write, so the very first wiring can already reference the file. The auth-time
  // refresh (src/commands/auth.ts) keeps it fresh afterwards. Account-wide, keyed
  // to the default credential -- named-profile writes never touch it.
  if (profile === null) await generateCodexModelCatalog(write.mode, catalogDeps);

  configureCodexConfig(codexHome, request, catalogDeps);

  // When the catalog is disabled the write above only stripped the key in THIS
  // home; the sync also deletes the generated file and clears the throttle
  // state, so a wiring pass finishes the opt-out immediately.
  if (profile === null) syncCodexCatalogReference(catalogDeps);
}

/**
 * The direct-mode `Copilot-Integration-Id` for `profile`'s credential: the
 * `integration-id` config pin, else a live probe (integration_identity.ts). Both
 * agents bake the result identically (Claude via ANTHROPIC_CUSTOM_HEADERS, Codex via
 * http_headers). `token` skips a redundant credential resolve when the caller already
 * has one. Throws when the credential is rejected under every known identity.
 */
export function probeDirectIntegrationId(
  profile: Profile = null,
  token?: string | null,
): Promise<string | null> {
  const resolved = token !== undefined ? token : new Credential(undefined, profile).resolve();
  return resolveDirectIntegrationId(resolved, codexUserAgent(), {
    pinned: new CopilotEnvConfig().pinnedIntegrationId(),
  });
}

/** The `--check` reading of a Codex "other" classification, keyed off the
 *  reason the classifier minted. */
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

/** Takes the status whole (not mode + reason separately) so an impossible pair
 *  can never be rendered. */
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

// Copilot Direct's answer to Codex's `service_tier`: `default` and `flex` are accepted,
// `priority` (Codex's fast-mode default) is rejected ("service_tier is not supported").
const COPILOT_ACCEPTED_SERVICE_TIERS: ReadonlySet<string> = new Set(["default", "flex"]);
const COPILOT_REJECTED_SERVICE_TIER = "priority";

/** The `--check` reading of a Direct config's `service_tier` line. The line is the
 *  user's knob and is never rewritten; with the opt-in catalog on, its stripped tier
 *  advertisements make Codex send no tier at all, whatever the line says. */
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

/**
 * Remove the managed artifacts of a NAMED profile from `codexHome`'s config.toml:
 * the `[model_providers.copilot-env-<name>]` table (ours by name) and the
 * `[profiles.<name>]` selector -- the latter only when it still points at our
 * provider id (a user-repointed selector is no longer ours to delete). No-op when
 * the config is absent; a present-but-unparseable file throws (never blind-write).
 * Used by `agent profile --del`.
 */
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
 * Remove the DEFAULT selection's managed artifacts from `codexHome`'s config.toml:
 * the `[model_providers.copilot-env]` table (ours by name), the top-level
 * `model_provider` selector (only while it still points at our id -- a
 * user-repointed selector is no longer ours to delete), the managed
 * `model_catalog_json` reference (only when it denotes the account-wide generated
 * catalog file, which the caller is about to delete -- a dangling reference is a
 * Codex startup error), and `web_search` (only the managed `"live"` value, and only
 * when the selector was still ours). No-op when the config is absent; a
 * present-but-unparseable file throws (never blind-write). Used by `agent uninstall`.
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
      // "yes" only: an UNKNOWN resolve is not proof the key is ours, and this
      // function's rule is to touch a key only when it denotes OUR file. Stripping
      // on doubt would silently delete a user-owned key; leaving it risks a dangling
      // reference only in the case where it WAS ours -- and that failure is loud and
      // fixable, where the other is silent data loss. Same direction as the cleanup
      // sweep above, which also refuses to act on "unknown".
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
    // Post-save (never claim-drop before the artifact write actually landed).
    if (catalogWasReferenced) new OwnershipLedger().release("codexCatalog", configPath);
  }
}

/**
 * Live auto-detect: does GitHub Copilot Direct work for Codex on this machine?
 * Writes a throwaway direct config and runs `codex exec --sandbox read-only`
 * against it (see src/agents/live_probe.ts). False => the caller writes proxy.
 */
export function detectCodexDirect(deps?: DirectProbeDeps): boolean {
  return probeDirectWorks(
    CODEX_PROBE,
    (tmpHome) => {
      configureCodexConfig(tmpHome, { mode: "direct", quiet: true });
    },
    deps,
  );
}

/**
 * The Codex AgentAdapter: the shared command skeleton's view of this file's
 * writers (see src/agents/configure.ts). `catalogDeps` is threaded through for
 * runCodex's test seam only; `agent profile` builds the adapter without it.
 */
export function codexAdapter(catalogDeps?: CodexCatalogDeps): AgentAdapter {
  return {
    id: "codex",
    label: "Codex",
    check: checkCodexConfig,
    detectDirect: detectCodexDirect,
    resolveDirectIdentity: (ghToken) => probeDirectIntegrationId(null, ghToken),
    async configureDefault(write, ghToken) {
      // Reuse the already-resolved credential for the catalog seed's direct fetch,
      // so the gh-cli provider isn't shelled out to a second time.
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

/**
 * `agent codex`: configure Codex at the effective CODEX_HOME (effectiveCodexHome),
 * after deriving the per-host farm from the `codex-host` key. The parsed
 * action union carries the intent whole: a `check` action reports the configured
 * mode (exit 0 direct / 2 proxy|none / 1 other) plus any farm drift without a
 * probe, and a `configure` action carries the requested mode (`--direct`/`--proxy`
 * forced, "auto" = live read-only probe, else the proxy).
 *
 * A GitHub token provisioned via `agent auth` (in the shared store) is used as the
 * Direct credential automatically; on "auto", its presence selects Direct
 * without probing. (Named profiles are managed by `agent profile`, not here.)
 * The body is the shared skeleton (runAgentConfig) over codexAdapter.
 */
export async function runCodex(
  action: AgentRunAction,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  return runAgentConfig(codexAdapter(catalogDeps), action);
}
