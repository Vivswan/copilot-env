// Per-host Codex home manager: builds the per-host CODEX_HOME symlink farm (Linux/macOS).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { recordDefaultModeFromWiring } from "../agents/configure_defaults.ts";
import { resolveDirectMode } from "../agents/direct_detect.ts";
import type { ManagedWrite } from "../agents/configure.ts";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isFile } from "../utils/fs.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../utils/hostname.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { applyCodexConfig, detectCodexDirect, probeDirectIntegrationId } from "./config.ts";

const logger = createStderrLogger();

export interface CodexHostArgs {
  delete?: boolean;
  /** `--direct`/`--proxy`, parsed once at the CLI boundary (auto = neither). */
  mode: RequestedMode;
}

// The per-host CODEX_HOME (<farm root>/<hostname>). On Linux/macOS it builds and
// inspects the shared-state symlink farm. Exported so `agent health` can report
// the per-host directory without rebuilding the path.
export function getHostLocalCodexHome(): string {
  return path.join(codexFarmHostsDir(), getSanitizedHostname());
}

/**
 * Guard a feature that needs POSIX symlinks (Linux or macOS). Returns false on
 * Windows after printing a friendly note and setting a non-zero exit code --
 * callers should `return` when it returns false rather than continue. (No raw
 * throw: an unsupported platform is an expected user condition, not a crash, so
 * it shouldn't dump a stack trace.)
 */
function assertUnix(feature: string, hint?: string): boolean {
  if (process.platform === "win32") {
    logger.info(
      `${feature} is only supported on Linux and macOS (this is ${process.platform}).${
        hint ? ` ${hint}` : ""
      }`,
    );
    process.exitCode = 1;
    return false;
  }
  return true;
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
 * `agent codex --host`: build the per-host CODEX_HOME symlink farm (Linux/macOS)
 * at `~/.codex/hosts/<hostname>`, then write its config and persist the CODEX_HOME
 * to state so `env` exports it. The provider mode is `--direct` / `--proxy` forced,
 * or with no mode flag auto-detected (direct when a live Copilot Direct probe
 * succeeds, else proxy). With `--delete-host`, remove that per-host dir and clear
 * the state instead. No stdout.
 */
export async function runCodexHost(args: CodexHostArgs): Promise<void> {
  if (!assertUnix("The CODEX_HOME symlink farm (host_codex)")) return;
  // Resolve to an absolute path: it gets persisted to state and re-exported into
  // future shells, so a cwd-relative value would later resolve against the wrong
  // directory.
  const codexHome = path.resolve(getHostLocalCodexHome());
  const state = new CopilotEnvRunState();

  if (args.delete) {
    fs.rmSync(codexHome, { recursive: true, force: true });
    logger.info(`Removed per-host CODEX_HOME: ${codexHome}`);
    state.set({ codexHome: null });
    // Re-derive the recorded default mode from the POST-delete truth. The
    // inherited CODEX_HOME may still name the farm just removed (only the next
    // `agent env` clears it), so a default read-back through it would see the
    // deleted dir. The override mirrors managedCodexHome's stale-env clear
    // predicate EXACTLY, so the record always matches the home the next shell
    // effectively uses (a spelling the clear leaves alone stays the truth).
    const envHome = process.env.CODEX_HOME;
    recordDefaultModeFromWiring(
      envHome && envHome === getHostLocalCodexHome() && !fs.existsSync(envHome)
        ? { codexHome: path.join(homedir(), ".codex") }
        : {},
    );
    return;
  }

  logger.info("Preparing CODEX_HOME (building symlink farm)...");
  try {
    buildCodexSymlinkFarm(codexHome);
  } catch (e: unknown) {
    // The one terminal handler for farm filesystem failures; the cause message
    // names the failing operation and path.
    throw new Error(
      `Failed to build the CODEX_HOME symlink farm at ${codexHome}: ${errMessage(e)}`,
      {
        cause: e,
      },
    );
  }
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args.mode, ghToken, detectCodexDirect);
  logger.info(
    `Configuring the per-host Codex home for ${
      direct ? "GitHub Copilot Direct" : "the local copilot-api proxy"
    } ...`,
  );
  // Direct resolves the client identity HERE (reusing the just-resolved
  // credential, so gh-cli is not shelled out to a second time) and passes it
  // down inside the shared write; a dead direct credential fails the wiring
  // instead of writing a config that 400s.
  const write: ManagedWrite = direct
    ? { mode: "direct", directIntegrationId: await probeDirectIntegrationId(null, ghToken) }
    : { mode: "proxy" };
  await applyCodexConfig(
    codexHome,
    write,
    // Reuse the credential for the catalog seed's direct fetch too.
    ghToken === null ? undefined : { directToken: ghToken },
  );
  // Persist the active CODEX_HOME (opt-in: only set because a codex command ran).
  state.set({ codexHome });
  // The default Codex selection just moved to the farm home; with the state
  // recorded, the default read-back resolves to the config written above, so
  // re-derive the recorded default mode (a failed wire never reaches here).
  recordDefaultModeFromWiring();
}
