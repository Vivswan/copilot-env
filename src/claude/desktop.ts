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
// Identity is by uuid path, never by display name: an owned path is ours whatever the app
// shows it as (the name is the user's; a wire only ever seeds a fresh entry's), and the
// wiring an owned entry serves is read from its own document -- the credential helper it
// points at names the profile (entryProfileAt).
//
// Model discovery: Desktop fetches `<inferenceGatewayBaseUrl>/v1/models`, hardcoded.
// Copilot Direct serves /models and 404s the v1 path, so direct entries carry an explicit
// inferenceModels list derived from live discovery (offline wires keep prior rows); the local
// proxy daemon mounts its model routes at BOTH /models and /v1/models, so proxy entries
// use discovery and always track the catalog.
//
// Whether Desktop is wired at all is STATE (the `claude-desktop` key, default on), not an
// action: every managed Claude write reconciles its entry from the key. `false` removes
// the profile entries and leaves the default's in place, unmanaged (the user's from then
// on; only uninstall removes it, since its helper script goes with the install). Every
// file created, rewritten, or removed is announced.
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { codexUserAgent } from "../codex/config.ts";
import type { ManagedWrite } from "../agents/configure.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { atomicWriteFile } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import {
  CODEX_IDENTITY_NAME,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  INTEGRATION_ID_HEADER,
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
import { CopilotApiPaths, resolveRootHome } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin, wiringPortFor } from "../copilot_api/port.ts";
import {
  parseProfileName,
  type Profile,
  profileLabel,
  WINDOWS_DEVICE_NAME_RE,
} from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { entryAbsent, isEnoentOrNotdir, readTextResult } from "../utils/fs.ts";
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

/** Read a file, or null ONLY when it is PROVEN absent (readTextResult's rule: a
 *  dangling symlink is unreadable, never absent -- the entry itself exists, and
 *  a rewrite would replace the app's or user's link with a plain file). Any
 *  other read failure (permission, I/O, the dangling link) throws: treating an
 *  unreadable library as absent would re-create it beside the app's real one. */
function readFileOrNull(path: string): string | null {
  const read = readTextResult(path);
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") throw new Error(`could not read ${path}: ${read.error}`);
  return read.text;
}

/** Pretty JSON + trailing newline, atomically, skipping byte-identical rewrites.
 *  Returns whether a write happened (callers announce every real write). */
export function saveJsonIfChanged(path: string, doc: unknown): boolean {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (readFileOrNull(path) === text) return false;
  atomicWriteFile(path, text);
  return true;
}

function saveDesktopMeta(dir: string, meta: DesktopMeta): void {
  const path = join(dir, META_FILENAME);
  const written = saveJsonIfChanged(path, {
    ...meta.extra,
    "appliedId": meta.appliedId ?? undefined,
    "entries": meta.entries.map((e) => ({ ...e.extra, "id": e.id, "name": e.name })),
  });
  if (written) logger.info(`  Claude Desktop: updated ${path}`);
}

/** Whether a directory entry exists at `path`: fail-closed (entryAbsent), so a failed
 *  look reads as "may be there" -- a dangling symlink is present, and a removal that
 *  could not look never skips the file while still releasing its ownership. */
function entryExists(path: string): boolean {
  return !entryAbsent(path);
}

/** Remove `path` when present, announcing the removal; absent means nothing to say. */
function removeAnnounced(path: string): void {
  if (!entryExists(path)) return;
  rmSync(path, { force: true });
  logger.info(`  Claude Desktop: removed ${path}`);
}

/** The ownership ledger's file, for the announcements of a recorded/released claim. */
function ledgerPath(): string {
  return new CopilotApiPaths().ownershipFile;
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

/** `existing` minus OUR managed direct header names (a non-record reads as
 *  empty) -- the ONE strip both payload branches apply, so a stale managed
 *  header survives neither a mode switch nor a credential rotation. */
function foreignCustomHeaders(existing: unknown): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...(isRecord(existing) ? existing : {}) };
  // Names only: any placeholder value yields the same key set, so no UA lookup runs.
  for (const name of Object.keys(directClientHeaders("x", "x"))) {
    delete stripped[name];
  }
  return stripped;
}

/** The payload inputs: the SHARED write variant (mode/identity pairing enforced
 *  by ManagedWrite; this module never probes) plus the entry-local fields. */
export type DesktopPayloadOptions = ManagedWrite & {
  profile: Profile;
  baseUrl: string;
  helperPath: string;
  models?: readonly DesktopModelSpec[];
  /** The entry's current document; foreign keys survive the merge. */
  existing?: Record<string, unknown>;
};

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
    // OUR header names are stripped BEFORE the merge (mirroring the proxy
    // branch): directClientHeaders OMITS the integration id when it is null,
    // so a credential rotation to a null identity must drop the stale header
    // rather than inherit it. A user-added extra header survives.
    doc["inferenceCustomHeaders"] = {
      ...foreignCustomHeaders(doc["inferenceCustomHeaders"]),
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
      const stripped = foreignCustomHeaders(existingHeaders);
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
  const body = desktopHelperBody(mode, profile);
  const path = desktopHelperPath(resolveRootHome(), mode, profile);
  if (readFileOrNull(path) !== body) {
    atomicWriteFile(path, body, 0o755);
    logger.info(`  Claude Desktop: wrote ${path}`);
  } else if (!helperExecutable(path)) {
    chmodSync(path, 0o755);
    logger.info(`  Claude Desktop: made ${path} executable`);
  }
  return path;
}

/** The exact helper-script body a wiring expects -- ONE builder for the writer and the
 *  status inspector, so "wired" always means "this body". */
export function desktopHelperBody(mode: ProfileMode, profile: Profile): string {
  const { command, args } = agentLauncherCommand(
    mode === "direct" ? agentAuthGetArgs(profile) : proxyTokenArgs(profile),
  );
  return WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
}

/** Whether the helper at `path` is executable where that matters (POSIX mode bits; a
 *  Windows .cmd runs by extension). Throws when the file cannot be stat'ed. */
function helperExecutable(path: string): boolean {
  return WIN || (statSync(path).mode & 0o111) === 0o111;
}

/** Remove the OTHER mode's helper script for `profile` -- called post-save on a wire. */
export function retireDesktopHelperScript(mode: ProfileMode, profile: Profile): void {
  const other: ProfileMode = mode === "direct" ? "proxy" : "direct";
  removeAnnounced(desktopHelperPath(resolveRootHome(), other, profile));
}

// --- wiring ------------------------------------------------------------------------

/** One Desktop-entry wiring: the SHARED write variant plus this surface's knobs. */
export type DesktopWireOptions = ManagedWrite & {
  profile: Profile;
  /** Direct only: credential for the catalog fetch (never re-resolved when given). */
  directToken?: string | null;
  quiet?: boolean;
  /** Test seam, threaded to fetchRawModels. */
  fetchImpl?: ProbeFetch;
};

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
 *   ours (ownership-recorded path whose document names `profile`) -> adoptable (foreign
 *   entry whose gateway base URL already matches the target: taken over in place under
 *   its uuid and name, the hand-made helper it referenced retired) -> foreign entry
 *   carrying our name (warn, never clobber) -> a fresh uuid.
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
    (e) =>
      ledger.owns("claudeDesktop", configPathOf(e.id)) &&
      entryProfileAt(configPathOf(e.id)) === opts.profile,
  );
  const commits: (() => void)[] = [];
  if (entry === undefined) {
    // Adoption scan: a foreign entry already wired at the same gateway is the user's
    // hand-made equivalent of what we are about to write -- take it over in place,
    // under the name the user gave it.
    for (const candidate of meta.entries) {
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
      const handMade = legacyHandMadeHelperPath();
      if (
        doc["inferenceCredentialHelper"] === handMade &&
        handMadeHelperUnreferenced(dir, meta, candidate.id, handMade)
      ) {
        // Retired only when NOTHING else references it: Claude Code's own
        // settings.json (the legacy helper-FILE wiring used this very path) and
        // every other Desktop entry are checked first; any doubt keeps the file.
        commits.push(() => removeAnnounced(handMade));
      }
      if (!opts.quiet) {
        logger.info(
          `  Claude Desktop: adopting the existing "${candidate.id}" entry (same gateway).`,
        );
      }
      break;
    }
  }
  // A FOREIGN row carrying the seed name at a DIFFERENT gateway (a same-gateway one was
  // adopted above): never clobber, never twin it. An owned row under that name is the
  // user's rename of another wiring's entry, no obstacle.
  const foreignNamesake = meta.entries.some(
    (e) => e.name === name && !ledger.owns("claudeDesktop", configPathOf(e.id)),
  );
  if (entry === undefined && foreignNamesake) {
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
      // Unparseable content under our path (an in-app edit racing us): rebuild it.
    }
  }

  // Model rows: the launcher hot path (quiet) must NEVER run discovery -- its
  // probes are billed requests. It reuses the recorded rows (or leaves them
  // absent); init / profile-add / `agent claude` refresh live.
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
  // Re-extract the shared write variant so the payload receives the identity
  // only alongside a direct mode (the union spread keeps the pairing).
  const write: ManagedWrite = opts.mode === "direct"
    ? { mode: "direct", directIntegrationId: opts.directIntegrationId }
    : { mode: "proxy" };
  const payload = desktopConfigPayload({
    ...write,
    profile: opts.profile,
    baseUrl,
    helperPath,
    models,
    existing,
  });

  // Config first (a config without a meta row is invisible junk; a meta row without a
  // config is a broken picker row), meta second, ownership + retirements last -- a
  // failed save must never leave a claim on an unwritten entry, a deleted hand-made
  // helper, or a retired mode twin the still-current entry references.
  const configWritten = saveJsonIfChanged(configPath, payload);
  // Announced the moment it lands, before the steps that may still fail. Quiet (the
  // launcher hot path) stays silent only on a byte-identical no-op.
  if (!opts.quiet || configWritten) {
    logger.success(
      `  Claude Desktop: wired "${entry.name}" (${opts.mode}) at ${configPath}; restart Claude Desktop to pick it up.`,
    );
  }
  if (meta.appliedId === null) meta.appliedId = entry.id;
  saveDesktopMeta(dir, meta);
  // Recorded only for a NEW claim: the ledger write is then a real change, never a
  // byte-identical rewrite of a claim already held.
  if (!owned) {
    ledger.record("claudeDesktop", configPath);
    logger.info(`  Claude Desktop: recorded ownership of ${configPath} in ${ledgerPath()}`);
  }
  retireDesktopHelperScript(opts.mode, opts.profile);
  for (const commit of commits) commit();
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

/** Whether the profile store file is absent, empty, or JSON with an object root and an
 *  object-of-objects `profiles` map. The lenient store reader degrades any other shape to
 *  "no profiles", which would make every named entry an orphan to delete: every removal
 *  decision checks this first and touches nothing when it fails. */
export function profileStoreWellFormed(storeFile: string): boolean {
  const read = readTextResult(storeFile);
  if (read.kind === "absent") return true;
  if (read.kind === "unreadable") throw new Error(`could not read ${storeFile}: ${read.error}`);
  if (read.text.trim() === "") return true; // the canonical reader's empty store
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return false;
  }
  if (!isRecord(doc)) return false;
  const profiles = doc["profiles"];
  return profiles === undefined ||
    (isRecord(profiles) && Object.values(profiles).every(isRecord));
}

/** The per-entry reconcile every managed Claude write runs: key on upserts `profile`'s
 *  entry (when the app is installed); key off removes a profile's entry -- never on a
 *  malformed profile store (the same guard the whole-library sweep in
 *  src/agents/claude_desktop.ts sits behind) -- and leaves the default's in place,
 *  silently: the whole-library reconcile after every default command (init, `agent claude`,
 *  import) names it, once; the launcher's default repair runs no reconcile and stays quiet.
 *  Best-effort: a Desktop failure warns and never fails the caller. */
export async function syncClaudeDesktopWiring(opts: DesktopWireOptions): Promise<void> {
  try {
    if (new CopilotEnvConfig().claudeDesktopEnabled()) {
      await wireClaudeDesktopEntry(opts);
      return;
    }
    if (opts.profile === null) return;
    const storeFile = new CopilotApiPaths().sharedStateFile;
    if (!profileStoreWellFormed(storeFile)) {
      logger.warn(
        `  Claude Desktop: the profile store ${storeFile} is malformed; leaving the config library alone.`,
      );
      return;
    }
    removeClaudeDesktopEntry(opts.profile);
  } catch (e) {
    logger.warn(
      `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${errMessage(e)}`,
    );
  }
}

/** Remove the owned entries serving `profile` (config file + meta row + helper scripts);
 *  a foreign entry -- even one carrying our name -- is never touched. Best-effort. */
export function removeClaudeDesktopEntry(profile: Profile): void {
  removeOwned(
    `the Claude Desktop entry for ${profileLabel(profile)}`,
    (e) => entryProfileAt(e.path) === profile,
    profile,
  );
}

/** Remove one orphan by its path, plus its profile's helper scripts when its document
 *  named one. Best-effort. */
export function removeClaudeDesktopOrphan(orphan: DesktopOwnedEntry): void {
  removeOwned(
    `the orphaned Claude Desktop entry at ${orphan.path}`,
    (e) => e.path === orphan.path,
    orphan.profile,
  );
}

function removeOwned(
  what: string,
  selects: (owned: OwnedDesktopEntry) => boolean,
  helpersOf: Profile | undefined,
): void {
  try {
    // A blocked sweep (malformed _meta.json) may leave a live entry pointing at
    // these scripts: only delete them when the library was actually processed.
    if (removeOwnedEntries(selects) === "blocked") return;
    if (helpersOf !== undefined) removeHelperScripts(helpersOf);
  } catch (e) {
    logger.warn(`  Could not remove ${what}: ${errMessage(e)}`);
  }
}

/** Both modes' helper scripts for `profile`, removed when present. */
function removeHelperScripts(profile: Profile): void {
  const rootHome = resolveRootHome();
  removeAnnounced(desktopHelperPath(rootHome, "direct", profile));
  removeAnnounced(desktopHelperPath(rootHome, "proxy", profile));
}

/** The filename grammar desktopHelperPath produces (either platform's extension). */
const HELPER_SCRIPT_NAME_RE = /^claude-desktop-(proxy-)?token(?:-([a-z0-9-]+))?\.(?:sh|cmd)$/;

/** The wiring a helper script's FILENAME encodes (the inverse of desktopHelperPath), or
 *  undefined for a name that is not ours -- a reserved word like `default` included -- so
 *  a sweep by filename can name every generated script without a store, yet never a
 *  neighbour's file. */
export function desktopHelperScriptWiring(
  name: string,
): { mode: ProfileMode; profile: Profile } | undefined {
  const match = HELPER_SCRIPT_NAME_RE.exec(name);
  if (match === null) return undefined;
  const mode: ProfileMode = match[1] === undefined ? "direct" : "proxy";
  if (match[2] === undefined) return { mode, profile: null };
  try {
    return { mode, profile: parseProfileName(match[2]) };
  } catch {
    return undefined;
  }
}

/** Every generated helper script present under `rootHome`, sorted. An absent root home
 *  is an empty list; any other read failure throws (a sweep must not claim completeness
 *  over a directory it could not list). */
export function presentDesktopHelperScripts(rootHome: string): string[] {
  let names: string[];
  try {
    names = readdirSync(rootHome);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
  return names
    .filter((n) => desktopHelperScriptWiring(n) !== undefined)
    .sort()
    .map((n) => join(rootHome, n));
}

/** The uninstall sweep: every owned entry (the default's included) plus every generated
 *  helper script. `dirOverride` is the injected library dir (homedir() is not
 *  env-redirectable on Windows); null means "treat Desktop as absent". */
export function removeAllClaudeDesktopWiring(dirOverride?: string | null): void {
  if (removeOwnedEntries(() => true, dirOverride) === "blocked") return;
  removeUnlistedClaudeDesktopClaims(dirOverride);
  // Helper scripts live under the root home, which uninstall deletes wholesale right
  // after this step -- still removed here so the step is complete on its own.
  for (const path of presentDesktopHelperScripts(resolveRootHome())) removeAnnounced(path);
}

/** The `claude-desktop false` sweep: every owned claim POSITIVELY attributed to a named
 *  profile goes -- listed entry or unlisted leftover, judged by its document alike -- with
 *  its helper scripts; the default's entry and helper stay in place, unmanaged, and are
 *  named (unless `quiet`, the steady-state hot path). Fail closed: a claim that cannot be
 *  attributed (document missing, damaged, naming no helper of ours, or unreadable) is
 *  warned about and left, file and claim -- it may be the default's. */
export function removeUnmanagedClaudeDesktopWiring(opts: { quiet?: boolean } = {}): void {
  const sweepable = (path: string): boolean => {
    let profile: Profile | undefined;
    try {
      profile = entryProfileAt(path);
    } catch (e) {
      logger.warn(`  Claude Desktop: ${errMessage(e)}; left alone.`);
      return false;
    }
    if (profile === undefined) {
      logger.warn(
        `  Claude Desktop: ${path} names no copilot-env credential helper, so its wiring is unknown; left alone.`,
      );
    }
    return profile !== undefined && profile !== null;
  };
  if (removeOwnedEntries((e) => sweepable(e.path)) === "blocked") return;
  removeUnlistedClaudeDesktopClaims(undefined, sweepable);
  for (const path of presentDesktopHelperScripts(resolveRootHome())) {
    if (desktopHelperScriptWiring(basename(path))?.profile !== null) removeAnnounced(path);
  }
  if (!opts.quiet) announceUnmanagedDefault();
}

/** Name every owned claim the key-off sweep leaves in place as the default's (listed or
 *  not), so the user knows it is theirs now and nothing was rewritten. One that could not
 *  be attributed is skipped: the sweep already warned about it. */
function announceUnmanagedDefault(): void {
  const dir = resolveDesktopLibraryDir();
  const library = dir === null ? null : readOwnedLibrary(dir);
  if (library === null) return;
  const claims = [
    ...library.owned.map((e) => [`"${e.entry.name}" at ${e.path}`, e.path] as const),
    ...library.unlisted.map((p) => [`${p} (not listed in ${META_FILENAME})`, p] as const),
  ];
  for (const [label, path] of claims) {
    try {
      if (entryProfileAt(path) !== null) continue;
    } catch {
      continue;
    }
    logger.info(`  Claude Desktop: ${label} left in place, unmanaged (claude-desktop false).`);
  }
}

/** What removeAllClaudeDesktopWiring WOULD delete now (the uninstall dry run): owned config
 *  files present plus generated helper scripts. Read-only; `blocked` mirrors the sweep (a
 *  not-understood _meta.json leaves the library alone). */
export function listClaudeDesktopOwnedArtifacts(
  dirOverride?: string | null,
): { entries: string[]; helpers: string[]; blocked: boolean } {
  const helpers = presentDesktopHelperScripts(resolveRootHome());
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { entries: [], helpers, blocked: false };
  const library = readOwnedLibrary(dir);
  if (library === null) return { entries: [], helpers, blocked: true };
  return {
    entries: [...library.owned.map((e) => e.path), ...library.unlisted].filter(entryExists),
    helpers,
    blocked: false,
  };
}

/** An owned entry as the library lists it: its meta row plus its config path. */
interface OwnedDesktopEntry {
  entry: DesktopMetaEntry;
  path: string;
}

/** The profile the entry document at `path` serves (its credential helper's filename), or
 *  undefined when it names none (absent or damaged: no target can claim it, so it is an
 *  orphan). An UNREADABLE document throws: a failed look is never "not ours". */
function entryProfileAt(path: string): Profile | undefined {
  const raw = readFileOrNull(path);
  if (raw === null) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const helper = isRecord(doc) ? doc["inferenceCredentialHelper"] : undefined;
  return typeof helper === "string"
    ? desktopHelperScriptWiring(basename(helper))?.profile
    : undefined;
}

/** The library read once: its parsed meta, the owned entries it lists, and the ledger
 *  claims under the dir it no longer lists (`unlisted` -- an interrupted removal's
 *  invisible leftovers, config file present or not). */
interface OwnedLibrary {
  meta: DesktopMeta;
  owned: OwnedDesktopEntry[];
  unlisted: string[];
}

/** The ledger's Desktop claims that are DIRECT entry files of `dir` (`<id>.json`, one
 *  segment down -- a trailing separator on `dir` or a nested path changes nothing), as one
 *  snapshot (one ledger read, not one per row). */
function claimsUnder(ledger: OwnershipLedger, dir: string): Set<string> {
  return new Set(
    ledger.ownedPaths("claudeDesktop").filter((p) => {
      const rel = relative(dir, p);
      return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..") && !rel.includes(sep) &&
        rel.endsWith(".json");
    }),
  );
}

/** The library's owned entries (ownership-recorded config paths), read-only. Null when
 *  _meta.json is unreadable or not understood (nothing can be judged or swept). A
 *  missing _meta.json is an empty library. */
function readOwnedLibrary(dir: string): OwnedLibrary | null {
  let raw: string | null;
  try {
    raw = readFileOrNull(join(dir, META_FILENAME));
  } catch {
    return null;
  }
  const meta = parseDesktopMeta(raw);
  if (meta === null) return null;
  const claims = claimsUnder(new OwnershipLedger(), dir);
  const owned: OwnedDesktopEntry[] = [];
  for (const entry of meta.entries) {
    const path = join(dir, `${entry.id}.json`);
    if (claims.has(path)) owned.push({ entry, path });
  }
  const listed = new Set(owned.map((e) => e.path));
  const unlisted = [...claims].filter((p) => !listed.has(p)).sort();
  return { meta, owned, unlisted };
}

/** Release the ledger claims `_meta.json` no longer lists, deleting their files when
 *  present: the leftovers of a removal that failed after the meta save. `dirOverride` as
 *  in removeAllClaudeDesktopWiring; an unreadable library is left alone (`blocked`).
 *  `selects` narrows the sweep (the key-off attribution). */
export function removeUnlistedClaudeDesktopClaims(
  dirOverride?: string | null,
  selects: (path: string) => boolean = () => true,
): "swept" | "blocked" {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return "swept";
  const library = readOwnedLibrary(dir);
  if (library === null) return "blocked";
  const ledger = new OwnershipLedger();
  for (const path of library.unlisted) {
    if (!selects(path)) continue;
    removeAnnounced(path);
    ledger.release("claudeDesktop", path);
    logger.info(`  Claude Desktop: released ownership of ${path} in ${ledgerPath()}`);
  }
  return "swept";
}

/** Shared removal core: drop every OWNED meta entry `selects` picks and its appliedId
 *  reference (a foreign row is never a candidate). Ordering is meta FIRST, config files
 *  second, ownership un-record last: a failure mid-way can leave an orphaned (invisible)
 *  config file, but never a picker row whose config is gone. */
function removeOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
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
  const claims = claimsUnder(ledger, dir);
  const removedPaths: string[] = [];
  const kept: DesktopMetaEntry[] = [];
  for (const entry of meta.entries) {
    const configPath = join(dir, `${entry.id}.json`);
    if (claims.has(configPath) && selects({ entry, path: configPath })) {
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
    removeAnnounced(path);
    ledger.release("claudeDesktop", path);
    logger.info(`  Claude Desktop: released ownership of ${path} in ${ledgerPath()}`);
  }
  return "swept";
}

// --- status (read-only) --------------------------------------------------------------

/** One expected Desktop entry: a wiring's profile and the mode its source of truth
 *  records (settings.json's managed mode for the default, the store slot for a profile). */
export interface DesktopTarget {
  profile: Profile;
  mode: ProfileMode;
}

/** How one expected entry compares with the library: present and matching its target,
 *  absent, or present but not what the target needs (`reason` names the mismatch). */
export type DesktopEntryVerdict =
  | { kind: "wired"; path: string }
  | { kind: "missing" }
  /** `fix` overrides the target's rewire command when a rewire cannot repair it. */
  | { kind: "stale"; path: string; reason: string; fix?: string };

export type DesktopEntryStatus = DesktopTarget & { verdict: DesktopEntryVerdict };

/** An owned claim as the status reports it: the uuid path and the wiring its document
 *  names -- undefined when it names none (see entryProfileAt), which no target can claim. */
export interface DesktopClaim {
  path: string;
  profile: Profile | undefined;
}

/** A listed owned entry: its claim plus the display name (the user's). An orphan is one
 *  no current target promises. */
export type DesktopOwnedEntry = DesktopClaim & { name: string };

/** The promised targets, or why they cannot be known. An unreadable or malformed
 *  settings.json is NOT "the default promises nothing": that reading is what would
 *  make the default's entry an orphan to delete. */
export type DesktopTargetResolution =
  | { kind: "resolved"; targets: readonly DesktopTarget[] }
  | { kind: "unresolvable"; reason: string };

/** The library's common facts: the `claude-desktop` key and the app detection. */
interface DesktopStatusBase {
  enabled: boolean;
  installed: boolean;
  /** Every generated helper script present under the root home (key off: leftovers). */
  helperPaths: string[];
}

/** The Desktop wiring as `agent claude --check` and the health engine report it. Each
 *  failed look (an unreadable library, unknowable targets) is its own kind, so it can
 *  never render as a clean one. */
export type ClaudeDesktopStatus =
  | (DesktopStatusBase & { kind: "no-library" })
  | (DesktopStatusBase & { kind: "unreadable"; metaPath: string })
  /** A failed look: the promised targets could not be known (Claude's own settings.json
   *  could not be read or parsed) or an owned document could not be read, so no entry is
   *  judged and none may be swept as an orphan. */
  | (DesktopStatusBase & { kind: "unjudged"; reason: string })
  | (DesktopStatusBase & {
    kind: "inspected";
    libraryDir: string;
    /** Every owned entry the library lists, whatever the key says. */
    owned: DesktopOwnedEntry[];
    /** One verdict per target; empty when the key is off or the app is absent. */
    entries: DesktopEntryStatus[];
    /** Owned entries matching no target; empty when the key is off or the app is absent. */
    orphans: DesktopOwnedEntry[];
    /** Ledger claims under the library `_meta.json` no longer lists (interrupted removals),
     *  attributed like the listed entries. */
    unlisted: DesktopClaim[];
  });

/** Judge the library against the promised targets WITHOUT writing or reserving anything
 *  (read-only port resolution). The caller supplies the targets: the default's mode lives
 *  in settings.json, read above this module. `dirOverride` as in removeAllClaudeDesktopWiring. */
export function inspectClaudeDesktopWiring(
  promised: readonly DesktopTarget[] | DesktopTargetResolution,
  dirOverride?: string | null,
): ClaudeDesktopStatus {
  const resolution: DesktopTargetResolution = "kind" in promised
    ? promised
    : { kind: "resolved", targets: promised };
  // Verdict order: the library's own facts first (no library, unreadable, key off or app
  // absent -- leftovers must show whatever the targets are), then the targets.
  const base = desktopStatusBase(dirOverride);
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { ...base, kind: "no-library" };
  const library = readOwnedLibrary(dir);
  if (library === null) return { ...base, kind: "unreadable", metaPath: join(dir, META_FILENAME) };
  // Attribution (which wiring each owned document serves) is read whatever the key says:
  // the key-off report tells the default's entry, left in place, from the leftovers by it.
  let judged: JudgedDesktopEntry[];
  let unlisted: DesktopClaim[];
  try {
    judged = library.owned.map((e) => ({ ...e, profile: entryProfileAt(e.path) }));
    unlisted = library.unlisted.map((path) => ({ path, profile: entryProfileAt(path) }));
  } catch (e) {
    return { ...base, kind: "unjudged", reason: errMessage(e) };
  }
  const status: ClaudeDesktopStatus = {
    ...base,
    kind: "inspected",
    libraryDir: dir,
    owned: judged.map((e) => ({ name: e.entry.name, path: e.path, profile: e.profile })),
    entries: [],
    orphans: [],
    unlisted,
  };
  if (!base.enabled || !base.installed) return status;
  if (resolution.kind === "unresolvable") {
    return { ...base, kind: "unjudged", reason: resolution.reason };
  }
  const rootHome = resolveRootHome();
  status.entries = resolution.targets.map((t) => ({
    ...t,
    verdict: entryVerdict(judged, t, rootHome),
  }));
  const wanted = new Set(resolution.targets.map((t) => t.profile));
  status.orphans = status.owned.filter((e) => e.profile === undefined || !wanted.has(e.profile));
  return status;
}

/** The facts every status arm carries (see DesktopStatusBase). */
export function desktopStatusBase(dirOverride?: string | null): DesktopStatusBase {
  return {
    enabled: new CopilotEnvConfig().claudeDesktopEnabled(),
    installed: dirOverride !== undefined ? dirOverride !== null : claudeDesktopInstalled(),
    helperPaths: presentDesktopHelperScripts(resolveRootHome()),
  };
}

type JudgedDesktopEntry = OwnedDesktopEntry & { profile: ReturnType<typeof entryProfileAt> };

function entryVerdict(
  owned: JudgedDesktopEntry[],
  target: DesktopTarget,
  rootHome: string,
): DesktopEntryVerdict {
  const matches = owned.filter((e) => e.profile === target.profile);
  const found = matches[0];
  if (found === undefined) return { kind: "missing" };
  const path = found.path;
  const stale = (reason: string): DesktopEntryVerdict => ({ kind: "stale", path, reason });
  if (matches.length > 1) {
    // A rewire only ever touches one of them, so the repair is manual.
    return {
      kind: "stale",
      path,
      reason: `${matches.length} owned entries serve this wiring`,
      fix:
        "delete the duplicate copilot-env entries in Claude Desktop's config picker, then re-run `agent claude`",
    };
  }
  let raw: string | null;
  let doc: unknown;
  try {
    raw = readFileOrNull(path);
    if (raw === null) return stale("the config file is missing");
    doc = JSON.parse(raw);
  } catch {
    return stale("the config file could not be read or parsed");
  }
  if (!isRecord(doc)) return stale("the config file is not a JSON object");
  const expectedBase = target.mode === "direct"
    ? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(copilotApiResolvePort(target.profile));
  const gateway = doc["inferenceGatewayBaseUrl"];
  if (!sameBaseUrl(gateway, expectedBase)) {
    return stale(`gateway ${String(gateway)}, expected ${expectedBase}`);
  }
  const helper = desktopHelperPath(rootHome, target.mode, target.profile);
  const recorded = doc["inferenceCredentialHelper"];
  if (recorded !== helper) {
    return stale(`credential helper ${String(recorded)}, expected ${helper}`);
  }
  // The helper must be the body this wiring would write, and runnable: a failed look
  // is a stale verdict, never a wired one.
  try {
    if (readFileOrNull(helper) !== desktopHelperBody(target.mode, target.profile)) {
      return stale(`credential helper ${helper} is missing or has a stale body`);
    }
    if (!helperExecutable(helper)) return stale(`credential helper ${helper} is not executable`);
  } catch (e) {
    return stale(`credential helper ${helper} could not be checked: ${errMessage(e)}`);
  }
  // Wired means the QUIET rewire (the launcher hot path: recorded rows, the replayed
  // identity, the live codex User-Agent, no probe) would be a byte-identical no-op -- the
  // same bytes saveJsonIfChanged compares. A direct entry must also carry model rows.
  const write: ManagedWrite = target.mode === "direct"
    ? { mode: "direct", directIntegrationId: expectedIntegrationId(target.profile, doc) }
    : { mode: "proxy" };
  const rewrite = desktopConfigPayload({
    ...write,
    profile: target.profile,
    baseUrl: expectedBase,
    helperPath: helper,
    models: recordedModelRows(doc) ?? undefined,
    existing: doc,
  });
  if (`${JSON.stringify(rewrite, null, 2)}\n` !== raw) {
    return stale("the managed keys drifted (a rewire would change the entry)");
  }
  const rows = doc["inferenceModels"];
  if (target.mode === "direct" && (!Array.isArray(rows) || rows.length === 0)) {
    return stale("no model rows (re-run `agent claude` online)");
  }
  return { kind: "wired", path };
}

/** The identity a rewire would bake, without probing: the config pin, else the slot's
 *  persisted verdict (the replay every rewire uses), else -- never probed yet -- the one
 *  the document already carries. */
function expectedIntegrationId(profile: Profile, doc: Record<string, unknown>): string | null {
  const pin = new CopilotEnvConfig().pinnedIntegrationId();
  if (pin !== null) return pin;
  const slot = new CopilotEnvState().readProfileSlot(profile).integrationIdentity;
  if (slot !== null) return slot === CODEX_IDENTITY_NAME ? null : slot;
  return recordedHeader(doc, INTEGRATION_ID_HEADER);
}

/** A direct entry's recorded custom header value, or null when absent/blank. */
function recordedHeader(doc: Record<string, unknown>, name: string): string | null {
  const headers = doc["inferenceCustomHeaders"];
  const value = isRecord(headers) ? headers[name] : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/** The repair command for one target's entry: the default rides on `agent claude`,
 *  a named profile on its atomic re-add (mode sticky from the store). */
function desktopEntryFix(profile: Profile): string {
  return profile === null ? "agent claude" : `agent profile --add ${profile}`;
}

/** Render a status as human lines plus the repair command(s) when it shows drift (a failed
 *  look, a missing/stale/orphaned entry, leftovers with the key off), null otherwise. Shared
 *  by `agent claude --check` and the health check so the two can never disagree. */
export function renderClaudeDesktopStatus(
  status: ClaudeDesktopStatus,
): { lines: string[]; fix: string | null } {
  if (status.kind === "unreadable") {
    return {
      lines: [`${status.metaPath} has an unexpected shape; the config library is left alone`],
      fix: `repair ${status.metaPath}, then re-run \`agent claude\``,
    };
  }
  // A failed look is reported before every other verdict: it must never render as clean.
  if (status.kind === "unjudged") {
    return {
      lines: [`${status.reason}; the Desktop entries were not judged`],
      fix: "fix the cause named above, then re-run `agent claude`",
    };
  }
  if (!status.enabled) {
    // The default's entry and helper stay by design; leftovers are the profile entries
    // (listed or not) and helper scripts an interrupted sweep can leave.
    const owned = status.kind === "inspected" ? status.owned : [];
    const unlisted = status.kind === "inspected" ? status.unlisted : [];
    const unmanaged = [
      ...owned.filter((e) => e.profile === null).map((e) =>
        `"${e.name}" present at ${e.path}, unmanaged (claude-desktop false)`
      ),
      ...unlisted.filter((c) => c.profile === null).map((c) =>
        `${c.path} present but not listed in ${META_FILENAME}, unmanaged (claude-desktop false)`
      ),
    ];
    // A claim of unknown wiring is one the key-off sweep deliberately keeps (it may be the
    // default's), so `agent claude` cannot clear it while the key is off: only the key-on
    // reconcile (which removes it as an orphan) or uninstall does.
    const claims = [...owned, ...unlisted];
    const unknown = claims.filter((c) => c.profile === undefined).map((c) => c.path);
    const left = [
      ...claims.filter((c) => c.profile !== null && c.profile !== undefined).map((c) => c.path),
      ...status.helperPaths.filter((p) => desktopHelperScriptWiring(basename(p))?.profile !== null),
    ];
    if (left.length === 0 && unknown.length === 0) {
      return {
        lines: [...unmanaged, "disabled (claude-desktop false); no copilot-env leftovers present"],
        fix: null,
      };
    }
    const total = left.length + unknown.length;
    const fixes = [
      ...(left.length > 0 ? ["agent claude"] : []),
      ...(unknown.length > 0
        ? [
          "for the entries of unknown wiring: set claude-desktop true and re-run `agent claude` (it removes them as orphans), or `agent uninstall`",
        ]
        : []),
    ];
    return {
      lines: [
        ...unmanaged,
        `disabled (claude-desktop false), but ${total} copilot-env leftover${
          total === 1 ? " remains" : "s remain"
        } (files or ownership claims)`,
        ...left,
        ...unknown.map((p) => `${p} (wiring unknown: it names no copilot-env credential helper)`),
      ],
      fix: fixes.join("; "),
    };
  }
  if (!status.installed || status.kind === "no-library") {
    return { lines: ["Claude Desktop not detected on this machine; nothing to wire"], fix: null };
  }
  if (status.entries.length === 0 && status.orphans.length === 0 && status.unlisted.length === 0) {
    return {
      lines: ["nothing to wire yet (Claude is not managed by copilot-env and no profile exists)"],
      fix: null,
    };
  }
  const lines: string[] = [];
  const fixes = new Set<string>();
  // An entry is labelled by the display name it carries in the app (the user's, possibly
  // renamed); a missing one by the name a wire would seed.
  const nameAt = (path: string) => status.owned.find((o) => o.path === path)?.name;
  for (const e of status.entries) {
    const shown = "path" in e.verdict ? nameAt(e.verdict.path) : undefined;
    const who = `"${shown ?? desktopEntryName(e.profile)}" (${e.mode})`;
    switch (e.verdict.kind) {
      case "wired":
        lines.push(`${who} wired at ${e.verdict.path}`);
        break;
      case "missing":
        lines.push(`${who} missing`);
        fixes.add(desktopEntryFix(e.profile));
        break;
      case "stale":
        lines.push(`${who} stale at ${e.verdict.path}: ${e.verdict.reason}`);
        fixes.add(e.verdict.fix ?? desktopEntryFix(e.profile));
        break;
      default:
        assertNever(e.verdict);
    }
  }
  for (const { path } of status.unlisted) {
    lines.push(
      `${path} is still claimed in the ownership ledger but no longer listed in ${META_FILENAME}${
        entryExists(path) ? "" : ", and its file is gone"
      } (an interrupted removal)`,
    );
    fixes.add("agent claude");
  }
  for (const o of status.orphans) {
    lines.push(`"${o.name}" orphaned at ${o.path} (no current wiring promises it)`);
    fixes.add("agent claude");
  }
  return { lines, fix: fixes.size === 0 ? null : [...fixes].join(", then ") };
}
