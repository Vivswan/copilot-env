// The Codex wiring inspector: the inverse of the config.toml write contract in src/codex/config.ts,
// so `agent health`, `agent profile check --codex`, and the mode decision (src/agents/wiring.ts)
// share one classification instead of shell/TOML copies. The writer imports the constants it shares
// with the reader from here.
import { parse } from "smol-toml";
import { type AgentProviderMode, MANAGED_MODE_DETAIL } from "../agents/provider_mode.ts";
import { DEFAULT_COPILOT_API_BASE, isDirectBaseUrl } from "../copilot_api/integration_identity.ts";
import { matchesProxyOrigin } from "../copilot_api/port.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import type { TextReadResult } from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenCommand } from "../utils/root.ts";
import { codexProviderId } from "./paths.ts";

// OPENAI_API_KEY is the same OpenAI-wire name `env.ts` exports; the inspector reports whether the
// user's `.env` or environment carries it as a fact about the home (no managed wiring needs it).
export const CODEX_ENV_KEY = "OPENAI_API_KEY";

/** The header a static write carries; Codex sends `http_headers` verbatim, so the value is the
 *  full `Bearer <token>` (the one header name Codex would otherwise fill from `auth`/`env_key`). */
export const AUTHORIZATION_HEADER = "Authorization";
const STATIC_AUTHORIZATION_SHAPE = /^Bearer \S+$/;

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
type CodexManagedCredential = "command" | "static" | "none";

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

/** Minted with providerMode by inspectCodexWiring (mirrors ClaudeOtherReason). The profile-
 *  prefixed pair names `<name>.config.toml`, so a named repair points at the right file.
 *    "malformed"           -> config.toml is present but not valid TOML
 *    "read-error"          -> config.toml exists but could not be read
 *    "profile-malformed"   -> `<name>.config.toml` is present but not valid TOML
 *    "profile-read-error"  -> `<name>.config.toml` exists but could not be read
 *    "custom"              -> a foreign `model_provider` is selected */
export type CodexOtherReason =
  | "malformed"
  | "read-error"
  | "profile-malformed"
  | "profile-read-error"
  | "custom";

/** What selects the inspected wiring: config.toml's top-level key for the default, and for a
 *  named profile the top-level key of its `<name>.config.toml`, read alongside config.toml. A
 *  named inspection without its profile read is unrepresentable. */
type CodexSelectionRead =
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
    case "custom":
      return "custom or unsupported provider";
    default:
      return assertNever(otherReason);
  }
}

/** Takes the status whole (not mode + reason separately) so an impossible pair can never render. */
export function providerModeDetail(status: CodexWiringStatus): string {
  switch (status.providerMode) {
    case "proxy":
    case "direct":
      return MANAGED_MODE_DETAIL[status.providerMode];
    case "none":
      return status.configExists ? "no model_provider configured" : "no config.toml found";
    case "other":
      return codexOtherDetail(status.otherReason);
    default:
      return assertNever(status);
  }
}
