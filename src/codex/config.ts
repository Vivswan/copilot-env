// Codex config writer for config.toml (the Claude twin is src/claude/config.ts): Copilot Direct or
// the local proxy. By default no credential is baked (`auth.command` resolves it at fetch time);
// with `static-key` covering Codex the value rides as a static `http_headers.Authorization` and
// no `auth` table is written.
import { parse } from "smol-toml";
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
import { providerModeExitCode } from "../agents/provider_mode.ts";
import { Credential } from "../copilot_api/credential.ts";
import { directOverlay, landDirectPair } from "../copilot_api/direct_pair.ts";
import { directSmoke, type EndpointSmoke } from "../copilot_api/endpoint_smoke.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { isReducedGpt } from "../copilot_api/models.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  selectDirectIdentityAndHost,
} from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, openaiBaseUrl } from "../copilot_api/port.ts";
import { agentStartCommand, type Profile, type ProfileName } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenCommand } from "../utils/root.ts";
import { printKeyValue, printWrapped } from "../utils/table.ts";
import {
  type CatalogFileVerdict,
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
import { AUTHORIZATION_HEADER, inspectCodexWiring, providerModeDetail } from "./inspect.ts";
import {
  CODEX_PROVIDER_ID,
  codexConfigPath,
  codexProfileConfigPath,
  codexProviderId,
} from "./paths.ts";
import { type CodexTomlRead, readCodexToml, saveCodexToml } from "./toml_io.ts";
import { codexUserAgent } from "./user_agent.ts";

const logger = createStderrLogger();

/** What one `agent auth --get` (the `gh` look and the token print, nothing else) has before Codex
 *  gives up. It sits in every install's config; the gh look's own budget (GH_AUTH_TIMEOUT_MS) stays
 *  far under it. */
const DIRECT_AUTH_TIMEOUT_MS = 30000;

/** Proxy ALWAYS carries a base URL: a proxy write without one is unrepresentable, so nothing
 *  downstream re-checks for it. `plannedPort` is the port the base URL was computed from
 *  (codexWriteRequest): the write reserves it right before it lands (reservePlannedPort). */
type CodexModeRequest =
  | Extract<ManagedWrite, { mode: "direct" }>
  | (Extract<ManagedWrite, { mode: "proxy" }> & { baseUrl: string; plannedPort?: string });

type Doc = Record<string, unknown>;

/** A table the writer descends into. Anything else is a leaf, a Date included: smol-toml parses a
 *  TOML datetime into a Date subclass, and writing keys onto it would emit the datetime again with
 *  the managed keys silently gone. */
function isTable(value: unknown): value is Doc {
  return isRecord(value) && !(value instanceof Date);
}

/** The table at `key` of `doc`, made (a leaf in the way replaced, as the writers always did). */
function tableAt(doc: Doc, key: string): Doc {
  const table = isTable(doc[key]) ? doc[key] : {};
  doc[key] = table;
  return table;
}

interface CodexWriteCommon {
  /** Wire a NAMED profile's tables instead of the default selection. */
  profile?: Profile;
}

/** Spelled as a top-level union so the discriminant narrows at every consumer. */
type CodexWriteRequest =
  | (Extract<CodexModeRequest, { mode: "direct" }> & CodexWriteCommon)
  | (Extract<CodexModeRequest, { mode: "proxy" }> & CodexWriteCommon);

// === config.toml management ===
//
// smol-toml does NOT preserve comments or whitespace (TS has no battle-tested tomlkit equivalent),
// so load-merge-stringify is the best the writer can do. Every managed field is ENFORCED on each
// run, so a renamed or added key propagates even into a pre-existing config.

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
    // The launcher may cold-start deno; warm calls take well under a second, and Codex refreshes
    // lazily. The catalog refresh runs at wiring and launch, never inside this command.
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

/**
 * The write: every managed key enforced over config.toml (and a named profile's `<name>.config.toml`),
 * landed through the facade (a dry run previews it there). A named profile's selector lives in
 * `<name>.config.toml`, never at the top level of config.toml, so `codex --profile <name>` and plain
 * `codex` coexist.
 */
export function configureCodexConfig(codexHome: string, request: CodexWriteRequest): void {
  const profile = request.profile ?? null;
  const providerId = codexProviderId(profile);

  const hostConfig = codexConfigPath(codexHome);
  // A present-but-UNPARSEABLE file throws rather than letting the caller clobber a config it could
  // not read: a hand-edit typo must never cost the user their whole config.toml (mcp_servers,
  // custom providers, model pins). Other read errors (EISDIR, permission) propagate raw.
  const hostRead = readCodexToml(hostConfig);
  if (hostRead.kind === "unparseable") {
    throw new Error(
      `${hostConfig} is not valid TOML; refusing to overwrite it (${hostRead.error})`,
    );
  }
  // A blank file is seeded like a missing one (readCodexToml reads it as absent).
  const current: Doc | null = hostRead.kind === "ok" ? hostRead.doc : null;
  const doc: Doc = current ?? defaultConfig();
  // Loaded BEFORE anything is saved, so a profile file this write refuses to clobber fails the
  // write whole rather than after config.toml already changed.
  const profileFile = profile === null ? null : {
    path: codexProfileConfigPath(codexHome, profile),
    doc: loadProfileConfig(codexHome, profile),
  };

  // Every managed field is (re)written on every run, so a stale value or a missing managed key
  // heals; other providers, [analytics]/[feedback], and unknown top-level keys are left untouched.
  // The top-level managed keys are the DEFAULT selection's alone.
  if (profile === null) {
    doc.model_provider = CODEX_PROVIDER_ID;
    doc.web_search = "live";
  } else if (current === null) {
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
    tableAt(doc, "sandbox_workspace_write").network_access = true;
  }

  // `model_catalog_json` REPLACES Codex's bundled catalog, and a missing, empty, unparseable, or
  // schema-rejected file is a Codex STARTUP error: the key is written only when opted in, usable,
  // and not rejected by the installed codex (re-judged on every write, so `agent profile sync --codex` recovers
  // from a codex upgrade); otherwise scrubbed, even over a user-pinned path. Only the DEFAULT write
  // owns it.
  let catalogRef: "written" | "cleared" | null = null;
  let catalogRefLine: string | null = null;
  if (profile === null) {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    const previousRef = doc.model_catalog_json;
    const verdict: CatalogFileVerdict | "disabled" =
      new CopilotEnvConfig().codexModelCatalogEnabled()
        ? inspectCatalogFile(catalogFile)
        : "disabled";
    if (verdict === "rejected") {
      logger.warn(
        `  ! the installed codex rejects ${catalogFile}; leaving it out of the config ` +
          "(regenerate with `agent profile sync --codex`, or disable with " +
          `\`${configSetCommand("codex.model-catalog", "false")}\`)`,
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

  // Both modes share ONE table per profile, so every managed key is stripped BEFORE the mode's own
  // land: toggling modes can never bleed the OTHER mode's keys, and the managed keys settle after
  // the user's own, which survive.
  const table = tableAt(tableAt(doc, "model_providers"), providerId);
  for (const key of MANAGED_PROVIDER_KEYS) delete table[key];
  for (const [key, value] of Object.entries(managedProviderForMode(request, profile))) {
    table[key] = value;
  }

  // `codex --profile <name>` flips ONLY the provider; the user's own keys in the profile file
  // (model pins etc.) survive.
  if (profileFile !== null) profileFile.doc.model_provider = providerId;

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

  // Reserved only now that the text is computed: a throw above leaves no reservation behind.
  if (request.mode === "proxy" && request.plannedPort !== undefined) {
    reservePlannedPort(profile, request.plannedPort);
  }
  try {
    fs.mkdir(codexHome);
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
}

/** The request for `profile`'s write. A proxy write PEEKS the profile's port (copilotApiResolvePort)
 *  so computing the text writes nothing; the write reserves it right before it lands. */
function codexWriteRequest(write: ManagedWrite, profile: Profile): CodexWriteRequest {
  if (write.mode !== "proxy") return { ...write, profile };
  const port = copilotApiResolvePort(profile);
  return {
    mode: "proxy",
    profile,
    baseUrl: openaiBaseUrl(port),
    plannedPort: port,
    credential: write.credential,
  };
}

/**
 * The caller persists CODEX_HOME to state and, for direct, has already resolved the client identity
 * carried in the write (this function never probes). Throws with the cause when the write cannot
 * proceed. `directToken` is that already-resolved credential, so the catalog seed's direct fetch
 * never shells out to the gh-cli provider a second time.
 */
async function applyCodexConfig(
  codexHome: string,
  write: ManagedWrite,
  directToken: string | null,
  profile: Profile = null,
): Promise<void> {
  // Seeded (best-effort, unthrottled) BEFORE the config write, so the very first wiring can already
  // reference the file; the launch-time refresh (src/commands/launch.ts) keeps it fresh afterwards.
  // Account-wide, keyed to the default credential, so named-profile writes never touch it.
  if (profile === null) await generateCodexModelCatalog(write.mode, directToken ?? undefined);

  configureCodexConfig(codexHome, codexWriteRequest(write, profile));

  // When the catalog is disabled the write above only stripped the key in THIS home; the sync also
  // deletes the generated file and clears the throttle state, so a wiring pass finishes the
  // opt-out.
  if (profile === null) syncCodexCatalogReference();
}

/** The Direct facts a write bakes, resolved ONCE on the host in use: the `identity` pin, else
 *  identity selection on that host, then the `host` literal, else the host probe under that
 *  identity; a host `auto` moves to re-runs the selection there. Throws when the credential is
 *  rejected under every known identity.
 *
 *  Claude           -> the result rides in ANTHROPIC_BASE_URL + ANTHROPIC_CUSTOM_HEADERS
 *  Codex            -> the same result rides in base_url + http_headers
 *  `token` supplied -> skips a redundant credential resolve
 *
 *  `probe` answers and stores nothing: a listing such as `agent profile models --direct` probes
 *  this way, so a transient answer there can never overwrite the stored pair.
 *
 *  `land` is the LANDING: landDirectPair (src/copilot_api/direct_pair.ts, the one probe-and-store
 *  owner) as the branded wiring the writers take. A named profile lands when a credential lands
 *  (`agent profile <name> add`, `agent profile <name> auth`, an import) or a re-render finds its
 *  slot holding no pair. The default profile never lands here: its landing probes per agent and
 *  stores through commitDefaultWiring (configure_defaults.ts) once both agents' files are written. */
export async function directWiringFor(
  profile: Profile,
  token: string | null | undefined,
  landing: "probe" | "land",
): Promise<DirectWiring> {
  const resolved = token !== undefined ? token : new Credential(undefined, profile).resolve();
  if (resolved === null) throw directNeedsCredentialError(profile);
  const overlay = directOverlay(profile);
  const userAgent = codexUserAgent();
  // The one identity-then-host rule (selectDirectIdentityAndHost, which the landing runs too): a
  // literal skips the HOST probe, never the identity selection, and a host `auto` moved to re-runs
  // the selection there.
  const { integrationId, apiBase } = landing === "land"
    ? await landDirectPair(profile, resolved, userAgent, overlay)
    : await selectDirectIdentityAndHost(resolved, userAgent, {
      pinned: overlay.pinned,
      fixedHost: overlay.literal,
    });
  return directWiring(integrationId, apiBase);
}

function checkCodexConfig(): void {
  try {
    const codexHome = narrateCodexHome(resolveCodexHome());
    const configPath = codexConfigPath(codexHome);
    const read = fs.readTextResult(configPath);
    const status = inspectCodexWiring(read, null, Number(copilotApiResolvePort()), false);
    printKeyValue("Codex provider mode", `${status.providerMode} (${providerModeDetail(status)})`);
    printKeyValue("CODEX_HOME", codexHome);
    printKeyValue("config.toml", configPath);
    const drift = codexHostDrift();
    if (drift !== null) printWrapped(codexHostDriftLine(drift));
    // "direct" was classified from this very text, so it parses.
    if (status.providerMode === "direct" && read.kind === "text") {
      printKeyValue(
        "service_tier",
        serviceTierDetail(parse(read.text) as Record<string, unknown>),
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
  const providers = doc !== null && isRecord(doc.model_providers) ? doc.model_providers : {};
  if (doc !== null && providers[providerId] !== undefined) {
    // Patched in place, as every managed write is: a copy would turn smol-toml's datetimes (a
    // Date subclass) into plain values and rewrite the user's own keys.
    delete providers[providerId];
    if (Object.keys(providers).length === 0) delete doc.model_providers;
    saveCodexToml(configPath, doc);
  }
  if (profileDoc !== null && profileDoc.model_provider === providerId) {
    delete profileDoc.model_provider;
    if (Object.keys(profileDoc).length === 0) fs.rm(profilePath, { force: true });
    else saveCodexToml(profilePath, profileDoc);
  }
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
 *  --get` in the child, which prints the token and writes nothing. The distinct selector keeps the
 *  reference sync (a wiring write or a launch run with $CODEX_HOME pointing here) from adding
 *  `model_catalog_json` to, and ledgering, a config removeScratchDir deletes: the sync touches only
 *  configs that select the managed provider, by its own contract. */
const CODEX_PROBE_PROVIDER_ID = `${CODEX_PROVIDER_ID}-probe`;

/** The detect probe's throwaway config: the Direct provider table and its selector, nothing else.
 *  The real write's top-level extras (`web_search`, the generated `model_catalog_json`) belong to
 *  the user's wiring, not to Direct, and a catalog file produced under another credential would
 *  colour the verdict. Shares managedDirectProvider, so the table is byte-identical to the real one;
 *  `credential` is the probe subject's (the resolver command, or a named profile's token baked). */
function writeCodexProbeConfig(
  tmpHome: string,
  direct: DirectWiring,
  credential: CredentialWiring,
): void {
  saveCodexToml(codexConfigPath(tmpHome), {
    ...defaultConfig(),
    "model_provider": CODEX_PROBE_PROVIDER_ID,
    "model_providers": {
      [CODEX_PROBE_PROVIDER_ID]: managedDirectProvider(
        credential,
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
  credential: CredentialWiring,
  deps?: DirectProbeDeps,
): Promise<boolean> {
  return probeDirectWorks(
    CODEX_PROBE,
    (tmpHome) => writeCodexProbeConfig(tmpHome, direct, credential),
    ghToken === null ? null : directSmoke(
      CODEX_ENDPOINT_SMOKE,
      ghToken,
      codexUserAgent(),
      direct.directIntegrationId,
      direct.directBaseUrl,
      {
        fetchImpl: deps?.fetchImpl,
        pinnedModel: new CopilotEnvConfig().resolve("probe.codex-model", { profile: null }).value ??
          null,
      },
    ),
    deps,
  );
}

export function codexAdapter(): AgentAdapter {
  return {
    id: "codex",
    label: "Codex",
    check: checkCodexConfig,
    detectDirect: detectCodexDirect,
    resolveDirectWiring: (ghToken) => directWiringFor(null, ghToken, "probe"),
    async configureProfile(profile, write, options) {
      if (profile !== null) {
        configureCodexConfig(effectiveCodexHome(), codexWriteRequest(write, profile));
        return;
      }
      // The farm derivation decides the home the write lands in (and records it after).
      await withCodexHostFarm((codexHome) =>
        applyCodexConfig(codexHome, write, options.directToken ?? null, null)
      );
    },
    removeProfile(name) {
      removeCodexProfile(effectiveCodexHome(), name);
    },
  };
}
