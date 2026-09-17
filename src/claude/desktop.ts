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
// what the app itself writes when the user clicks through; see wireClaudeDesktopAppFiles):
//   Claude-3p/claude_desktop_config.json  deploymentMode "3p"  -> boots third-party, no sign-in chooser
//   Claude/developer_settings.json        allowDevTools true   -> Developer menu (the 3p copy too)
// Desktop discovers models at `<gateway>/v1/models`, hardcoded: Copilot Direct 404s it, so direct
// entries carry an explicit inferenceModels list; the proxy serves it, so proxy entries discover.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { codexUserAgent } from "../codex/user_agent.ts";
import { type ManagedMode, type ManagedWrite, reservePlannedPort } from "../agents/configure.ts";
import {
  applyPatch,
  type Doc,
  type FilePlan,
  filePlan,
  NO_WRITE,
  type PatchOp,
  planPatch,
  remove,
  set,
  textVerdict,
  type WritePlan,
} from "../agents/write_plan.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { atomicWriteFile, chmodReported, removeReported } from "../utils/report_write.ts";
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
  WINDOWS_DEVICE_NAME_RE,
} from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { appRunning, type AppScan } from "../utils/app_scan.ts";
import { entryAbsent, isEnoentOrNotdir, readTextResult } from "../utils/fs.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenArgs } from "../utils/root.ts";
import type { DesktopOwnedEntry } from "./desktop_status.ts";
import { cmdHelperBody, posixExecBody } from "./helper_body.ts";

const logger = createStderrLogger();

const WIN = process.platform === "win32";

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
  if (seam !== null) return existsSync(seam);
  return desktopAppInstalledFor(process.platform, existsSync, homedir(), desktopEnv());
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
  const read = readTextResult(path);
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") throw new Error(`could not read ${path}: ${read.error}`);
  return read.text;
}

export function saveJsonIfChanged(path: string, doc: unknown, detail?: string): boolean {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (readFileOrNull(path) === text) return false;
  atomicWriteFile(path, text, undefined, detail);
  return true;
}

/** A JSON write, planned: `apply` lands the bytes unless the file already holds them (what
 *  saveJsonIfChanged decides at write time, decided here at plan time). */
interface JsonWritePlan {
  file: FilePlan;
  /** True when the file was written. */
  apply(): boolean;
}

function parsedRecord(raw: string | null): Doc | null {
  return raw === null ? null : parseJsonRecord(raw);
}

/** `ops` over `base` (the document the save starts from) yield the bytes; the rows compare against
 *  the file's own current document (`currentRaw` parsed, null when absent or not an object). */
function planJsonWrite(
  path: string,
  currentRaw: string | null,
  base: Doc,
  ops: readonly PatchOp[],
  detail?: string,
  secrets?: ReadonlySet<string>,
): JsonWritePlan {
  const attributes = planPatch(parsedRecord(currentRaw), ops, secrets);
  const text = `${JSON.stringify(applyPatch(base, ops), null, 2)}\n`;
  return {
    file: { path, verdict: textVerdict(currentRaw, text), attributes },
    apply() {
      if (currentRaw === text) return false;
      atomicWriteFile(path, text, undefined, detail);
      return true;
    },
  };
}

/** `_meta.json` rebuilt from the parsed index: the app's other fields first, then the two we own.
 *  A cleared applied slot is an explicit removal, so the plan names it. */
function planDesktopMeta(dir: string, currentRaw: string | null, meta: DesktopMeta): JsonWritePlan {
  const ops: PatchOp[] = [
    meta.appliedId === null ? remove(["appliedId"]) : set(["appliedId"], meta.appliedId),
    set(["entries"], meta.entries.map((e) => ({ ...e.extra, "id": e.id, "name": e.name }))),
  ];
  return planJsonWrite(
    join(dir, META_FILENAME),
    currentRaw,
    { ...meta.extra },
    ops,
    "Claude Desktop config-library index",
  );
}

/** Fail-closed (entryAbsent): a failed look reads "may be there", a dangling symlink is present,
 *  and a removal that could not look never skips the file while still releasing its ownership. */
export function entryExists(path: string): boolean {
  return !entryAbsent(path);
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
const MCP_SERVER_NAME = "copilot-env";
function managedMcpServers(profile: Profile, existing: unknown): Record<string, unknown>[] {
  const { command, args } = agentLauncherCommand(
    profile === null ? ["mcp", "--serve"] : ["mcp", "--serve", "--profile", profile],
  );
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
const DESKTOP_SECRETS: ReadonlySet<string> = new Set(["inferenceGatewayApiKey"]);

/** Every key below is an external contract (Desktop's documented flat config vocabulary): never
 *  rename. The patch over the entry's current document; desktopConfigPayload is it applied. */
export function desktopPayloadOps(opts: DesktopPayloadOptions): PatchOp[] {
  const existing = opts.existing ?? {};
  // inferenceProvider is what activates third-party mode: without it the app treats the entry as
  // incomplete and boots into claude.ai sign-in. The credential kind names the ONE source the app
  // may use (a recorded helper would otherwise win over static fields), so each shape sets its own
  // kind and deletes the other's keys.
  const ops: PatchOp[] = [
    set(["inferenceProvider"], "gateway"),
    set(["inferenceGatewayBaseUrl"], opts.baseUrl),
  ];
  if (opts.credential.kind === "command") {
    ops.push(
      set(["inferenceCredentialKind"], "helper-script"),
      set(["inferenceCredentialHelper"], opts.credential.helperPath),
      // The proxy helper may float and launch the daemon on first call, so it gets headroom.
      set(["inferenceCredentialHelperTimeoutSec"], opts.mode === "direct" ? 30 : 120),
      remove(["inferenceGatewayApiKey"]),
      remove(["inferenceGatewayAuthScheme"]),
    );
  } else {
    ops.push(
      remove(["inferenceCredentialHelper"]),
      remove(["inferenceCredentialHelperTimeoutSec"]),
      set(["inferenceCredentialKind"], "static"),
      set(["inferenceGatewayApiKey"], opts.credential.token),
      set(["inferenceGatewayAuthScheme"], "bearer"),
    );
  }
  ops.push(
    set(["deploymentDisplayName"], DESKTOP_DISPLAY_NAME),
    set(["managedMcpServers"], managedMcpServers(opts.profile, existing["managedMcpServers"])),
    // Capability switches: everything on (user decision).
    set(["chatTabEnabled"], true),
    set(["coworkTabEnabled"], true),
    set(["isClaudeCodeForDesktopEnabled"], true),
    set(["isDesktopExtensionEnabled"], true),
    set(["chatAdvancedFileAnalysisEnabled"], true),
    set(["skillCreationEnabled"], true),
    set(["autoModeEnabled"], true),
    set(["userPluginMarketplacesEnabled"], true),
    set(["userPluginUploadsEnabled"], true),
    // Show estimated cost in the UI, default to the 1M window (user decisions).
    set(["inferenceModelPricingEnabled"], true),
    set(["modelPrefer1mContext"], true),
    // Claude.ai data import/export switches all on (user decision); leaf sets, so a hand-set field
    // like bannerBehavior survives.
    set(["claudeAiImport", "enabled"], true),
    set(["claudeAiImport", "automatic3pImport"], true),
    set(["claudeAiImport", "exportEnabled"], true),
    // No telemetry at all (user decision), essential included.
    set(["disableEssentialTelemetry"], true),
    set(["disableNonessentialTelemetry"], true),
    set(["disableNonessentialServices"], true),
  );
  const headers = existing["inferenceCustomHeaders"];
  if (opts.mode === "direct") {
    // directClientHeaders OMITS the integration id when null, so a rotation to a null identity must
    // drop the stale header rather than inherit it; user-added headers survive.
    for (const name of MANAGED_HEADER_NAMES) ops.push(remove(["inferenceCustomHeaders", name]));
    for (
      const [name, value] of Object.entries(
        directClientHeaders(codexUserAgent(), opts.directIntegrationId),
      )
    ) {
      ops.push(set(["inferenceCustomHeaders", name], value));
    }
    // Copilot Direct 404s /v1/models -- discovery must stay off; the list is the picker.
    ops.push(remove(["modelDiscoveryEnabled"]));
  } else {
    // Discovery alone carries no capability metadata (anthropics/claude-code#88345: 1m models
    // silently cap at 200k), so the inferenceModels list stays as ANNOTATIONS marking 1m support.
    ops.push(set(["modelDiscoveryEnabled"], true));
    if (isRecord(headers)) {
      const foreign = Object.keys(headers).filter((name) => !MANAGED_HEADER_NAMES.includes(name));
      if (foreign.length === 0) ops.push(remove(["inferenceCustomHeaders"]));
      else {for (const name of MANAGED_HEADER_NAMES) {
          ops.push(remove(["inferenceCustomHeaders", name]));
        }}
    }
  }
  // No live rows (an offline wire): the entry keeps whatever it carries; a fresh offline entry has
  // none until the first online wire.
  if (opts.models !== undefined) {
    ops.push(set(
      ["inferenceModels"],
      opts.models.map((m) => ({
        "name": m.name,
        "labelOverride": m.labelOverride,
        "supports1m": m.supports1m,
        "prefer1m": m.prefer1m,
        "anthropicFamilyTier": m.anthropicFamilyTier,
        "isFamilyDefault": m.isFamilyDefault,
      })),
    ));
  }
  return ops;
}

export function desktopConfigPayload(opts: DesktopPayloadOptions): Record<string, unknown> {
  return applyPatch(structuredClone(opts.existing ?? {}), desktopPayloadOps(opts));
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

/** The executable bit is healed even when the body matched (a chmod'd-away +x would otherwise
 *  survive every wire). The OTHER mode's script is retired separately (planRetireDesktopHelperScript)
 *  AFTER the entry saves, so a failed save never leaves the current entry pointing at a deleted
 *  helper. */
export function planDesktopHelperScript(
  mode: ProfileMode,
  profile: Profile,
): { path: string; file: FilePlan; apply(): void } {
  const body = desktopHelperBody(mode, profile);
  const path = desktopHelperPath(resolveRootHome(), mode, profile);
  const current = readFileOrNull(path);
  const verdict = current === null
    ? "create"
    : current !== body || !helperExecutable(path)
    ? "rewrite"
    : "same";
  return {
    path,
    file: filePlan(path, verdict),
    apply() {
      if (current !== body) atomicWriteFile(path, body, 0o755);
      else if (!helperExecutable(path)) chmodReported(path, 0o755);
    },
  };
}

/** planDesktopHelperScript, performed; returns the script's path. */
export function writeDesktopHelperScript(mode: ProfileMode, profile: Profile): string {
  const plan = planDesktopHelperScript(mode, profile);
  plan.apply();
  return plan.path;
}

/** ONE builder for the writer and the status inspector, so "wired" always means "this body". */
export function desktopHelperBody(mode: ProfileMode, profile: Profile): string {
  const { command, args } = agentLauncherCommand(
    mode === "direct" ? agentAuthGetArgs(profile) : proxyTokenArgs(profile),
  );
  return WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
}

/** A Windows .cmd runs by extension, never stat'ed; on POSIX a file that cannot be stat'ed throws. */
export function helperExecutable(path: string): boolean {
  return WIN || (statSync(path).mode & 0o111) === 0o111;
}

/** A file removal as a plan: present files are named with the delete verdict; the apply removes
 *  whatever is there at that moment (removeReported is a no-op on an absent path). */
function planRemoveFile(path: string, detail?: string): WritePlan {
  return {
    files: entryExists(path) ? [filePlan(path, "delete")] : [],
    apply: () => void removeReported(path, detail),
  };
}

function concatPlans(plans: readonly WritePlan[]): WritePlan {
  return {
    files: plans.flatMap((p) => p.files),
    apply() {
      for (const plan of plans) plan.apply();
    },
  };
}

/** Applied post-save on a wire. */
export function planRetireDesktopHelperScript(mode: ProfileMode, profile: Profile): WritePlan {
  const other: ProfileMode = mode === "direct" ? "proxy" : "direct";
  return planRemoveFile(desktopHelperPath(resolveRootHome(), other, profile));
}

export function retireDesktopHelperScript(mode: ProfileMode, profile: Profile): void {
  planRetireDesktopHelperScript(mode, profile).apply();
}

// --- app files -----------------------------------------------------------------------

/** The app's process name, for the running scan. */
export const CLAUDE_DESKTOP_PROCESS = "Claude";
const APP_CONFIG_FILENAME = "claude_desktop_config.json";
const DEVELOPER_SETTINGS_FILENAME = "developer_settings.json";

export type DesktopDeploymentMode = "3p" | "1p";

/** What the app will do at its next launch, read from the two app files. `deploymentMode` null is
 *  "unset": the app shows the sign-in chooser. A file that cannot be read or parsed is its own
 *  kind: a rewire leaves such a file alone (mergeAppFile), so the repair is the file itself. */
export type DesktopAppState =
  | { kind: "read"; developerMode: boolean; deploymentMode: DesktopDeploymentMode | null }
  | { kind: "unreadable"; path: string; reason: string };

/** A merge that keeps the file's other keys (claude_desktop_config.json holds the user's MCP
 *  servers and preferences). An unparseable file is left alone and reported: rebuilding it would
 *  destroy those. */
function planAppFileMerge(path: string, patch: Record<string, unknown>, detail: string): WritePlan {
  const loaded = loadAppFile(path);
  if (typeof loaded === "string") {
    logger.warn(`  Claude Desktop: ${path} is ${loaded}; leaving it alone.`);
    return NO_WRITE;
  }
  const write = planJsonWrite(
    path,
    loaded.raw,
    loaded.doc,
    Object.entries(patch).map(([key, value]) => set([key], value)),
    detail,
  );
  return { files: [write.file], apply: () => void write.apply() };
}

/** The two files the app itself writes when the user clicks "Continue" on the sign-in chooser and
 *  "Enable Developer Mode": written with every entry wire so `agent init` alone leaves the app
 *  ready. Never removed: once no applied entry names an inferenceProvider the app boots claude.ai
 *  regardless, and Developer Mode is the user's. Both files are read at launch only. */
function planClaudeDesktopAppFiles(): WritePlan {
  const dirs = resolveDesktopDataDirs();
  if (dirs === null) return NO_WRITE;
  return concatPlans([
    planAppFileMerge(
      join(dirs.data, APP_CONFIG_FILENAME),
      { "deploymentMode": "3p" },
      "Claude Desktop starts in third-party mode, no sign-in chooser",
    ),
    ...[dirs.standard, dirs.data].map((dir) =>
      planAppFileMerge(
        join(dir, DEVELOPER_SETTINGS_FILENAME),
        { "allowDevTools": true },
        "Claude Desktop Developer Mode on",
      )
    ),
  ]);
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

/** The same parse `agent models` renders: one pipeline for both surfaces. */
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
        opts.directIntegrationId ?? null,
        opts.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
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
 * The entry wire, computed but not performed. Throws on real read failures; planClaudeDesktopSync
 * is the best-effort face. `appliedId` is only ever SET when the library had none: an applied user
 * config is never displaced.
 *   ours (an owned path whose document names `profile`)
 *   -> adoptable (a foreign entry at the same gateway, taken over under its uuid and name)
 *   -> a foreign namesake (warn, never clobber)
 *   -> a fresh uuid
 */
export async function planClaudeDesktopEntry(opts: DesktopWireOptions): Promise<WritePlan> {
  const dir = resolveDesktopLibraryDir();
  if (dir === null || !claudeDesktopInstalled()) return NO_WRITE;

  // The plan PEEKS a proxy port; the apply reserves it (reservePlannedPort).
  const plannedPort = opts.mode === "proxy" ? copilotApiResolvePort(opts.profile) : null;
  const baseUrl = plannedPort === null
    ? opts.directBaseUrl ?? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(plannedPort);

  const metaRaw = readFileOrNull(join(dir, META_FILENAME));
  const meta = parseDesktopMeta(metaRaw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${
        join(dir, META_FILENAME)
      } has an unexpected shape; leaving the config library alone.`,
    );
    return NO_WRITE;
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
    return NO_WRITE;
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
  // reuses the recorded rows; init, profile-add, and `agent claude` refresh live.
  const models = opts.quiet
    ? (owned ? recordedModelRows(existing) ?? undefined : undefined)
    : await wiringModels(opts);

  // A FRESH direct entry without model data would have neither discovery (Copilot 404s /v1/models)
  // nor a picker, so it is not created at all; an existing entry keeps its recorded rows.
  if (created && opts.mode === "direct" && models === undefined) {
    logger.warn(
      "  Claude Desktop: no model data available; not creating an unusable direct entry (re-run online).",
    );
    return NO_WRITE;
  }
  if (created) meta.entries.push(entry);

  // The helper script exists only for the command shape; a static entry names none.
  const credential: DesktopCredential = opts.credential.kind === "static" ? opts.credential : {
    kind: "command",
    helperPath: desktopHelperPath(resolveRootHome(), opts.mode, opts.profile),
  };
  const helper = credential.kind === "command"
    ? planDesktopHelperScript(opts.mode, opts.profile)
    : null;
  // Re-extracted so the payload receives the Direct facts only alongside a direct mode.
  const write: ManagedMode = opts.mode === "direct"
    ? {
      mode: "direct",
      directIntegrationId: opts.directIntegrationId,
      directBaseUrl: opts.directBaseUrl,
    }
    : { mode: "proxy" };
  // The write's own line announces the wiring; a byte-identical no-op states it instead, unless
  // quiet (the launcher hot path).
  const staticClause = credential.kind === "command"
    ? ""
    : opts.mode === "direct"
    ? "; static key"
    : `; static key, start the proxy yourself (${agentStartCommand(opts.profile)})`;
  const wiring = `${ENTRY} "${entry.name}" (${opts.mode}) wired${staticClause}`;
  const config = planJsonWrite(
    configPath,
    existingRaw,
    structuredClone(existing),
    desktopPayloadOps({ ...write, profile: opts.profile, baseUrl, credential, models, existing }),
    `${wiring}; restart Claude Desktop to pick it up`,
    DESKTOP_SECRETS,
  );
  // An applied slot that is empty, or names a row the library no longer lists, is ours to fill;
  // a slot naming a live entry (a user's own config) is never displaced.
  if (!meta.entries.some((e) => e.id === meta.appliedId)) meta.appliedId = entry.id;
  const index = planDesktopMeta(dir, metaRaw, meta);
  const retire = helper === null
    ? planRemoveHelperScripts(opts.profile)
    : planRetireDesktopHelperScript(opts.mode, opts.profile);
  const appFiles = planClaudeDesktopAppFiles();

  return {
    files: [
      ...(helper === null ? [] : [helper.file]),
      config.file,
      index.file,
      ...retire.files,
      ...appFiles.files,
    ],
    apply() {
      if (plannedPort !== null) reservePlannedPort(opts.profile, plannedPort);
      helper?.apply();
      // The order is the safety: config, then meta, then ownership and helper retirement.
      //   config without its meta row  -> invisible junk
      //   meta row without its config  -> a broken picker row
      //   claim before the save        -> a claim on an entry that was never written
      //   retirement before the save   -> a helper the still-current entry names, gone
      const configWritten = config.apply();
      if (!configWritten && !opts.quiet) {
        logger.success(`  ${wiring} at ${configPath} already.`);
      }
      index.apply();
      // Only a NEW claim is recorded, so the ledger write is a real change, never a byte-identical
      // one.
      if (!owned) ledger.record("claudeDesktop", configPath);
      retire.apply();
      // Last: the app files are independent of the entry, so a failure here (an unreadable
      // developer_settings.json) leaves a complete, owned entry behind.
      appFiles.apply();
    },
  };
}

/** planClaudeDesktopEntry, performed. */
export async function wireClaudeDesktopEntry(opts: DesktopWireOptions): Promise<void> {
  (await planClaudeDesktopEntry(opts)).apply();
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

/** Best-effort: a Desktop failure warns, never fails the caller, at plan time and at apply time
 *  alike. Key off leaves the default's entry alone and says nothing, because the whole-library
 *  reconcile in src/agents/claude_desktop.ts names it once and the launcher's default repair stays
 *  quiet.
 *
 *    key on                    -> upserts `profile`'s entry
 *    key off, named profile    -> removes that entry
 *    key off, malformed store  -> warns, touches nothing (the guard that sweep sits behind too)
 */
export async function planClaudeDesktopSync(opts: DesktopWireOptions): Promise<WritePlan> {
  const warn = (e: unknown): void =>
    logger.warn(
      `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${errMessage(e)}`,
    );
  let plan: WritePlan;
  try {
    plan = await planClaudeDesktopSyncOrThrow(opts);
  } catch (e) {
    warn(e);
    return NO_WRITE;
  }
  return {
    files: plan.files,
    apply() {
      try {
        plan.apply();
      } catch (e) {
        warn(e);
      }
    },
  };
}

async function planClaudeDesktopSyncOrThrow(opts: DesktopWireOptions): Promise<WritePlan> {
  if (new CopilotEnvConfig().claudeDesktopEnabled()) return await planClaudeDesktopEntry(opts);
  if (opts.profile === null) return NO_WRITE;
  const storeFile = new CopilotApiPaths().sharedStateFile;
  if (!profileStoreWellFormed(storeFile)) {
    logger.warn(
      `  Claude Desktop: the profile store ${storeFile} is malformed; leaving the config library alone.`,
    );
    return NO_WRITE;
  }
  return planRemoveClaudeDesktopEntry(opts.profile);
}

/** planClaudeDesktopSync, performed. */
export async function syncClaudeDesktopWiring(opts: DesktopWireOptions): Promise<void> {
  (await planClaudeDesktopSync(opts)).apply();
}

/** A foreign entry, even one carrying our name, is never touched. Best-effort. */
export function planRemoveClaudeDesktopEntry(profile: Profile): WritePlan {
  return planRemoveOwned(
    `the Claude Desktop entry for ${profileLabel(profile)}`,
    (e) => entryProfileAt(e.path) === profile,
    profile,
  );
}

export function removeClaudeDesktopEntry(profile: Profile): void {
  planRemoveClaudeDesktopEntry(profile).apply();
}

/** Best-effort. */
export function planRemoveClaudeDesktopOrphan(orphan: DesktopOwnedEntry): WritePlan {
  return planRemoveOwned(
    `the orphaned Claude Desktop entry at ${orphan.path}`,
    (e) => e.path === orphan.path,
    orphan.profile,
  );
}

export function removeClaudeDesktopOrphan(orphan: DesktopOwnedEntry): void {
  planRemoveClaudeDesktopOrphan(orphan).apply();
}

function planRemoveOwned(
  what: string,
  selects: (owned: OwnedDesktopEntry) => boolean,
  helpersOf: Profile | undefined,
): WritePlan {
  const warn = (e: unknown): void => logger.warn(`  Could not remove ${what}: ${errMessage(e)}`);
  let entries: OwnedEntriesRemoval;
  try {
    entries = planRemoveOwnedEntries(selects);
  } catch (e) {
    warn(e);
    return NO_WRITE;
  }
  // A blocked sweep (malformed _meta.json) may leave a live entry pointing at these scripts, so
  // they go only when the library was actually processed.
  if (entries.kind === "blocked") return NO_WRITE;
  const helpers = helpersOf === undefined ? NO_WRITE : planRemoveHelperScripts(helpersOf);
  return {
    files: [...entries.files, ...helpers.files],
    apply() {
      try {
        entries.apply();
        helpers.apply();
      } catch (e) {
        warn(e);
      }
    },
  };
}

function planRemoveHelperScripts(profile: Profile): WritePlan {
  const rootHome = resolveRootHome();
  return concatPlans([
    planRemoveFile(desktopHelperPath(rootHome, "direct", profile)),
    planRemoveFile(desktopHelperPath(rootHome, "proxy", profile)),
  ]);
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
 *  completeness over a directory it could not list. */
export function presentDesktopHelperScripts(rootHome: string): string[] {
  const helpersDir = join(rootHome, HELPERS_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(helpersDir);
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
  if (removeOwnedEntries((owned) => planned.has(owned.path), dirOverride) === "blocked") return;
  removeUnlistedClaudeDesktopClaims(dirOverride, (path) => planned.has(path));
  // Uninstall deletes the root home wholesale right after this step; the helpers still go here so
  // the step is complete on its own.
  for (const path of artifacts.helpers) removeReported(path);
}

/** The `claude.desktop false` sweep. Fail closed: only a claim POSITIVELY attributed to a named
 *  profile goes, since anything else may be the default's. Helper scripts go by FILENAME, so a
 *  named profile's script goes even when its entry was left. */
export function planRemoveUnmanagedClaudeDesktopWiring(opts: { quiet?: boolean } = {}): WritePlan {
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
  const entries = planRemoveOwnedEntries((e) => sweepable(e.path));
  if (entries.kind === "blocked") return NO_WRITE;
  const unlisted = planRemoveUnlistedClaudeDesktopClaims(undefined, sweepable);
  const helpers = concatPlans(
    presentDesktopHelperScripts(resolveRootHome())
      .filter((path) => desktopHelperScriptWiring(basename(path))?.profile !== null)
      .map((path) => planRemoveFile(path)),
  );
  return {
    files: [
      ...entries.files,
      ...(unlisted.kind === "blocked" ? [] : unlisted.files),
      ...helpers.files,
    ],
    apply() {
      entries.apply();
      if (unlisted.kind === "swept") unlisted.apply();
      helpers.apply();
      if (!opts.quiet) announceUnmanagedDefault();
    },
  };
}

/** planRemoveUnmanagedClaudeDesktopWiring, performed. */
export function removeUnmanagedClaudeDesktopWiring(opts: { quiet?: boolean } = {}): void {
  planRemoveUnmanagedClaudeDesktopWiring(opts).apply();
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

/** Undefined when the document carries no wiring of ours (absent or damaged: no target can claim
 *  it, so it is an orphan). Attribution reads the managed MCP server's `--profile` argument, the one
 *  key both credential shapes write (a static entry names no helper script). An UNREADABLE
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
  const at = args.indexOf("--profile");
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

/** The leftovers of a removal that failed after the meta save: the claims released, their files
 *  deleted when present. `dirOverride` as in removeAllClaudeDesktopWiring; `selects` narrows the
 *  sweep (the key-off attribution). */
export function planRemoveUnlistedClaudeDesktopClaims(
  dirOverride?: string | null,
  selects: (path: string) => boolean = () => true,
): OwnedEntriesRemoval {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { kind: "swept", ...NO_WRITE };
  const library = readOwnedLibrary(dir);
  if (library === null) return { kind: "blocked" };
  const ledger = new OwnershipLedger();
  const removals = library.unlisted.filter(selects).map((path) => ({
    path,
    file: planRemoveFile(path, ENTRY),
  }));
  return {
    kind: "swept",
    files: removals.flatMap((r) => r.file.files),
    apply() {
      for (const { path, file } of removals) {
        file.apply();
        ledger.release("claudeDesktop", path);
      }
    },
  };
}

/** planRemoveUnlistedClaudeDesktopClaims, performed. */
export function removeUnlistedClaudeDesktopClaims(
  dirOverride?: string | null,
  selects: (path: string) => boolean = () => true,
): "swept" | "blocked" {
  const plan = planRemoveUnlistedClaudeDesktopClaims(dirOverride, selects);
  if (plan.kind === "swept") plan.apply();
  return plan.kind;
}

/** A sweep over the owned entries: blocked when _meta.json cannot be judged, else the files it
 *  removes and the step that removes them. */
type OwnedEntriesRemoval = { kind: "blocked" } | ({ kind: "swept" } & WritePlan);

/** A foreign row is never a candidate. Meta FIRST, config files second, ownership release last: a
 *  failure mid-way can leave an orphaned (invisible) config file, never a picker row whose config
 *  is gone. */
function planRemoveOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
  dirOverride?: string | null,
): OwnedEntriesRemoval {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { kind: "swept", ...NO_WRITE };
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  if (raw === null) return { kind: "swept", ...NO_WRITE }; // no library, nothing recorded here to remove
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the config library alone.`,
    );
    return { kind: "blocked" }; // a live entry may reference the helper scripts: keep them
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
  if (removedPaths.length === 0) return { kind: "swept", ...NO_WRITE };
  // The applied slot is handed to a remaining entry of ours (the default's first), never left
  // empty: an empty slot boots the app into claude.ai sign-in, and only the non-quiet wire could
  // refill it.
  if (removedApplied) {
    const ours = kept.filter((e) => claims.has(join(dir, `${e.id}.json`)));
    const next = ours.find((e) => entryProfileAt(join(dir, `${e.id}.json`)) === null) ?? ours[0];
    meta.appliedId = next?.id ?? null;
  }
  meta.entries = kept;
  const index = planDesktopMeta(dir, raw, meta);
  const removals = removedPaths.map((path) => ({ path, file: planRemoveFile(path, ENTRY) }));
  return {
    kind: "swept",
    files: [index.file, ...removals.flatMap((r) => r.file.files)],
    apply() {
      index.apply();
      for (const { path, file } of removals) {
        file.apply();
        ledger.release("claudeDesktop", path);
      }
    },
  };
}

/** planRemoveOwnedEntries, performed. */
function removeOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
  dirOverride?: string | null,
): "swept" | "blocked" {
  const plan = planRemoveOwnedEntries(selects, dirOverride);
  if (plan.kind === "swept") plan.apply();
  return plan.kind;
}
