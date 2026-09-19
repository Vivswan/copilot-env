// Claude Desktop's files on disk: the per-platform data dirs, whether the app is installed, the
// config library (index and entry files), and the two app files beside it. The entry document's
// vocabulary is desktop_payload.ts; the reconcile that decides what to write is desktop.ts.
//
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
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Profile, WINDOWS_DEVICE_NAME_RE } from "../copilot_api/profile.ts";
import { appRunning, type AppScan } from "../utils/app_scan.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

export type Doc = Record<string, unknown>;

// --- paths + detection ---------------------------------------------------------

/** Test seam. When set it also GOVERNS detection: the dir's existence means Desktop is installed,
 *  so the suite floor points it at a non-created dir and the whole suite sees no Desktop. */
export const CLAUDE_DESKTOP_DIR_ENV = "COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR";

/** The environment the app's data dirs derive from, one field per platform. */
interface DesktopEnv {
  localAppData?: string;
  appData?: string;
  xdgConfigHome?: string;
}

/** Where the app lives on one platform. `data` is the third-party (Claude-3p) userData dir and
 *  `standard` the default (claude.ai) one: Developer Mode is read from the latter even in
 *  third-party mode, since the app resolves developer_settings.json before it switches its data
 *  dir (Electron's default userData is the ROAMING AppData on Windows, unlike the Claude-3p dir).
 *  `app` is where an install itself sits; Linux has no fixed install path. A null dir: the
 *  platform's variable is unset, or the platform has no app. */
interface DesktopDirs {
  data: string | null;
  standard: string | null;
  app: string[];
}

/** Platform-parameterized so every branch runs on every CI runner. The XDG spec reads an EMPTY or
 *  RELATIVE variable as unset (a relative one would land the app files in the working directory). */
export function desktopDirsFor(platform: string, home: string, env: DesktopEnv): DesktopDirs {
  switch (platform) {
    case "darwin": {
      const support = join(home, "Library", "Application Support");
      return {
        data: join(support, "Claude-3p"),
        standard: join(support, "Claude"),
        app: ["/Applications/Claude.app", join(home, "Applications", "Claude.app")],
      };
    }
    case "win32":
      return {
        data: env.localAppData ? join(env.localAppData, "Claude-3p") : null,
        standard: env.appData ? join(env.appData, "Claude") : null,
        app: env.localAppData === undefined
          ? []
          : [join(env.localAppData, "AnthropicClaude", "claude.exe")],
      };
    case "linux": {
      const xdg = env.xdgConfigHome;
      const root = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
      return { data: join(root, "Claude-3p"), standard: join(root, "Claude"), app: [] };
    }
    default:
      return { data: null, standard: null, app: [] };
  }
}

function desktopEnv(): DesktopEnv {
  return {
    localAppData: process.env.LOCALAPPDATA,
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  };
}

function desktopDirs(): DesktopDirs {
  return desktopDirsFor(process.platform, homedir(), desktopEnv());
}

/** Under the seam, the standard dir is the seam's `-1p` sibling. */
function resolveDesktopDataDirs(): { data: string; standard: string } | null {
  const seam = seamDir();
  if (seam !== null) return { data: seam, standard: `${seam}-1p` };
  const { data, standard } = desktopDirs();
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
  const dataDir = seamDir() ?? desktopDirs().data;
  return dataDir === null ? null : desktopLibraryDirUnder(dataDir);
}

/** The app at an install path, or either data dir present: an app installed somewhere unusual
 *  that has run (on Linux the only signal). */
export function desktopAppInstalledFor(
  platform: string,
  exists: (path: string) => boolean,
  home: string,
  env: DesktopEnv,
): boolean {
  const dirs = desktopDirsFor(platform, home, env);
  return [dirs.data, dirs.standard, ...dirs.app].some((path) => path !== null && exists(path));
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

export interface DesktopMetaEntry {
  id: string;
  name: string;
  /** Every OTHER field the app keeps on this row, preserved verbatim on save. */
  extra: Record<string, unknown>;
}

export interface DesktopMeta {
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

/** A JSON write: the bytes land unless the file already holds them (true when written). `secretKeys`
 *  names the leaves a preview redacts. */
export function writeJson(
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
export function writeDesktopMeta(
  dir: string,
  currentRaw: string | null,
  meta: DesktopMeta,
): boolean {
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

/** A present file goes, named; an absent path, or one under a parent that is not a directory (a
 *  helpers dir replaced by a file), is nothing to do. A directory at the path is the seam's own
 *  refusal (assertNotDirectory), in a dry run too. */
export function removeFile(path: string, detail?: string): void {
  fs.assertNotDirectory(path);
  try {
    fs.rm(path, { force: true, detail });
  } catch (e) {
    if (!isEnoentOrNotdir(e)) throw e;
  }
}

// --- app files -----------------------------------------------------------------------

/** The app's process name, for the running scan. */
const CLAUDE_DESKTOP_PROCESS = "Claude";
const APP_CONFIG_FILENAME = "claude_desktop_config.json";
const DEVELOPER_SETTINGS_FILENAME = "developer_settings.json";

type DesktopDeploymentMode = "3p" | "1p";

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
export function prepareClaudeDesktopAppFiles(): () => void {
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
