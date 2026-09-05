// Per-host Codex home manager: the per-host CODEX_HOME symlink farm (Linux/macOS),
// DERIVED from the `codex-host` config key by every default Codex wiring pass.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { configDefaultBoolean, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, isFile } from "../utils/fs.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../utils/hostname.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { codexConfigPath, defaultCodexHome } from "./paths.ts";

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
  /** Its config.toml has content (the build seeds an EMPTY one; empty = api.openai.com). */
  wired: boolean;
  /** A probe (the dir, or its config.toml) failed for a reason other than absence, so
   *  `present`/`wired` are unproven: an unset key then refuses to remove the farm. */
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
  try {
    fs.lstatSync(hostHome);
  } catch (e) {
    return { present: false, wired: false, probeError: isEnoentOrNotdir(e) ? null : errMessage(e) };
  }
  try {
    const st = fs.statSync(codexConfigPath(hostHome));
    return { present: true, wired: st.isFile() && st.size > 0, probeError: null };
  } catch (e) {
    return { present: true, wired: false, probeError: isEnoentOrNotdir(e) ? null : errMessage(e) };
  }
}

// True when the inherited CODEX_HOME is OUR farm export: never a user's choice, so
// the record (not the shell) decides whether the farm is the home, and `agent env`
// may clear it. Exact string equality on purpose (no path normalization): a
// trailing-slash spelling is not ours and stays hands-off.
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
  return effectiveCodexHomeFor(settingOrUnset());
}

/** effectiveCodexHome under a given key value: the settings-import plan resolves the
 *  POST-import home with the bundle's value before the store is replaced. */
export function effectiveCodexHomeFor(setting: boolean | null): string {
  const recorded = new CopilotEnvRunState().read().codexHome;
  // An explicit off retires the record at once (the next pass removes the farm);
  // unset keeps a pre-key install's farm live until a pass adopts it.
  if (recorded !== undefined && fs.existsSync(recorded) && setting !== false) return recorded;
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

/**
 * What ONE wiring pass does to the farm for `setting` (the three-way key read): the
 * single decision the derivation (withCodexHostFarm) and the settings-import plan
 * share, so the plan can never announce an action the apply skips.
 */
export type CodexHostFarmPlan =
  | { action: "build" | "verify"; adopt: boolean }
  | { action: "remove" }
  | { action: "refuse"; detail: string }
  /** An unwired, unrecorded dir at the farm path under an unset key: not proven ours. */
  | { action: "leave" }
  | { action: "none" };

export function planCodexHostFarm(
  setting: boolean | null,
  farm: CodexHostFarm,
  platform: NodeJS.Platform = process.platform,
): CodexHostFarmPlan {
  if (platform === "win32") return { action: "none" };
  // Unproven wiring must not authorize a removal (an unadoptable farm).
  if (setting === null && farm.probeError !== null) {
    return { action: "refuse", detail: farm.probeError };
  }
  const adopt = setting === null && farm.wired;
  const enabled = setting ?? (adopt || configDefaultBoolean("codex-host"));
  if (enabled) return { action: farm.present ? "verify" : "build", adopt };
  // An explicit off removes what is there, even unprobeable (rmSync reports a real
  // failure itself); a proven-absent path has nothing to remove.
  if (setting === false) {
    return farm.present || farm.probeError !== null ? { action: "remove" } : { action: "none" };
  }
  // Unset: only a half-built farm a wiring pass recorded (proven ours) is removed;
  // an unrecorded dir is left for the user to decide with an explicit key.
  if (!farm.present) return { action: "none" };
  return farm.active ? { action: "remove" } : { action: "leave" };
}

/** The key read behind the effective-home rule only: an unreadable store is not a
 *  proven off, so the record stays honored (every other read site stays strict). */
function settingOrUnset(): boolean | null {
  try {
    return new CopilotEnvConfig().codexHostSetting();
  } catch {
    return null;
  }
}

/** The farm's disagreement with the `codex-host` key (each kind's line below says
 *  what the next wiring pass does about it), or null when they agree. */
export type CodexHostDrift =
  | { kind: "missing" | "inactive" | "unadopted" | "disabled" | "unowned"; hostHome: string }
  | { kind: "unreadable"; hostHome: string; detail: string };

export function codexHostDrift(
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): CodexHostDrift | null {
  // No farm can exist on Windows, so a farm-shaped path there (a shared home) is not ours.
  if (process.platform === "win32") return null;
  return codexHostDriftFrom(config.codexHostSetting(), codexHostFarm());
}

/** The pure decision behind codexHostDrift, over already-gathered facts (health
 *  probes them through its own seams). `setting` is the three-way key read. */
export function codexHostDriftFrom(
  setting: boolean | null,
  farm: CodexHostFarm,
): CodexHostDrift | null {
  // Off: the next wiring pass removes what is there (or what it could not probe).
  if (setting === false) {
    return farm.present || farm.probeError !== null
      ? { kind: "disabled", hostHome: farm.hostHome }
      : null;
  }
  if (farm.probeError !== null) {
    return { kind: "unreadable", hostHome: farm.hostHome, detail: farm.probeError };
  }
  if (setting === true) {
    if (!farm.wired) return { kind: "missing", hostHome: farm.hostHome };
    return farm.active ? null : { kind: "inactive", hostHome: farm.hostHome };
  }
  if (farm.wired) return { kind: "unadopted", hostHome: farm.hostHome };
  if (!farm.present) return null;
  // Unset with a half-built dir: removed by the next pass only when a pass recorded it.
  return farm.active
    ? { kind: "disabled", hostHome: farm.hostHome }
    : { kind: "unowned", hostHome: farm.hostHome };
}

/** The one-line report of a drift, shared by `agent codex --check` and `agent health`. */
export function codexHostDriftLine(drift: CodexHostDrift): string {
  switch (drift.kind) {
    case "missing":
      return `codex-host is on but the per-host CODEX_HOME farm is missing at ${drift.hostHome}; run \`agent codex\` to rebuild it`;
    case "inactive":
      return `codex-host is on but ${drift.hostHome} is not the active CODEX_HOME; run \`agent codex\` to activate it`;
    case "unadopted":
      return `codex-host is unset but a per-host CODEX_HOME farm exists at ${drift.hostHome}; run \`agent codex\` to adopt it (records codex-host = true)`;
    case "disabled":
      return `codex-host is off but a per-host CODEX_HOME farm is still present at ${drift.hostHome}; run \`agent codex\` to remove it`;
    case "unowned":
      return `an unwired directory sits at the per-host CODEX_HOME farm path ${drift.hostHome} and no wiring pass recorded it; set codex-host true to build the farm there or false to remove it`;
    case "unreadable":
      return `the per-host CODEX_HOME farm at ${drift.hostHome} cannot be inspected (${drift.detail}); fix that, then run \`agent codex\``;
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

// Rename, falling back to copy+delete when src and dst sit on different devices.
function moveTree(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EXDEV") {
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

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
        if (dstIsSymlink || !dstIsDir) {
          fs.unlinkSync(dst);
        }
      }
      fs.symlinkSync(target, dst);
    } else if (entry.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function ensureParentDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
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
    moveTree(localPath, sharedPath);
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
  fs.rmSync(localPath, { recursive: true, force: true });
  return "promoted";
}

function primeSharedCodexHomeIfMissing(sharedRoot: string): void {
  if (lexists(sharedRoot)) return;
  // resolveCommand, not a bare PATH lookup: its nvm fallback also finds an
  // nvm-only codex, and spawning the RESOLVED path below keeps the prime
  // working even though this process never sourced nvm.sh.
  const codexBin = resolveCommand("codex");
  if (codexBin === null) return;

  // Best effort: let Codex create its default shared home before we seed and
  // symlink into it. Timeout prevents a misconfigured codex from blocking.
  // spawnSync reports failures (a nonzero exit, ENOENT, the timeout) in its
  // result rather than throwing, and the result is ignored on purpose: the
  // prime is a convenience, never a build failure.
  spawnSync(codexBin, ["exec"], {
    input: "hi\n",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10_000,
  });
}

function seedLocalCodexFileIfMissing(localPath: string, sharedPath: string): void {
  if (lexists(localPath)) {
    if (isSymlinkPath(localPath)) {
      logger.warn(
        `Skipping local Codex seed because the path already exists as a symlink: ${localPath}`,
      );
    }
    return;
  }

  ensureParentDir(localPath);
  if (isFile(sharedPath)) {
    fs.copyFileSync(sharedPath, localPath);
  } else {
    fs.writeFileSync(localPath, "");
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
      fs.copyFileSync(localPath, sharedPath);
      return;
    }

    if (
      isFile(sharedPath) &&
      fs.statSync(sharedPath).size === 0 &&
      fs.statSync(localPath).size > 0
    ) {
      fs.copyFileSync(localPath, sharedPath);
    }
    return;
  }

  if (createPlaceholder && !sharedExists) {
    ensureParentDir(sharedPath);
    fs.writeFileSync(sharedPath, "");
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
    fs.symlinkSync(sharedPath, localPath);
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
    fs.unlinkSync(localPath);
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return;
  }

  ensureParentDir(localPath);
  fs.symlinkSync(sharedPath, localPath);
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

// Host-local files seeded once from the shared root (or empty), then owned by
// the host: config.toml in particular diverges per host and is never promoted.
const HOST_LOCAL_SEED_FILES = [".personality_migration", "config.toml", "history.jsonl"];

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
  const sharedRoot = path.dirname(codexFarmHostsDir());
  primeSharedCodexHomeIfMissing(sharedRoot);
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  for (const name of HOST_LOCAL_DIRS) {
    fs.mkdirSync(path.join(codexHome, name), { recursive: true });
  }

  for (const name of HOST_LOCAL_SEED_FILES) {
    seedLocalCodexFileIfMissing(path.join(codexHome, name), path.join(sharedRoot, name));
  }

  for (const name of SHARED_DIRS) {
    fs.mkdirSync(path.join(sharedRoot, name), { recursive: true });
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

/**
 * Run ONE default Codex config write with the farm derived from the `codex-host`
 * key around it (planCodexHostFarm decides): build/verify, write, THEN record (a
 * failed write never activates a half-wired farm); or remove and clear the record,
 * then write at the default home. Every artifact touched gets a stderr line.
 */
export async function withCodexHostFarm(
  write: (codexHome: string) => Promise<void>,
): Promise<void> {
  // Windows has no farm (POSIX symlinks): nothing to derive, nothing recorded.
  if (process.platform === "win32") return write(effectiveCodexHome());
  const config = new CopilotEnvConfig();
  const farm = codexHostFarm();
  // ONE key read drives the whole pass, so a concurrent `agent config` cannot split it.
  const plan = planCodexHostFarm(config.codexHostSetting(), farm);
  const state = new CopilotEnvRunState();
  const paths = new CopilotApiPaths();
  switch (plan.action) {
    case "refuse":
      throw new Error(
        codexHostDriftLine({ kind: "unreadable", hostHome: farm.hostHome, detail: plan.detail }) +
          " or set codex-host explicitly (agent config --set codex-host true|false).",
      );
    case "build":
    case "verify": {
      if (plan.adopt) {
        config.set({ codexHost: true });
        logger.log(
          `  ✓ Recorded codex-host = true (adopted the per-host CODEX_HOME farm ${farm.hostHome}) → ${paths.envConfigFile}`,
        );
      }
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
      logger.log(
        `  ✓ Per-host CODEX_HOME farm ${
          plan.action === "verify" ? "verified" : "built"
        } → ${farm.hostHome}`,
      );
      await write(farm.hostHome);
      state.set({ codexHome: farm.hostHome });
      logger.log(`  ✓ Active CODEX_HOME recorded → ${paths.stateFile}`);
      return;
    }
    case "remove":
      fs.rmSync(farm.hostHome, { recursive: true, force: true });
      logger.log(`  ✓ Per-host CODEX_HOME farm removed → ${farm.hostHome}`);
      break;
    case "leave":
    case "none":
      break;
  }
  if (state.read().codexHome !== undefined) {
    state.set({ codexHome: null });
    logger.log(`  ✓ Active CODEX_HOME record cleared → ${paths.stateFile}`);
  }
  await write(effectiveCodexHome());
}
