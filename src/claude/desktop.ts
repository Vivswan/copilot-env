// Claude Desktop reads none of Claude Code's settings.json; its only local config surface is this
// library, whose documents use the FLAT keys documented at
// claude.com/docs/third-party/claude-desktop/configuration (the nested "$schemaVersion: 2" export
// is not what it stores). Ownership is by exact uuid path in the ledger, recorded after save; the
// display name is the user's.
//   macOS:    ~/Library/Application Support/Claude-3p/configLibrary/<uuid>.json
//   Windows:  %LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json
//   Linux:    ${XDG_CONFIG_HOME:-~/.config}/Claude-3p/configLibrary/<uuid>.json
//   index:    _meta.json = {appliedId, entries:[{id,name}]}
// Two app files beside the library decide what the app does with the entry at launch (both are
// what the app itself writes when the user clicks through; see prepareClaudeDesktopAppFiles):
//   Claude-3p/claude_desktop_config.json  deploymentMode "3p"  -> boots third-party, no sign-in chooser
//   Claude/developer_settings.json        allowDevTools true   -> Developer menu (the 3p copy too)
// Desktop discovers models at `<gateway>/v1/models`, hardcoded: Copilot Direct 404s it, so direct
// entries carry an explicit inferenceModels list; the proxy serves it, so proxy entries discover.
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { codexUserAgent } from "../codex/user_agent.ts";
import { type ManagedMode, type ManagedWrite, reservePlannedPort } from "../agents/configure.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
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
import { CopilotApiPaths, HELPERS_DIR_NAME, resolveRootHome } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin } from "../copilot_api/port.ts";
import {
  agentStartCommand,
  parseProfileName,
  type Profile,
  profileLabel,
  type ProfileName,
  WINDOWS_DEVICE_NAME_RE,
} from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { appRunning, type AppScan } from "../utils/app_scan.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenArgs } from "../utils/root.ts";
import type { DesktopOwnedEntry } from "./desktop_status.ts";
import { cmdHelperBody, posixExecBody } from "./helper_body.ts";

const logger = createStderrLogger();

const WIN = process.platform === "win32";

type Doc = Record<string, unknown>;

/** The table at `key` of `doc`, made (a leaf in the way replaced, as the writers always did). */
function tableAt(doc: Doc, key: string): Doc {
  const table = isRecord(doc[key]) ? doc[key] : {};
  doc[key] = table;
  return table;
}

// --- paths + detection ---------------------------------------------------------

/** Test seam. When set it also GOVERNS detection: the dir's existence means Desktop is installed,
 *  so the suite floor points it at a non-created dir and the whole suite sees no Desktop. */
export const CLAUDE_DESKTOP_DIR_ENV = "COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR";

/** The environment the app's data dirs derive from, one field per platform. */
export interface DesktopEnv {
  localAppData?: string;
  appData?: string;
  xdgConfigHome?: string;
}

function desktopEnv(): DesktopEnv {
  return {
    localAppData: process.env.LOCALAPPDATA,
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  };
}

/** Electron's userData root on Linux. The XDG spec reads an EMPTY or RELATIVE variable as unset
 *  (a relative one would land the app files in the working directory). */
function linuxConfigRoot(home: string, env: DesktopEnv): string {
  const xdg = env.xdgConfigHome;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
}

/** Platform-parameterized so every branch runs on every CI runner. */
export function desktopDataDirFor(platform: string, home: string, env: DesktopEnv): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude-3p");
  if (platform === "win32") {
    return env.localAppData ? join(env.localAppData, "Claude-3p") : null;
  }
  if (platform === "linux") return join(linuxConfigRoot(home, env), "Claude-3p");
  return null;
}

/** The app's default (claude.ai) data dir. Developer Mode is read from here even in third-party
 *  mode: the app resolves developer_settings.json before it switches its data dir to Claude-3p.
 *  Electron's default userData is the ROAMING AppData on Windows, unlike the Claude-3p dir. */
export function desktopStandardDataDirFor(
  platform: string,
  home: string,
  env: DesktopEnv,
): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude");
  if (platform === "win32") {
    return env.appData ? join(env.appData, "Claude") : null;
  }
  if (platform === "linux") return join(linuxConfigRoot(home, env), "Claude");
  return null;
}

/** Under the seam, the standard dir is the seam's `-1p` sibling. */
export function resolveDesktopDataDirs(): { data: string; standard: string } | null {
  const seam = seamDir();
  if (seam !== null) return { data: seam, standard: `${seam}-1p` };
  const data = desktopDataDirFor(process.platform, homedir(), desktopEnv());
  const standard = desktopStandardDataDirFor(process.platform, homedir(), desktopEnv());
  return data === null || standard === null ? null : { data, standard };
}

export function desktopLibraryDirUnder(dataDir: string): string {
  return join(dataDir, "configLibrary");
}

/** A relative seam throws: quietly falling back to the real library is the one outcome a seam must
 *  never have. */
function seamDir(): string | null {
  const dir = process.env[CLAUDE_DESKTOP_DIR_ENV];
  if (dir === undefined) return null;
  if (!isAbsolute(dir)) {
    throw new Error(`${CLAUDE_DESKTOP_DIR_ENV} must be an absolute path (got: ${dir})`);
  }
  return dir;
}

export function resolveDesktopLibraryDir(): string | null {
  const seam = seamDir();
  if (seam !== null) return desktopLibraryDirUnder(seam);
  const dataDir = desktopDataDirFor(process.platform, homedir(), desktopEnv());
  return dataDir === null ? null : desktopLibraryDirUnder(dataDir);
}

/** Either data dir counts as installed too: an app installed somewhere unusual that has run. On
 *  Linux (no fixed install path) that is the only signal. */
export function desktopAppInstalledFor(
  platform: string,
  exists: (path: string) => boolean,
  home: string,
  env: DesktopEnv,
): boolean {
  for (const dir of [desktopDataDirFor, desktopStandardDataDirFor]) {
    const dataDir = dir(platform, home, env);
    if (dataDir !== null && exists(dataDir)) return true;
  }
  if (platform === "darwin") {
    return exists("/Applications/Claude.app") || exists(join(home, "Applications", "Claude.app"));
  }
  if (platform === "win32") {
    return env.localAppData !== undefined &&
      exists(join(env.localAppData, "AnthropicClaude", "claude.exe"));
  }
  return false;
}

export function claudeDesktopInstalled(): boolean {
  const seam = seamDir();
  if (seam !== null) return fs.exists(seam);
  return desktopAppInstalledFor(process.platform, fs.exists, homedir(), desktopEnv());
}

// --- entry naming + classification ----------------------------------------------

export function desktopEntryName(profile: Profile): string {
  return profile === null ? "copilot-env" : `copilot-env: ${profile}`;
}

/** A hand-typed trailing slash is the same gateway. */
export function sameBaseUrl(a: unknown, b: string): boolean {
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

export const META_FILENAME = "_meta.json";

/** Ids become `<id>.json` filenames, so a hand-mangled id must neither escape the library dir nor
 *  collide with _meta.json: no separators, no leading dot or underscore, and no Windows reserved
 *  device name (`CON.json` is a device path there). */
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeEntryId(id: string): boolean {
  if (!SAFE_ENTRY_ID.test(id)) return false;
  const stem = id.split(".", 1)[0] ?? id;
  return !WINDOWS_DEVICE_NAME_RE.test(stem.toLowerCase());
}

/** FAIL-CLOSED: any shape this module does not fully understand is null, and the caller leaves the
 *  library alone (it is the app's file, not ours to repair). Fields beyond the understood ones ride
 *  through `extra` so a save never drops them. */
export function parseDesktopMeta(raw: string | null): DesktopMeta | null {
  // Only a MISSING file is an empty library; present-but-blank is damage (the app never writes it).
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
    // Duplicate ids would make path-keyed removal delete a config a surviving foreign row still
    // references. Folded case: Windows and default macOS filesystems make `Foo.json` and `foo.json`
    // one file.
    const folded = entry.id.toLowerCase();
    if (seen.has(folded)) return null;
    seen.add(folded);
    const { id, name, ...extra } = entry;
    entries.push({ id, name, extra });
  }
  const { appliedId: _a, entries: _e, ...extra } = doc;
  return { appliedId: typeof doc.appliedId === "string" ? doc.appliedId : null, entries, extra };
}

/** Null only when PROVEN absent. A dangling symlink is unreadable, never absent (the entry exists,
 *  and a rewrite would replace the app's or user's link with a plain file); every other failure
 *  throws: an unreadable library treated as absent would be re-created beside the real one. */
export function readFileOrNull(path: string): string | null {
  const read = fs.readTextResult(path);
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") throw new Error(`could not read ${path}: ${read.error}`);
  return read.text;
}

/** A whole-document rewrite of a Desktop file that may carry a baked `inferenceGatewayApiKey`
 *  (the migrations' retarget): the file holds secrets, so a dry run prints its verdict alone. False
 *  when the file already holds the bytes. */
export function saveJsonIfChanged(path: string, doc: unknown, detail?: string): boolean {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (readFileOrNull(path) === text) return false;
  fs.writeText(path, text, { detail, secret: true });
  return true;
}

function parsedRecord(raw: string | null): Doc | null {
  return raw === null ? null : parseJsonRecord(raw);
}

/** A JSON write: the bytes land unless the file already holds them (true when written). `secretKeys`
 *  names the leaves a preview redacts. */
function writeJson(
  path: string,
  currentRaw: string | null,
  doc: Doc,
  detail: string,
  secretKeys: Iterable<string> = [],
): boolean {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (currentRaw === text) return false;
  fs.writeText(path, text, { detail, secretKeys });
  return true;
}

/** `_meta.json` rebuilt from the parsed index: the app's other fields first, then the two we own. */
function writeDesktopMeta(dir: string, currentRaw: string | null, meta: DesktopMeta): boolean {
  const doc: Doc = { ...meta.extra };
  if (meta.appliedId !== null) doc.appliedId = meta.appliedId;
  doc.entries = meta.entries.map((e) => ({ ...e.extra, "id": e.id, "name": e.name }));
  return writeJson(
    join(dir, META_FILENAME),
    currentRaw,
    doc,
    "Claude Desktop config-library index",
  );
}

/** Fail-closed (entryAbsent): a failed look reads "may be there", a dangling symlink is present,
 *  and a removal that could not look never skips the file while still releasing its ownership. */
export function entryExists(path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (e) {
    return !isEnoentOrNotdir(e);
  }
}

/** How a removal's report names an entry file. */
const ENTRY = "Claude Desktop entry";
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

/** `claude-fable-5` -> `Claude Fable 5`; `claude-opus-4.8` and `claude-opus-4-8` -> `Claude Opus
 *  4.8`. Without a labelOverride the app's config editor shows the row's Display name blank. */
export function desktopModelLabel(id: string): string {
  const words: string[] = [];
  for (const token of id.split("-")) {
    const last = words[words.length - 1];
    // Only PURE 1-2 digit tokens fold into a dotted version (the model-id grammar's minor cap), so
    // "20251001" or "1m" stays its own word.
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

/** The profile selector rides along so a named profile's web search resolves ITS credential (a
 *  named profile never falls back to the default). Rows are Desktop's documented managedMcpServers
 *  shape (an ARRAY; an object keyed by name is rejected as invalid_type and silently dropped).
 *  Foreign rows survive by name; a value of any other shape is our own former object and goes. */
export const MCP_SERVER_NAME = "copilot-env";
/** The `agent` subcommand a profile's entry spawns: `mcp --serve` for the default (its alias), the
 *  profile verb for a named one. One spelling for the writer, the two readers below, and the
 *  4.0.9 migration's rewrite of the old shape. */
export function mcpServeArgs(profile: Profile): string[] {
  return profile === null ? ["mcp", "--serve"] : ["profile", profile, "mcp", "--serve"];
}
function managedMcpServers(profile: Profile, existing: unknown): Record<string, unknown>[] {
  const { command, args } = agentLauncherCommand(mcpServeArgs(profile));
  const foreign = Array.isArray(existing)
    ? existing.filter((row): row is Record<string, unknown> =>
      isRecord(row) && row["name"] !== MCP_SERVER_NAME
    )
    : [];
  return [
    ...foreign,
    { "name": MCP_SERVER_NAME, "transport": "stdio", "command": command, "args": args },
  ];
}

/** The Direct client header names, the ONE strip both payload branches apply, so a stale managed
 *  header survives neither a mode switch nor a credential rotation. Names only: any placeholder
 *  value yields the same key set, so no UA lookup runs at import. */
const MANAGED_HEADER_NAMES: readonly string[] = Object.keys(directClientHeaders("x", "x"));

/** How the entry obtains its credential. Desktop's helper is a FILE path (unlike Claude Code's
 *  inline command), so the command shape carries the script the writer produced. */
export type DesktopCredential =
  | { kind: "command"; helperPath: string }
  | { kind: "static"; token: string };

export type DesktopPayloadOptions = ManagedMode & {
  profile: Profile;
  baseUrl: string;
  credential: DesktopCredential;
  models?: readonly DesktopModelSpec[];
  /** The entry's current document; foreign keys survive the merge. */
  existing?: Record<string, unknown>;
};

/** The one Desktop value a preview must redact. */
const DESKTOP_SECRETS: readonly string[] = ["inferenceGatewayApiKey"];

/** Every key below is an external contract (Desktop's documented flat config vocabulary): never
 *  rename. The entry's current document with the managed keys written over it; foreign keys
 *  survive. */
export function desktopConfigPayload(opts: DesktopPayloadOptions): Record<string, unknown> {
  const existing = opts.existing ?? {};
  const doc: Doc = structuredClone(existing);
  // inferenceProvider is what activates third-party mode: without it the app treats the entry as
  // incomplete and boots into claude.ai sign-in. The credential kind names the ONE source the app
  // may use (a recorded helper would otherwise win over static fields), so each shape sets its own
  // kind and deletes the other's keys.
  doc.inferenceProvider = "gateway";
  doc.inferenceGatewayBaseUrl = opts.baseUrl;
  if (opts.credential.kind === "command") {
    doc.inferenceCredentialKind = "helper-script";
    doc.inferenceCredentialHelper = opts.credential.helperPath;
    // The proxy helper may float and launch the daemon on first call, so it gets headroom.
    doc.inferenceCredentialHelperTimeoutSec = opts.mode === "direct" ? 30 : 120;
    delete doc.inferenceGatewayApiKey;
    delete doc.inferenceGatewayAuthScheme;
  } else {
    delete doc.inferenceCredentialHelper;
    delete doc.inferenceCredentialHelperTimeoutSec;
    doc.inferenceCredentialKind = "static";
    doc.inferenceGatewayApiKey = opts.credential.token;
    doc.inferenceGatewayAuthScheme = "bearer";
  }
  doc.deploymentDisplayName = DESKTOP_DISPLAY_NAME;
  doc.managedMcpServers = managedMcpServers(opts.profile, existing["managedMcpServers"]);
  // Capability switches: everything on (user decision).
  doc.chatTabEnabled = true;
  doc.coworkTabEnabled = true;
  doc.isClaudeCodeForDesktopEnabled = true;
  doc.isDesktopExtensionEnabled = true;
  doc.chatAdvancedFileAnalysisEnabled = true;
  doc.skillCreationEnabled = true;
  doc.autoModeEnabled = true;
  doc.userPluginMarketplacesEnabled = true;
  doc.userPluginUploadsEnabled = true;
  // Show estimated cost in the UI, default to the 1M window (user decisions).
  doc.inferenceModelPricingEnabled = true;
  doc.modelPrefer1mContext = true;
  // Claude.ai data import/export switches all on (user decision); leaf writes, so a hand-set field
  // like bannerBehavior survives.
  const claudeAiImport = tableAt(doc, "claudeAiImport");
  claudeAiImport.enabled = true;
  claudeAiImport.automatic3pImport = true;
  claudeAiImport.exportEnabled = true;
  // No telemetry at all (user decision), essential included.
  doc.disableEssentialTelemetry = true;
  doc.disableNonessentialTelemetry = true;
  doc.disableNonessentialServices = true;
  const headers = existing["inferenceCustomHeaders"];
  if (opts.mode === "direct") {
    // directClientHeaders OMITS the integration id when null, so a rotation to a null identity must
    // drop the stale header rather than inherit it; user-added headers survive.
    if (isRecord(doc.inferenceCustomHeaders)) {
      for (const name of MANAGED_HEADER_NAMES) delete doc.inferenceCustomHeaders[name];
    }
    const table = tableAt(doc, "inferenceCustomHeaders");
    for (
      const [name, value] of Object.entries(
        directClientHeaders(codexUserAgent(), opts.direct?.directIntegrationId ?? null),
      )
    ) {
      table[name] = value;
    }
    // Copilot Direct 404s /v1/models -- discovery must stay off; the list is the picker.
    delete doc.modelDiscoveryEnabled;
  } else {
    // Discovery alone carries no capability metadata (anthropics/claude-code#88345: 1m models
    // silently cap at 200k), so the inferenceModels list stays as ANNOTATIONS marking 1m support.
    doc.modelDiscoveryEnabled = true;
    if (isRecord(headers) && isRecord(doc.inferenceCustomHeaders)) {
      const foreign = Object.keys(headers).filter((name) => !MANAGED_HEADER_NAMES.includes(name));
      if (foreign.length === 0) delete doc.inferenceCustomHeaders;
      else for (const name of MANAGED_HEADER_NAMES) delete doc.inferenceCustomHeaders[name];
    }
  }
  // No live rows (an offline wire): the entry keeps whatever it carries; a fresh offline entry has
  // none until the first online wire.
  if (opts.models !== undefined) {
    doc.inferenceModels = opts.models.map((m) => ({
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

/** Under the root home's helpers/ dir (a foreign program executes it), which uninstall already
 *  sweeps. */
export function desktopHelperPath(rootHome: string, mode: ProfileMode, profile: Profile): string {
  const base = mode === "direct" ? "claude-desktop-token" : "claude-desktop-proxy-token";
  const name = profile === null ? base : `${base}-${profile}`;
  return join(rootHome, HELPERS_DIR_NAME, `${name}${WIN ? ".cmd" : ".sh"}`);
}

/** A helper script as the writer judges it: the body this wiring wants, the file's current body
 *  (null: absent), and its path. Read up front, so a wire refuses on an unreadable helper before it
 *  reserves or writes anything. */
interface DesktopHelperScript {
  path: string;
  body: string;
  current: string | null;
}

function readDesktopHelperScript(mode: ProfileMode, profile: Profile): DesktopHelperScript {
  const path = desktopHelperPath(resolveRootHome(), mode, profile);
  return { path, body: desktopHelperBody(mode, profile), current: readFileOrNull(path) };
}

/** The executable bit is healed even when the body matched (a chmod'd-away +x would otherwise
 *  survive every wire). The OTHER mode's script is retired separately
 *  (prepareRetireDesktopHelperScript)
 *  AFTER the entry saves, so a failed save never leaves the current entry pointing at a deleted
 *  helper. */
function landDesktopHelperScript({ path, body, current }: DesktopHelperScript): void {
  if (current !== body) fs.writeText(path, body, { mode: 0o755 });
  else if (!helperExecutable(path)) fs.chmod(path, 0o755);
}

/** Read and landed in one step; returns the script's path. */
export function writeDesktopHelperScript(mode: ProfileMode, profile: Profile): string {
  const helper = readDesktopHelperScript(mode, profile);
  landDesktopHelperScript(helper);
  return helper.path;
}

/** ONE builder for the writer and the status inspector, so "wired" always means "this body". */
export function desktopHelperBody(mode: ProfileMode, profile: Profile): string {
  const { command, args } = agentLauncherCommand(
    mode === "direct" ? agentAuthGetArgs(profile) : proxyTokenArgs(profile),
  );
  return WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
}

/** A Windows .cmd runs by extension, never stat'ed; on POSIX a file that cannot be stat'ed throws.
 *  Through the facade, so a body this dry run landed 0755 reads executable. */
export function helperExecutable(path: string): boolean {
  return WIN || (fs.stat(path).mode & 0o111) === 0o111;
}

/** A present file goes, named; an absent path, or one under a parent that is not a directory (a
 *  helpers dir replaced by a file), is nothing to do. A directory at the path is the seam's own
 *  refusal (assertNotDirectory), in a dry run too. */
function removeFile(path: string, detail?: string): void {
  fs.assertNotDirectory(path);
  try {
    fs.rm(path, { force: true, detail });
  } catch (e) {
    if (!isEnoentOrNotdir(e)) throw e;
  }
}

/** A directory at a helper's path is warned once and left alone, in both runs; the entry the
 *  script served still lands or goes on its own. Any other failure is the caller's. */
function prepareRemoveHelperScript(path: string): () => void {
  try {
    fs.assertNotDirectory(path);
  } catch (e) {
    logger.warn(`  Claude Desktop: ${errMessage(e)}; left alone.`);
    return () => {};
  }
  return () => removeFile(path);
}

/** The other mode's script goes, post-save on a wire. */
function prepareRetireDesktopHelperScript(mode: ProfileMode, profile: Profile): () => void {
  const other: ProfileMode = mode === "direct" ? "proxy" : "direct";
  return prepareRemoveHelperScript(desktopHelperPath(resolveRootHome(), other, profile));
}

// --- app files -----------------------------------------------------------------------

/** The app's process name, for the running scan. */
export const CLAUDE_DESKTOP_PROCESS = "Claude";
const APP_CONFIG_FILENAME = "claude_desktop_config.json";
const DEVELOPER_SETTINGS_FILENAME = "developer_settings.json";

export type DesktopDeploymentMode = "3p" | "1p";

/** What the app will do at its next launch, read from the two app files. `deploymentMode` null is
 *  "unset": the app shows the sign-in chooser. A file that cannot be read or parsed is its own
 *  kind: a rewire leaves such a file alone (prepareAppFileMerge), so the repair is the file
 *  itself. */
export type DesktopAppState =
  | { kind: "read"; developerMode: boolean; deploymentMode: DesktopDeploymentMode | null }
  | { kind: "unreadable"; path: string; reason: string };

/** A merge that keeps the file's other keys (claude_desktop_config.json holds the user's MCP
 *  servers and preferences). An unparseable file is left alone and reported: rebuilding it would
 *  destroy those. */
function prepareAppFileMerge(
  path: string,
  patch: Record<string, unknown>,
  detail: string,
): () => void {
  const loaded = loadAppFile(path);
  if (typeof loaded === "string") {
    logger.warn(`  Claude Desktop: ${path} is ${loaded}; leaving it alone.`);
    return () => {};
  }
  return () => void writeJson(path, loaded.raw, Object.assign(loaded.doc, patch), detail);
}

/** The two files the app itself writes when the user clicks "Continue" on the sign-in chooser and
 *  "Enable Developer Mode": written with every entry wire so `agent init` alone leaves the app
 *  ready. Never removed: once no applied entry names an inferenceProvider the app boots claude.ai
 *  regardless, and Developer Mode is the user's. Both files are read at launch only. */
function prepareClaudeDesktopAppFiles(): () => void {
  const dirs = resolveDesktopDataDirs();
  if (dirs === null) return () => {};
  const merges = [
    prepareAppFileMerge(
      join(dirs.data, APP_CONFIG_FILENAME),
      { "deploymentMode": "3p" },
      "Claude Desktop starts in third-party mode, no sign-in chooser",
    ),
    ...[dirs.standard, dirs.data].map((dir) =>
      prepareAppFileMerge(
        join(dir, DEVELOPER_SETTINGS_FILENAME),
        { "allowDevTools": true },
        "Claude Desktop Developer Mode on",
      )
    ),
  ];
  return () => {
    for (const merge of merges) merge();
  };
}

/** The state the writer's merge would read: absent is an empty document; unreadable or malformed
 *  is the file, named. */
export function readDesktopAppState(): DesktopAppState {
  const dirs = resolveDesktopDataDirs();
  if (dirs === null) return { kind: "read", developerMode: false, deploymentMode: null };
  const docs: Record<string, unknown>[] = [];
  for (
    const path of [
      join(dirs.data, APP_CONFIG_FILENAME),
      join(dirs.standard, DEVELOPER_SETTINGS_FILENAME),
      join(dirs.data, DEVELOPER_SETTINGS_FILENAME),
    ]
  ) {
    const loaded = loadAppFile(path);
    if (typeof loaded === "string") return { kind: "unreadable", path, reason: loaded };
    docs.push(loaded.doc);
  }
  const [config, ...developer] = docs;
  const mode = config?.["deploymentMode"];
  return {
    kind: "read",
    developerMode: developer.every((doc) => doc["allowDevTools"] === true),
    deploymentMode: mode === "3p" || mode === "1p" ? mode : null,
  };
}

/** The document with its bytes (an empty document and null bytes when the file is absent), or the
 *  reason it could not be one. */
function loadAppFile(path: string): { raw: string | null; doc: Record<string, unknown> } | string {
  let raw: string | null;
  try {
    raw = readFileOrNull(path);
  } catch (e) {
    return errMessage(e);
  }
  if (raw === null) return { raw, doc: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "not valid JSON";
  }
  return isRecord(parsed) ? { raw, doc: parsed } : "not a JSON object";
}

/** The app reads its files at launch only; a running app also rewrites claude_desktop_config.json
 *  from memory on any preference save, which can undo deploymentMode. */
export function claudeDesktopRunning(): Promise<AppScan> {
  return appRunning(CLAUDE_DESKTOP_PROCESS);
}

// --- wiring ------------------------------------------------------------------------

export type DesktopWireOptions = ManagedWrite & {
  profile: Profile;
  /** Direct only: credential for the catalog fetch (never re-resolved when given). */
  directToken?: string | null;
  quiet?: boolean;
  /** Test seam, threaded to fetchRawModels. */
  fetchImpl?: ProbeFetch;
};

/** The same parse `agent profile models` renders: one pipeline for both surfaces. */
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
 * Undefined when no live data exists: the caller then leaves an existing entry's rows untouched and
 * refuses to create a fresh direct one. Each mode shows what its own backend will actually serve.
 *   direct -> the full discovery pipeline (src/copilot_api/discovery.ts) under the wiring's own
 *             identity, so unadvertised-but-servable models get a PROBED 1m verdict
 *   proxy  -> what the daemon's /v1/models will discover: its catalog first, Copilot when down
 */
async function wiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  if (opts.mode === "direct") {
    try {
      const resolved = typeof opts.directToken === "string"
        ? { token: opts.directToken, reason: null }
        : opts.credential.kind === "static"
        ? { token: opts.credential.token, reason: null }
        : new Credential(undefined, opts.profile).resolveWithReason();
      if (resolved.token === null) throw new Error(resolved.reason);
      const token = resolved.token;
      const discovered = await discoverServableClaudeModels(
        token,
        codexUserAgent(),
        opts.direct?.directIntegrationId ?? null,
        opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
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
 * The entry wire. Throws on real read failures; syncClaudeDesktopWiring is the best-effort face.
 * `appliedId` is only ever SET when the library had none: an applied user config is never
 * displaced.
 *   ours (an owned path whose document names `profile`)
 *   -> adoptable (a foreign entry at the same gateway, taken over under its uuid and name)
 *   -> a foreign namesake (warn, never clobber)
 *   -> a fresh uuid
 */
export async function wireClaudeDesktopEntry(opts: DesktopWireOptions): Promise<void> {
  const dir = resolveDesktopLibraryDir();
  if (dir === null || !claudeDesktopInstalled()) return;

  // The text PEEKS a proxy port; the write reserves it (reservePlannedPort).
  const plannedPort = opts.mode === "proxy" ? copilotApiResolvePort(opts.profile) : null;
  const baseUrl = plannedPort === null
    ? opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(plannedPort);

  const metaRaw = readFileOrNull(join(dir, META_FILENAME));
  const meta = parseDesktopMeta(metaRaw);
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
  if (entry === undefined) {
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
      if (!opts.quiet) {
        logger.info(
          `  Claude Desktop: adopting the existing "${candidate.id}" entry (same gateway).`,
        );
      }
      break;
    }
  }
  // A foreign namesake at a DIFFERENT gateway (a same-gateway one was adopted above) is never
  // clobbered or twinned. An owned namesake is the user's rename of another wiring's entry.
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
  // Unparseable content under our path (an in-app edit racing us) is rebuilt.
  const existing: Record<string, unknown> = parsedRecord(existingRaw) ?? {};

  // The launcher hot path (quiet) must NEVER run discovery: its probes are billed requests. It
  // reuses the recorded rows; `agent init`, `agent profile <name> add`, and `agent profile sync --claude` refresh live.
  const models = opts.quiet
    ? (owned ? recordedModelRows(existing) ?? undefined : undefined)
    : await wiringModels(opts);

  // A FRESH direct entry without model data would have neither discovery (Copilot 404s /v1/models)
  // nor a picker, so it is not created at all; an existing entry keeps its recorded rows.
  if (created && opts.mode === "direct" && models === undefined) {
    logger.warn(
      "  Claude Desktop: no model data available; not creating an unusable direct entry (re-run online).",
    );
    return;
  }
  if (created) meta.entries.push(entry);

  // The helper script exists only for the command shape; a static entry names none. Read now, so
  // an unreadable helper refuses the wire before anything is reserved or written.
  const credential: DesktopCredential = opts.credential.kind === "static" ? opts.credential : {
    kind: "command",
    helperPath: desktopHelperPath(resolveRootHome(), opts.mode, opts.profile),
  };
  const helper = credential.kind === "command"
    ? readDesktopHelperScript(opts.mode, opts.profile)
    : null;
  // Re-extracted so the payload receives the Direct facts only alongside a direct mode.
  const write: ManagedMode = opts.mode === "direct"
    ? { mode: "direct", direct: opts.direct }
    : { mode: "proxy" };
  // The write's own line announces the wiring; a byte-identical no-op states it instead, unless
  // quiet (the launcher hot path).
  const staticClause = credential.kind === "command"
    ? ""
    : opts.mode === "direct"
    ? "; static key"
    : `; static key, start the proxy yourself (${agentStartCommand(opts.profile)})`;
  const wiring = `${ENTRY} "${entry.name}" (${opts.mode}) wired${staticClause}`;
  const payload = desktopConfigPayload({
    ...write,
    profile: opts.profile,
    baseUrl,
    credential,
    models,
    existing,
  });
  // An applied slot that is empty, or names a row the library no longer lists, is ours to fill;
  // a slot naming a live entry (a user's own config) is never displaced.
  if (!meta.entries.some((e) => e.id === meta.appliedId)) meta.appliedId = entry.id;

  // The post-save steps take their looks before the first wiring write.
  const retire = credential.kind === "command"
    ? prepareRetireDesktopHelperScript(opts.mode, opts.profile)
    : prepareRemoveHelperScripts(opts.profile);
  const appFiles = prepareClaudeDesktopAppFiles();
  // Reserved now that everything is computed: a refusal above leaves no reservation behind.
  if (plannedPort !== null) reservePlannedPort(opts.profile, plannedPort);
  // The order is the safety: helper, config, then meta; the ownership claim, the helper
  // retirement, and the app files follow, in that order.
  //   config without its meta row  -> invisible junk
  //   meta row without its config  -> a broken picker row
  //   claim before the save        -> a claim on an entry that was never written
  //   retirement before the claim  -> a saved entry left unclaimed when the retirement fails
  if (helper !== null) landDesktopHelperScript(helper);
  const configWritten = writeJson(
    configPath,
    existingRaw,
    payload,
    `${wiring}; restart Claude Desktop to pick it up`,
    DESKTOP_SECRETS,
  );
  if (!configWritten && !opts.quiet) {
    logger.success(`  ${wiring} at ${configPath} already.`);
  }
  writeDesktopMeta(dir, metaRaw, meta);
  // Only a NEW claim is recorded, so the ledger write is a real change, never a byte-identical
  // one. What follows lands on its own, after the claim: the other mode's helper (the
  // still-current entry never names a deleted one) and the app files, independent of the entry,
  // so a failure in either leaves a complete, OWNED entry.
  if (!owned) ledger.record("claudeDesktop", configPath);
  retire();
  appFiles();
}

/** The entry's recorded inferenceModels rows when they are OUR shape, else null (fetch). */
export function recordedModelRows(existing: Record<string, unknown>): DesktopModelSpec[] | null {
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

/** The lenient store reader degrades any other shape to "no profiles", which would make every named
 *  entry an orphan to delete, so every removal decision checks this first and touches nothing when
 *  it fails. */
export function profileStoreWellFormed(storeFile: string): boolean {
  const read = fs.readTextResult(storeFile);
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

/** Best-effort: a Desktop failure warns, never fails the caller. Key off leaves the default's
 *  entry alone and says nothing, because the whole-library reconcile in
 *  src/agents/claude_desktop.ts names it once and the launcher's default repair stays quiet.
 *
 *    key on                    -> upserts `profile`'s entry
 *    key off, named profile    -> removes that entry
 *    key off, malformed store  -> warns, touches nothing (the guard that sweep sits behind too)
 */
export async function syncClaudeDesktopWiring(opts: DesktopWireOptions): Promise<void> {
  try {
    await syncClaudeDesktopWiringOrThrow(opts);
  } catch (e) {
    logger.warn(
      `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${errMessage(e)}`,
    );
  }
}

async function syncClaudeDesktopWiringOrThrow(opts: DesktopWireOptions): Promise<void> {
  // The one store holds the key AND the profiles: judged once, before either is read.
  const storeFile = new CopilotApiPaths().stateStoreFile;
  if (!profileStoreWellFormed(storeFile)) {
    logger.warn(
      `  Claude Desktop: the state store ${storeFile} is malformed; leaving the config library alone.`,
    );
    return;
  }
  if (new CopilotEnvConfig().claudeDesktopEnabled()) {
    await wireClaudeDesktopEntry(opts);
    return;
  }
  if (opts.profile === null) return;
  removeClaudeDesktopEntry(opts.profile);
}

/** A foreign entry, even one carrying our name, is never touched. Best-effort. */
export function removeClaudeDesktopEntry(profile: Profile): void {
  removeOwned(
    `the Claude Desktop entry for ${profileLabel(profile)}`,
    (e) => entryProfileAt(e.path) === profile,
    profile,
  );
}

/** Best-effort. */
export function removeClaudeDesktopOrphan(orphan: DesktopOwnedEntry): void {
  removeOwned(
    `the orphaned Claude Desktop entry at ${orphan.path}`,
    (e) => e.path === orphan.path,
    orphan.profile,
  );
}

/** A failed removal is warned about, and its ownership stays with the entry it did not remove
 *  (the claims go last). A blocked sweep (malformed _meta.json) may leave a live entry pointing at
 *  the helper scripts, so they go only when the library was actually processed. */
function removeOwned(
  what: string,
  selects: (owned: OwnedDesktopEntry) => boolean,
  helpersOf: Profile | undefined,
): void {
  try {
    // The helpers' looks come before the library is touched.
    const helpers = helpersOf === undefined ? () => {} : prepareRemoveHelperScripts(helpersOf);
    const entries = sweepOwnedEntries(selects);
    if (entries.kind === "blocked") return;
    helpers();
    releaseClaims(entries.removed);
  } catch (e) {
    logger.warn(`  Could not remove ${what}: ${errMessage(e)}`);
  }
}

function releaseClaims(paths: readonly string[]): void {
  const ledger = new OwnershipLedger();
  for (const path of paths) ledger.release("claudeDesktop", path);
}

/** Both modes' scripts. */
function prepareRemoveHelperScripts(profile: Profile): () => void {
  const rootHome = resolveRootHome();
  const steps = [
    prepareRemoveHelperScript(desktopHelperPath(rootHome, "direct", profile)),
    prepareRemoveHelperScript(desktopHelperPath(rootHome, "proxy", profile)),
  ];
  return () => {
    for (const step of steps) step();
  };
}

/** The filename grammar desktopHelperPath produces, either platform's extension. */
const HELPER_SCRIPT_NAME_RE = /^claude-desktop-(proxy-)?token(?:-([a-z0-9-]+))?\.(?:sh|cmd)$/;

/** The inverse of desktopHelperPath; undefined for a name that is not ours (a reserved word like
 *  `default` included), so a sweep by filename names every generated script without a store, yet
 *  never a neighbour's file. */
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

/** An absent root home is an empty list; any other failure throws, since a sweep must not claim
 *  completeness over a directory it could not list. Listed through the facade, so a script this
 *  dry run removed is gone to the run's later readers (the status read that decides a re-sync). */
export function presentDesktopHelperScripts(rootHome: string): string[] {
  const helpersDir = join(rootHome, HELPERS_DIR_NAME);
  let names: string[];
  try {
    names = fs.readdir(helpersDir);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
  return names
    .filter((n) => desktopHelperScriptWiring(n) !== undefined)
    .sort()
    .map((n) => join(helpersDir, n));
}

/** The uninstall sweep. `dirOverride` is the injected library dir (homedir() is not
 *  env-redirectable on Windows); null means "treat Desktop as absent". */
export function removeAllClaudeDesktopWiring(
  dirOverride?: string | null,
  artifacts: ClaudeDesktopOwnedArtifacts = listClaudeDesktopOwnedArtifacts(dirOverride),
): void {
  // `artifacts` is the plan uninstall rendered as its dry run: exactly those paths go, so a claim
  // that appeared after planning stays.
  if (artifacts.blocked) return;
  const planned = new Set([...artifacts.entries, ...artifacts.staleClaims]);
  const entries = sweepOwnedEntries((owned) => planned.has(owned.path), dirOverride);
  if (entries.kind === "blocked") return;
  releaseClaims(entries.removed);
  removeUnlistedClaudeDesktopClaims(dirOverride, (path) => planned.has(path));
  // Uninstall deletes the root home wholesale right after this step; the helpers still go here so
  // the step is complete on its own.
  for (const path of artifacts.helpers) removeFile(path);
}

/** The `claude.desktop false` sweep. Fail closed: only a claim POSITIVELY attributed to a named
 *  profile goes, since anything else may be the default's. Helper scripts go by FILENAME, so a
 *  named profile's script goes even when its entry was left. */
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
        `  Claude Desktop: ${path} carries no copilot-env wiring, so its profile is unknown; left alone.`,
      );
    }
    return profile !== undefined && profile !== null;
  };
  // Every look before the first write: the helper listing and the unlisted claims are judged over
  // the library as it stands, and a listing that fails leaves it untouched.
  const helpers = presentDesktopHelperScripts(resolveRootHome())
    .filter((path) => desktopHelperScriptWiring(basename(path))?.profile !== null)
    .map(prepareRemoveHelperScript);
  const unlisted = unlistedClaims(undefined, sweepable);
  const entries = sweepOwnedEntries((e) => sweepable(e.path));
  if (entries.kind === "blocked") return;
  if (unlisted.kind === "listed") { for (const path of unlisted.paths) removeFile(path, ENTRY); }
  for (const remove of helpers) remove();
  if (!opts.quiet) announceUnmanagedDefault();
  releaseClaims(entries.removed);
  if (unlisted.kind === "listed") releaseClaims(unlisted.paths);
}

/** Name every claim the key-off sweep leaves as the default's, so the user knows it is theirs now
 *  and nothing was rewritten. One that could not be attributed is skipped: the sweep already
 *  warned. */
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
    logger.info(`  Claude Desktop: ${label} left in place, unmanaged (claude.desktop false).`);
  }
}

/** What removeAllClaudeDesktopWiring removes and the uninstall dry run names. Read-only.
 *    entries      -> owned config files present (listed and unlisted claims alike)
 *    staleClaims  -> owned paths whose file is gone (their _meta.json row and claim still go)
 *    helpers      -> the generated helper scripts
 *    blocked      -> a not-understood _meta.json; the library is left alone */
export interface ClaudeDesktopOwnedArtifacts {
  entries: string[];
  staleClaims: string[];
  helpers: string[];
  /** The `_meta.json` path when removing the listed owned rows will rewrite it (null: nothing
   *  listed is ours). Outside our homes, so the dry run names the rewrite like the live sweep. */
  metaRewrite: string | null;
  blocked: boolean;
}

export function listClaudeDesktopOwnedArtifacts(
  dirOverride?: string | null,
): ClaudeDesktopOwnedArtifacts {
  const helpers = presentDesktopHelperScripts(resolveRootHome());
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  const none = { entries: [], staleClaims: [], helpers, metaRewrite: null };
  if (dir === null) return { ...none, blocked: false };
  const library = readOwnedLibrary(dir);
  if (library === null) return { ...none, blocked: true };
  // One look per path: a file appearing or vanishing between two looks would land in neither list
  // or both.
  const entries: string[] = [];
  const staleClaims: string[] = [];
  for (const path of [...library.owned.map((e) => e.path), ...library.unlisted]) {
    (entryExists(path) ? entries : staleClaims).push(path);
  }
  return {
    entries,
    staleClaims,
    helpers,
    metaRewrite: library.owned.length > 0 ? join(dir, META_FILENAME) : null,
    blocked: false,
  };
}

export interface OwnedDesktopEntry {
  entry: DesktopMetaEntry;
  path: string;
}

/** The rename's retarget of an entry's own MCP row (the `copilot-env` server, never another
 *  program's): its `profile <from>` becomes `profile <to>`. True when a row changed. */
export function retargetEntryProfile(
  doc: Record<string, unknown>,
  from: ProfileName,
  to: ProfileName,
): boolean {
  const servers = doc["managedMcpServers"];
  const ours = Array.isArray(servers)
    ? servers.find((row) => isRecord(row) && row["name"] === MCP_SERVER_NAME)
    : undefined;
  if (!isRecord(ours) || !Array.isArray(ours.args)) return false;
  const at = ours.args.indexOf("profile");
  if (at === -1 || ours.args[at + 1] !== from) return false;
  ours.args[at + 1] = to;
  return true;
}

/** Undefined when the document carries no wiring of ours (absent or damaged: no target can claim
 *  it, so it is an orphan). Attribution reads the managed MCP server's `profile <name>` words, the
 *  one key both credential shapes write (a static entry names no helper script). An UNREADABLE
 *  document throws: a failed look is never "not ours". */
export function entryProfileAt(path: string): Profile | undefined {
  const raw = readFileOrNull(path);
  if (raw === null) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const servers = isRecord(doc) ? doc["managedMcpServers"] : undefined;
  const ours = Array.isArray(servers)
    ? servers.find((row) => isRecord(row) && row["name"] === MCP_SERVER_NAME)
    : undefined;
  const args = isRecord(ours) && Array.isArray(ours.args) ? ours.args : null;
  if (args === null || !args.includes("--serve")) return undefined;
  const at = args.indexOf("profile");
  if (at === -1) return null;
  const name = args[at + 1];
  if (typeof name !== "string") return undefined;
  try {
    return parseProfileName(name);
  } catch {
    return undefined;
  }
}

interface OwnedLibrary {
  meta: DesktopMeta;
  owned: OwnedDesktopEntry[];
  /** Ledger claims under the dir that _meta.json no longer lists: an interrupted removal's
   *  invisible leftovers, config file present or not. */
  unlisted: string[];
}

/** DIRECT entry files of `dir` only (`<id>.json`, one segment down; a trailing separator on `dir`
 *  or a nested path changes nothing), as one snapshot: one ledger read, not one per row. */
function claimsUnder(ledger: OwnershipLedger, dir: string): Set<string> {
  return new Set(
    ledger.ownedPaths("claudeDesktop").filter((p) => {
      const rel = relative(dir, p);
      return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..") && !rel.includes(sep) &&
        rel.endsWith(".json");
    }),
  );
}

/** Null when _meta.json is unreadable or not understood (nothing can be judged or swept); a missing
 *  _meta.json is an empty library. */
export function readOwnedLibrary(dir: string): OwnedLibrary | null {
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

/** The ledger claims under the library that _meta.json no longer lists, narrowed by `selects`;
 *  "blocked" when _meta.json cannot be judged. */
function unlistedClaims(
  dirOverride: string | null | undefined,
  selects: (path: string) => boolean,
): { kind: "blocked" } | { kind: "listed"; paths: string[] } {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { kind: "listed", paths: [] };
  const library = readOwnedLibrary(dir);
  if (library === null) return { kind: "blocked" };
  return { kind: "listed", paths: library.unlisted.filter(selects) };
}

/** The leftovers of a removal that failed after the meta save: their files deleted when present,
 *  then the claims released. `dirOverride` as in removeAllClaudeDesktopWiring; `selects` narrows
 *  the sweep (the key-off attribution). "blocked" when _meta.json cannot be judged. */
export function removeUnlistedClaudeDesktopClaims(
  dirOverride?: string | null,
  selects: (path: string) => boolean = () => true,
): "swept" | "blocked" {
  const unlisted = unlistedClaims(dirOverride, selects);
  if (unlisted.kind === "blocked") return "blocked";
  for (const path of unlisted.paths) removeFile(path, ENTRY);
  releaseClaims(unlisted.paths);
  return "swept";
}

/** A foreign row is never a candidate. Meta FIRST, config files second; the caller releases the
 *  ownership of `removed` LAST, once everything that must go with them went: a failure mid-way can
 *  leave an orphaned (invisible) config file, never a picker row whose config is gone, and never a
 *  released claim on a file still there. "blocked" when _meta.json cannot be judged (a live entry
 *  may reference the helper scripts: keep them). */
function sweepOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
  dirOverride?: string | null,
): { kind: "blocked" } | { kind: "swept"; removed: string[] } {
  const swept = (removed: string[]) => ({ kind: "swept" as const, removed });
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return swept([]);
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  if (raw === null) return swept([]); // no library, nothing recorded here to remove
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the config library alone.`,
    );
    return { kind: "blocked" };
  }
  const ledger = new OwnershipLedger();
  const claims = claimsUnder(ledger, dir);
  const removedPaths: string[] = [];
  const kept: DesktopMetaEntry[] = [];
  let removedApplied = false;
  for (const entry of meta.entries) {
    const configPath = join(dir, `${entry.id}.json`);
    if (claims.has(configPath) && selects({ entry, path: configPath })) {
      removedPaths.push(configPath);
      if (meta.appliedId === entry.id) removedApplied = true;
    } else {
      kept.push(entry);
    }
  }
  if (removedPaths.length === 0) return swept([]);
  // The applied slot is handed to a remaining entry of ours (the default's first), never left
  // empty: an empty slot boots the app into claude.ai sign-in, and only the non-quiet wire could
  // refill it.
  if (removedApplied) {
    const ours = kept.filter((e) => claims.has(join(dir, `${e.id}.json`)));
    const next = ours.find((e) => entryProfileAt(join(dir, `${e.id}.json`)) === null) ?? ours[0];
    meta.appliedId = next?.id ?? null;
  }
  meta.entries = kept;
  writeDesktopMeta(dir, raw, meta);
  for (const path of removedPaths) removeFile(path, ENTRY);
  return swept(removedPaths);
}
