// Codex config writer: points Codex at GitHub Copilot directly by default, with
// the local copilot-api proxy available as an explicit proxy mode. Direct mode
// fetches its bearer at runtime via an `auth.command` that runs `agent auth --get`
// (provider-driven: gh-cli -> gh, copilot/gh-token -> the stored token) -- nothing is baked
// into the config or `.env`.
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse, stringify } from "smol-toml";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import {
  CODEX_EXEC_USER_AGENT,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  resolveDirectIntegrationId,
} from "../copilot_api/integration_identity.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import {
  copilotApiResolvePort,
  matchesProxyOrigin,
  openaiBaseUrl,
  wiringPortFor,
} from "../copilot_api/port.ts";
import { type Profile, type ProfileName, profileLabel } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { assertNever } from "../utils/assert.ts";
import {
  CODEX_PROBE,
  type DirectProbeDeps,
  probeDirectWorks,
  resolveDirectMode,
} from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent, isEnoentOrNotdir } from "../utils/fs.ts";
import { codexFarmHostsDir } from "../utils/hostname.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  type AgentProviderMode,
  type ManagedAgentMode,
  providerModeExitCode,
  type RequestedMode,
} from "../utils/provider_mode.ts";
import {
  AGENT_AUTH_GET_ARGS,
  agentAuthGetArgs,
  agentLauncherCommand,
  proxyTokenCommand,
} from "../utils/root.ts";
import {
  type CodexCatalogDeps,
  codexUserAgentVersion,
  generateCodexModelCatalog,
  isCatalogFileUsable,
} from "./catalog.ts";
import { codexConfigPath, defaultCodexHome } from "./paths.ts";

const logger = createStderrLogger();

// The Codex model-provider id we manage: ONE provider, `copilot-env`, for BOTH
// direct and proxy -- the mode is read from the table's CONTENTS (base_url + an
// `auth` block vs an `env_key`), not from the provider name. OPENAI_API_KEY is the
// same OpenAI-wire name `env.ts` already exports, so the single proxy token has ONE
// name across the shell exports and the Codex `.env`. (The pre-unification
// `github-copilot-direct` provider is handled ONLY by the 3.3.3 migration, which
// rewrites existing configs to `copilot-env`; nothing here knows that legacy name.)
export const CODEX_PROVIDER_ID = "copilot-env";
export const CODEX_ENV_KEY = "OPENAI_API_KEY";
// Direct mode's base_url: the same individual-plan host the identity probe hits
// (integration_identity.ts owns the literal -- the probe's verdict must be
// rendered against the host the agents actually bake).
const DIRECT_BASE_URL = DEFAULT_COPILOT_API_BASE;

/** The managed provider id for `profile`: the unsuffixed `copilot-env` contract for the
 *  default, `copilot-env-<name>` for a named profile. A named profile is selected via
 *  Codex's NATIVE `[profiles.<name>]` table (`codex --profile <name>`), whose
 *  `model_provider` points here -- the top-level default selection is never touched. */
export function codexProviderId(profile: Profile = null): string {
  return profile === null ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${profile}`;
}
// Legacy: an older copilot-env baked the Direct bearer into this .env key. Direct
// mode no longer bakes a token (it resolves at runtime via `agent auth --get`), so
// this name now exists ONLY so configureCodexConfig can scrub a token left at rest
// by an older release. Deliberately NOT a standard name like GITHUB_TOKEN/GH_TOKEN:
// those are read by gh/git, so a leftover under a standard name could
// re-authenticate tool subprocesses as the token's account.
export const DIRECT_ENV_KEY = "COPILOT_ENV_GH_TOKEN";

export interface CodexConfigArgs {
  check?: boolean;
  /** `--direct`/`--proxy`, parsed once at the CLI boundary (auto = neither). */
  mode: RequestedMode;
}

/** The mode-dependent half of a Codex config write: direct carries the (optional)
 *  probed client-identity header, proxy ALWAYS carries a base URL -- a proxy write
 *  without one is unrepresentable, so nothing downstream re-checks for it. */
type CodexModeRequest =
  | {
      mode: "direct";
      /** Direct mode: the probed `Copilot-Integration-Id` to bake, or null to send none. */
      directIntegrationId?: string | null;
    }
  | { mode: "proxy"; baseUrl: string };

/** The mode-independent knobs of a Codex config write. */
interface CodexWriteCommon {
  codexExecVersion?: string | null;
  /** Suppress the "config written" info line (used by the temp-config probe). */
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
// added key (e.g. the env_key) propagates even into a pre-existing config.

// The single source of truth for our managed direct Copilot provider table.
// Re-applied on every direct-mode run (managed keys win; any user-added key in
// the same table is preserved by the merge).
export function codexUserAgent(version: string | null = codexUserAgentVersion()): string {
  return version ? `${CODEX_EXEC_USER_AGENT}/${version}` : CODEX_EXEC_USER_AGENT;
}

/**
 * Derive the mode from our managed provider TABLE's contents (the unified `copilot-env`
 * table doesn't encode mode in its name): a Direct base_url -> direct, a localhost proxy
 * base_url or our `env_key` -> proxy, anything else -> "other" (e.g. a half-written
 * table). `expectedPort` is the running proxy port used to validate a proxy base_url.
 */
function codexTableMode(table: unknown, expectedPort: number): AgentProviderMode {
  if (!isRecord(table)) return "other";
  if (table.base_url === DIRECT_BASE_URL) return "direct";
  const baseUrl = typeof table.base_url === "string" ? table.base_url : null;
  if (
    (baseUrl !== null && baseUrlMatchesProxy(baseUrl, expectedPort)) ||
    table.env_key === CODEX_ENV_KEY
  ) {
    return "proxy";
  }
  return "other";
}

function isManagedProviderMode(mode: AgentProviderMode): mode is ManagedAgentMode {
  return mode === "direct" || mode === "proxy";
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
      // Generous vs the old `gh` path (5s): the launcher may cold-start bun, and a
      // due (at most daily) model-catalog refresh adds a bounded /models fetch (5s)
      // plus a `codex debug models --bundled` dump (8s) after the token prints.
      // The common warm case returns in well under a second; Codex refreshes lazily.
      "timeout_ms": 30000,
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
// `auth.command` runs the shared `src/scripts/proxy-token.sh --yes` (`.ps1` on Windows, via
// `proxyTokenCommand`): it ensures the proxy is up (auto-starting it when the managed
// lifecycle is on, the `auto-start` config key) and then prints the proxy key. `--yes` is the
// headless path (never prompt). Codex forbids `auth` together with `env_key` on one
// provider, so proxy (like direct) resolves its key via the command, not an env var.
function managedProxyProvider(baseUrl: string, profile: Profile = null) {
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
      // Cold-starting the proxy runs a full child `agent start`: bun startup, the daemon's
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
  if (request.mode === "direct")
    return managedDirectProvider(codexExecVersion, profile, request.directIntegrationId);
  return managedProxyProvider(request.baseUrl, profile);
}

// Every key either managed provider table sets, plus the legacy `env_key`
// (Codex forbids `auth` + `env_key` on one provider; older releases wrote it
// and codexTableMode still reads it for back-compat). Derived from the
// factories so a new mode-specific managed key can never reintroduce
// cross-mode bleed on the shared table; a RETIRED managed key must be kept
// here explicitly (like `env_key`) or old configs retain it as a user key.
// (The proxy baseUrl argument is only embedded in the returned object, never
// validated or fetched, so any placeholder string is safe; only Object.keys
// is used.)
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

/** True iff `auth` is OUR managed direct auth block (`agent auth --get`). */
function isManagedDirectAuth(auth: unknown): boolean {
  return authMatches(auth, agentLauncherCommand(AGENT_AUTH_GET_ARGS));
}

/** True iff `auth` is OUR managed proxy auth block (runs the shared proxy-token script). */
function isManagedProxyAuth(auth: unknown): boolean {
  return authMatches(auth, proxyTokenCommand());
}

// === wiring inspection (inverse of the write contract above) ===
//
// The read-only counterpart to configureCodexConfig: given a CODEX_HOME's raw
// config.toml/.env content, report whether Codex is direct, proxy-backed, or
// custom. It lives HERE, next to the managed provider tables, so `agent health`
// and `agent codex` reuse the same contract instead of shell/TOML copies.

export interface CodexWiringStatus {
  /** A config.toml exists at the home (false => the user never wired Codex). */
  configExists: boolean;
  /** Whatever `model_provider` is set to, for messaging. */
  modelProvider: string | null;
  /** Which provider family the current config selects. */
  providerMode: AgentProviderMode;
  /** `model_provider` selects one of our managed providers. */
  providerSelected: boolean;
  /** The managed provider table's `base_url`, if present. */
  baseUrl: string | null;
  /** `base_url` matches the selected provider contract. */
  baseUrlMatches: boolean;
  /** The managed provider table's `env_key` is OPENAI_API_KEY. */
  envKeyMatches: boolean;
  /** All of: provider selected, base_url matches, env_key matches. */
  providerWired: boolean;
  /** A `.env` file exists at the home. */
  envFilePresent: boolean;
  /** `.env` defines the OPENAI_API_KEY token. */
  envKeyInDotenv: boolean;
  /** OPENAI_API_KEY is exported in the running process environment. */
  envKeyInEnviron: boolean;
  /** The token is resolvable from .env OR the environment (Codex needs one). */
  tokenAvailable: boolean;
  /**
   * Direct mode only: true when the direct provider carries a managed
   * `auth.command` (it resolves the bearer via `agent auth --get`). Always false
   * outside direct mode. Whether a `gh` login is needed is a STORE question, not a
   * config one -- the health probe decides that separately.
   */
  directUsesToken: boolean;
}

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
 * Inspect raw config.toml + .env content against the managed contracts. Pure
 * (no I/O): callers read the files and pass the strings (null = absent file),
 * plus whether OPENAI_API_KEY is set in the running environment (proxy mode
 * needs a token; direct mode uses its auth command).
 */
export function inspectCodexWiring(
  configToml: string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
): CodexWiringStatus {
  const envKeyInDotenv =
    envText !== null &&
    new RegExp(`^\\s*(?:export\\s+)?${CODEX_ENV_KEY}\\s*=\\s*\\S`, "m").test(envText);
  const status: CodexWiringStatus = {
    configExists: configToml !== null,
    modelProvider: null,
    providerMode: "none",
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    envFilePresent: envText !== null,
    envKeyInDotenv,
    envKeyInEnviron,
    tokenAvailable: envKeyInDotenv || envKeyInEnviron,
    directUsesToken: false,
  };
  if (configToml === null) return status;
  try {
    const doc = parse(configToml);
    const modelProvider =
      isRecord(doc) && typeof doc.model_provider === "string" ? doc.model_provider : null;
    const providers = isRecord(doc) ? doc.model_providers : undefined;
    // We select our single provider by name, but read the MODE from its table's
    // contents -- the unified `copilot-env` table no longer encodes mode in its name.
    const selected = modelProvider === CODEX_PROVIDER_ID;
    const table = selected && isRecord(providers) ? providers[CODEX_PROVIDER_ID] : undefined;
    const tableMode = selected ? codexTableMode(table, expectedPort) : "other";
    // A selected-but-unrecognized table shape ("other") still counts as one of ours for
    // messaging; report it as proxy so the wiring checks below flag what's off.
    const providerMode: AgentProviderMode = selected
      ? isManagedProviderMode(tableMode)
        ? tableMode
        : "proxy"
      : modelProvider === null
        ? "none"
        : "other";
    const baseUrl = isRecord(table) && typeof table.base_url === "string" ? table.base_url : null;
    status.modelProvider = modelProvider;
    status.providerMode = providerMode;
    status.providerSelected = selected;
    status.baseUrl = baseUrl;
    status.baseUrlMatches =
      baseUrl !== null &&
      (providerMode === "proxy"
        ? baseUrlMatchesProxy(baseUrl, expectedPort)
        : providerMode === "direct" && baseUrl === DIRECT_BASE_URL);
    // Proxy mode resolves its key (and auto-starts the proxy) via the managed
    // `auth.command` (the shared proxy-token script), so it needs no `env_key`. A legacy
    // proxy config still using `env_key` is also accepted (back-compat).
    const proxyUsesManagedAuth =
      providerMode === "proxy" && isRecord(table) && isManagedProxyAuth(table.auth);
    status.envKeyMatches =
      providerMode === "direct" ||
      proxyUsesManagedAuth ||
      (isRecord(table) && table.env_key === CODEX_ENV_KEY);
    // Direct mode resolves its bearer via the managed `auth.command` (agent auth
    // --get). Positively identify OUR launcher (command + args), not just any
    // auth.command -- a stale `gh auth token` block must NOT read as managed. Whether
    // a `gh` login is actually needed depends on the store (a token there means no
    // gh) -- the health probe decides that from the store, not the static config.
    status.directUsesToken =
      providerMode === "direct" && isRecord(table) && isManagedDirectAuth(table.auth);
    status.providerWired =
      status.providerSelected &&
      status.baseUrlMatches &&
      status.envKeyMatches &&
      (providerMode === "direct" || proxyUsesManagedAuth || status.tokenAvailable);
  } catch {
    // Malformed TOML => leave everything but config/.env facts false.
  }
  return status;
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
// loadSettings refuse-to-overwrite contract.
function loadOrCreateConfig(hostConfig: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(hostConfig, "utf8");
  } catch (e) {
    if (isEnoent(e)) return defaultConfig();
    throw e; // EISDIR / permission / etc. -- fail loudly, don't overwrite blindly
  }
  if (text.trim() === "") return defaultConfig();
  try {
    return parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${hostConfig} is not valid TOML; refusing to overwrite it (${errMessage(e)})`);
  }
}

// Remove `key` from `$CODEX_HOME/.env` (any `export`-prefixed or duplicate
// assignment), preserving everything else. No-op when the file is absent or the
// key isn't present, so it never creates or rewrites a file needlessly. Used to
// scrub the baked direct token (COPILOT_ENV_GH_TOKEN) when reverting to gh-direct.
function removeEnvKey(envFile: string, key: string): void {
  let existing: string;
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch (e) {
    if (isEnoent(e)) return; // nothing to scrub
    throw e;
  }
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = existing.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  const kept = lines.filter((line) => !matcher.test(line));
  if (kept.length === lines.length) return; // key absent -- leave the file untouched
  fs.writeFileSync(envFile, kept.length ? `${kept.join("\n")}\n` : "");
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // pass
  }
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
 * write request (mode + its mode-dependent fields), and scrub the legacy baked
 * `COPILOT_ENV_GH_TOKEN` from `.env`. Neither mode bakes a credential -- both resolve
 * it at fetch time via `auth.command`.
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
): void {
  codexHome = codexHome || defaultCodexHome();
  const profile = request.profile ?? null;
  const providerId = codexProviderId(profile);
  // Parse the proxy variant up front (the union already guarantees a base URL exists;
  // this rejects an empty/malformed one) so nothing below sees an unvalidated URL.
  const modeRequest: CodexModeRequest =
    request.mode === "proxy" ? validateProxyOptions(request) : request;

  try {
    fs.mkdirSync(codexHome, { recursive: true });
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
  // overwriting a stale value (e.g. an old env_key) and filling any managed key
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

  // Point Codex at the patched Copilot model catalog (src/codex/catalog.ts) --
  // ONLY when the feature is opted in (`agent config --set codex-model-catalog
  // true`) AND the file is USABLE (exists and parses with at least one model):
  // `model_catalog_json` REPLACES Codex's bundled catalog and a missing, empty,
  // or unparseable file is a Codex STARTUP error, so a bad reference must be
  // scrubbed rather than left behind. A failed refresh keeps a good file
  // (generation never truncates), so a referenced file stays usable. Disabled
  // means an unconditional delete (even of a user-pinned custom path): the
  // full managed write owns this key wholesale, and the managed contract when
  // the feature is off is "no catalog key". (Account-wide, so the DEFAULT
  // selection's write owns it; named-profile writes leave it alone.)
  if (profile === null) {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    if (new CopilotEnvConfig().codexModelCatalogEnabled() && isCatalogFileUsable(catalogFile)) {
      doc.model_catalog_json = catalogFile;
    } else {
      delete doc.model_catalog_json;
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

  fs.writeFileSync(hostConfig, stringify(doc));
  if (!request.quiet) {
    logger.log(
      `  ✓ Codex config written → ${hostConfig}` +
        `${profile === null ? "" : ` (${profileLabel(profile)}; launch with \`codex --profile ${profile}\`)`}`,
    );
  }

  // Scrub only the copilot-env-OWNED legacy key: a `COPILOT_ENV_GH_TOKEN` baked by a
  // still-older direct-token release. We deliberately do NOT scrub OPENAI_API_KEY: its name
  // collides with the standard OpenAI key a Codex user keeps in $CODEX_HOME/.env for their
  // own provider, and a leftover managed value is harmless anyway (the managed provider
  // resolves via `auth.command` and carries no `env_key`). Removing it by name would destroy
  // the user's personal key on every write.
  removeEnvKey(path.join(codexHome, ".env"), DIRECT_ENV_KEY);
}

/**
 * Resolve baseUrl/apiKey from the local proxy and write the Codex config at
 * `codexHome` for `profile` (null = the default selection); throws with the cause
 * when the write cannot proceed. The caller persists CODEX_HOME to state. Shared by
 * `runCodexConfig` and codex_host's `runCodexHost`. Direct mode fetches the bearer
 * at runtime via `agent auth --get`; nothing is baked into the config.
 */
export async function applyCodexConfig(
  codexHome: string,
  mode: ManagedAgentMode,
  catalogDeps?: CodexCatalogDeps,
  profile: Profile = null,
): Promise<void> {
  let request: CodexWriteRequest;

  if (mode === "proxy") {
    // The key is resolved at request time by the `auth.command` (the shared proxy-token
    // script), so we only need the local proxy base URL here -- reserving the addressed
    // profile's stable port via wiringPortFor (this is a write path; read-only checks
    // peek without recording).
    request = { mode, profile, baseUrl: openaiBaseUrl(wiringPortFor(profile)) };
  } else {
    // Direct: bake the client identity this credential is accepted under (probe, or the
    // `integration-id` config pin). Throws with the real reason when nothing works, so a
    // dead direct credential fails the wiring instead of writing a config that 400s.
    request = { mode, profile, directIntegrationId: await probeDirectIntegrationId(profile) };
  }

  // Seed the patched model catalog (best-effort, unthrottled) BEFORE the config
  // write, so the very first wiring can already reference the file. The auth-time
  // refresh (src/commands/auth.ts) keeps it fresh afterwards. Account-wide, keyed
  // to the default credential -- named-profile writes never touch it.
  if (profile === null) await generateCodexModelCatalog(mode, catalogDeps);

  configureCodexConfig(codexHome, request);

  // When the catalog is disabled the write above only stripped the key in THIS
  // home; the sync also deletes the generated file and clears the throttle
  // state, so a wiring pass finishes the opt-out immediately.
  if (profile === null) syncCodexCatalogReference();
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

export function effectiveCodexHome(): string {
  return new CopilotEnvRunState().read().codexHome ?? defaultCodexHome();
}

/**
 * Auth-time sync: keep the managed config's `model_catalog_json` in step with the
 * opt-in `codex-model-catalog` preference. Called on every auth resolution (one
 * cheap TOML read; writes only fire when something is actually out of step).
 * Best-effort: never throws, stderr-only.
 *
 * ENABLED -- self-heal: when a usable catalog exists but the managed config
 * predates it (e.g. the wiring-time seed failed because the proxy was down or no
 * credential existed yet, or the file was generated while mobile pairing had the
 * provider stripped), add the reference in place -- WITHOUT re-running the full
 * managed write, and only when the config currently selects OUR provider. The
 * provider check keeps the key out during `agent codex --mobile` pairing, which
 * strips `model_provider` to run the app on its default OpenAI provider (whose
 * limits the patched catalog would misstate). ADD-only: a present key -- ours or
 * a user-pinned custom catalog path -- is never rewritten here; enforcing OUR
 * path over a custom one is the full managed write's job (configureCodexConfig).
 *
 * DISABLED -- cleanup: strip the reference from every known Codex config, then
 * delete the generated file, then clear the refresh-throttle state. "Every
 * known config" sweeps the active home, the default ~/.codex, and the per-host
 * symlink-farm homes (~/.codex/hosts/*): all of them reference the ONE
 * account-wide file, so stripping only the active home could leave a dangling
 * reference elsewhere. The reference is stripped only when its value IS our
 * generated path (the value match alone proves ownership -- no provider check,
 * because leaving our reference behind while the file goes would break Codex
 * startup; a user-pinned custom path survives). Strip-BEFORE-delete keeps the
 * dangling-reference window to the one unavoidable TOCTOU sliver (a Codex that
 * read the old config but has not opened the file yet); anything wider --
 * every config on disk -- always sees (reference + file) or (no reference).
 * Deletion FAILS CLOSED: when any config is unreadable for a reason other
 * than "no config.toml", when the farm directory cannot be enumerated, or
 * when a NON-matching reference still resolves to the same file (a case
 * variant / symlinked spelling of our path), the file is kept this round; a
 * possibly-live reference to a deleted file is a Codex startup error, and
 * Codex re-runs auth every 300s, so the retry is near. Steady state is
 * write-free.
 */
export function syncCodexCatalogReference(): void {
  try {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) {
      cleanupCodexCatalogArtifacts(catalogFile);
      return;
    }
    if (!isCatalogFileUsable(catalogFile)) return;
    const configPath = codexConfigPath(effectiveCodexHome());
    const doc = parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (doc.model_provider !== CODEX_PROVIDER_ID) return;
    if (doc.model_catalog_json !== undefined) return;
    doc.model_catalog_json = catalogFile;
    fs.writeFileSync(configPath, stringify(doc));
  } catch {
    // No config.toml (Codex never wired), unreadable TOML, or a write race:
    // the next `agent codex`/`agent init` wiring writes the key anyway.
  }
}

/** Every Codex home that may hold per-home state (config.toml, sessions): the
 *  active home (run state / CODEX_HOME env), the default ~/.codex, and each
 *  per-host symlink-farm home, enumerated through the farm layout's owner
 *  (codexFarmHostsDir in src/utils/hostname.ts). `complete` is false when the
 *  farm directory exists but cannot be enumerated -- unseen homes may still
 *  hold state. */
export function knownCodexHomes(): { homes: string[]; complete: boolean } {
  const homes = new Set<string>([effectiveCodexHome()]);
  // The default home resolves via homedir() (the effectiveCodexHome contract);
  // the farm root via its creator's contract (codexFarmHostsDir on homeDir,
  // process.env.HOME first). They usually agree, but can differ (e.g. HOME set
  // on Windows), so sweep BOTH -- the Set dedupes the common case.
  homes.add(path.join(homedir(), ".codex"));
  const hostsDir = codexFarmHostsDir();
  homes.add(path.dirname(hostsDir));
  let complete = true;
  try {
    for (const entry of fs.readdirSync(hostsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.add(path.join(hostsDir, entry.name));
    }
  } catch (e) {
    // No farm directory (ENOENT/ENOTDIR): the two base homes cover everything.
    // Any OTHER failure (EACCES, I/O) hides farm homes that may hold state,
    // so the sweep is incomplete.
    if (isRecord(e) && !isEnoentOrNotdir(e)) complete = false;
  }
  return { homes: [...homes], complete };
}

/** Every config.toml that may reference the account-wide catalog file: one per
 *  known Codex home (a farm home's config.toml is a host-LOCAL seeded copy,
 *  not a symlink -- each needs its own strip). An incomplete home sweep means
 *  unseen configs may still hold references, so deletion must not proceed on
 *  that sweep. */
function codexCatalogConfigCandidates(): { configs: string[]; complete: boolean } {
  const { homes, complete } = knownCodexHomes();
  return { configs: homes.map((home) => codexConfigPath(home)), complete };
}

/** True when `value` is a non-identical spelling of `catalogFile` that still
 *  resolves to the same file (case variant, symlink, relative segmenting).
 *  Exact matches are handled upstream; a resolve failure (the path does not
 *  exist) means it cannot denote our existing file. */
function resolvesToCatalogFile(value: unknown, catalogFile: string): boolean {
  if (typeof value !== "string" || value === catalogFile) return false;
  try {
    return fs.realpathSync(value) === fs.realpathSync(catalogFile);
  } catch {
    return false;
  }
}

/** The disabled branch of syncCodexCatalogReference: strip our reference from
 *  every candidate config, delete the generated file, clear the throttle state
 *  -- in that order, each step skipped when already clean so the 300s auth
 *  cadence stays write-free. */
function cleanupCodexCatalogArtifacts(catalogFile: string): void {
  const { configs, complete } = codexCatalogConfigCandidates();
  let deletionSafe = complete;
  for (const configPath of configs) {
    try {
      const doc = parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (doc.model_catalog_json === catalogFile) {
        delete doc.model_catalog_json;
        fs.writeFileSync(configPath, stringify(doc));
      } else if (resolvesToCatalogFile(doc.model_catalog_json, catalogFile)) {
        // An alternate spelling of OUR path (case variant on Windows, a
        // symlinked home): not provably ours to strip, but deleting the file
        // would dangle it -- keep the file.
        deletionSafe = false;
      }
    } catch (e) {
      // ENOENT (Codex never wired there) cannot hold a reference; any other
      // failure might, so keep the file until every readable config proves it
      // unreferenced.
      if (!isEnoent(e)) deletionSafe = false;
    }
  }
  if (deletionSafe && fs.existsSync(catalogFile)) {
    try {
      fs.rmSync(catalogFile, { force: true });
    } catch (e) {
      logger.warn(`codex model catalog cleanup failed: ${errMessage(e)}`);
    }
  }
  const state = new CopilotEnvState();
  const recorded = state.read();
  if (recorded.codexCatalogLastAttemptMs !== 0 || recorded.codexCatalogCodexVersion !== null) {
    state.set({ codexCatalogLastAttemptMs: null, codexCatalogCodexVersion: null });
  }
}

interface EffectiveCodexConfig {
  codexHome: string;
  configPath: string;
  configExists: boolean;
  providerMode: AgentProviderMode;
}

function inspectEffectiveCodexConfig(): EffectiveCodexConfig {
  const codexHome = effectiveCodexHome();
  const configPath = codexConfigPath(codexHome);
  try {
    const status = inspectCodexWiring(
      fs.readFileSync(configPath, "utf8"),
      null,
      Number(copilotApiResolvePort()),
      false,
    );
    return {
      codexHome,
      configPath,
      configExists: status.configExists,
      providerMode: status.providerMode,
    };
  } catch (e) {
    if (!isEnoent(e)) throw e;
    return { codexHome, configPath, configExists: false, providerMode: "none" };
  }
}

function providerModeDetail(mode: AgentProviderMode, configExists: boolean): string {
  switch (mode) {
    case "proxy":
      return "local copilot-api proxy";
    case "direct":
      return "GitHub Copilot Direct";
    case "none":
      return configExists ? "no model_provider configured" : "no config.toml found";
    case "other":
      return "custom or unsupported provider";
    default:
      return assertNever(mode);
  }
}

function checkCodexConfig(): void {
  try {
    const { codexHome, configPath, configExists, providerMode } = inspectEffectiveCodexConfig();
    console.log(
      `Codex provider mode: ${providerMode} (${providerModeDetail(providerMode, configExists)})`,
    );
    console.log(`CODEX_HOME: ${codexHome}`);
    console.log(`config.toml: ${configPath}`);
    process.exitCode = providerModeExitCode(providerMode);
  } catch (e) {
    logger.error(`Codex provider check failed: ${errMessage(e)}`);
    process.exitCode = 1;
  }
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
  let doc: Record<string, unknown>;
  try {
    doc = parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if (isEnoent(e)) return;
    throw new Error(`${configPath} is not readable/valid TOML: ${errMessage(e)}`);
  }
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
  if (changed) fs.writeFileSync(configPath, stringify(doc));
}

/**
 * Remove the DEFAULT selection's managed artifacts from `codexHome`'s config.toml:
 * the `[model_providers.copilot-env]` table (ours by name), the top-level
 * `model_provider` selector (only while it still points at our id -- a
 * user-repointed selector is no longer ours to delete), the managed
 * `model_catalog_json` reference (only when it denotes the account-wide generated
 * catalog file, which the caller is about to delete -- a dangling reference is a
 * Codex startup error), and `web_search` (only the managed `"live"` value, and only
 * when the selector was still ours). Also scrubs the legacy baked
 * `COPILOT_ENV_GH_TOKEN` from `.env` (never OPENAI_API_KEY -- see
 * configureCodexConfig). No-op when the config is absent; a present-but-unparseable
 * file throws (never blind-write). Used by `agent uninstall`.
 */
export function removeCodexDefaultWiring(codexHome: string): void {
  const configPath = codexConfigPath(codexHome);
  let doc: Record<string, unknown> | null;
  try {
    doc = parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if (isEnoent(e)) doc = null;
    else throw new Error(`${configPath} is not readable/valid TOML: ${errMessage(e)}`);
  }
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
    if (
      doc.model_catalog_json === catalogFile ||
      resolvesToCatalogFile(doc.model_catalog_json, catalogFile)
    ) {
      delete doc.model_catalog_json;
      changed = true;
    }
    if (selectorWasOurs && doc.web_search === "live") {
      delete doc.web_search;
      changed = true;
    }
    if (changed) fs.writeFileSync(configPath, stringify(doc));
  }
  removeEnvKey(path.join(codexHome, ".env"), DIRECT_ENV_KEY);
}

/**
 * Live auto-detect: does GitHub Copilot Direct work for Codex on this machine?
 * Writes a throwaway direct config and runs `codex exec --sandbox read-only`
 * against it (see src/utils/direct_probe.ts). False => the caller writes proxy.
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
 * `agent codex`: configure Codex at the active CODEX_HOME -- the one a `--host`
 * farm set in state, else `$CODEX_HOME`, else the default `~/.codex`. `--direct`
 * forces GitHub Copilot Direct, `--proxy` forces the local proxy, and with no
 * mode flag it auto-detects (live read-only probe, else the proxy). `--check`
 * reports the configured mode (exit 0 direct / 2 proxy|none / 1 other) without a
 * probe. Does NOT touch `state.codexHome` (only `--host` sets/clears that).
 *
 * A GitHub token provisioned via `agent auth` (in the shared store) is used as the
 * Direct credential automatically; with no mode flag, its presence selects Direct
 * without probing. (Named profiles are managed by `agent profile`, not here.)
 */
export async function runCodex(
  args: CodexConfigArgs,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  if (args.check) {
    checkCodexConfig();
    return;
  }
  // A configured credential (`agent auth`) selects Direct without a live probe.
  // Resolve it provider-aware (gh-cli -> gh, copilot/gh-token -> stored token, none ->
  // null) so a recorded-but-broken provider correctly falls through to the probe.
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args.mode, ghToken, detectCodexDirect);
  logger.log(
    `  Configuring Codex for ${direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"} ...`,
  );
  // Reuse the just-resolved credential for the catalog seed's direct fetch so the
  // gh-cli provider isn't shelled out to a second time.
  const seedDeps = catalogDeps ?? (ghToken === null ? undefined : { directToken: ghToken });
  await applyCodexConfig(effectiveCodexHome(), direct ? "direct" : "proxy", seedDeps);
}

/** The configured Codex provider mode at the effective CODEX_HOME (read-only). */
export function effectiveCodexProviderMode(): AgentProviderMode {
  return inspectEffectiveCodexConfig().providerMode;
}
