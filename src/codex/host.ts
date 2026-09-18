// The Codex home derivation (the `codex.home` root, the per-host farm under it, else ~/.codex) and
// the per-host CODEX_HOME symlink farm (Linux/macOS), DERIVED from the `codex.host` config key by
// every default Codex wiring pass.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { type CodexHomePrefs, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../utils/hostname.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { reportWrite } from "../utils/report_write.ts";
import { CODEX_PROVIDER_ID, codexConfigPath, defaultCodexHome, plainCodexHome } from "./paths.ts";
import { readCodexToml } from "./toml_io.ts";

const logger = createStderrLogger();

// Resolved absolute at its one source: it is recorded, exported into shells, and removed by this
// path, so a relative HOME must never make it cwd-dependent. The farm lives under the `codex.home`
// root when that key is set (`<codex-home>/hosts/<hostname>`), else under ~/.codex.
export function getHostLocalCodexHome(
  root: string | null = codexHomePrefsOrDerived().explicit,
): string {
  return path.resolve(codexFarmHostsDir(root ?? undefined), getSanitizedHostname());
}

/** `active` is recorded in run state AFTER the config write succeeded. */
export interface CodexHostFarm {
  hostHome: string;
  /** The farm directory exists (a half-built farm counts). */
  present: boolean;
  /** Its config.toml selects OUR managed provider: proof the farm is copilot-env's (the build's
   *  empty seed, a foreign config, or an unparseable one are all not wired). */
  wired: boolean;
  /** A probe (the dir, or its config.toml) failed for a reason other than absence, so `present` and
   *  `wired` are unproven. */
  probeError: string | null;
  active: boolean;
}

export function codexHostFarm(prefs: CodexHomePrefs = codexHomePrefsOrDerived()): CodexHostFarm {
  const hostHome = getHostLocalCodexHome(prefs.explicit);
  return {
    hostHome,
    ...probeCodexFarm(hostHome),
    active: new CopilotEnvRunState().read().codexHome === hostHome,
  };
}

/** The farm facts for any path, ours or not: `agent uninstall` asks it about the recorded farm before
 *  deleting, since the record alone never authorizes a delete (see isOurFarm). */
export function probeCodexFarm(
  hostHome: string,
): Pick<CodexHostFarm, "present" | "wired" | "probeError"> {
  let viaLink: boolean;
  try {
    viaLink = fs.lstat(hostHome).isSymbolicLink();
  } catch (e) {
    return { present: false, wired: false, probeError: isEnoentOrNotdir(e) ? null : errMessage(e) };
  }
  try {
    // Wiring reached THROUGH a symlink (the home or its config.toml) is someone else's tree, never
    // proof the farm is ours.
    const configPath = codexConfigPath(hostHome);
    if (viaLink || (lexists(configPath) && isSymlinkPath(configPath))) {
      return { present: true, wired: false, probeError: null };
    }
    const read = readCodexToml(configPath);
    const wired = read.kind === "ok" && read.doc.model_provider === CODEX_PROVIDER_ID;
    return { present: true, wired, probeError: null };
  } catch (e) {
    return { present: true, wired: false, probeError: isEnoentOrNotdir(e) ? null : errMessage(e) };
  }
}

// The inherited CODEX_HOME is OUR farm export (never a user's choice, so `agent profile env` may clear it).
// Exact spelling on purpose: a trailing-slash variant is not ours. Never on Windows: no farm is
// built there, so a farm-shaped export is a shared home of the user's own.
export function isManagedFarmExport(
  envHome: string | undefined,
  prefs: CodexHomePrefs = codexHomePrefsOrDerived(),
): boolean {
  if (process.platform === "win32") return false;
  return Boolean(envHome && envHome === getHostLocalCodexHome(prefs.explicit));
}

/** The home every Codex write, `agent profile check --codex`, `agent profile env`, and the launch pin agree on, plus
 *  the one note the writer, `--check`, and the launcher print (the other readers stay silent). */
export interface CodexHomeResolution {
  home: string;
  /** What decided the home: the `codex.host` farm, the `codex.home` root, or the shell/default
   *  convention (which is never stale). The note's wording follows it. */
  by: "farm" | "codex-home" | "default";
  /** The shell's CODEX_HOME when copilot-env decided the home (the farm, or the `codex.home` root)
   *  and the export names another directory: an rc file, a shell `agent profile env` never refreshed. Null
   *  when the shell is silent or agrees; with neither key the export IS the home, so never stale. */
  staleExport: string | null;
}

/**
 * The ONE precedence, over the folded keys (codexHomePrefsFor). The keys alone decide: neither the
 * run-state record nor the disk steers the home, so a farm not built yet (or hand-edited) is still
 * the home the user asked for, and the next `agent profile sync --codex` builds or repairs it there.
 *
 *   codex.host on   -> the farm, <root>/hosts/<hostname>; a differing export is noted, not honoured
 *   codex.home set  -> that path; a differing export is noted, not honoured
 *   neither         -> $CODEX_HOME unless it is OUR farm export, built or not (a write through it
 *                      would resurrect the removed farm as a plain dir), else ~/.codex
 */
export function resolveCodexHome(
  prefs: CodexHomePrefs = codexHomePrefsOrDerived(),
): CodexHomeResolution {
  if (prefs.hostFarm) {
    const hostHome = getHostLocalCodexHome(prefs.explicit);
    return { home: hostHome, by: "farm", staleExport: staleExportAgainst(hostHome) };
  }
  if (prefs.explicit !== null) {
    return {
      home: prefs.explicit,
      by: "codex-home",
      staleExport: staleExportAgainst(prefs.explicit),
    };
  }
  return { home: unmanagedCodexHome(prefs), by: "default", staleExport: null };
}

function staleExportAgainst(home: string): string | null {
  const exported = process.env.CODEX_HOME;
  return exported && exported !== home ? exported : null;
}

export function effectiveCodexHome(): string {
  return resolveCodexHome().home;
}

export function effectiveCodexHomeFor(prefs: CodexHomePrefs): string {
  return resolveCodexHome(prefs).home;
}

/** `$CODEX_HOME` unless it is OUR farm export (POSIX only; Windows never has a farm), else
 *  `~/.codex`. `prefs` names the root the farm export is judged against: the settings-import plan
 *  passes the bundle's, so its line and the apply's write agree. */
export function unmanagedCodexHome(prefs: CodexHomePrefs = codexHomePrefsOrDerived()): string {
  if (isManagedFarmExport(process.env.CODEX_HOME, prefs)) {
    return plainCodexHome();
  }
  return defaultCodexHome();
}

export function staleCodexHomeExportLine(resolution: CodexHomeResolution): string | null {
  if (resolution.staleExport === null) return null;
  const wired = resolution.by === "farm"
    ? `codex.host is on, so Codex is wired at the per-host farm ${resolution.home}`
    : `codex.home is set, so Codex is wired at ${resolution.home}`;
  return `Ignoring the shell's CODEX_HOME=${resolution.staleExport}: ${wired}`;
}

const narratedStaleExports = new Set<string>();

/** Prints the stale-export note once per process and hands the home back. A launch that re-wires
 *  Codex resolves the home twice (the write, then the child's pin) and must not say it twice. */
export function narrateCodexHome(resolution: CodexHomeResolution): string {
  const line = staleCodexHomeExportLine(resolution);
  if (line !== null && !narratedStaleExports.has(line)) {
    narratedStaleExports.add(line);
    logger.warn(line);
  }
  return resolution.home;
}

/** The single decision the derivation (withCodexHostFarm) and the settings-import plan share.
 *  `leave` = something sits at the farm path that is not proven ours (no record, no managed
 *  wiring). */
export type CodexHostFarmPlan = { action: "build" | "verify" | "remove" | "leave" | "none" };

/** The activation record alone proves only that we built something there once; the user may have
 *  replaced it since, so it never authorizes a delete. */
export function isOurFarm(farm: CodexHostFarm): boolean {
  return farm.wired;
}

export function planCodexHostFarm(
  enabled: boolean,
  farm: CodexHostFarm,
  platform: NodeJS.Platform = process.platform,
): CodexHostFarmPlan {
  if (platform === "win32") return { action: "none" };
  if (enabled) return { action: farm.present ? "verify" : "build" };
  if (!farm.present && farm.probeError === null) return { action: "none" };
  // Never delete what we cannot prove is ours right now: a foreign dir, a symlink, a half-built
  // leftover, an unprobeable path.
  return isOurFarm(farm) ? { action: "remove" } : { action: "leave" };
}

/** Runs on every read path (`--check`, health, the wiring read-back), where an unreadable store
 *  must not throw: it reads as the built-in derivation (no path, farm off). */
function codexHomePrefsOrDerived(): CodexHomePrefs {
  try {
    return new CopilotEnvConfig().codexHomePrefs();
  } catch {
    return { explicit: null, hostFarm: false };
  }
}

/** The farm's disagreement with the `codex.host` key (each kind's line says what the next wiring
 *  pass does about it), or null when they agree. */
export type CodexHostDrift = { kind: "missing" | "inactive" | "disabled"; hostHome: string };

export function codexHostDrift(
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): CodexHostDrift | null {
  // No farm can exist on Windows, so a farm-shaped path there (a shared home) is not ours.
  if (process.platform === "win32") return null;
  const prefs = config.codexHomePrefs();
  return codexHostDriftFrom(prefs.hostFarm, codexHostFarm(prefs));
}

/** Over already-gathered farm facts: health probes them through its own seams. */
export function codexHostDriftFrom(enabled: boolean, farm: CodexHostFarm): CodexHostDrift | null {
  if (!enabled) return isOurFarm(farm) ? { kind: "disabled", hostHome: farm.hostHome } : null;
  if (!farm.wired) return { kind: "missing", hostHome: farm.hostHome };
  return farm.active ? null : { kind: "inactive", hostHome: farm.hostHome };
}

/** The one-line report of a drift, shared by `agent profile check --codex` and `agent health`. */
export function codexHostDriftLine(drift: CodexHostDrift): string {
  switch (drift.kind) {
    case "missing":
      return `codex.host is on but the per-host CODEX_HOME farm is missing at ${drift.hostHome}; run \`agent profile sync --codex\` to rebuild it`;
    case "inactive":
      // A farm built under another root (or before a rebuild) is wired but unrecorded: `agent
      // uninstall` would not delete it until a pass records it again.
      return `codex.host is on but no completed wiring pass is recorded for the per-host CODEX_HOME ` +
        `farm at ${drift.hostHome}; run \`agent profile sync --codex\` to record it`;
    case "disabled":
      return `codex.host is off but a per-host CODEX_HOME farm is still present at ${drift.hostHome}; run \`agent profile sync --codex\` to remove it`;
  }
}

// --- small fs probes ---------------------------------------------------------
// A stat/read failure means "not that kind of thing", never an error. The mutating operations below
// are the opposite: they throw, and the failure surfaces through the farm error.

function lexists(p: string): boolean {
  try {
    fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function readlinkOrEmpty(p: string): string {
  try {
    return fs.readlink(p);
  } catch {
    return "";
  }
}

// An unreadable side counts as "not equal", so callers refuse rather than merge.
function filesEqual(a: string, b: string): boolean {
  try {
    const x = fs.readBytes(a);
    const y = fs.readBytes(b);
    return x.length === y.length && x.every((byte, i) => byte === y[i]);
  } catch {
    return false;
  }
}

function isSymlinkPath(p: string): boolean {
  try {
    return fs.lstat(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirPath(p: string): boolean {
  try {
    return fs.stat(p).isDirectory();
  } catch {
    return false;
  }
}

function isFilePath(p: string): boolean {
  try {
    return fs.stat(p).isFile();
  } catch {
    return false;
  }
}

// --- fs operations that throw on failure --------------------------------------
// Every mutation goes through the reporting seam, which names the path it changed (nothing hidden);
// what the farm did to it rides as the line's detail.

// Symlinked directories are not descended into; each level lists dirs before files.
function listDescendants(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dirpath = stack.pop() as string;
    const entries = fs.readdirEntries(dirpath);
    const dirnames: string[] = [];
    const filenames: string[] = [];
    for (const entry of entries) {
      const isDir = !entry.isSymbolicLink() && entry.isDirectory();
      (isDir ? dirnames : filenames).push(entry.name);
    }
    for (const name of dirnames) results.push(path.join(dirpath, name));
    for (const name of filenames) results.push(path.join(dirpath, name));
    for (const name of dirnames) stack.push(path.join(dirpath, name));
  }
  return results;
}

// Symlinks are preserved as links.
function mergeDirInto(localPath: string, sharedPath: string): void {
  const entries = fs.readdirEntries(localPath);
  for (const entry of entries) {
    const src = path.join(localPath, entry.name);
    const dst = path.join(sharedPath, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlink(src);
      if (lexists(dst)) {
        const dstIsSymlink = isSymlinkPath(dst);
        const dstIsDir = isDirPath(dst);
        if (dstIsSymlink || !dstIsDir) fs.rm(dst, { force: true, detail: "replaced by a link" });
      }
      fs.symlink(target, dst);
    } else if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      fs.copyFile(src, dst, `copied from ${src}`);
    }
  }
}

/** Names every entry it writes; symlinks are copied as links. */
function copyTree(src: string, dst: string): void {
  fs.mkdir(dst);
  for (const entry of fs.readdirEntries(src)) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlink(from);
      // An existing link here already passed the merge validation (same target).
      fs.rm(to, { force: true, detail: "replaced by a link" });
      fs.symlink(target, to);
    } else if (entry.isDirectory()) {
      copyTree(from, to);
    } else {
      fs.copyFile(from, to, `copied from ${from}`);
    }
  }
}

function ensureParentDir(p: string): void {
  fs.mkdir(path.dirname(p));
}

// === CODEX_HOME symlink farm (seeding) ===

function warnExistingCodexPath(p: string): void {
  logger.warn(`Leaving existing Codex path unchanged: ${p}`);
}

// "refused" is a normal outcome (the caller warns and moves on), not an error; filesystem failures
// throw instead.
type PromoteResult = "promoted" | "refused";

/** How a host-local directory reaches the shared root, judged once (reads only) by the preflight
 *  and the builder alike. The builder creates the shared directory first, so a missing one is an
 *  empty one here and every local entry is copied into it.
 *    merge    -> every local entry fits the shared directory (same-target links, equal files,
 *                directories where directories go): copied in, the local tree removed
 *    refused  -> the merge would overwrite shared content: warned, local left unchanged, no link */
type PromoteDecision = "merge" | "refused";

function promoteDecision(localPath: string, sharedPath: string): PromoteDecision {
  if (lexists(sharedPath) && (isSymlinkPath(sharedPath) || !isDirPath(sharedPath))) {
    return "refused";
  }
  for (const entry of listDescendants(localPath)) {
    const targetPath = path.join(sharedPath, path.relative(localPath, entry));
    if (isSymlinkPath(entry)) {
      if (isSymlinkPath(targetPath)) {
        if (readlinkOrEmpty(entry) !== readlinkOrEmpty(targetPath)) return "refused";
      } else if (lexists(targetPath)) {
        return "refused";
      }
    } else if (isDirPath(entry)) {
      if (lexists(targetPath) && (isSymlinkPath(targetPath) || !isDirPath(targetPath))) {
        return "refused";
      }
    } else if (isFilePath(entry)) {
      if (
        lexists(targetPath) &&
        (isSymlinkPath(targetPath) || !isFilePath(targetPath) || !filesEqual(entry, targetPath))
      ) {
        return "refused";
      }
    } else {
      return "refused";
    }
  }
  return "merge";
}

// Refused (warning, local dir left unchanged) when the merge would overwrite existing shared
// content.
function promoteCodexDirToSharedIfSafe(localPath: string, sharedPath: string): PromoteResult {
  switch (promoteDecision(localPath, sharedPath)) {
    case "refused":
      warnExistingCodexPath(localPath);
      return "refused";
    case "merge":
      // TOCTOU: the merge below races the decision above; accepted, startup-only flow.
      mergeDirInto(localPath, sharedPath);
      fs.rm(localPath, { recursive: true, force: true, detail: "merged into the shared root" });
      return "promoted";
  }
}

function primeSharedCodexHomeIfMissing(sharedRoot: string): void {
  // The prime is codex's own first run, outside the seam: a dry run must not spawn it, and lands
  // the shared root's mkdir through the facade instead.
  if (fs.dryRunActive()) return;
  // Proven absence only: a look that failed (permissions, a blip) must not start a prime whose scan
  // below would then name an existing tree as newly created.
  try {
    fs.lstat(sharedRoot);
    return;
  } catch (e) {
    if (!isEnoentOrNotdir(e)) return;
  }
  // resolveCommand's nvm fallback also finds an nvm-only codex, and spawning the RESOLVED path
  // keeps the prime working even though this process never sourced nvm.sh.
  const codexBin = resolveCommand("codex");
  if (codexBin === null) return;

  // Codex itself creates the shared home before we seed and symlink into it. The prime is a
  // convenience, never a build failure, so spawnSync's result (a nonzero exit, ENOENT, and the
  // timeout land there; none throw) is ignored on purpose.
  //   CODEX_HOME set explicitly -> an inherited value (our own farm export) would send codex's
  //                                writes elsewhere; the scan below covers exactly the home given
  spawnSync(codexBin, ["exec"], {
    input: "hi\n",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10_000,
    env: { ...process.env, CODEX_HOME: sharedRoot },
  });
  // The root was absent, so everything under it now is what the prime made: a write asked for by
  // us, named by us. A root that came back as a symlink is named as the one entry it is, never
  // walked into.
  if (!lexists(sharedRoot)) return;
  reportWrite("created", sharedRoot);
  if (isDirPath(sharedRoot) && !isSymlinkPath(sharedRoot)) reportTreeCreated(sharedRoot);
}

/** Each level names all its entries in readdir order, then recurses into its directories; a level
 *  that cannot be listed leaves its whole subtree unnamed. */
function reportTreeCreated(dir: string): void {
  let entries: fs.DirEntry[];
  try {
    entries = fs.readdirEntries(dir);
  } catch {
    return;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const made = path.join(dir, entry.name);
    reportWrite("created", made);
    if (!entry.isSymbolicLink() && entry.isDirectory()) dirs.push(made);
  }
  for (const sub of dirs) reportTreeCreated(sub);
}

function seedLocalCodexFileIfMissing(
  localPath: string,
  sharedPath: string,
  createPlaceholder: boolean,
  role: string,
): void {
  if (lexists(localPath)) {
    if (isSymlinkPath(localPath)) {
      logger.warn(
        `Skipping local Codex seed because the path already exists as a symlink: ${localPath}`,
      );
    }
    return;
  }

  if (isFilePath(sharedPath)) {
    ensureParentDir(localPath);
    fs.copyFile(sharedPath, localPath, `${role}, seeded from ${sharedPath}`);
  } else if (createPlaceholder) {
    ensureParentDir(localPath);
    fs.writeText(localPath, "", { atomic: false, detail: `${role}, empty`, secretKeys: [] });
  }
}

/** What the shared copy holds after the seed: the local file's bytes (just copied), or whatever
 *  was there. The link step takes the copy as equal without a byte compare, as the copy IS the
 *  local file. */
type SharedSeed = "copy-of-local" | "as-is";

// Shared desktop state files need a one-time promotion from the host-local CODEX_HOME into ~/.codex
// so existing installs keep their saved projects. Without `createPlaceholder` the shared file only
// appears when a host-local copy exists to promote.
function seedSharedCodexFileIfMissing(
  sharedPath: string,
  localPath: string,
  createPlaceholder: boolean,
): SharedSeed {
  const sharedExists = lexists(sharedPath);

  if (isFilePath(localPath) && !isSymlinkPath(localPath)) {
    if (!sharedExists) {
      ensureParentDir(sharedPath);
      fs.copyFile(localPath, sharedPath, `copied from ${localPath}`);
      return "copy-of-local";
    }

    if (
      isFilePath(sharedPath) &&
      fs.stat(sharedPath).size === 0 &&
      fs.stat(localPath).size > 0
    ) {
      fs.copyFile(localPath, sharedPath, `copied from ${localPath}`);
      return "copy-of-local";
    }
    return "as-is";
  }

  if (createPlaceholder && !sharedExists) {
    ensureParentDir(sharedPath);
    fs.writeText(sharedPath, "", { atomic: false, detail: "empty seed", secretKeys: [] });
  }
  return "as-is";
}

function ensureCodexDirSymlink(localPath: string, sharedPath: string): void {
  if (isSymlinkPath(localPath)) {
    if (readlinkOrEmpty(localPath) !== sharedPath) warnExistingCodexPath(localPath);
    return;
  }

  if (isDirPath(localPath)) {
    if (promoteCodexDirToSharedIfSafe(localPath, sharedPath) === "refused") return;
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return;
  }

  if (!lexists(localPath)) {
    ensureParentDir(localPath);
    fs.symlink(sharedPath, localPath);
  }
}

// A host-local copy identical to the seeded shared file becomes a symlink, so future desktop
// updates read and write the same shared state.
function ensureCodexFileSymlink(localPath: string, sharedPath: string, seed: SharedSeed): void {
  if (isSymlinkPath(localPath)) {
    if (readlinkOrEmpty(localPath) !== sharedPath) warnExistingCodexPath(localPath);
    return;
  }

  if (isFilePath(localPath)) {
    if (seed !== "copy-of-local" && !filesEqual(localPath, sharedPath)) {
      warnExistingCodexPath(localPath);
      return;
    }
    fs.rm(localPath, { force: true, detail: "identical to the shared copy" });
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return;
  }

  ensureParentDir(localPath);
  fs.symlink(sharedPath, localPath);
}

// --- the farm layout, as data ------------------------------------------------
// Every entry name is an on-disk contract with the Codex desktop app: renaming one is a layout
// change, not a refactor.

// Host-local scratch: real directories, never shared or symlinked.
const HOST_LOCAL_DIRS = [
  ".tmp", // Host-local scratch/cache state, including plugin temp data.
  "log", // Host-local runtime logs.
  "tmp", // Host-local transient working files.
];

// Seeded once from the shared root (or empty, with `placeholder`), then owned by the host; `role`
// is what the seed's write line calls the file. config.toml gets no placeholder: the default config
// write that follows every build rewrites it, silently when the seed already named it (the seam
// names a path once per process), so a fresh farm's config.toml is named by that write instead.
const HOST_LOCAL_SEED_FILES = [
  { name: ".personality_migration", placeholder: true, role: "host-local seed" },
  { name: "config.toml", placeholder: false, role: "Codex config" },
  { name: "history.jsonl", placeholder: true, role: "host-local seed" },
];

// A real directory at the shared root, symlinked from the host home (host-local content is promoted
// into the shared copy when safe).
const SHARED_DIRS = [
  "ambient-suggestions", // Background suggestion state surfaced by Codex.
  "archived_sessions", // Older conversation transcripts kept by the desktop app.
  "memories", // Long-term memory state.
  "memories_extensions", // Extension-generated memory enrichments.
  "plugins", // Installed plugins and their persistent data.
  "rules", // Synced Codex rules and instructions.
  "sessions", // Active conversation transcripts.
  "shell_snapshots", // Reusable shell context captured by Codex.
  "skills", // Installed skills available to Codex.
  "vendor_imports", // Imported third-party agent bundles.
  "worktrees", // Shared worktree metadata used across checkouts.
];

// Seeded at the shared root, symlinked from the host home. `placeholder: false` marks state only
// worth syncing when a host already has it, so no empty shared file is fabricated (the host symlink
// dangles).
const SHARED_FILES: readonly { name: string; placeholder: boolean }[] = [
  { name: ".codex-global-state.json", placeholder: true }, // Desktop workspace and project state.
  { name: "AGENTS.md", placeholder: true }, // Shared agent instructions exposed inside Codex home.
  { name: "session_index.jsonl", placeholder: true }, // Session lookup index maintained by the desktop app.
  { name: "version.json", placeholder: true }, // Codex home layout/schema version marker.
  { name: "installation_id", placeholder: false }, // Per-install identifier, present once Codex has run.
  { name: "shell-init.sh", placeholder: false }, // User shell hook, present only when configured.
];

/** Every look the build takes is taken before its first write, so a refused build leaves nothing
 *  half-made: mkdir fails on anything that is not a directory where one goes (a link to one
 *  included, as mkdir follows it; the error is mkdir's own), and a promotion's listing of a
 *  host-local tree fails where it would fail the merge. */
function preflightCodexSymlinkFarm(codexHome: string, sharedRoot: string): void {
  const slots = [
    sharedRoot,
    codexHome,
    ...HOST_LOCAL_DIRS.map((name) => path.join(codexHome, name)),
    ...SHARED_DIRS.map((name) => path.join(sharedRoot, name)),
  ];
  for (const p of slots) {
    if (lexists(p) && !isDirPath(p)) throw new Error(`EEXIST: file already exists, mkdir '${p}'`);
  }
  for (const name of SHARED_DIRS) {
    const local = path.join(codexHome, name);
    if (isDirPath(local) && !isSymlinkPath(local)) {
      promoteDecision(local, path.join(sharedRoot, name));
    }
  }
}

function buildCodexSymlinkFarm(codexHome: string): void {
  // Both halves from the ONE resolved host path (<shared root>/hosts/<host>): a shared root spelled
  // relative would make every symlink target relative to the link's own directory, pointing back
  // inside the farm.
  const sharedRoot = path.dirname(path.dirname(codexHome));
  preflightCodexSymlinkFarm(codexHome, sharedRoot);
  primeSharedCodexHomeIfMissing(sharedRoot);
  fs.mkdir(sharedRoot);
  fs.mkdir(codexHome, { detail: "per-host CODEX_HOME farm" });

  for (const name of HOST_LOCAL_DIRS) {
    fs.mkdir(path.join(codexHome, name));
  }

  for (const { name, placeholder, role } of HOST_LOCAL_SEED_FILES) {
    seedLocalCodexFileIfMissing(
      path.join(codexHome, name),
      path.join(sharedRoot, name),
      placeholder,
      role,
    );
  }

  for (const name of SHARED_DIRS) {
    fs.mkdir(path.join(sharedRoot, name));
    ensureCodexDirSymlink(path.join(codexHome, name), path.join(sharedRoot, name));
  }

  for (const { name, placeholder } of SHARED_FILES) {
    const seed = seedSharedCodexFileIfMissing(
      path.join(sharedRoot, name),
      path.join(codexHome, name),
      placeholder,
    );
    ensureCodexFileSymlink(path.join(codexHome, name), path.join(sharedRoot, name), seed);
  }
}

/** ONE default Codex config write with the farm derived from the `codex.host` key around it
 *  (planCodexHostFarm decides). The activation record lands only AFTER a successful write and is
 *  cleared BEFORE a rebuild, so it never outlives a proven farm; `agent uninstall` deletes by it. */
export async function withCodexHostFarm(
  write: (codexHome: string) => Promise<void>,
): Promise<void> {
  // ONE key read drives the whole pass, so a concurrent `agent config` cannot split it.
  const prefs = new CopilotEnvConfig().codexHomePrefs();
  // Windows has no farm (POSIX symlinks): nothing to derive, nothing recorded.
  if (process.platform === "win32") return write(narrateCodexHome(resolveCodexHome(prefs)));
  const farm = codexHostFarm(prefs);
  const plan = planCodexHostFarm(prefs.hostFarm, farm);
  const state = new CopilotEnvRunState();
  switch (plan.action) {
    case "build":
    case "verify": {
      if (farm.active) state.set({ codexHome: null });
      // The one terminal handler for farm filesystem failures; the cause names the failing
      // operation and path.
      try {
        buildCodexSymlinkFarm(farm.hostHome);
      } catch (e: unknown) {
        throw new Error(
          `Failed to build the CODEX_HOME symlink farm at ${farm.hostHome}: ${errMessage(e)}`,
          { cause: e },
        );
      }
      // A build names the home it created; a verify names only the members it recreated. A dry
      // run lands nothing, so it has no success to report.
      if (plan.action === "verify" && !fs.dryRunActive()) {
        logger.log(`  ✓ Per-host CODEX_HOME farm verified → ${farm.hostHome}`);
      }
      await write(farm.hostHome);
      state.set({ codexHome: farm.hostHome });
      narrateCodexHome(resolveCodexHome(prefs));
      return;
    }
    case "remove":
      fs.rm(farm.hostHome, { recursive: true, force: true, detail: "per-host CODEX_HOME farm" });
      break;
    case "leave":
      logger.warn(
        `Leaving ${farm.hostHome} alone: it sits at the per-host CODEX_HOME farm path but ` +
          "copilot-env cannot prove it built it (no activation record, no managed config.toml).",
      );
      break;
    case "none":
      break;
  }
  if (state.read().codexHome !== undefined) {
    state.set({ codexHome: null });
  }
  await write(narrateCodexHome(resolveCodexHome(prefs)));
}

/** The effective home (resolveCodexHome), the default ~/.codex, and each per-host farm home,
 *  enumerated through the layout's owner (codexFarmHostsDir, src/utils/hostname.ts). `complete` is
 *  false when the farm directory exists but cannot be enumerated: unseen homes may still hold
 *  state. */
export function knownCodexHomes(): { homes: string[]; complete: boolean } {
  // An unreadable store hides a `codex.home` root and its farms, so the sweep says so rather than
  // reporting the default homes as the whole set.
  let prefs: CodexHomePrefs = { explicit: null, hostFarm: false };
  let complete = true;
  try {
    prefs = new CopilotEnvConfig().codexHomePrefs();
  } catch {
    complete = false;
  }
  const homes = new Set<string>([effectiveCodexHomeFor(prefs)]);
  // The default home resolves via homedir(); the farm root via its creator's contract
  // (codexFarmHostsDir on homeDir, process.env.HOME first). They can differ (HOME set on Windows),
  // so BOTH are swept; the Set dedupes the common case. A `codex.home` root is a third: its own
  // farm hosts dir is swept beside the default one, since a key change leaves the other behind.
  homes.add(plainCodexHome());
  const hostsDirs = [codexFarmHostsDir()];
  if (prefs.explicit !== null) {
    homes.add(prefs.explicit);
    hostsDirs.push(codexFarmHostsDir(prefs.explicit));
  }
  for (const hostsDir of hostsDirs) {
    homes.add(path.dirname(hostsDir));
    try {
      for (const entry of fs.readdirEntries(hostsDir)) {
        if (entry.isDirectory()) homes.add(path.join(hostsDir, entry.name));
      }
    } catch (e) {
      // No farm directory: the base homes cover everything. Any OTHER failure (EACCES, I/O) hides
      // farm homes that may hold state.
      if (isRecord(e) && !isEnoentOrNotdir(e)) complete = false;
    }
  }
  return { homes: [...homes], complete };
}
