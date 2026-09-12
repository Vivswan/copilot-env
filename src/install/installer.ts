// The in-binary `agent install`: finalize an install root around the compiled binary that
// install.sh / install.ps1 downloaded to <root>/bin/copilot-env(.exe). A plan/apply split, like
// planImport/applyImportPlan in src/agents/transfer.ts. Assets are read via URLs relative to
// import.meta.url (the compiled VFS, or the checkout); that source root equalling the install
// root is what makes a run in-place.
//
//   in-place (dev checkout)   -> shell integration only; the checkout's own files are never touched
//   assets-only (compiled)    -> the embedded assets into the aimed root; `agent update` runs the
//                                NEW binary this way inside the staged version root
//   full (compiled)           -> the VERSIONED layout at the top:
//       <top>/versions/vX.Y.Z/   one complete root per release
//       <top>/current            a link naming the live version (POSIX symlink, Windows junction)
//       <top>/bin/agent(.ps1)    stable shims dispatching THROUGH `current`
//
// Every path that outlives a release goes through `<top>/current/...`, so flipping the link is
// the whole commit of an update and old version dirs can be garbage-collected safely.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { consola } from "consola";

import {
  hasMarker,
  LAUNCHERS_MARKER,
  MARKER,
  rcFiles,
  runShellIntegration,
  windowsProfileTarget,
} from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import {
  atomicSymlink,
  atomicWriteFile,
  chmodReported,
  copyFileReported,
  mkdirReported,
  removeEmptyDirReported,
  removeReported,
  removeTreeReported,
  RenameRefusedError,
  symlinkReported,
  writeFileReported,
} from "../utils/report_write.ts";
import {
  ASSET_ROOT,
  CURRENT_LINK,
  denoRuntime,
  INSTALL_MANIFEST_FILE,
  type InstallManifest,
  installStateRoot,
  isStandaloneBinary,
  isVersionedInstallTop,
  PROJECT_ROOT,
  readInstallManifest,
  type RootMode,
  rootMode,
  VERSIONS_DIR,
} from "../utils/root.ts";
import { stripV } from "../utils/semver.ts";
import { packageVersion } from "../utils/version.ts";
import {
  INSTALLED_BINARY_POSIX,
  INSTALLED_BINARY_WINDOWS,
  installedBinaryName,
} from "./targets.ts";

/** Embedded AND materialized: something outside this process opens these by path (the daemon's
 *  `--preload` shims, the shell payload the rc block sources, the plugin/skill surface other
 *  tools read). `src/scripts` is materialized WHOLE: the daemon loads a per-credential subset of
 *  DAEMON_SHIM_FILES (src/copilot_api/shims.ts) whose entrypoints import siblings, so copying
 *  the directory covers the in-dir ones; imports reaching OUTSIDE it are
 *  MATERIALIZED_ASSET_FILES. */
export const MATERIALIZED_ASSET_DIRS = [
  "src/scripts",
  "shell",
  "skills",
  ".claude-plugin",
] as const;

/** Materialized as individual files: the `src/scripts` shims import these, and the sidecar deno
 *  resolves them on real disk in the install root, so a missing one kills the daemon at module
 *  load. The shims' full local import closure OUTSIDE the materialized dirs, pinned
 *  bidirectionally by test/installer_pinning.test.ts. */
export const MATERIALIZED_ASSET_FILES = [
  "src/copilot_api/config.ts",
  "src/copilot_api/env_config.ts",
  "src/copilot_api/paths.ts",
  "src/copilot_api/profile.ts",
  "src/copilot_api/state.ts",
  "src/utils/file_lock.ts",
  "src/utils/fs.ts",
  "src/utils/hostname.ts",
  "src/utils/json.ts",
  "src/utils/pid.ts",
  "src/utils/report_write.ts",
  "src/utils/time.ts",
] as const;

/** Embedded and NEVER materialized: read in-process through ASSET_ROOT (the compiled VFS), a
 *  copy in the install root would be read by nothing and drift from the binary. Still verified
 *  present at plan time: absent from the VFS means a broken build.
 *
 *    copilot-env.config -> readProjectConfig
 *    .dvmrc             -> readDvmrcPin
 *    deno.json          -> writeDaemonConfig; also a CHECKOUT_MARKERS entry, so on disk it would
 *                          make every install root read as checkout debris */
export const BUNDLED_ONLY_ASSETS = ["copilot-env.config", ".dvmrc", "deno.json"] as const;

/** Superseded files a pre-binary source install leaves in the root; `node_modules` alone is
 *  hundreds of megabytes, so they are removed outright (no upgrade bridge). This list lives
 *  ONLY here: install.sh / install.ps1 do no sweeping, they hand off to `agent install`. */
export const LEGACY_ARTIFACTS = ["node_modules", "bun.lock", "bunfig.toml"] as const;

// --- The versioned layout vocabulary --------------------------------------------

// The layout NAMES live in src/utils/root.ts (root detection reads the layout, so root.ts owns
// the vocabulary); re-exported here beside the operations that build the layout.
export { CURRENT_LINK, VERSIONS_DIR };

/** root.ts's install-root override (ROOT_OVERRIDE_ENV there, unexported): how a SPAWNED binary
 *  is aimed at the exact root it must manage (`agent update` aims `install --assets-only` inside
 *  the staged version root, and every post-flip spawn at `<top>/current`). An external
 *  contract; never rename. */
export const INSTALL_ROOT_ENV = "COPILOT_ENV_INSTALL_ROOT";

/** The version-dir name for a release: `v3.5.7` (tolerates a leading v). */
export function versionDirName(version: string): string {
  return `v${stripV(version)}`;
}

export function versionsDirPath(top: string): string {
  return join(top, VERSIONS_DIR);
}

export function versionRootPath(top: string, versionName: string): string {
  return join(top, VERSIONS_DIR, versionName);
}

export function currentLinkPath(top: string): string {
  return join(top, CURRENT_LINK);
}

/**
 * Accepts both spellings a versioned root reaches this code under: the `current` link path (how
 * a versioned binary sees its own root) and the top directory (how the bootstrap sees a root it
 * is about to version). Versioned is believed only when `current` is a REAL link into
 * `versions/` (isVersionedInstallTop): coincidental directory names must never reroute an
 * install or an update. Anything else is the flat, pre-versioned shape.
 */
export type InstallRootShape =
  | { kind: "flat"; top: string }
  | { kind: "versioned"; top: string };

export function classifyInstallRoot(root: string): InstallRootShape {
  // installStateRoot (src/utils/root.ts) owns the current-link -> top mapping;
  // the verdict here is only whether that top carries the real link layout.
  const top = installStateRoot(root);
  return isVersionedInstallTop(top) ? { kind: "versioned", top } : { kind: "flat", top };
}

/** The link target in the spelling the platform stores: RELATIVE on POSIX (the install stays
 *  relocatable), ABSOLUTE on Windows (a junction has no relative form). The plan and the flip
 *  both take it from here, so the dry run and the seam cannot disagree. */
export function currentLinkTarget(top: string, versionName: string): string {
  return process.platform === "win32"
    ? versionRootPath(top, versionName)
    : join(VERSIONS_DIR, versionName);
}

/**
 * THE commit step of an install or update. POSIX: build the replacement link aside and rename
 * it over, so a concurrent reader sees the old link or the new one (only the corrupt-layout
 * repair below removes first). Windows: a directory junction
 * (resolvable by every Win32 path API, PowerShell 5.1 included, and creatable without the
 * symlink privilege); Windows cannot rename over a directory entry, so replace = remove the old
 * junction (an entry delete; the target's contents are untouched), then create the new one.
 */
export function pointCurrentAt(top: string, versionName: string): void {
  const link = currentLinkPath(top);
  const target = currentLinkTarget(top, versionName);
  if (process.platform === "win32") {
    // Remove-then-create with a RESTORE: if the new junction cannot be created (antivirus,
    // transient locks) the old one is put back before the error surfaces. The layout is left
    // linkless when the restore fails too (the error below says so), when there was no previous
    // target to put back (a first install), or when the process dies between the two calls; each
    // is repaired by re-running the update or installer.
    const previous = readCurrentTargetPath(top);
    removeEmptyDirReported(link);
    try {
      symlinkReported(target, link, "junction");
    } catch (error) {
      if (previous !== null) {
        try {
          symlinkReported(previous, link, "junction");
        } catch {
          // Double fault: the layout is now LINKLESS. Say so, instead of reporting only the
          // creation failure as if nothing else changed.
          throw new Error(
            `could not create ${link} (and could not restore its previous target); ` +
              `re-run the update or installer to re-point it: ${errMessage(error)}`,
          );
        }
      }
      throw error;
    }
    return;
  }
  // A corrupt layout may leave a REAL directory at the link path; rename cannot replace one.
  // rmdirSync is non-recursive on purpose: an empty stray dir is repaired, a non-empty one is
  // unknown data and fails the flip loudly.
  try {
    if (!lstatSync(link).isSymbolicLink()) removeEmptyDirReported(link);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  atomicSymlink(target, link);
}

/** The current link's raw target path (absolute on Windows, `\\?\` stripped),
 *  or null when there is no readable link. */
function readCurrentTargetPath(top: string): string | null {
  try {
    return readlinkSync(currentLinkPath(top)).replace(/^\\\\\?\\/, "");
  } catch {
    return null;
  }
}

/** The version-dir NAME `current` points at, or null (no link, or unreadable). */
export function readCurrentVersionName(top: string): string | null {
  const target = readCurrentTargetPath(top);
  if (target === null) return null;
  const name = basename(target.replace(/[\\/]+$/, ""));
  return name.length > 0 ? name : null;
}

/** Skips when the text already matches (the steady state: an update never touches the file a
 *  user's PATH points at), else writes beside and renames over; the direct-write fallback covers
 *  a rename refused by an open handle on the live file. Every shim write is announced here, once
 *  per path, on the caller's logger so an update inside the autoupdate preflight stays
 *  stderr-only. */
function writeShimFile(to: string, text: string, executable: boolean, logger: ShimLogger): void {
  let current: string | null;
  try {
    current = readFileSync(to, "utf-8");
  } catch {
    current = null; // absent or unreadable: write it below
  }
  if (current === text) {
    // Still repair a lost exec bit: a crash between an earlier write and its chmod would
    // otherwise persist across retries.
    if (executable && (statSync(to).mode & 0o100) === 0) chmodReported(to, 0o755);
    return;
  }
  try {
    atomicWriteFile(to, text, executable ? 0o755 : undefined);
  } catch (error) {
    // Only a refused publish falls back to the direct write; a failure to stage the text (disk
    // full, I/O) propagates and never truncates the live shim.
    if (!(error instanceof RenameRefusedError)) throw error;
    writeFileReported(to, text);
    if (executable) chmodReported(to, 0o755);
  }
  logger.info(`Wrote launcher shim ${to}`);
}

/** Where a shim write is announced (the global consola, or an update's stderr logger). */
export interface ShimLogger {
  info(message: string): void;
}

/** Idempotent and cheap in the steady state (identical text is never rewritten), so every
 *  install and update commit can refresh the shims, which is also what heals a crash that
 *  flipped `current` but got no further. */
export function writeTopLevelShims(top: string, logger: ShimLogger = consola): void {
  writeShimFile(join(top, "bin", "agent"), POSIX_CURRENT_SHIM, true, logger);
  writeShimFile(join(top, "bin", "agent.ps1"), POWERSHELL_CURRENT_SHIM, false, logger);
}

/** Markers + .git: the shape of a LIVE source checkout (see CHECKOUT_MARKERS).
 *  Every destructive sweep in this module refuses such a root outright. */
export function isCheckoutShapedRoot(root: string): boolean {
  return CHECKOUT_MARKERS.some((marker) => existsSync(join(root, marker))) &&
    existsSync(join(root, ".git"));
}

/** The pre-versioned (flat) artifacts present at `top`. Empty for a checkout-shaped root: those
 *  files are SOURCE there, never ours to sweep. */
export function flatArtifactPaths(top: string): string[] {
  if (isCheckoutShapedRoot(top)) return [];
  const names: string[] = [
    ...MATERIALIZED_ASSET_DIRS,
    ...MATERIALIZED_ASSET_FILES,
    INSTALL_MANIFEST_FILE,
    ...LEGACY_ARTIFACTS,
    ...CHECKOUT_MARKERS,
  ];
  return names.map((name) => join(top, name)).filter(directoryEntryExists);
}

/** The flat `src` scaffolding dirs that `removals` (flatArtifactPaths) will leave EMPTY,
 *  innermost first. A scaffolding dir holding anything else is not planned and stays. */
export function flatScaffoldingPaths(top: string, removals: readonly string[]): string[] {
  const going = new Set(removals);
  const prunes: string[] = [];
  for (const dir of [join("src", "copilot_api"), join("src", "utils"), "src"]) {
    const path = join(top, dir);
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue; // absent (or unreadable, which the sweep would also leave alone)
    }
    if (entries.every((entry) => going.has(join(path, entry)))) {
      going.add(path);
      prunes.push(path);
    }
  }
  return prunes;
}

/** Best-effort entry by entry. `keep` names entries to spare: the shell payload stays whenever
 *  the rc/profile block still points at it (a stale payload that works beats a swept one a block
 *  still sources). */
export function removeFlatArtifacts(
  paths: readonly string[],
  prunes: readonly string[],
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const path of paths) {
    if (keep.has(basename(path))) continue;
    try {
      removeTreeReported(path);
    } catch {
      // in use (Windows); harmless debris until something releases it
    }
  }
  for (const dir of prunes) {
    try {
      removeEmptyDirReported(dir); // non-recursive: only ever prunes an EMPTY dir
    } catch {
      // not empty or already gone -- either way, leave it
    }
  }
}

/** The flat-layout `copilot-env(.exe)` in `<top>/bin` (superseded by `versions/<v>/bin/...`)
 *  and any `.old-<ts>` aside files the pre-versioned Windows updater left. */
export function flatBinaryResiduePaths(top: string): string[] {
  const binDir = join(top, "bin");
  let entries: string[];
  try {
    entries = readdirSync(binDir);
  } catch {
    return [];
  }
  const liveName = installedBinaryName();
  return entries
    .filter((entry) => entry === liveName || entry.startsWith(`${liveName}.old-`))
    .map((entry) => join(binDir, entry));
}

/** Best-effort: a still-running image refuses deletion and is swept by a later update. */
export function removeFlatBinaryResidue(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      removeReported(path);
    } catch {
      // still the running image (Windows); the next update sweeps it
    }
  }
}

/** Best-effort per entry: a version still running a process (Windows) stays until a later
 *  update. The update flow keeps the new version plus exactly one previous, the rollback
 *  candidate. */
export function removeVersionDirsExcept(top: string, keep: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(versionsDirPath(top));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      removeTreeReported(join(versionsDirPath(top), entry));
    } catch {
      // in use; the next update retries
    }
  }
}

// --- Launcher shim texts ---------------------------------------------------------

/** Per-version bin/agent, INSIDE each version root; agent configs reach it as
 *  `<top>/current/bin/agent`, so the version it dispatches is always the live one. The
 *  checkout's bin/agent is the dev variant, and an install never overwrites a checkout, so the
 *  two texts never compete for one file. */
export const POSIX_SHIM = `#!/bin/sh
# copilot-env launcher (installed): dispatch to the compiled agent binary.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/${INSTALLED_BINARY_POSIX}" "$@"
`;

/** Per-version bin/agent.ps1 (Windows twin of POSIX_SHIM). */
export const POWERSHELL_SHIM =
  `# copilot-env launcher (installed): dispatch to the compiled agent binary.
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Here '${INSTALLED_BINARY_WINDOWS}') @args
exit $LASTEXITCODE
`;

/** Top-level bin/agent: the stable PATH entry of a versioned install. One release-independent
 *  hop through the `current` link, so an update never has to touch the file a user's PATH points
 *  at; the post-flip shim refresh rewrites it only when its text differs or its exec bit is lost. */
export const POSIX_CURRENT_SHIM = `#!/bin/sh
# copilot-env launcher (installed): dispatch through the current version link.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/../${CURRENT_LINK}/bin/${INSTALLED_BINARY_POSIX}" "$@"
`;

/** Top-level bin/agent.ps1 (Windows twin of POSIX_CURRENT_SHIM; the junction
 *  resolves through every Win32 path API, PowerShell 5.1 included). */
export const POWERSHELL_CURRENT_SHIM =
  `# copilot-env launcher (installed): dispatch through the current version link.
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path (Split-Path -Parent $Here) '${CURRENT_LINK}\\bin\\${INSTALLED_BINARY_WINDOWS}') @args
exit $LASTEXITCODE
`;

export interface InstallOptions {
  noShellIntegration: boolean;
  allHosts: boolean;
  /** The embedded assets and launcher shims into the aimed root and nothing else: no layout
   *  work, no shell wiring, no epilogue. `agent update` runs the NEW binary this way INSIDE the
   *  staged version root, so the release that owns the assets writes them before the `current`
   *  flip makes it live. */
  assetsOnly: boolean;
}

/** Files only a source checkout OR a legacy source-archive install carries at its root. With
 *  `.git` beside them they mark a live checkout an installed-mode plan must refuse to clobber;
 *  without `.git` they are debris the old source-archive installer left, swept like
 *  LEGACY_ARTIFACTS. */
export const CHECKOUT_MARKERS = ["package.json", "deno.json"] as const;

/** One shell-integration pass (Windows may need two: per-host and all-hosts profiles are
 *  separate targets). */
export interface ShellWiring {
  allHosts: boolean;
}

interface AssetCopy {
  from: string;
  to: string;
  executable: boolean;
}

interface ShimWrite {
  to: string;
  text: string;
  executable: boolean;
}

/** The sentinel manifest write: `INSTALL_MANIFEST_FILE` at the version root. */
interface ManifestWrite {
  to: string;
  text: string;
}

/** The complete materialization of ONE version root: every embedded asset,
 *  the per-version launcher shims, and the per-version install manifest. */
interface Materialization {
  copies: AssetCopy[];
  shims: ShimWrite[];
  manifest: ManifestWrite;
}

export type InstallPlan =
  | { kind: "in-place"; root: string; shell: ShellWiring | null }
  | {
    kind: "installed";
    root: string;
    copies: AssetCopy[];
    shims: ShimWrite[];
    manifest: ManifestWrite;
    legacyRemovals: string[];
    shell: ShellWiring | null;
  }
  | {
    kind: "versioned";
    top: string;
    versionName: string;
    versionRoot: string;
    copies: AssetCopy[];
    shims: ShimWrite[];
    manifest: ManifestWrite;
    /** The compiled binary to place into the version root; null when it is already there, or
     *  when no standalone binary is running (a dev process aimed at a foreign root has none). */
    binary: { from: string; to: string } | null;
    /** The commit step: `<top>/current` linked to `target` (currentLinkTarget). */
    currentLink: { path: string; target: string };
    topShims: ShimWrite[];
    /** Pre-versioned artifacts at the top root, swept AFTER the flip. */
    flatRemovals: string[];
    /** The flat `src` scaffolding those removals empty, pruned after them. */
    flatPrunes: string[];
    /** The flat binary and its `.old-` aside files, swept once the top shims dispatch through
     *  the link. */
    flatBinaryRemovals: string[];
    /** Run through the INSTALLED binary post-flip: this process may be rooted at the flat top,
     *  so its own PROJECT_ROOT-derived rc paths would not survive the layout change. */
    shellWires: ShellWiring[];
  };

/** Without following a final symlink: a dangling link or a loop IS an entry, and the guard must
 *  hand it to realpath (which refuses it) instead of peeling it as a missing tail. Errors other
 *  than a clean ENOENT count as existing for the same reason: "cannot prove absent" must fail
 *  closed at the realpath step. */
function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}

/** Canonicalize for the unsafe-target guard: the longest existing prefix resolved physically
 *  (symlinks; on Windows also junctions and 8.3 short names, via the OS realpath), the
 *  not-yet-existing tail re-appended lexically. Null when the prefix cannot be resolved (a
 *  dangling symlink, a loop, an unreadable parent), so the guard refuses rather than trust a
 *  path it cannot prove. */
function canonicalizeForGuard(path: string): string | null {
  let base = resolve(path);
  const tail: string[] = [];
  while (!directoryEntryExists(base)) {
    const parent = dirname(base);
    if (parent === base) break; // walked off the root; realpath below decides
    tail.unshift(basename(base));
    base = parent;
  }
  try {
    base = realpathSync.native(base);
  } catch {
    return null;
  }
  return tail.length > 0 ? join(base, ...tail) : base;
}

/** The REAL canonical twin of the shell installers' pre-download check: they only absolutize
 *  lexically and compare strings, so an alias of the home directory (a symlink, a Windows
 *  junction or 8.3 short name) or of a filesystem root has to be caught here, where the writes
 *  and removals are planned. */
function unsafeRootReason(root: string): string | null {
  const canonical = canonicalizeForGuard(root);
  if (canonical === null) return "its canonical path cannot be resolved";
  if (canonical === dirname(canonical)) return "it is a filesystem root";
  const home = homedir() ? canonicalizeForGuard(homedir()) : null;
  if (home !== null) {
    const sameAsHome = process.platform === "win32"
      ? canonical.toLowerCase() === home.toLowerCase()
      : canonical === home;
    if (sameAsHome) return "it is the home directory";
  }
  return null;
}

/** Sorted for determinism. `.sh` files get the executable bit: they are the only embedded assets
 *  ever handed to an OS exec directly. */
function collectAssetCopies(sourceRoot: string, root: string, dir: string): AssetCopy[] {
  const copies: AssetCopy[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(join(sourceRoot, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryRel = join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(entryRel);
      } else {
        copies.push({
          from: join(sourceRoot, entryRel),
          to: join(root, entryRel),
          executable: entry.name.endsWith(".sh"),
        });
      }
    }
  };
  walk(dir);
  return copies;
}

/** The refusals every installed-mode target must clear. Returns the checkout markers present
 *  WITHOUT `.git`: legacy source-install debris the caller may sweep. */
function guardInstalledTarget(root: string): string[] {
  // The root is DERIVED (from the binary's location, or the COPILOT_ENV_INSTALL_ROOT override)
  // and the writes and removals aim at it, so an unsafe target is refused before anything is
  // planned. The shell installers keep only a lexical pre-check; this is the canonical one.
  const unsafe = unsafeRootReason(root);
  if (unsafe !== null) {
    throw new Error(`refusing to install into ${root}: ${unsafe}`);
  }

  // The markers alone cannot condemn a root: the source-archive installer era laid down roots
  // byte-indistinguishable from a checkout, and LEGACY_ARTIFACTS never swept package.json /
  // deno.json out of them. `.git` (a directory, or a file in a worktree) is the one honest
  // discriminant: archives never carry it.
  //
  //   markers + .git   -> a live checkout reached through COPILOT_ENV_INSTALL_ROOT, refused here
  //   markers, no .git -> legacy debris, swept with the other superseded artifacts
  const presentMarkers = CHECKOUT_MARKERS.filter((marker) => existsSync(join(root, marker)));
  if (presentMarkers.length > 0 && existsSync(join(root, ".git"))) {
    throw new Error(
      `refusing to install into ${root}: it holds ${presentMarkers[0]} and .git, so it is a ` +
        `source checkout, and installing would overwrite its bin/agent and working files`,
    );
  }
  return presentMarkers;
}

/** Verifies the embedded assets, then lays out the copies, per-version shims, and manifest. */
function planMaterialization(root: string, sourceRoot: string): Materialization {
  const copies: AssetCopy[] = [];
  for (const dir of MATERIALIZED_ASSET_DIRS) {
    if (!existsSync(join(sourceRoot, dir))) {
      throw new Error(
        `embedded assets are missing ${dir}; deno.json compile.include did not embed it`,
      );
    }
    copies.push(...collectAssetCopies(sourceRoot, root, dir));
  }
  for (const file of MATERIALIZED_ASSET_FILES) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(
        `embedded assets are missing ${file}; deno.json compile.include did not embed it`,
      );
    }
    copies.push({
      from: join(sourceRoot, file),
      to: join(root, file),
      executable: file.endsWith(".sh"),
    });
  }
  // Verified, never copied: these are read out of the VFS in-process.
  for (const file of BUNDLED_ONLY_ASSETS) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(
        `embedded assets are missing ${file}; deno.json compile.include did not embed it`,
      );
    }
  }

  const manifest: InstallManifest = {
    version: packageVersion(),
    kind: "installed",
    assets: [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES],
  };
  return {
    copies,
    shims: [
      { to: join(root, "bin", "agent"), text: POSIX_SHIM, executable: true },
      { to: join(root, "bin", "agent.ps1"), text: POWERSHELL_SHIM, executable: false },
    ],
    manifest: {
      to: join(root, INSTALL_MANIFEST_FILE),
      text: JSON.stringify(manifest, null, 2) + "\n",
    },
  };
}

/** Null when this process is not a standalone binary: a dev run has no binary to contribute. */
function defaultBinarySource(): string | null {
  if (!isStandaloneBinary()) return null;
  return denoRuntime()?.execPath() ?? null;
}

/** Exported for tests; `runInstall` is the composed entry point. `root`/`sourceRoot` default to
 *  the live install root and the embedded asset source; `binarySource` to the running binary. */
export function buildInstallPlan(
  options: InstallOptions,
  root: string = PROJECT_ROOT,
  sourceRoot: string = ASSET_ROOT,
  binarySource: string | null = defaultBinarySource(),
): InstallPlan {
  const shell: ShellWiring | null = options.noShellIntegration || options.assetsOnly
    ? null
    : { allHosts: options.allHosts };

  // The discriminant IS rootMode's, over the arguments: root.ts sets ASSET_ROOT === PROJECT_ROOT
  // for a checkout and splits them for a compiled binary (VFS vs install root). Gating on
  // `rootMode()` would ignore the parameters and make the installed branch unreachable from a
  // test, which is exactly the branch worth testing.
  if (resolve(sourceRoot) === resolve(root)) {
    return { kind: "in-place", root, shell };
  }

  if (options.assetsOnly) {
    // INTO the aimed root exactly: an update aims this inside a staged version root; the
    // pre-versioned updater aimed it at a flat top.
    const presentMarkers = guardInstalledTarget(root);
    return {
      kind: "installed",
      root,
      ...planMaterialization(root, sourceRoot),
      legacyRemovals: [...LEGACY_ARTIFACTS, ...presentMarkers]
        .map((name) => join(root, name))
        .filter(existsSync),
      shell: null,
    };
  }

  // A FULL install builds the versioned layout at the top root, whichever spelling of it this
  // process was aimed at (the top during bootstrap, the `current` link from an installed binary).
  const top = classifyInstallRoot(root).top;
  guardInstalledTarget(top);

  const versionName = versionDirName(packageVersion());
  const versionRoot = versionRootPath(top, versionName);
  const binaryTarget = join(versionRoot, "bin", installedBinaryName());
  // CANONICAL identity, not lexical: a binary running through the `current` link names its own
  // file twice (`<top>/current/bin/...` vs the version path), and copyFileSync onto the same
  // inode TRUNCATES it before reading.
  const sameFile = binarySource !== null &&
    canonicalizeForGuard(binarySource) !== null &&
    canonicalizeForGuard(binarySource) === canonicalizeForGuard(binaryTarget);
  const binary = binarySource !== null && !sameFile
    ? { from: binarySource, to: binaryTarget }
    : null;
  const flatRemovals = flatArtifactPaths(top);

  return {
    kind: "versioned",
    top,
    versionName,
    versionRoot,
    ...planMaterialization(versionRoot, sourceRoot),
    binary,
    currentLink: { path: currentLinkPath(top), target: currentLinkTarget(top, versionName) },
    topShims: [
      { to: join(top, "bin", "agent"), text: POSIX_CURRENT_SHIM, executable: true },
      { to: join(top, "bin", "agent.ps1"), text: POWERSHELL_CURRENT_SHIM, executable: false },
    ],
    flatRemovals,
    flatPrunes: flatScaffoldingPaths(top, flatRemovals),
    flatBinaryRemovals: flatBinaryResiduePaths(top),
    shellWires: shell === null ? [] : [shell],
  };
}

/** read+write instead of copyFileSync: the source side may be a compiled VFS path, which is only
 *  guaranteed readable through in-process reads. */
function applyMaterialization(m: Materialization): void {
  for (const copy of m.copies) {
    mkdirReported(dirname(copy.to));
    writeFileReported(copy.to, readFileSync(copy.from));
    if (copy.executable) chmodReported(copy.to, 0o755);
  }
  for (const shim of m.shims) {
    mkdirReported(dirname(shim.to));
    writeFileReported(shim.to, shim.text);
    if (shim.executable) chmodReported(shim.to, 0o755);
  }
  mkdirReported(dirname(m.manifest.to));
  writeFileReported(m.manifest.to, m.manifest.text);
}

/** Runs through the INSTALLED binary aimed at `<top>/current`, because only a process rooted at
 *  the link derives rc-block paths that survive updates and GC.
 *
 *   every pass succeeded (vacuously, for none) -> the caller may sweep the flat shell payload
 *   a pass failed                              -> warn with the manual command and install anyway
 */
function wireShellsThroughInstalledBinary(
  top: string,
  versionRoot: string,
  wires: readonly ShellWiring[],
): boolean {
  if (wires.length === 0) return true;
  const binary = join(versionRoot, "bin", installedBinaryName());
  if (!existsSync(binary)) {
    consola.warn("No installed binary to wire the shell with; run 'agent shell' afterwards.");
    return false;
  }
  let allOk = true;
  for (const wire of wires) {
    const args = ["shell", ...(wire.allHosts ? ["--all-hosts"] : [])];
    const result = spawnSync(binary, args, {
      cwd: top,
      stdio: "inherit",
      env: { ...process.env, [INSTALL_ROOT_ENV]: currentLinkPath(top) },
    });
    if (result.error || result.status !== 0) {
      consola.warn("Shell integration reported a problem; run 'agent shell' to retry.");
      allOk = false;
    }
  }
  return allOk;
}

export function applyInstallPlan(plan: InstallPlan): void {
  if (plan.kind === "installed") {
    applyMaterialization(plan);
    consola.success("Installed the copilot-env runtime files.");
    for (const path of plan.legacyRemovals) removeTreeReported(path);
  }

  if (plan.kind === "versioned") {
    // Prepare the version root completely BEFORE the flip: any failure up to pointCurrentAt
    // leaves whatever was live before fully live. Deliberate exception: a SAME-VERSION reinstall
    // refreshes the live version root in place; staging plus a dir swap is not available under
    // a running image on Windows, and in-place refresh is what every pre-versioned release did.
    applyMaterialization(plan);
    if (plan.binary !== null) {
      mkdirReported(dirname(plan.binary.to));
      copyFileReported(plan.binary.from, plan.binary.to);
      if (process.platform !== "win32") chmodReported(plan.binary.to, 0o755);
    }
    pointCurrentAt(plan.top, plan.versionName);
    for (const shim of plan.topShims) {
      writeShimFile(shim.to, shim.text, shim.executable, consola);
    }
    consola.success(`Installed copilot-env ${plan.versionName} (live via the current link).`);
    // Shell wiring BEFORE the flat sweep: on a flat->versioned transition the rc block still
    // points at the flat payload, and the rewire must land before that payload disappears; a
    // failed rewire keeps it in place. Each removal names itself as it happens (through the
    // reporting seam), so nothing is announced that the keep set then spares.
    const wiredOk = wireShellsThroughInstalledBinary(plan.top, plan.versionRoot, plan.shellWires);
    removeFlatArtifacts(
      plan.flatRemovals,
      plan.flatPrunes,
      wiredOk ? new Set() : new Set(["shell"]),
    );
    removeFlatBinaryResidue(plan.flatBinaryRemovals);
    return;
  }

  if (plan.shell === null) return;
  runShellIntegration({ kind: "wire", allHosts: plan.shell.allHosts });
}

/** What a layout adoption must REWIRE (the block's source path changes), never widen: a user who
 *  opted out stays out. A LAUNCHERS-only rc counts as wired: the launchers ride the main block
 *  now (`agent env` function emissions), so the shell pass is what carries that opt-in into the
 *  `launchers` config key and strips the retired block; skipping it would leave the user
 *  silently launcher-less once the payload sweep runs. */
export function wiredShellTargets(): ShellWiring[] {
  const wiredIn = (paths: string[]): boolean =>
    paths.some((path) => {
      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (error) {
        // Present but unreadable: assume wired. The answer gates whether the flat shell payload
        // may be swept, and "could not look" must retain.
        return (error as { code?: string }).code !== "ENOENT";
      }
      return hasMarker(content, MARKER) || hasMarker(content, LAUNCHERS_MARKER);
    });
  if (process.platform !== "win32") {
    return wiredIn(rcFiles(true)) ? [{ allHosts: false }] : [];
  }
  const wires: ShellWiring[] = [];
  if (wiredIn(windowsProfileTarget(false).paths)) wires.push({ allHosts: false });
  if (wiredIn(windowsProfileTarget(true).paths)) wires.push({ allHosts: true });
  return wires;
}

/** Test seam for `adoptVersionedLayout`: the ambient root mode, asset source, and binary source
 *  are all real-machine facts a suite must substitute. */
export interface AdoptVersionedLayoutDeps {
  mode?: RootMode;
  sourceRoot?: string;
  binarySource?: string | null;
}

/**
 * The 3.5.6 migration core: the versioned layout built around a live flat install. It runs as the
 * NEW binary (spawned from `<top>/bin/copilot-env` by the pre-versioned updater), so the image it
 * relocates is its own, which is why the placement is a COPY rather than a rename.
 *
 *   copy into versions/ -> flip `current` -> top shims -> rewire shells -> sweep the flat original
 *
 *   a failure before the flip -> the flat install is still live
 *   after the flip            -> POSIX unlinks the flat binary, Windows leaves it to a later sweep
 *   an already versioned root -> re-runs from the shims on, each step converging
 */
export function adoptVersionedLayout(deps: AdoptVersionedLayoutDeps = {}): void {
  const mode = deps.mode ?? rootMode();
  if (mode.kind !== "compiled") {
    consola.info("  a source checkout keeps its own layout; nothing to adopt.");
    return;
  }
  const shape = classifyInstallRoot(mode.root);
  if (shape.kind === "versioned") {
    // Never ours to repair: `agent update --force` on a dev clone can build versions/ + current
    // INSIDE the checkout, but its bin/agent launchers and rc wiring are SOURCE (the same guard
    // commit() applies before refreshing the top shims).
    if (isCheckoutShapedRoot(shape.top)) {
      consola.info("  a source checkout keeps its own launchers; nothing to repair.");
      return;
    }
    // REPAIR, not a no-op: an earlier run may have crashed after the flip but before the shims,
    // rewire, or sweep. Only behind a link that RESOLVES to a complete version, though (the
    // binary present AND a valid manifest naming the linked version, the updater's provision
    // postcondition): through a dangling or half-built `current` the shims dispatch nothing
    // trustworthy, and the flat leftovers may be the only working install.
    const link = currentLinkPath(shape.top);
    const manifest = readInstallManifest(link);
    const complete = existsSync(join(link, "bin", installedBinaryName())) &&
      manifest.kind === "valid" &&
      versionDirName(manifest.manifest.version) === readCurrentVersionName(shape.top);
    if (!complete) {
      consola.warn(
        `  ${link} does not resolve to a complete installed version; ` +
          "leaving everything in place - re-run the installer to repair this install.",
      );
      return;
    }
    // Each step converges (identical shims skip, wiring is idempotent, the sweep finds nothing
    // on a clean layout), so re-running is always safe. The flat binary residue goes only once
    // the top shims dispatch through the link.
    writeTopLevelShims(shape.top);
    const repaired = wireShellsThroughInstalledBinary(
      shape.top,
      link,
      wiredShellTargets(),
    );
    const flat = flatArtifactPaths(shape.top);
    removeFlatArtifacts(
      flat,
      flatScaffoldingPaths(shape.top, flat),
      repaired ? new Set() : new Set(["shell"]),
    );
    removeFlatBinaryResidue(flatBinaryResiduePaths(shape.top));
    consola.info("  already on the versioned layout.");
    return;
  }
  const plan = buildInstallPlan(
    { noShellIntegration: true, allHosts: false, assetsOnly: false },
    shape.top,
    deps.sourceRoot ?? ASSET_ROOT,
    deps.binarySource !== undefined ? deps.binarySource : defaultBinarySource(),
  );
  if (plan.kind !== "versioned") {
    throw new Error(`expected a versioned install plan for ${shape.top}, got ${plan.kind}`);
  }
  // Rewire exactly the shell targets wired today (their block points at the flat payload the
  // sweep removes); never wire a target that was not.
  applyInstallPlan({ ...plan, shellWires: wiredShellTargets() });
  consola.info("  moved the install to the versioned layout (live via the current link).");
}

/** Skipped for `--assets-only`, a machine-to-machine step inside `agent update`. */
function printEpilogue(options: InstallOptions): void {
  console.log("");
  if (options.noShellIntegration) {
    console.log("Done. Shell integration was skipped; run 'agent shell' to enable it.");
  } else {
    console.log(
      process.platform === "win32"
        ? "Done. Restart PowerShell to load the integration."
        : "Done. Restart your shell to load the integration.",
    );
  }
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Run 'agent init' to set up Codex + Claude (it picks GitHub Copilot Direct or the local proxy), then tells you whether you need 'agent start' (only for the proxy).",
  );
  console.log(
    "  2. Optionally run 'agent shell --clis' to install the CLIs and 'agent config --set launchers true' for the cl/co/cx shortcuts.",
  );
}

export function runInstall(options: InstallOptions): void {
  applyInstallPlan(buildInstallPlan(options));
  if (options.assetsOnly) return;
  if (options.noShellIntegration) {
    consola.info("Skipping shell integration (--no-shell-integration).");
  }
  printEpilogue(options);
}
