// The in-binary `agent install` implementation: finalize an install root
// around the compiled agent binary that install.sh / install.ps1 just
// downloaded to <root>/bin/copilot-env(.exe).
//
// The work is a plan/apply split (build one typed plan up front, then execute
// it -- the same shape as planImport/applyImportPlan in src/agents/transfer.ts):
//
// - in-place mode (dev checkout, where the asset source IS the install root):
//   only shell integration applies -- the checkout's own bin/agent launchers
//   and working files are never overwritten.
// - assets-only mode (compiled binary): materialize the embedded runtime assets
//   into the root this process is aimed at. `agent update` runs the NEW binary
//   this way, aimed (via COPILOT_ENV_INSTALL_ROOT) INSIDE the not-yet-live
//   version root it just staged.
// - full installed mode (compiled binary): build the VERSIONED layout at the
//   top root --
//
//     <top>/versions/vX.Y.Z/   one complete root per release (binary, assets,
//                              launcher shims, install manifest)
//     <top>/current            a link naming the live version (POSIX symlink;
//                              Windows directory junction)
//     <top>/bin/agent(.ps1)    stable shims dispatching THROUGH `current`
//
//   Every path that outlives a release (agent configs, rc blocks, daemon
//   preloads) goes through `<top>/current/...`, so flipping the link is the
//   whole commit of an update and old version dirs can be garbage-collected
//   without breaking anything persisted.
//
// Assets are read via URLs relative to import.meta.url, which resolves inside
// the compiled VFS (a virtual path readable in-process only) and inside a dev
// checkout alike; comparing that source root to the install root is what
// discriminates in-place from the compiled modes.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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

/** Embedded AND materialized: something outside this process opens these by
 *  path, so they have to exist on real disk in the install root - the daemon's
 *  `--preload` shims and the one-release proxy-token forwarders, the
 *  shell-integration payload the rc block sources, and the plugin/skill surface
 *  other tools read.
 *
 *  `src/scripts` is materialized WHOLE rather than by naming the shims. The
 *  daemon loads a per-credential subset of `DAEMON_SHIM_FILES`
 *  (src/copilot_api/shims.ts) by absolute path, and those entrypoints import
 *  further siblings; copying the directory covers the in-dir ones by
 *  construction. Imports reaching OUTSIDE the directory are
 *  `MATERIALIZED_ASSET_FILES` below. */
export const MATERIALIZED_ASSET_DIRS = [
  "src/scripts",
  "shell",
  "skills",
  ".claude-plugin",
] as const;

/** Embedded and materialized as INDIVIDUAL files: the daemon shims in
 *  `src/scripts` import these siblings from `src/copilot_api` and `src/utils`,
 *  and the sidecar deno resolves those imports on real disk in the install
 *  root -- a missing one kills the daemon at module load. The list is the
 *  shims' full local import closure OUTSIDE the materialized dirs, pinned
 *  bidirectionally to the computed closure by test/installer_pinning.test.ts
 *  so a new shim import cannot silently break installs again. */
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
  "src/utils/time.ts",
] as const;

/** Embedded and NEVER materialized: read in-process through `ASSET_ROOT`, which
 *  resolves inside the compiled VFS. The rule these follow is general - if a
 *  file ships with the build and is read in-process, it is an ASSET_ROOT read,
 *  and writing a second copy into the install root would only create something
 *  nothing reads and that can drift from the binary that shipped it.
 *
 *  `copilot-env.config` is the proxy-float floor/ceiling (`readProjectConfig`),
 *  `.dvmrc` is the deno version the sidecar provisions against
 *  (`readDvmrcPin`), and `deno.json` is the import map the daemon config is
 *  generated from (`writeDaemonConfig`); all default to ASSET_ROOT.
 *
 *  `deno.json` MUST stay bundled-only for a second reason: on disk it is a
 *  CHECKOUT_MARKERS entry, so materializing it would make every install root
 *  read as checkout debris.
 *
 *  They are still verified present at plan time: absent from the VFS means the
 *  build is broken, and failing here beats failing at first proxy start. */
export const BUNDLED_ONLY_ASSETS = ["copilot-env.config", ".dvmrc", "deno.json"] as const;

/** Superseded files a pre-binary source install leaves in the root. The binary
 *  install has no runtime bootstrap left to use them and `node_modules` alone
 *  is hundreds of megabytes, so they are removed outright (clean break --
 *  there is no upgrade bridge). This list lives ONLY here: install.sh /
 *  install.ps1 do no sweeping of their own, they hand off to `agent install`,
 *  which plans and applies the removal. */
export const LEGACY_ARTIFACTS = ["node_modules", "bun.lock", "bunfig.toml"] as const;

// --- The versioned layout vocabulary --------------------------------------------

// The layout NAMES (`versions`, `current`) live in src/utils/root.ts -- root
// detection reads the layout, so root.ts owns the vocabulary; this module
// re-exports it beside the operations that build the layout.
export { CURRENT_LINK, VERSIONS_DIR };

/** root.ts's install-root override env var (ROOT_OVERRIDE_ENV there, unexported):
 *  how a SPAWNED binary is aimed at the exact root it must manage -- `agent
 *  update` aims `install --assets-only` inside the staged version root, and every
 *  post-flip spawn at `<top>/current`. An external contract; never rename. */
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
 * What layout an install root is on, and where its TOP is. Accepts both
 * spellings a versioned root reaches this code under: the `current` link path
 * itself (how a versioned binary sees its own root), and the top directory
 * (how the bootstrap sees a root it is about to version). The layout is only
 * believed when `current` is a REAL link into `versions/`
 * (isVersionedInstallTop): coincidental directory names must never reroute an
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

/**
 * Point `<top>/current` at `<top>/versions/<versionName>` -- THE commit step of
 * an install or update.
 *
 * POSIX: build the replacement link aside and rename it over -- atomic, so a
 * concurrent reader never observes a missing link -- with a RELATIVE target so
 * the install stays relocatable.
 *
 * Windows: a directory junction (`New-Item -ItemType Junction` semantics):
 * resolvable by every Win32 path API, stock PowerShell 5.1 included, and
 * creatable without the symlink privilege. Windows cannot rename an entry over
 * an existing directory entry, so replace = remove the old junction (an entry
 * delete; the target's contents are never touched), then create the new one.
 * Junction targets are stored absolute (relative junctions do not exist).
 */
export function pointCurrentAt(top: string, versionName: string): void {
  const link = currentLinkPath(top);
  if (process.platform === "win32") {
    // Windows has no atomic replace of a directory entry, so the flip is
    // remove-then-create with a RESTORE on failure: if the new junction cannot
    // be created (antivirus interference, transient locks), the old one is put
    // back before the error surfaces, so a failed flip never strands the
    // layout linkless. The remaining exposure is process termination between
    // the two calls -- microseconds, and repaired by re-running the update or
    // installer (both re-point the link).
    const previous = readCurrentTargetPath(top);
    try {
      rmdirSync(link);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    try {
      symlinkSync(versionRootPath(top, versionName), link, "junction");
    } catch (error) {
      if (previous !== null) {
        try {
          symlinkSync(previous, link, "junction");
        } catch {
          // Double fault: the layout is now LINKLESS -- say so, instead of
          // reporting only the creation failure as if nothing else changed.
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
  // A corrupt layout may leave a REAL directory at the link path; rename cannot
  // replace one. rmdirSync is non-recursive on purpose: an empty stray dir is
  // repaired, a non-empty one is unknown data and fails the flip loudly.
  try {
    if (!lstatSync(link).isSymbolicLink()) rmdirSync(link);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const staged = join(top, `.${CURRENT_LINK}-next-${process.pid}-${Date.now().toString(36)}`);
  rmSync(staged, { force: true });
  symlinkSync(join(VERSIONS_DIR, versionName), staged);
  renameSync(staged, link);
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

/** Write ONE launcher shim, atomically where the OS allows: skip when the text
 *  already matches (the steady state -- an update then never touches the file a
 *  user's PATH points at), else write beside and rename over. The direct-write
 *  fallback covers a rename refused by an open handle on the live file. Every
 *  write is announced here, once per path: install, update commit, and the
 *  post-update shim refresh all land through this one writer. */
function writeShimFile(to: string, text: string, executable: boolean): void {
  try {
    if (readFileSync(to, "utf-8") === text) {
      // Text is current; still repair a lost exec bit (a crash between an
      // earlier write and its chmod would otherwise persist across retries).
      if (executable) chmodSync(to, 0o755);
      return;
    }
  } catch {
    // absent or unreadable: write it below
  }
  mkdirSync(dirname(to), { recursive: true });
  const staged = `${to}.next-${process.pid}`;
  writeFileSync(staged, text);
  if (executable) chmodSync(staged, 0o755);
  try {
    renameSync(staged, to);
  } catch {
    rmSync(staged, { force: true });
    writeFileSync(to, text);
    if (executable) chmodSync(to, 0o755);
  }
  consola.info(`Wrote launcher shim ${to}`);
}

/** Write the stable `<top>/bin/agent(.ps1)` shims that dispatch through the
 *  `current` link. Idempotent and cheap in the steady state (identical text is
 *  never rewritten), so every install and update commit can refresh them --
 *  which is also what heals a crash that flipped `current` but got no further. */
export function writeTopLevelShims(top: string): void {
  writeShimFile(join(top, "bin", "agent"), POSIX_CURRENT_SHIM, true);
  writeShimFile(join(top, "bin", "agent.ps1"), POWERSHELL_CURRENT_SHIM, false);
}

/** Markers + .git: the shape of a LIVE source checkout (see CHECKOUT_MARKERS).
 *  Every destructive sweep in this module refuses such a root outright. */
export function isCheckoutShapedRoot(root: string): boolean {
  return CHECKOUT_MARKERS.some((marker) => existsSync(join(root, marker))) &&
    existsSync(join(root, ".git"));
}

/** The pre-versioned (flat) artifacts present at `top`: the materialized asset
 *  dirs/files an old layout kept at the root, its manifest, and the legacy
 *  source-install debris. Empty for a checkout-shaped root -- those files are
 *  SOURCE there, never ours to sweep. */
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

/** Remove the flat artifacts at `top` (best-effort, entry by entry), then prune
 *  the emptied `src` scaffolding the per-file removals leave behind. `keep`
 *  names entries to spare -- the shell payload stays whenever the rc/profile
 *  block still points at it (a stale payload that works beats a swept one a
 *  block still sources). */
export function removeFlatArtifacts(
  top: string,
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const path of flatArtifactPaths(top)) {
    if (keep.has(basename(path))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // in use (Windows); harmless debris until something releases it
    }
  }
  for (const dir of [join("src", "copilot_api"), join("src", "utils"), "src"]) {
    try {
      rmdirSync(join(top, dir)); // non-recursive: only ever prunes an EMPTY dir
    } catch {
      // not empty or already gone -- either way, leave it
    }
  }
}

/** Remove the pre-versioned binary leftovers in `<top>/bin`: the flat-layout
 *  `copilot-env(.exe)` (superseded by `versions/<v>/bin/...`) and any
 *  `.old-<ts>` aside files the pre-versioned Windows updater left. Best-effort:
 *  a still-running image refuses deletion and is swept by a later update. */
export function removeFlatBinaryResidue(top: string): void {
  const binDir = join(top, "bin");
  let entries: string[];
  try {
    entries = readdirSync(binDir);
  } catch {
    return;
  }
  const liveName = installedBinaryName();
  for (const entry of entries) {
    if (entry !== liveName && !entry.startsWith(`${liveName}.old-`)) continue;
    try {
      rmSync(join(binDir, entry), { force: true });
    } catch {
      // still the running image (Windows); the next update sweeps it
    }
  }
}

/** Garbage-collect `<top>/versions`: remove every version dir NOT in `keep`
 *  (the update flow keeps the new version plus exactly one previous, the
 *  rollback candidate). Best-effort per entry -- a version still running a
 *  process (Windows) stays until a later update. */
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
      rmSync(join(versionsDirPath(top), entry), { recursive: true, force: true });
    } catch {
      // in use; the next update retries
    }
  }
}

// --- Launcher shim texts ---------------------------------------------------------
//
// Every installed shim carries the same `agent start` hook as the checkout's
// bin/agent(.ps1): the opt-in autoupdate preflight, reached as the binary's own
// `update --preflight` (a compiled binary has no preflight.ts on disk to run).
// It runs BEFORE the dispatch so a swapped release is what dispatches, on
// `start` only, non-fatal, and on stderr (stdout is `agent env`'s, which the
// shell wrapper evals). The gate itself (the auto-update key, the daily
// cadence) lives inside the preflight, so the shims stay dumb dispatchers.

/** The POSIX shim text around `binary` (an expression the shell expands). */
function posixShimText(purpose: string, binary: string): string {
  return `#!/bin/sh
# copilot-env launcher (installed): ${purpose}
HERE="$(cd "$(dirname "$0")" && pwd)"
# Opt-in autoupdate preflight, on \`agent start\` only (what the checkout's bin/agent
# runs too): gated on the auto-update config key, non-fatal, stderr only.
if [ "\${1:-}" = "start" ]; then
    "${binary}" update --preflight >&2 || true
fi
exec "${binary}" "$@"
`;
}

/** The PowerShell shim text around `binary` (an expression yielding its path). */
function powershellShimText(purpose: string, binary: string): string {
  return `# copilot-env launcher (installed): ${purpose}
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Binary = ${binary}
# Opt-in autoupdate preflight, on \`agent start\` only (what the checkout's bin/agent.ps1
# runs too): gated on the auto-update config key, non-fatal, stderr only.
if ($args.Count -gt 0 -and $args[0] -eq 'start') {
    try { & $Binary update --preflight | ForEach-Object { [Console]::Error.WriteLine($_) } }
    catch { [Console]::Error.WriteLine("autoupdate preflight failed: $_") }
}
& $Binary @args
exit $LASTEXITCODE
`;
}

/** Per-version bin/agent: a thin dispatcher to the adjacent compiled binary.
 *  Lives INSIDE each version root; the paths persisted into agent configs reach
 *  it as `<top>/current/bin/agent`, so the version it dispatches is always the
 *  live one. The checkout's bin/agent is the dev-mode variant; an install never
 *  overwrites a checkout (in-place mode writes no shims), so the two texts
 *  never compete for the same file. */
export const POSIX_SHIM = posixShimText(
  "dispatch to the compiled agent binary.",
  `$HERE/${INSTALLED_BINARY_POSIX}`,
);

/** Per-version bin/agent.ps1 (Windows twin of POSIX_SHIM). */
export const POWERSHELL_SHIM = powershellShimText(
  "dispatch to the compiled agent binary.",
  `Join-Path $Here '${INSTALLED_BINARY_WINDOWS}'`,
);

/** Top-level bin/agent: the stable PATH entry of a versioned install. One
 *  release-independent hop through the `current` link, so an update never has
 *  to touch the file a user's PATH points at. */
export const POSIX_CURRENT_SHIM = posixShimText(
  "dispatch through the current version link.",
  `$HERE/../${CURRENT_LINK}/bin/${INSTALLED_BINARY_POSIX}`,
);

/** Top-level bin/agent.ps1 (Windows twin of POSIX_CURRENT_SHIM; the junction
 *  resolves through every Win32 path API, PowerShell 5.1 included). */
export const POWERSHELL_CURRENT_SHIM = powershellShimText(
  "dispatch through the current version link.",
  `Join-Path (Split-Path -Parent $Here) '${CURRENT_LINK}\\bin\\${INSTALLED_BINARY_WINDOWS}'`,
);

export interface InstallOptions {
  noShellIntegration: boolean;
  allHosts: boolean;
  /**
   * Materialize the embedded assets and launcher shims into the aimed root and
   * nothing else: no layout work, no shell wiring, no next-steps epilogue.
   * `agent update` runs the NEW binary this way INSIDE the staged version root
   * (aimed via COPILOT_ENV_INSTALL_ROOT), so the release that owns the assets
   * is the one that writes them -- before the `current` flip makes it live.
   */
  assetsOnly: boolean;
}

/** Files only a source checkout OR a legacy source-archive install carries at
 *  its root. With `.git` beside them they mark a live checkout an installed-mode
 *  plan must refuse to clobber; without `.git` they are debris the old
 *  source-archive installer left behind, swept like `LEGACY_ARTIFACTS`. */
export const CHECKOUT_MARKERS = ["package.json", "deno.json"] as const;

/** One shell-integration wiring pass (Windows may need two: per-host and
 *  all-hosts profiles are separate targets). */
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
    /** The compiled binary to place into the version root (null when it is
     *  already there, or when no standalone binary is running -- a dev process
     *  aimed at a foreign root has no binary to contribute). */
    binary: { from: string; to: string } | null;
    topShims: ShimWrite[];
    /** Pre-versioned artifacts at the top root, swept AFTER the flip. */
    flatRemovals: string[];
    /** Shell wiring passes, run through the INSTALLED binary post-flip (this
     *  process may be rooted at the flat top, so its own PROJECT_ROOT-derived
     *  rc paths would not survive the layout change). */
    shellWires: ShellWiring[];
  };

/** Whether a directory ENTRY exists at `path`, without following a final
 *  symlink: a dangling link or a loop IS an entry, and the guard must hand it
 *  to realpath (which refuses it) instead of peeling it as a missing tail.
 *  Errors other than a clean ENOENT count as existing for the same reason --
 *  "cannot prove absent" must fail closed at the realpath step. */
function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}

/** Canonicalize a path for the unsafe-target guard: resolve the longest
 *  existing prefix physically (symlinks; on Windows also junctions and 8.3
 *  short names, via the OS realpath) and re-append the not-yet-existing tail
 *  lexically. Null when the existing prefix cannot be resolved (a dangling
 *  symlink, a loop, an unreadable parent), so the guard refuses rather than
 *  trust a path it cannot prove. */
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

/** Why `root` is unsafe to finalize an install into, or null when it is fine.
 *  The REAL canonical twin of the shell installers' pre-download check: they
 *  only absolutize lexically and compare strings, so an alias of the home
 *  directory (a symlink, a Windows junction or 8.3 short name) or of a
 *  filesystem root has to be caught here, where the writes and removals are
 *  planned. */
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

/** Collect every file under `dir` (recursively, sorted for determinism) as
 *  install-root-relative copies. `.sh` files get the executable bit: they are
 *  the only embedded assets ever handed to an OS exec directly. */
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

/** The refusals every installed-mode target must clear: an unsafe canonical
 *  path, and the live-checkout shape. Returns the checkout markers present
 *  WITHOUT `.git` -- legacy source-install debris the caller may sweep. */
function guardInstalledTarget(root: string): string[] {
  // The install root is DERIVED (from the binary's location, or the
  // COPILOT_ENV_INSTALL_ROOT override), and the installed-mode writes and
  // removals aim at it, so an unsafe target must be refused before anything is
  // planned. The shell installers keep only a lexical pre-check; this is the
  // canonical one.
  const unsafe = unsafeRootReason(root);
  if (unsafe !== null) {
    throw new Error(`refusing to install into ${root}: ${unsafe}`);
  }

  // Installed-mode writes replace bin/agent with a dispatch shim and sweep the
  // flat-layout files -- exactly the files a dev checkout authored. But the
  // markers alone cannot condemn a root: the source-archive installer era laid
  // down roots byte-indistinguishable from a checkout (it extracted release
  // source archives), and LEGACY_ARTIFACTS never swept package.json/deno.json
  // out of them. `.git` (a directory, or a file in a worktree) is the one
  // honest discriminant: archives never carry it. Markers + .git is a live
  // checkout reached through COPILOT_ENV_INSTALL_ROOT -- refuse before planning
  // any write. Markers without .git is a legacy source install: sweep the
  // markers with the other superseded artifacts.
  const presentMarkers = CHECKOUT_MARKERS.filter((marker) => existsSync(join(root, marker)));
  if (presentMarkers.length > 0 && existsSync(join(root, ".git"))) {
    throw new Error(
      `refusing to install into ${root}: it holds ${presentMarkers[0]} and .git, so it is a ` +
        `source checkout, and installing would overwrite its bin/agent and working files`,
    );
  }
  return presentMarkers;
}

/** Plan the complete materialization of one version root at `root`: verify the
 *  embedded assets, then lay out the copies, per-version shims, and manifest. */
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

/** The running compiled binary's on-disk path, or null when this process is not
 *  a standalone binary (a dev run has no binary to contribute to a layout). */
function defaultBinarySource(): string | null {
  if (!isStandaloneBinary()) return null;
  return denoRuntime()?.execPath() ?? null;
}

/** Build the full typed plan. Exported for tests; `runInstall` is the composed
 *  entry point. `root`/`sourceRoot` default to the live install root and the
 *  embedded asset source; `binarySource` to the running binary. */
export function buildInstallPlan(
  options: InstallOptions,
  root: string = PROJECT_ROOT,
  sourceRoot: string = ASSET_ROOT,
  binarySource: string | null = defaultBinarySource(),
): InstallPlan {
  const shell: ShellWiring | null = options.noShellIntegration || options.assetsOnly
    ? null
    : { allHosts: options.allHosts };

  // The discriminant IS rootMode's, expressed over the arguments rather than
  // read from ambient state: root.ts sets ASSET_ROOT === PROJECT_ROOT for a
  // checkout (both resolve to the checkout) and splits them for a compiled
  // binary (VFS vs install root). Comparing the injected pair therefore gives
  // the same answer as `rootMode().kind`, and keeps the parameters meaningful -
  // gating on `rootMode()` instead would ignore them and make the installed
  // branch unreachable from a test, which is exactly the branch worth testing.
  if (resolve(sourceRoot) === resolve(root)) {
    return { kind: "in-place", root, shell };
  }

  if (options.assetsOnly) {
    // Materialize INTO the aimed root exactly (an update aims this inside a
    // staged version root; the pre-versioned updater aimed it at a flat top).
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

  // A FULL install builds the versioned layout at the top root, whichever
  // spelling of it this process was aimed at (the top itself during bootstrap,
  // the `current` link when re-run from an installed binary).
  const top = classifyInstallRoot(root).top;
  guardInstalledTarget(top);

  const versionName = versionDirName(packageVersion());
  const versionRoot = versionRootPath(top, versionName);
  const binaryTarget = join(versionRoot, "bin", installedBinaryName());
  // CANONICAL identity, not lexical: a binary running through the `current`
  // link names its own file twice (`<top>/current/bin/...` vs the version
  // path), and copyFileSync onto the same inode TRUNCATES it before reading.
  const sameFile = binarySource !== null &&
    canonicalizeForGuard(binarySource) !== null &&
    canonicalizeForGuard(binarySource) === canonicalizeForGuard(binaryTarget);
  const binary = binarySource !== null && !sameFile
    ? { from: binarySource, to: binaryTarget }
    : null;

  return {
    kind: "versioned",
    top,
    versionName,
    versionRoot,
    ...planMaterialization(versionRoot, sourceRoot),
    binary,
    topShims: [
      { to: join(top, "bin", "agent"), text: POSIX_CURRENT_SHIM, executable: true },
      { to: join(top, "bin", "agent.ps1"), text: POWERSHELL_CURRENT_SHIM, executable: false },
    ],
    flatRemovals: flatArtifactPaths(top),
    shellWires: shell === null ? [] : [shell],
  };
}

/** Apply one version root's materialization (copies, shims, manifest).
 *  read+write instead of copyFileSync: the source side may be a compiled VFS
 *  path, which is only guaranteed readable through in-process reads. */
function applyMaterialization(m: Materialization): void {
  for (const copy of m.copies) {
    mkdirSync(dirname(copy.to), { recursive: true });
    writeFileSync(copy.to, readFileSync(copy.from));
    if (copy.executable) chmodSync(copy.to, 0o755);
  }
  for (const shim of m.shims) {
    mkdirSync(dirname(shim.to), { recursive: true });
    writeFileSync(shim.to, shim.text);
    if (shim.executable) chmodSync(shim.to, 0o755);
  }
  mkdirSync(dirname(m.manifest.to), { recursive: true });
  writeFileSync(m.manifest.to, m.manifest.text);
}

/** Run each shell-integration pass through the INSTALLED binary, aimed at
 *  `<top>/current`: the rc/profile block it writes must reference paths that
 *  survive updates and GC, and only a process rooted at the link derives them.
 *  Returns whether EVERY pass succeeded (vacuously true for none): the caller
 *  must not sweep the flat shell payload while a block still points at it. A
 *  failure downgrades to a warning with the manual command -- a working
 *  install with unwired shell beats a failed install. */
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
    consola.success(`Installed the copilot-env runtime files into ${plan.root}`);
    for (const path of plan.legacyRemovals) {
      consola.info(`Removing superseded ${path} ...`);
      rmSync(path, { recursive: true, force: true });
    }
  }

  if (plan.kind === "versioned") {
    // Prepare the version root completely BEFORE the flip: any failure up to
    // the pointCurrentAt call leaves whatever was live before fully live.
    // Deliberate exception: a SAME-VERSION reinstall targets the live version
    // root and so refreshes it in place -- staging plus a dir swap is not
    // available under a running image on Windows, and in-place refresh is
    // exactly what every pre-versioned release did on every install.
    applyMaterialization(plan);
    if (plan.binary !== null) {
      mkdirSync(dirname(plan.binary.to), { recursive: true });
      copyFileSync(plan.binary.from, plan.binary.to);
      if (process.platform !== "win32") chmodSync(plan.binary.to, 0o755);
    }
    pointCurrentAt(plan.top, plan.versionName);
    for (const shim of plan.topShims) {
      writeShimFile(shim.to, shim.text, shim.executable);
    }
    consola.success(
      `Installed copilot-env ${plan.versionName} into ${plan.versionRoot} (live via ${
        currentLinkPath(plan.top)
      })`,
    );
    // Shell wiring BEFORE the flat sweep: on a flat->versioned transition the
    // rc block still points at the flat payload, and the rewire must land
    // before that payload disappears -- a failed rewire keeps it in place.
    const wiredOk = wireShellsThroughInstalledBinary(plan.top, plan.versionRoot, plan.shellWires);
    for (const path of plan.flatRemovals) {
      consola.info(`Removing superseded ${path} ...`);
    }
    removeFlatArtifacts(plan.top, wiredOk ? new Set() : new Set(["shell"]));
    removeFlatBinaryResidue(plan.top);
    return;
  }

  if (plan.shell === null) return;
  runShellIntegration({ kind: "wire", allHosts: plan.shell.allHosts });
}

/** The shell-integration targets currently carrying our wiring block: what a
 *  layout adoption must REWIRE (the block's source path changes), never widen --
 *  a user who opted out stays opted out. A LAUNCHERS-only rc counts as wired:
 *  the launchers ride the main block now (`agent env` function emissions), so
 *  the shell pass is what carries that opt-in into the `launchers` config key
 *  and strips the retired block -- skipping it would leave the user silently
 *  launcher-less once the payload sweep runs. */
export function wiredShellTargets(): ShellWiring[] {
  const wiredIn = (paths: string[]): boolean =>
    paths.some((path) => {
      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (error) {
        // Present but unreadable: assume wired. The answer gates whether the
        // flat shell payload may be swept, and "could not look" must retain.
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

/** Test seam for `adoptVersionedLayout`: the ambient root mode, asset source,
 *  and binary source are all real-machine facts a suite must substitute. */
export interface AdoptVersionedLayoutDeps {
  mode?: RootMode;
  sourceRoot?: string;
  binarySource?: string | null;
}

/**
 * The 3.5.6 migration core: build the versioned layout around a live flat
 * install. Runs as the NEW binary (spawned from `<top>/bin/copilot-env` by the
 * pre-versioned updater), so the binary it relocates is its own running image --
 * which is why the placement is a COPY, never a rename: a copy is crash-safe
 * (any pre-flip failure leaves the flat install fully live) and reading a
 * running image is legal on every platform, while the flat original is removed
 * only after the flip (POSIX unlinks it; Windows leaves it for a later update's
 * sweep). Idempotent: an already-versioned root only re-sweeps flat debris (a
 * crashed earlier run may have flipped but not swept).
 */
export function adoptVersionedLayout(deps: AdoptVersionedLayoutDeps = {}): void {
  const mode = deps.mode ?? rootMode();
  if (mode.kind !== "compiled") {
    consola.info("  a source checkout keeps its own layout; nothing to adopt.");
    return;
  }
  const shape = classifyInstallRoot(mode.root);
  if (shape.kind === "versioned") {
    // A checkout-shaped top is never ours to repair: `agent update --force` on
    // a dev clone can build versions/ + current INSIDE the checkout, but its
    // bin/agent launchers and rc wiring are SOURCE -- the same guard commit()
    // applies before refreshing the top shims.
    if (isCheckoutShapedRoot(shape.top)) {
      consola.info("  a source checkout keeps its own launchers; nothing to repair.");
      return;
    }
    // REPAIR, not a bare no-op: an earlier run may have crashed after the flip
    // but before the shims, rewire, or sweep. Only behind a link that RESOLVES
    // to a complete version, though -- the binary present AND a valid manifest
    // naming the version the link points at (the same postcondition the
    // updater's provision stage demands). Through a dangling or half-built
    // `current` the through-link shims dispatch nothing trustworthy, and the
    // flat leftovers may be the only working install; re-running the installer
    // is the fix for that.
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
    // Each step converges (identical shims skip, wiring is idempotent, the
    // sweep finds nothing on a clean layout), so re-running is always safe --
    // and the flat binary residue only goes once the top shims dispatch
    // through the link.
    writeTopLevelShims(shape.top);
    const repaired = wireShellsThroughInstalledBinary(
      shape.top,
      link,
      wiredShellTargets(),
    );
    removeFlatArtifacts(shape.top, repaired ? new Set() : new Set(["shell"]));
    removeFlatBinaryResidue(shape.top);
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
  // Rewire exactly the shell targets that are wired today (their block points
  // at the flat payload the sweep removes); never wire a target that was not.
  applyInstallPlan({ ...plan, shellWires: wiredShellTargets() });
  consola.info(`  moved the install to ${plan.versionRoot} (live via the current link).`);
}

/** What to tell the user once a real install finishes. Skipped for
 *  `--assets-only`, which is a machine-to-machine step inside `agent update`. */
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
