// Claude Desktop third-party (3P) inference wiring: manage copilot-env-owned entries in
// the Desktop app's config library. Desktop's chat surface reads NONE of Claude Code's
// settings.json -- its only local config surface is this library:
//   macOS:   ~/Library/Application Support/Claude-3p/configLibrary/<uuid>.json
//   Windows: %LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json
// plus _meta.json ({appliedId, entries:[{id,name}]}) indexing them. Config documents use
// the FLAT keys documented at claude.com/docs/third-party/claude-desktop/configuration
// (the same names as the ADMX registry values; the app's nested "$schemaVersion: 2" file
// is an EXPORT format, not what it stores).
//
// Posture mirrors mcp_registration.ts: best-effort, and a foreign or surprising document
// is warned about and left alone, never clobbered. Ownership of every entry we create or
// adopt is recorded by exact path in the ownership ledger (src/copilot_api/ownership.ts),
// with the record-after-save ordering of the WebSearch deny: a failed save must never
// leave a claim on an entry we did not actually write.
//
// Model discovery: Desktop fetches `<inferenceGatewayBaseUrl>/v1/models`, hardcoded.
// Copilot Direct serves /models and 404s the v1 path, so direct entries carry an explicit
// inferenceModels list derived from live discovery (offline wires keep prior rows); the local
// proxy daemon mounts its model routes at BOTH /models and /v1/models, so proxy entries
// use discovery and always track the catalog.
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { codexUserAgent } from "../codex/config.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { atomicWriteFile } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import type { ProfileMode } from "../copilot_api/env_state.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  type ProbeFetch,
} from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  type ClaudeCatalogRow,
  claudeCatalogRows,
  ONE_M_SUFFIX,
  parseCatalogModels,
  parseModelList,
} from "../copilot_api/models.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { proxyLoopbackOrigin, wiringPortFor } from "../copilot_api/port.ts";
import { type Profile, profileLabel, WINDOWS_DEVICE_NAME_RE } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenArgs } from "../utils/root.ts";
import { cmdHelperBody, posixExecBody } from "./helper_body.ts";
import { resolveClaudeHome } from "./paths.ts";

const logger = createStderrLogger();

const WIN = process.platform === "win32";

// --- paths + detection ---------------------------------------------------------

/** Test seam for the config-library dir (COPILOT_ENV_CI_* family). When set, it also
 *  GOVERNS detection: the dir's existence is "Claude Desktop is installed", so the suite
 *  floor points it at a non-created dir and the whole suite sees no Desktop. */
export const CLAUDE_DESKTOP_DIR_ENV = "COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR";

/** The `Claude-3p` data dir for a platform, or null where no official app exists.
 *  Platform-parameterized so every branch runs on every CI runner. */
export function desktopDataDirFor(
  platform: string,
  home: string,
  localAppData: string | undefined,
): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude-3p");
  if (platform === "win32") {
    return localAppData ? join(localAppData, "Claude-3p") : null;
  }
  return null;
}

/** The configLibrary dir under a data dir -- the one spelling of the layout. */
export function desktopLibraryDirUnder(dataDir: string): string {
  return join(dataDir, "configLibrary");
}

/** The seam value, absolute-or-throw (the isolation-seam contract: quietly falling back
 *  to the real library is the one outcome a seam must never have). */
function seamDir(): string | null {
  const dir = process.env[CLAUDE_DESKTOP_DIR_ENV];
  if (dir === undefined) return null;
  if (!isAbsolute(dir)) {
    throw new Error(`${CLAUDE_DESKTOP_DIR_ENV} must be an absolute path (got: ${dir})`);
  }
  return dir;
}

/** The config-library dir this machine would use, or null when unsupported here. */
export function resolveDesktopLibraryDir(): string | null {
  const seam = seamDir();
  if (seam !== null) return desktopLibraryDirUnder(seam);
  const dataDir = desktopDataDirFor(process.platform, homedir(), process.env.LOCALAPPDATA);
  return dataDir === null ? null : desktopLibraryDirUnder(dataDir);
}

/** Whether Claude Desktop is present, per platform heuristics -- the app bundle/exe in
 *  its standard install locations, or the Claude-3p data dir itself (an app installed
 *  elsewhere that has run). Pure core; `claudeDesktopInstalled` binds the live probes. */
export function desktopAppInstalledFor(
  platform: string,
  exists: (path: string) => boolean,
  home: string,
  localAppData: string | undefined,
): boolean {
  const dataDir = desktopDataDirFor(platform, home, localAppData);
  if (dataDir !== null && exists(dataDir)) return true;
  if (platform === "darwin") {
    return exists("/Applications/Claude.app") || exists(join(home, "Applications", "Claude.app"));
  }
  if (platform === "win32") {
    return localAppData !== undefined &&
      exists(join(localAppData, "AnthropicClaude", "claude.exe"));
  }
  return false;
}

/** Live detection. Under the seam, the seam dir's existence governs -- tests opt in by
 *  creating it, and the suite floor's non-created dir opts the whole suite out. */
export function claudeDesktopInstalled(): boolean {
  const seam = seamDir();
  if (seam !== null) return existsSync(seam);
  return desktopAppInstalledFor(process.platform, existsSync, homedir(), process.env.LOCALAPPDATA);
}

// --- entry naming + classification ----------------------------------------------

/** The library-entry display name for a wiring: the app's config picker shows it. */
export function desktopEntryName(profile: Profile): string {
  return profile === null ? "copilot-env" : `copilot-env: ${profile}`;
}

/** Compare gateway base URLs the way adoption should: exact after trim and a single
 *  trailing-slash strip (a hand-typed trailing slash is the same gateway). */
function sameBaseUrl(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const strip = (u: string) => u.trim().replace(/\/$/, "");
  return strip(a) === strip(b);
}

// --- library IO ------------------------------------------------------------------

interface DesktopMetaEntry {
  id: string;
  name: string;
  /** Every OTHER field the app keeps on this row, preserved verbatim on save. */
  extra: Record<string, unknown>;
}

interface DesktopMeta {
  appliedId: string | null;
  entries: DesktopMetaEntry[];
  /** Every OTHER top-level field of _meta.json, preserved verbatim on save. */
  extra: Record<string, unknown>;
}

const META_FILENAME = "_meta.json";

/** Entry ids become `<id>.json` filenames: only plain filename-safe ids are accepted
 *  (no separators, no leading dot/underscore -- `_meta` itself can never be an id, and
 *  no Windows reserved device names -- `CON.json` is a device path there), so a
 *  hand-mangled id can neither escape the library dir nor collide with _meta.json. */
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeEntryId(id: string): boolean {
  if (!SAFE_ENTRY_ID.test(id)) return false;
  const stem = id.split(".", 1)[0] ?? id;
  return !WINDOWS_DEVICE_NAME_RE.test(stem.toLowerCase());
}

/** Parse _meta.json content, FAIL-CLOSED: a missing file is an empty library, but any
 *  shape this module does not fully understand -- junk JSON, a non-string appliedId, an
 *  entry without string id/name, an id that is not filename-safe -- is null, and the
 *  caller leaves the library alone (it is the app's file, not ours to repair). Fields
 *  beyond the understood ones are carried through `extra` so a save never drops them. */
export function parseDesktopMeta(raw: string | null): DesktopMeta | null {
  // Only a MISSING file is an empty library; present-but-blank is damage (the app
  // never writes it) and fails closed like any other not-understood shape.
  if (raw === null) return { appliedId: null, entries: [], extra: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (doc.appliedId !== undefined && typeof doc.appliedId !== "string") return null;
  if (doc.appliedId !== undefined && !isSafeEntryId(doc.appliedId)) return null;
  if (doc.entries !== undefined && !Array.isArray(doc.entries)) return null;
  const entries: DesktopMetaEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(doc.entries) ? doc.entries : []) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
      return null;
    }
    if (!isSafeEntryId(entry.id)) return null;
    // Duplicate ids would make path-keyed ownership destructive on removal (deleting
    // a config file a surviving foreign row still references): fail closed. Compared
    // case-insensitively -- Windows and default macOS filesystems fold case, so
    // `Foo.json` and `foo.json` are one file.
    const folded = entry.id.toLowerCase();
    if (seen.has(folded)) return null;
    seen.add(folded);
    const { id, name, ...extra } = entry;
    entries.push({ id, name, extra });
  }
  const { appliedId: _a, entries: _e, ...extra } = doc;
  return { appliedId: typeof doc.appliedId === "string" ? doc.appliedId : null, entries, extra };
}

/** Read a file, or null ONLY when it does not exist -- any other read error (permission,
 *  I/O) propagates: treating an unreadable library as absent would re-create it beside
 *  the app's real one. */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
}

/** Pretty JSON + trailing newline, atomically, skipping byte-identical rewrites. */
export function saveJsonIfChanged(path: string, doc: unknown): void {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (readFileOrNull(path) === text) return;
  atomicWriteFile(path, text);
}

function saveDesktopMeta(dir: string, meta: DesktopMeta): void {
  saveJsonIfChanged(join(dir, META_FILENAME), {
    ...meta.extra,
    "appliedId": meta.appliedId ?? undefined,
    "entries": meta.entries.map((e) => ({ ...e.extra, "id": e.id, "name": e.name })),
  });
}

// --- payload ---------------------------------------------------------------------

/** One inferenceModels row (Desktop's documented shape). */
export interface DesktopModelSpec {
  name: string;
  labelOverride: string;
  supports1m: boolean;
  prefer1m: boolean;
  anthropicFamilyTier: string;
  isFamilyDefault: boolean;
}

/** A human picker label from a catalog id: `claude-fable-5` -> `Claude Fable 5`,
 *  `claude-opus-4.8` and the dash-form `claude-opus-4-8` -> `Claude Opus 4.8`.
 *  Written into labelOverride: without it the app's config editor shows the row's
 *  Display name blank. */
export function desktopModelLabel(id: string): string {
  const words: string[] = [];
  for (const token of id.split("-")) {
    const last = words[words.length - 1];
    // Fold only PURE numeric 1-2 digit tokens into a dotted version ("4"+"8" ->
    // "4.8") -- the same minor cap as the model-id grammar, so a dated qualifier
    // ("20251001") or "1m" stays its own word, never "5.20251001".
    if (/^\d{1,2}$/.test(token) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) {
      words[words.length - 1] = `${last}.${token}`;
    } else {
      words.push(/^[a-z]/.test(token) ? `${token[0]?.toUpperCase()}${token.slice(1)}` : token);
    }
  }
  return words.join(" ");
}

/** The provider label Desktop shows (sidebar footer / user menu). */
export const DESKTOP_DISPLAY_NAME = "GitHub Copilot";

/** The managed MCP server entry for a wiring: copilot-env's own stdio server
 *  (web_search), the same spawn recipe as the Claude Code registration -- with the
 *  profile selector, so a named profile's web search resolves ITS credential (a named
 *  profile never falls back to the default). Merged over any existing managedMcpServers
 *  record: foreign server entries survive. The value shape follows the app's
 *  claude_desktop_config.json mcpServers vocabulary (name -> {command, args}); if a
 *  Desktop release rejects it, the config window flags the key and the rest of the
 *  entry still applies -- inference never depends on it. */
function managedMcpServers(profile: Profile, existing: unknown): Record<string, unknown> {
  const { command, args } = agentLauncherCommand(
    profile === null ? ["mcp", "--serve"] : ["mcp", "--serve", "--profile", profile],
  );
  return {
    ...(isRecord(existing) ? existing : {}),
    "copilot-env": { "command": command, "args": args },
  };
}

export interface DesktopPayloadOptions {
  mode: ProfileMode;
  profile: Profile;
  baseUrl: string;
  helperPath: string;
  /** Direct only; ALREADY resolved by the caller (this module never probes). */
  directIntegrationId?: string | null;
  models?: readonly DesktopModelSpec[];
  /** The entry's current document; foreign keys survive the merge. */
  existing?: Record<string, unknown>;
}

/** Build the entry document: the managed keys over `existing`. Every key below is an
 *  external contract (Desktop's documented flat config vocabulary) -- never rename. */
export function desktopConfigPayload(opts: DesktopPayloadOptions): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...(opts.existing ?? {}) };
  doc["inferenceGatewayBaseUrl"] = opts.baseUrl;
  doc["inferenceCredentialHelper"] = opts.helperPath;
  // Direct resolves via `agent auth --get` (fast); the proxy helper may float and
  // launch the daemon on first call, so it gets headroom.
  doc["inferenceCredentialHelperTimeoutSec"] = opts.mode === "direct" ? 30 : 120;
  doc["deploymentDisplayName"] = DESKTOP_DISPLAY_NAME;
  doc["managedMcpServers"] = managedMcpServers(opts.profile, doc["managedMcpServers"]);
  // Capability switches: everything on (user decision).
  doc["chatTabEnabled"] = true;
  doc["coworkTabEnabled"] = true;
  doc["isClaudeCodeForDesktopEnabled"] = true;
  doc["isDesktopExtensionEnabled"] = true;
  doc["chatAdvancedFileAnalysisEnabled"] = true;
  doc["skillCreationEnabled"] = true;
  doc["autoModeEnabled"] = true;
  doc["userPluginMarketplacesEnabled"] = true;
  doc["userPluginUploadsEnabled"] = true;
  // Show estimated cost in the UI, default to the 1M window (user decisions).
  doc["inferenceModelPricingEnabled"] = true;
  doc["modelPrefer1mContext"] = true;
  // Claude.ai data import/export switches all on (user decision); merged so a
  // hand-set field like bannerBehavior survives.
  const existingImport = doc["claudeAiImport"];
  doc["claudeAiImport"] = {
    ...(isRecord(existingImport) ? existingImport : {}),
    "enabled": true,
    "automatic3pImport": true,
    "exportEnabled": true,
  };
  // No telemetry at all (user decision), essential included.
  doc["disableEssentialTelemetry"] = true;
  doc["disableNonessentialTelemetry"] = true;
  doc["disableNonessentialServices"] = true;
  if (opts.mode === "direct") {
    // Ours win on our header names; a user-added extra header survives the merge.
    const existingHeaders = doc["inferenceCustomHeaders"];
    doc["inferenceCustomHeaders"] = {
      ...(isRecord(existingHeaders) ? existingHeaders : {}),
      ...directClientHeaders(codexUserAgent(), opts.directIntegrationId),
    };
    // Copilot Direct 404s /v1/models -- discovery must stay off; the list is the picker.
    delete doc["modelDiscoveryEnabled"];
  } else {
    // The daemon serves /v1/models, so the picker tracks the live catalog -- but
    // discovery alone carries no capability metadata (anthropics/claude-code#88345:
    // 1m models silently cap at 200k), so the inferenceModels list below stays as
    // ANNOTATIONS (ids matching what /v1/models returns) marking 1m support.
    doc["modelDiscoveryEnabled"] = true;
    // Strip only OUR header names from a mode switch; foreign extras survive.
    const existingHeaders = doc["inferenceCustomHeaders"];
    if (isRecord(existingHeaders)) {
      const stripped = { ...existingHeaders };
      for (const name of Object.keys(directClientHeaders(codexUserAgent(), "x"))) {
        delete stripped[name];
      }
      if (Object.keys(stripped).length === 0) delete doc["inferenceCustomHeaders"];
      else doc["inferenceCustomHeaders"] = stripped;
    }
  }
  // No discovered rows (offline wire): leave whatever inferenceModels the entry
  // already carries -- a fresh offline entry simply has none until the first
  // online wire fills them.
  if (opts.models !== undefined) {
    doc["inferenceModels"] = opts.models.map((m) => ({
      "name": m.name,
      "labelOverride": m.labelOverride,
      "supports1m": m.supports1m,
      "prefer1m": m.prefer1m,
      "anthropicFamilyTier": m.anthropicFamilyTier,
      "isFamilyDefault": m.isFamilyDefault,
    }));
  }
  return doc;
}

/** Map catalog rows onto Desktop model rows: the WHOLE catalog makes the picker,
 *  each family's newest marked as its default. `labelOf` supplies the upstream
 *  display name (the same field `agent models` shows); absent one, the label is
 *  synthesized from the id. */
export function desktopModelsFromPicks(
  rows: ClaudeCatalogRow[],
  labelOf?: (id: string) => string | null,
): DesktopModelSpec[] {
  return rows.map((r) => ({
    name: r.id,
    labelOverride: labelOf?.(r.id) ?? desktopModelLabel(r.id),
    supports1m: r.is1m,
    prefer1m: r.is1m,
    anthropicFamilyTier: r.family,
    isFamilyDefault: r.familyDefault,
  }));
}

// --- credential-helper scripts -----------------------------------------------------

/** The generated helper-script path for a wiring. Undotted (a foreign program reads it,
 *  the codex-model-catalog.json convention) under the account-wide root home, which
 *  uninstall already sweeps. */
export function desktopHelperPath(rootHome: string, mode: ProfileMode, profile: Profile): string {
  const base = mode === "direct" ? "claude-desktop-token" : "claude-desktop-proxy-token";
  const name = profile === null ? base : `${base}-${profile}`;
  return join(rootHome, `${name}${WIN ? ".cmd" : ".sh"}`);
}

/** Write (or refresh) the helper script for a wiring: body healed when it drifted, the
 *  executable bit healed even when the body matched (a chmod'd-away +x would otherwise
 *  survive every wire). Returns the script path. Regenerated on every wire so a moved
 *  install root heals on init. The OTHER mode's script is retired separately
 *  (retireDesktopHelperScript) AFTER the entry saves, so a failed save never leaves the
 *  still-current entry pointing at a deleted helper. */
export function writeDesktopHelperScript(mode: ProfileMode, profile: Profile): string {
  const rootHome = resolveRootHome();
  const { command, args } = agentLauncherCommand(
    mode === "direct" ? agentAuthGetArgs(profile) : proxyTokenArgs(profile),
  );
  const body = WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
  const path = desktopHelperPath(rootHome, mode, profile);
  if (readFileOrNull(path) !== body) atomicWriteFile(path, body, 0o755);
  else if (!WIN) chmodSync(path, 0o755);
  return path;
}

/** Remove the OTHER mode's helper script for `profile` -- called post-save on a wire. */
export function retireDesktopHelperScript(mode: ProfileMode, profile: Profile): void {
  const other: ProfileMode = mode === "direct" ? "proxy" : "direct";
  rmSync(desktopHelperPath(resolveRootHome(), other, profile), { force: true });
}

// --- wiring ------------------------------------------------------------------------

export interface DesktopWireOptions {
  profile: Profile;
  mode: ProfileMode;
  /** Direct only; already resolved by the caller -- never probed here. */
  directIntegrationId?: string | null;
  /** Direct only: credential for the catalog fetch (never re-resolved when given). */
  directToken?: string | null;
  quiet?: boolean;
  /** Test seam, threaded to fetchRawModels. */
  fetchImpl?: ProbeFetch;
}

/** The hand-rolled pre-copilot-env helper this feature supersedes: retired during
 *  adoption iff the adopted entry referenced it AND nothing else still does. */
function legacyHandMadeHelperPath(): string {
  return join(resolveClaudeHome(), "copilot-token.sh");
}

/** True when NO OTHER consumer references the hand-made helper: Claude Code's own
 *  settings.json (the legacy helper-FILE wiring used this exact path) and every other
 *  Desktop entry's config. Any read/parse doubt answers false -- keep the file. */
function handMadeHelperUnreferenced(
  dir: string,
  meta: { entries: { id: string }[] },
  adoptedId: string,
  handMade: string,
): boolean {
  try {
    const settingsRaw = readFileOrNull(join(resolveClaudeHome(), "settings.json"));
    if (settingsRaw !== null) {
      const settings: unknown = JSON.parse(settingsRaw);
      if (!isRecord(settings)) return false;
      if (settings["apiKeyHelper"] === handMade) return false;
    }
    for (const entry of meta.entries) {
      if (entry.id === adoptedId) continue;
      const raw = readFileOrNull(join(dir, `${entry.id}.json`));
      if (raw === null) continue;
      const doc: unknown = JSON.parse(raw);
      if (isRecord(doc) && doc["inferenceCredentialHelper"] === handMade) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The upstream display names in `body`, folded onto base ids -- the same parse
 *  `agent models` renders (one pipeline for both surfaces). */
function labelLookup(body: unknown): (id: string) => string | null {
  const names = new Map<string, string>();
  try {
    for (const entry of parseModelList(body)) {
      const base = entry.id.endsWith(ONE_M_SUFFIX)
        ? entry.id.slice(0, -ONE_M_SUFFIX.length)
        : entry.id;
      if (entry.name !== null && !names.has(base)) names.set(base, entry.name);
    }
  } catch {
    // No labels is only a cosmetic loss; ids still synthesize labels.
  }
  return (id) => names.get(id) ?? null;
}

/**
 * The model rows for a wiring, or undefined when no live data exists (the caller then
 * leaves an existing entry's rows untouched and refuses to create a fresh direct one).
 *
 * Direct runs the full DISCOVERY pipeline (src/copilot_api/discovery.ts): the catalog
 * under the wiring's own identity, plus the allowlist-oracle extras verified one by
 * one on /v1/messages -- so unadvertised-but-servable models (claude-fable-5) make the
 * picker with a PROBED 1m verdict, and nothing hand-kept decides membership.
 *
 * Proxy annotates what the daemon's /v1/models will discover: the daemon's own
 * aggregated catalog first, the direct Copilot catalog when the daemon is down -- the
 * rows are the 1m-capability annotations discovery alone cannot provide
 * (claude-code#88345).
 */
async function wiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  if (opts.mode === "direct") {
    try {
      const token = opts.directToken ?? new Credential(undefined, opts.profile).resolve();
      if (token === null) {
        throw new Error("no GitHub credential configured (run `agent auth`)");
      }
      const discovered = await discoverServableClaudeModels(
        token,
        codexUserAgent(),
        opts.directIntegrationId ?? null,
        { fetchImpl: opts.fetchImpl },
      );
      const rows = claudeCatalogRows(discovered.models);
      if (rows.length > 0) {
        return desktopModelsFromPicks(rows, labelLookup(discovered.catalogBody));
      }
    } catch (e) {
      logger.warn(`  Claude Desktop: model discovery failed (${errMessage(e)}).`);
    }
  } else {
    for (const source of ["proxy", "direct"] as const) {
      try {
        const body = await fetchRawModels(source, {
          directToken: opts.directToken ?? undefined,
          profile: opts.profile,
          fetchImpl: opts.fetchImpl,
        });
        const rows = claudeCatalogRows(parseCatalogModels(body));
        if (rows.length > 0) return desktopModelsFromPicks(rows, labelLookup(body));
      } catch (e) {
        logger.warn(
          `  Claude Desktop: could not fetch the ${source} model catalog (${errMessage(e)}).`,
        );
      }
    }
  }
  logger.warn(
    "  Claude Desktop: no live model data; leaving the entry's model rows as they are.",
  );
  return undefined;
}

/**
 * Upsert the copilot-env entry for `profile` into the Desktop config library. Throws on
 * real write failures (syncClaudeDesktopWiring is the best-effort face). Resolution
 * order for the target entry:
 *   ours (ownership-recorded path + our name) -> adoptable (foreign entry whose gateway
 *   base URL already matches the target: taken over in place under its uuid, renamed,
 *   and the hand-made helper it referenced retired) -> foreign entry carrying our name
 *   (warn, never clobber) -> a fresh uuid.
 * `appliedId` is only ever SET when the library had none -- an applied user config is
 * never displaced (an adopted applied entry stays applied naturally: its id is stable).
 * Ownership is committed AFTER both saves (record-after-save, like the WebSearch deny).
 */
export async function wireClaudeDesktopEntry(opts: DesktopWireOptions): Promise<void> {
  const dir = resolveDesktopLibraryDir();
  if (dir === null || !claudeDesktopInstalled()) return;

  const baseUrl = opts.mode === "direct"
    ? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(wiringPortFor(opts.profile));

  const meta = parseDesktopMeta(readFileOrNull(join(dir, META_FILENAME)));
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${
        join(dir, META_FILENAME)
      } has an unexpected shape; leaving the config library alone.`,
    );
    return;
  }

  const ledger = new OwnershipLedger();
  const name = desktopEntryName(opts.profile);
  const configPathOf = (id: string) => join(dir, `${id}.json`);

  let entry = meta.entries.find(
    (e) => e.name === name && ledger.owns("claudeDesktop", configPathOf(e.id)),
  );
  const commits: (() => void)[] = [];
  if (entry === undefined) {
    // Adoption scan: a foreign entry already wired at the same gateway is the user's
    // hand-made equivalent of what we are about to write -- take it over in place.
    // Never when ANOTHER entry already carries our name (renaming the candidate
    // would mint a duplicate picker name).
    const nameTaken = meta.entries.some((e) => e.name === name);
    for (const candidate of nameTaken ? [] : meta.entries) {
      const path = configPathOf(candidate.id);
      if (ledger.owns("claudeDesktop", path)) continue;
      const raw = readFileOrNull(path);
      if (raw === null) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        continue; // malformed is foreign, never adopted
      }
      if (!isRecord(doc) || !sameBaseUrl(doc["inferenceGatewayBaseUrl"], baseUrl)) continue;
      entry = candidate;
      candidate.name = name;
      const handMade = legacyHandMadeHelperPath();
      if (
        doc["inferenceCredentialHelper"] === handMade &&
        handMadeHelperUnreferenced(dir, meta, candidate.id, handMade)
      ) {
        // Retired only when NOTHING else references it: Claude Code's own
        // settings.json (the legacy helper-FILE wiring used this very path) and
        // every other Desktop entry are checked first; any doubt keeps the file.
        commits.push(() => rmSync(handMade, { force: true }));
      }
      if (!opts.quiet) {
        logger.info(
          `  Claude Desktop: adopting the existing "${candidate.id}" entry (same gateway).`,
        );
      }
      break;
    }
  }
  if (entry === undefined && meta.entries.some((e) => e.name === name)) {
    logger.warn(
      `  Claude Desktop: a config entry named "${name}" already exists and is not ours; leaving it alone.`,
    );
    return;
  }
  const owned = entry !== undefined &&
    ledger.owns("claudeDesktop", configPathOf(entry.id));
  const created = entry === undefined;
  if (entry === undefined) {
    entry = { id: crypto.randomUUID(), name, extra: {} };
  }

  const configPath = configPathOf(entry.id);
  const existingRaw = readFileOrNull(configPath);
  let existing: Record<string, unknown> = {};
  if (existingRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (isRecord(parsed)) existing = parsed;
    } catch {
      // Ours (created/adopted above) with corrupt content: we own it, overwrite.
    }
  }

  // Model rows: the launcher hot path (quiet) must NEVER run discovery -- its
  // probes are billed requests. It reuses the recorded rows (or leaves them
  // absent); init / profile-add / `agent claude --desktop` refresh live.
  const models = opts.quiet
    ? (owned ? recordedModelRows(existing) ?? undefined : undefined)
    : await wiringModels(opts);

  // A FRESH direct entry without model data would have neither discovery (the
  // Copilot endpoint 404s /v1/models) nor a picker: don't create it at all.
  // Existing entries proceed -- their recorded rows survive the merge untouched.
  if (created && opts.mode === "direct" && models === undefined) {
    logger.warn(
      "  Claude Desktop: no model data available; not creating an unusable direct entry (re-run online).",
    );
    return;
  }
  if (created) meta.entries.push(entry);

  const helperPath = writeDesktopHelperScript(opts.mode, opts.profile);
  const payload = desktopConfigPayload({
    mode: opts.mode,
    profile: opts.profile,
    baseUrl,
    helperPath,
    directIntegrationId: opts.directIntegrationId,
    models,
    existing,
  });

  // Config first (a config without a meta row is invisible junk; a meta row without a
  // config is a broken picker row), meta second, ownership + retirements last -- a
  // failed save must never leave a claim on an unwritten entry, a deleted hand-made
  // helper, or a retired mode twin the still-current entry references.
  saveJsonIfChanged(configPath, payload);
  if (meta.appliedId === null) meta.appliedId = entry.id;
  saveDesktopMeta(dir, meta);
  ledger.record("claudeDesktop", configPath);
  retireDesktopHelperScript(opts.mode, opts.profile);
  for (const commit of commits) commit();
  if (!opts.quiet) {
    logger.success(
      `  Claude Desktop: wired "${name}" (${opts.mode}) at ${configPath}; restart Claude Desktop to pick it up.`,
    );
  }
}

/** The entry's recorded inferenceModels rows when they are OUR shape, else null (fetch). */
function recordedModelRows(existing: Record<string, unknown>): DesktopModelSpec[] | null {
  const rows = existing["inferenceModels"];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const parsed: DesktopModelSpec[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== "string") return null;
    parsed.push({
      name: row.name,
      // Rows written before labels existed heal on the quiet path too.
      labelOverride: typeof row.labelOverride === "string" && row.labelOverride !== ""
        ? row.labelOverride
        : desktopModelLabel(row.name),
      supports1m: row.supports1m === true,
      prefer1m: row.prefer1m === true,
      anthropicFamilyTier: typeof row.anthropicFamilyTier === "string"
        ? row.anthropicFamilyTier
        : "",
      isFamilyDefault: row.isFamilyDefault === true,
    });
  }
  return parsed;
}

/** Best-effort face of wireClaudeDesktopEntry: a Desktop-wiring failure warns and never
 *  fails the caller (init/profile wiring succeed on the agents alone). */
export async function syncClaudeDesktopWiring(opts: DesktopWireOptions): Promise<void> {
  try {
    await wireClaudeDesktopEntry(opts);
  } catch (e) {
    logger.warn(
      `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${errMessage(e)}`,
    );
  }
}

/** Remove the owned entry for `profile` (config file + meta row + helper scripts); a
 *  foreign entry -- even one carrying our name -- is never touched. Best-effort. */
export function removeClaudeDesktopEntry(profile: Profile): void {
  try {
    const swept = removeOwnedEntries((entry, owned) =>
      owned && entry.name === desktopEntryName(profile)
    );
    // A blocked sweep (malformed _meta.json) may leave a live entry pointing at
    // these scripts: only delete them when the library was actually processed.
    if (swept === "blocked") return;
    const rootHome = resolveRootHome();
    rmSync(desktopHelperPath(rootHome, "direct", profile), { force: true });
    rmSync(desktopHelperPath(rootHome, "proxy", profile), { force: true });
  } catch (e) {
    logger.warn(
      `  Could not remove the Claude Desktop entry for ${profileLabel(profile)}: ${errMessage(e)}`,
    );
  }
}

/** Uninstall sweep: every owned entry plus every generated helper script. `dirOverride`
 *  is the injected library dir (homedir() is not env-redirectable on Windows); null
 *  means "treat Desktop as absent". */
export function removeAllClaudeDesktopWiring(dirOverride?: string | null): void {
  if (removeOwnedEntries((_entry, owned) => owned, dirOverride) === "blocked") return;
  // Helper scripts live under the root home, which uninstall deletes wholesale right
  // after this step -- still removed here so the step is complete on its own.
  const rootHome = resolveRootHome();
  const state = new CopilotEnvState();
  const profiles: Profile[] = [null, ...state.profileNames()];
  for (const profile of profiles) {
    rmSync(desktopHelperPath(rootHome, "direct", profile), { force: true });
    rmSync(desktopHelperPath(rootHome, "proxy", profile), { force: true });
  }
}

/** Shared removal core: drop every meta entry `selects` picks (given its ownership) and
 *  its appliedId reference. Ordering is meta FIRST, config files second, ownership
 *  un-record last: a failure mid-way can leave an orphaned (invisible) config file, but
 *  never a picker row whose config is gone. */
function removeOwnedEntries(
  selects: (entry: DesktopMetaEntry, owned: boolean) => boolean,
  dirOverride?: string | null,
): "swept" | "blocked" {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return "swept";
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  if (raw === null) return "swept"; // no library, nothing recorded here to remove
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the config library alone.`,
    );
    return "blocked"; // a live entry may reference the helper scripts: keep them
  }
  const ledger = new OwnershipLedger();
  const removedPaths: string[] = [];
  const kept: DesktopMetaEntry[] = [];
  for (const entry of meta.entries) {
    const configPath = join(dir, `${entry.id}.json`);
    if (selects(entry, ledger.owns("claudeDesktop", configPath))) {
      removedPaths.push(configPath);
      if (meta.appliedId === entry.id) meta.appliedId = null;
    } else {
      kept.push(entry);
    }
  }
  if (removedPaths.length === 0) return "swept";
  meta.entries = kept;
  saveDesktopMeta(dir, meta);
  for (const path of removedPaths) {
    rmSync(path, { force: true });
    ledger.release("claudeDesktop", path);
  }
  return "swept";
}
