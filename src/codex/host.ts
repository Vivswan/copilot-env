// Per-host Codex home manager: the per-host CODEX_HOME symlink farm (Linux/macOS),
// DERIVED from the `codex-host` config key by every default Codex wiring pass.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, isFile } from "../utils/fs.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../utils/hostname.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  copyFileReported,
  mkdirReported,
  removeReported,
  removeTreeReported,
  renameReported,
  reportWrite,
  symlinkReported,
  writeFileReported,
} from "../utils/report_write.ts";
import { CODEX_PROVIDER_ID, codexConfigPath, defaultCodexHome } from "./paths.ts";
import { readCodexToml } from "./toml_io.ts";

const logger = createStderrLogger();

// The per-host CODEX_HOME (<farm root>/<hostname>), resolved absolute at its one
// source: it is recorded, exported into shells, and removed by this path, so a
// relative HOME must never make it cwd-dependent.
export function getHostLocalCodexHome(): string {
  return path.resolve(codexFarmHostsDir(), getSanitizedHostname());
}

/** The per-host farm's state: what is on disk, and whether a wiring pass activated
 *  it (recorded it in run state AFTER its config write succeeded). */
export interface CodexHostFarm {
  hostHome: string;
  /** The farm directory exists (a half-built farm counts). */
  present: boolean;
  /** Its config.toml selects OUR managed provider: proof the farm is copilot-env's (the
   *  build's empty seed, a foreign config, or an unparseable one are all not wired). */
  wired: boolean;
  /** A probe (the dir, or its config.toml) failed for a reason other than absence, so
   *  `present`/`wired` are unproven. */
  probeError: string | null;
  /** Run state records it as the active CODEX_HOME (the post-write commit marker). */
  active: boolean;
}

export function codexHostFarm(): CodexHostFarm {
  const hostHome = getHostLocalCodexHome();
  return {
    hostHome,
    ...probeFarm(hostHome),
    active: new CopilotEnvRunState().read().codexHome === hostHome,
  };
}

function probeFarm(hostHome: string): Pick<CodexHostFarm, "present" | "wired" | "probeError"> {
  let viaLink: boolean;
  try {
    viaLink = fs.lstatSync(hostHome).isSymbolicLink();
  } catch (e) {
    return { present: false, wired: false, probeError: isEnoentOrNotdir(e) ? null : errMessage(e) };
  }
  try {
    // Wiring reached THROUGH a symlink (the home or its config.toml) is someone else's
    // tree, never proof the farm is ours.
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

// The inherited CODEX_HOME is OUR farm export (never a user's choice, so `agent env`
// may clear it). Exact spelling on purpose: a trailing-slash variant is not ours.
export function isManagedFarmExport(envHome: string | undefined): boolean {
  return Boolean(envHome && envHome === getHostLocalCodexHome());
}

/**
 * The Codex home every default-selection read and write uses: the recorded farm
 * while its directory exists, else `$CODEX_HOME`, else `~/.codex`. A dead record
 * and OUR dead farm export are skipped: a write through either would resurrect
 * the removed farm as a plain dir.
 */
export function effectiveCodexHome(): string {
  return effectiveCodexHomeFor(codexHostEnabledOrOff());
}

/** effectiveCodexHome under a given key value: the settings-import plan resolves the
 *  POST-import home with the bundle's value before the store is replaced. */
export function effectiveCodexHomeFor(enabled: boolean): string {
  const recorded = new CopilotEnvRunState().read().codexHome;
  // The key off (or unset) retires the record at once; the next pass removes the farm.
  if (enabled && recorded !== undefined && fs.existsSync(recorded)) return recorded;
  return unmanagedCodexHome();
}

/** The Codex home when no farm record applies: `$CODEX_HOME` unless it is OUR farm
 *  export (POSIX only; Windows never has a farm), else `~/.codex`. */
export function unmanagedCodexHome(): string {
  if (process.platform !== "win32" && isManagedFarmExport(process.env.CODEX_HOME)) {
    return path.join(homedir(), ".codex");
  }
  return defaultCodexHome();
}

/** What ONE wiring pass does to the farm: the single decision the derivation
 *  (withCodexHostFarm) and the settings-import plan share. `leave` = something sits
 *  at the farm path that is not proven ours (no record, no managed wiring). */
export type CodexHostFarmPlan = { action: "build" | "verify" | "remove" | "leave" | "none" };

/** Proof that what is on disk NOW is copilot-env's: our managed wiring in its
 *  config.toml. The activation record alone proves only that we built something there
 *  once; the user may have replaced it since, so it never authorizes a delete. */
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
  // Never delete what we cannot prove is ours right now: a foreign dir, a symlink, a
  // half-built leftover, an unprobeable path.
  return isOurFarm(farm) ? { action: "remove" } : { action: "leave" };
}

/** The key read behind the effective-home rule only: this runs on every read path
 *  (`--check`, health, the wiring read-back), where an unreadable store must not throw. */
function codexHostEnabledOrOff(): boolean {
  try {
    return new CopilotEnvConfig().codexHostEnabled();
  } catch {
    return false;
  }
}

/** The farm's disagreement with the `codex-host` key (each kind's line below says
 *  what the next wiring pass does about it), or null when they agree. */
export type CodexHostDrift = { kind: "missing" | "inactive" | "disabled"; hostHome: string };

export function codexHostDrift(
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): CodexHostDrift | null {
  // No farm can exist on Windows, so a farm-shaped path there (a shared home) is not ours.
  if (process.platform === "win32") return null;
  return codexHostDriftFrom(config.codexHostEnabled(), codexHostFarm());
}

/** The pure decision behind codexHostDrift, over already-gathered facts (health
 *  probes them through its own seams). */
export function codexHostDriftFrom(enabled: boolean, farm: CodexHostFarm): CodexHostDrift | null {
  if (!enabled) return isOurFarm(farm) ? { kind: "disabled", hostHome: farm.hostHome } : null;
  if (!farm.wired) return { kind: "missing", hostHome: farm.hostHome };
  return farm.active ? null : { kind: "inactive", hostHome: farm.hostHome };
}

/** The one-line report of a drift, shared by `agent codex --check` and `agent health`. */
export function codexHostDriftLine(drift: CodexHostDrift): string {
  switch (drift.kind) {
    case "missing":
      return `codex-host is on but the per-host CODEX_HOME farm is missing at ${drift.hostHome}; run \`agent codex\` to rebuild it`;
    case "inactive":
      return `codex-host is on but ${drift.hostHome} is not the active CODEX_HOME; run \`agent codex\` to activate it`;
    case "disabled":
      return `codex-host is off but a per-host CODEX_HOME farm is still present at ${drift.hostHome}; run \`agent codex\` to remove it`;
  }
}

// --- small fs probes ---------------------------------------------------------
// These answer "what is at this path right now?"; a stat/read failure means
// "not that kind of thing", never an error. Mutating operations below are the
// opposite: they throw, and the failure surfaces through the farm error.

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function readlinkOrEmpty(p: string): string {
  try {
    return fs.readlinkSync(p);
  } catch {
    return "";
  }
}

// An unreadable side counts as "not equal", so callers refuse rather than merge.
function filesEqual(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function isSymlinkPath(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirPath(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- fs operations that throw on failure --------------------------------------
// Every mutation below goes through the reporting seam, which names the path it
// changed (nothing hidden); what the farm did to it rides as the line's detail.

// Every path under root, one level at a time, without descending into symlinked
// directories (each level lists dirs before files).
function listDescendants(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dirpath = stack.pop() as string;
    const entries = fs.readdirSync(dirpath, { withFileTypes: true });
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

// Merge-copy contents of localPath into sharedPath, preserving symlinks.
function mergeDirInto(localPath: string, sharedPath: string): void {
  const entries = fs.readdirSync(localPath, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(localPath, entry.name);
    const dst = path.join(sharedPath, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      if (lexists(dst)) {
        const dstIsSymlink = isSymlinkPath(dst);
        const dstIsDir = isDirPath(dst);
        if (dstIsSymlink || !dstIsDir) removeReported(dst, "replaced by a link");
      }
      symlinkReported(target, dst);
    } else if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      copyFileReported(src, dst, `copied from ${src}`);
    }
  }
}

/** Recursive copy that names every entry it writes (symlinks copied as links). */
function copyTree(src: string, dst: string): void {
  mkdirReported(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      // An existing link here already passed the merge validation (same target).
      removeReported(to, "replaced by a link");
      symlinkReported(target, to);
    } else if (entry.isDirectory()) {
      copyTree(from, to);
    } else {
      copyFileReported(from, to, `copied from ${from}`);
    }
  }
}

function ensureParentDir(p: string): void {
  mkdirReported(path.dirname(p));
}

// === CODEX_HOME symlink farm (seeding) ===

function warnExistingCodexPath(p: string): void {
  logger.warn(`Leaving existing Codex path unchanged: ${p}`);
}

// "refused" is a normal outcome (the caller warns and moves on), not an error;
// filesystem failures throw instead.
type PromoteResult = "promoted" | "refused";

// Promote a host-local directory into the shared Codex root when it can be
// merged without overwriting existing shared content; refuse (warning, local
// dir left unchanged) when the contents conflict.
function promoteCodexDirToSharedIfSafe(localPath: string, sharedPath: string): PromoteResult {
  if (!lexists(sharedPath)) {
    ensureParentDir(sharedPath);
    renameReported(localPath, sharedPath);
    return "promoted";
  }

  if (isSymlinkPath(sharedPath) || !isDirPath(sharedPath)) {
    warnExistingCodexPath(localPath);
    return "refused";
  }

  for (const entry of listDescendants(localPath)) {
    const relPath = path.relative(localPath, entry);
    const targetPath = path.join(sharedPath, relPath);

    if (isSymlinkPath(entry)) {
      const localTarget = readlinkOrEmpty(entry);
      if (isSymlinkPath(targetPath)) {
        if (localTarget !== readlinkOrEmpty(targetPath)) {
          warnExistingCodexPath(localPath);
          return "refused";
        }
      } else if (lexists(targetPath)) {
        warnExistingCodexPath(localPath);
        return "refused";
      }
    } else if (isDirPath(entry)) {
      if (lexists(targetPath) && (isSymlinkPath(targetPath) || !isDirPath(targetPath))) {
        warnExistingCodexPath(localPath);
        return "refused";
      }
    } else if (isFile(entry)) {
      if (lexists(targetPath)) {
        if (isSymlinkPath(targetPath) || !isFile(targetPath) || !filesEqual(entry, targetPath)) {
          warnExistingCodexPath(localPath);
          return "refused";
        }
      }
    } else {
      warnExistingCodexPath(localPath);
      return "refused";
    }
  }

  // TOCTOU: the merge below races the validation above; accepted, startup-only flow.
  mergeDirInto(localPath, sharedPath);
  removeTreeReported(localPath, "merged into the shared root");
  return "promoted";
}

function primeSharedCodexHomeIfMissing(sharedRoot: string): void {
  // Proven absence only: a look that failed (permissions, a blip) must not start a prime
  // whose scan below would then name an existing tree as newly created.
  try {
    fs.lstatSync(sharedRoot);
    return;
  } catch (e) {
    if (!isEnoentOrNotdir(e)) return;
  }
  // resolveCommand, not a bare PATH lookup: its nvm fallback also finds an
  // nvm-only codex, and spawning the RESOLVED path below keeps the prime
  // working even though this process never sourced nvm.sh.
  const codexBin = resolveCommand("codex");
  if (codexBin === null) return;

  // Best effort: let Codex create the shared home before we seed and symlink into
  // it. CODEX_HOME is set to that root explicitly: an inherited value (our own farm
  // export) would send codex's writes elsewhere, and the scan below covers exactly the
  // home the spawn was given. Timeout prevents a misconfigured codex from blocking.
  // spawnSync reports failures (a nonzero exit, ENOENT, the timeout) in its result
  // rather than throwing, and the result is ignored on purpose: the prime is a
  // convenience, never a build failure.
  spawnSync(codexBin, ["exec"], {
    input: "hi\n",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10_000,
    env: { ...process.env, CODEX_HOME: sharedRoot },
  });
  // The root was absent, so everything under it now is what the prime made: a write
  // asked for by us, named by us. Judged by lstat: a root that came back as a symlink
  // is named as the one entry it is, never walked into.
  if (!lexists(sharedRoot)) return;
  reportWrite("created", sharedRoot);
  if (isDirPath(sharedRoot) && !isSymlinkPath(sharedRoot)) reportTreeCreated(sharedRoot);
}

/** Name every entry under `dir` (a real directory) as created, dirs before files, one
 *  level at a time; a level that cannot be listed leaves only its own entries unnamed. */
function reportTreeCreated(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
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

  if (isFile(sharedPath)) {
    ensureParentDir(localPath);
    copyFileReported(sharedPath, localPath, `${role}, seeded from ${sharedPath}`);
  } else if (createPlaceholder) {
    ensureParentDir(localPath);
    writeFileReported(localPath, "", { detail: `${role}, empty` });
  }
}

// Shared desktop state files need a one-time promotion path from host-local
// CODEX_HOME into ~/.codex so existing installs keep their saved projects.
// With `createPlaceholder`, a missing shared file is created empty; without it
// the shared file only appears when a host-local copy exists to promote.
function seedSharedCodexFileIfMissing(
  sharedPath: string,
  localPath: string,
  createPlaceholder: boolean,
): void {
  const sharedExists = lexists(sharedPath);

  if (isFile(localPath) && !isSymlinkPath(localPath)) {
    if (!sharedExists) {
      ensureParentDir(sharedPath);
      copyFileReported(localPath, sharedPath, `copied from ${localPath}`);
      return;
    }

    if (
      isFile(sharedPath) &&
      fs.statSync(sharedPath).size === 0 &&
      fs.statSync(localPath).size > 0
    ) {
      copyFileReported(localPath, sharedPath, `copied from ${localPath}`);
    }
    return;
  }

  if (createPlaceholder && !sharedExists) {
    ensureParentDir(sharedPath);
    writeFileReported(sharedPath, "", { detail: "empty seed" });
  }
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
    symlinkReported(sharedPath, localPath);
  }
}

// After the shared file is seeded, replace a matching host-local copy with a
// symlink so future desktop updates read and write the same shared state.
function ensureCodexFileSymlink(localPath: string, sharedPath: string): void {
  if (isSymlinkPath(localPath)) {
    if (readlinkOrEmpty(localPath) !== sharedPath) warnExistingCodexPath(localPath);
    return;
  }

  if (isFile(localPath)) {
    if (!filesEqual(localPath, sharedPath)) {
      warnExistingCodexPath(localPath);
      return;
    }
    removeReported(localPath, "identical to the shared copy");
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return;
  }

  ensureParentDir(localPath);
  symlinkReported(sharedPath, localPath);
}

// --- the farm layout, as data ------------------------------------------------
// Every entry name is an on-disk contract with the Codex desktop app: renaming
// one is a layout change, not a refactor.

// Host-local scratch: real directories, never shared or symlinked.
const HOST_LOCAL_DIRS = [
  ".tmp", // Host-local scratch/cache state, including plugin temp data.
  "log", // Host-local runtime logs.
  "tmp", // Host-local transient working files.
];

// Host-local files seeded once from the shared root (or empty, with `placeholder`),
// then owned by the host; `role` is what the seed's write line calls the file. The
// default config write that follows every build rewrites config.toml, silently when the
// seed already named it (the seam names a path once per process), so the seed's line
// calls it what it is; it gets no empty placeholder, so a fresh farm's config.toml is
// named by that config write instead.
const HOST_LOCAL_SEED_FILES = [
  { name: ".personality_migration", placeholder: true, role: "host-local seed" },
  { name: "config.toml", placeholder: false, role: "Codex config" },
  { name: "history.jsonl", placeholder: true, role: "host-local seed" },
];

// Shared directories: a real directory at the shared root, symlinked from the
// host home (host-local content is promoted into the shared copy when safe).
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

// Shared files: seeded at the shared root, symlinked from the host home.
// `placeholder: false` marks state only worth syncing when a host already has
// it, so no empty shared file is fabricated (the host symlink dangles).
const SHARED_FILES: readonly { name: string; placeholder: boolean }[] = [
  { name: ".codex-global-state.json", placeholder: true }, // Desktop workspace and project state.
  { name: "AGENTS.md", placeholder: true }, // Shared agent instructions exposed inside Codex home.
  { name: "session_index.jsonl", placeholder: true }, // Session lookup index maintained by the desktop app.
  { name: "version.json", placeholder: true }, // Codex home layout/schema version marker.
  { name: "installation_id", placeholder: false }, // Per-install identifier, present once Codex has run.
  { name: "shell-init.sh", placeholder: false }, // User shell hook, present only when configured.
];

function buildCodexSymlinkFarm(codexHome: string): void {
  // Both halves from the ONE resolved host path (<shared root>/hosts/<host>): a shared
  // root spelled relative would make every symlink target relative to the link's own
  // directory, pointing back inside the farm.
  const sharedRoot = path.dirname(path.dirname(codexHome));
  primeSharedCodexHomeIfMissing(sharedRoot);
  mkdirReported(sharedRoot);
  mkdirReported(codexHome, undefined, "per-host CODEX_HOME farm");

  for (const name of HOST_LOCAL_DIRS) {
    mkdirReported(path.join(codexHome, name));
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
    mkdirReported(path.join(sharedRoot, name));
    ensureCodexDirSymlink(path.join(codexHome, name), path.join(sharedRoot, name));
  }

  for (const { name, placeholder } of SHARED_FILES) {
    seedSharedCodexFileIfMissing(
      path.join(sharedRoot, name),
      path.join(codexHome, name),
      placeholder,
    );
    ensureCodexFileSymlink(path.join(codexHome, name), path.join(sharedRoot, name));
  }
}

/** Run ONE default Codex config write with the farm derived from the `codex-host`
 *  key around it (planCodexHostFarm decides). The activation record lands only AFTER a
 *  successful write, and is cleared BEFORE a rebuild, so it never outlives a proven farm. */
export async function withCodexHostFarm(
  write: (codexHome: string) => Promise<void>,
): Promise<void> {
  // Windows has no farm (POSIX symlinks): nothing to derive, nothing recorded.
  if (process.platform === "win32") return write(effectiveCodexHome());
  const farm = codexHostFarm();
  // ONE key read drives the whole pass, so a concurrent `agent config` cannot split it.
  const plan = planCodexHostFarm(new CopilotEnvConfig().codexHostEnabled(), farm);
  const state = new CopilotEnvRunState();
  switch (plan.action) {
    case "build":
    case "verify": {
      // Cleared here and re-recorded after the write below, so the record never
      // outlives a proven farm.
      if (farm.active) state.set({ codexHome: null });
      try {
        buildCodexSymlinkFarm(farm.hostHome);
      } catch (e: unknown) {
        // The one terminal handler for farm filesystem failures; the cause message
        // names the failing operation and path.
        throw new Error(
          `Failed to build the CODEX_HOME symlink farm at ${farm.hostHome}: ${errMessage(e)}`,
          { cause: e },
        );
      }
      // A build names the home it created; a verify created nothing, so it says so.
      if (plan.action === "verify") {
        logger.log(`  ✓ Per-host CODEX_HOME farm verified → ${farm.hostHome}`);
      }
      await write(farm.hostHome);
      state.set({ codexHome: farm.hostHome });
      return;
    }
    case "remove":
      removeTreeReported(farm.hostHome, "per-host CODEX_HOME farm");
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
  await write(effectiveCodexHome());
}
