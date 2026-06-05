// Prepare copilot-env's node_modules so cli.ts can run, then print (on stdout)
// the directory cli.ts should be run from. Installs deps + floats the gateway;
// no awareness of what command runs next (start/stop/env/...).
//
// Four modes, chosen by flag (default = no cache):
//   (no flag)      in-place: install + float directly in the source checkout and
//                  run cli.ts from there. No cache, no mirror.
//   --symlink      mirror the source into a per-user cache as symlinks, then
//                  install + float in the cache (macOS + Linux).
//   --copy         mirror the source into the cache as real copies, then install
//                  + float in the cache (works on every OS).
//   --local-cache  pick per-OS: --symlink on macOS/Linux, --copy on Windows.
//   --no-float     skip the gateway float in any mode (install/mirror only).
//
// Why copy on Windows: a POSIX symlink to the source works because Node/bun
// resolve modules relative to the link's directory (the cache). A Windows
// junction is an OS-transparent reparse point, so bun resolves the real source
// path and then looks for node_modules next to the source (which doesn't
// exist) -> "cannot find package". Copying makes the cached files real, so
// node_modules sits right beside them.
//
// Cross-platform — runs on Linux, macOS, Windows. Uses only node builtins so
// it works before any dep is installed.
//
// Usage:  bun run user_cache.ts <snapshot-dir> [--symlink|--copy|--local-cache] [--no-float]
//
// (Despite the .ts extension we invoke via `bun run` from the bin shims, so no
// compile step is needed.)

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
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Relative source import — resolved by bun straight from the snapshot, so it
// needs no node_modules and works before any dep is installed.
import { cacheDir } from "./utils/cache.ts";

// Float target: the gateway is the one dependency we track to "latest" (clamped
// to releases >=7 days old by bunfig's minimumReleaseAge). Everything else stays
// pinned via the committed bun.lock.
const GATEWAY_PKG = "@jeffreycao/copilot-api";
const GATEWAY_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // re-check at most weekly

// Compatibility floor: the minimum gateway version this wrapper's code is known
// to work against. We never run anything older. The default float resolves the
// newest release that is BOTH >=this floor AND >=7 days old; if none has cleared
// the cooldown yet, we pin exactly the floor with the cooldown bypassed. Bump
// this whenever the wrapper starts depending on a newer gateway behavior.
const GATEWAY_MIN_VERSION = "1.10.30";

// Optional ceiling on the float (inclusive). null = no cap: track the newest
// >=floor, >=7-day-old release. Set a version to hold the float below a known-bad
// release without raising the floor (e.g. cap at the last release a wrapper
// change is verified against). Wired through resolution; currently inert (null).
const GATEWAY_MAX_VERSION: string | null = null;

// Override: set COPILOT_API_VERSION to a specific version (e.g. "1.10.30") or a
// dist-tag to pin the gateway, bypassing both the floor and the 7-day cooldown.
// Lets you adopt a fresh release immediately when you trust it. Unset = float
// per GATEWAY_MIN_VERSION above.
const GATEWAY_VERSION_ENV = "COPILOT_API_VERSION";

// Mirror-mode flags. Default (no flag) = no cache: install + float directly in
// the source checkout and run cli.ts from there. The flags opt into a separate
// per-user cache instead:
//   --symlink      mirror the source into the cache as symlinks (macOS + Linux)
//   --copy         mirror the source into the cache as real copies (any OS)
//   --local-cache  pick per-OS: --symlink on macOS/Linux, --copy on Windows
//   --no-float     skip the gateway float in any mode
const SYMLINK_FLAG = "--symlink";
const COPY_FLAG = "--copy";
const LOCAL_CACHE_FLAG = "--local-cache";
const NO_FLOAT_FLAG = "--no-float";

// Records a cache's mirror mode: present => symlink mirror, absent => copy.
// Flipped by --symlink / --copy. Bookkeeping only — the in-place (no-flag) path
// never touches the cache, so nothing reads it to "inherit" a mode.
const SYMLINK_MARKER = ".symlink-cache";

type MirrorMode = "inplace" | "symlink" | "copy";

/**
 * Resolve the mirror mode from argv. `--local-cache` expands per-OS to symlink
 * (macOS/Linux) or copy (Windows): a Windows junction is OS-transparent and
 * breaks module resolution from the cache, so symlinks stay POSIX-only. With no
 * mirror flag the mode is "inplace" — no cache; work in the checkout directly.
 */
function resolveMirrorMode(): MirrorMode {
  if (process.argv.includes(SYMLINK_FLAG)) return "symlink";
  if (process.argv.includes(COPY_FLAG)) return "copy";
  if (process.argv.includes(LOCAL_CACHE_FLAG)) {
    return process.platform === "win32" ? "copy" : "symlink";
  }
  return "inplace";
}

function die(msg: string): never {
  process.stderr.write(`user-cache: ${msg}\n`);
  process.exit(1);
}

function ensureSymlink(target: string, link: string): void {
  // POSIX (macOS/Linux) symlink mirror — see resolveMirrorMode. Node/bun resolve
  // modules relative to the link's directory (the cache), so a symlink to the
  // source resolves node_modules in the cache correctly.
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) {
      return; // already correct
    }
    // Replace whatever is there (a stale link, or a copied tree/file left by a
    // prior copy-mode run) before linking.
    rmSync(link, { recursive: true, force: true });
  } catch {
    // doesn't exist yet — fine
  }
  symlinkSync(target, link);
}

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Mirror `src` to `dst` as a writable regular-file copy (not a symlink), so a
 * tool that opens it for writing (e.g. `bun add`) doesn't hit EACCES against a
 * read-only snapshot. Refreshed only when content differs, and force-replaces a
 * pre-existing symlink left by an older cache setup.
 */
function ensureWritableCopy(src: string, dst: string): void {
  try {
    if (lstatSync(dst).isSymbolicLink()) {
      unlinkSync(dst); // replace an old symlink with a real copy
    } else if (filesEqual(src, dst)) {
      return; // already an up-to-date copy
    }
  } catch {
    // doesn't exist yet — fine
  }
  copyFileSync(src, dst);
  try {
    chmodSync(dst, 0o644);
  } catch {
    // best effort; Windows ignores beyond the read-only bit
  }
}

/**
 * Mirror a snapshot entry (file or directory) into the cache as a real, writable
 * copy — the `--copy` mirror mode (symlinks are the alternative; see
 * resolveMirrorMode). Content-aware: files are recopied only when their bytes
 * differ, directories are recursed and pruned of stale children. A pre-existing
 * symlink (left by a prior symlink-mode run) is replaced with a real copy.
 * Preserves source exec bits while guaranteeing user-write so the next refresh
 * can overwrite.
 */
function ensureCopyTree(src: string, dst: string): void {
  try {
    if (lstatSync(dst).isSymbolicLink()) {
      rmSync(dst, { recursive: true, force: true }); // replace stale symlink
    }
  } catch {
    // doesn't exist yet — fine
  }

  const st = statSync(src); // follow: snapshot entries are plain files/dirs
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    const children = readdirSync(src);
    for (const child of children) {
      ensureCopyTree(join(src, child), join(dst, child));
    }
    // Prune cached children no longer present in the source.
    const keep = new Set(children);
    for (const entry of readdirSync(dst)) {
      if (keep.has(entry)) continue;
      try {
        rmSync(join(dst, entry), { recursive: true, force: true });
      } catch {
        // best effort; stale entry is harmless
      }
    }
    return;
  }

  if (!filesEqual(src, dst)) {
    copyFileSync(src, dst);
  }
  try {
    chmodSync(dst, (st.mode & 0o777) | 0o600);
  } catch {
    // best effort; Windows ignores beyond the read-only bit
  }
}

function detectBunCmd(): string {
  // Prefer ~/.bun/bin/bun (installer default); fall back to PATH lookup.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localBun =
    process.platform === "win32"
      ? join(home, ".bun", "bin", "bun.exe")
      : join(home, ".bun", "bin", "bun");
  if (existsSync(localBun)) return localBun;
  return "bun";
}

function gatewayInstalled(cache: string): boolean {
  return existsSync(join(cache, "node_modules", "@jeffreycao", "copilot-api", "package.json"));
}

/** Installed gateway version (from its package.json), or null if unresolved. */
function installedGatewayVersion(cache: string): string | null {
  try {
    const pkgPath = join(cache, "node_modules", "@jeffreycao", "copilot-api", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Full semver shape (core + optional prerelease/build), anchored. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The version recorded in the float stamp (its content), or null if absent/legacy. */
function readRecordedVersion(stamp: string): string | null {
  try {
    const content = readFileSync(stamp, "utf-8").trim();
    return SEMVER_RE.test(content) ? content : null;
  } catch {
    return null;
  }
}

/**
 * True if dotted-numeric version `a` is lower than `b` (e.g. 1.10.13 < 1.10.30).
 * Compares numeric cores segment by segment; on equal cores, a prerelease
 * (`x.y.z-...`) ranks below the plain release (build metadata after `+` is
 * ignored, per semver). Not a full prerelease-identifier ordering — sufficient
 * because the gateway ships plain releases and we only need floor/ceiling tests.
 */
function versionLessThan(a: string, b: string): boolean {
  const core = (v: string): number[] =>
    (v.split(/[-+]/)[0] ?? v).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const isPrerelease = (v: string): boolean => (v.split("+")[0] ?? v).includes("-");
  const pa = core(a);
  const pb = core(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  // Equal numeric cores: a prerelease ranks below a plain release.
  const preA = isPrerelease(a);
  const preB = isPrerelease(b);
  if (preA !== preB) return preA;
  return false;
}

/** True if `v` is within the configured [floor, max] window (max optional, inclusive). */
function withinGatewayWindow(v: string): boolean {
  if (versionLessThan(v, GATEWAY_MIN_VERSION)) return false;
  if (GATEWAY_MAX_VERSION !== null && versionLessThan(GATEWAY_MAX_VERSION, v)) return false;
  return true;
}

function applyPatches(cache: string, bun: string): number {
  const result = spawnSync(bun, [join(cache, "node_modules", "patch-package", "index.js")], {
    cwd: cache,
    stdio: ["ignore", process.stderr, "inherit"],
  });
  return result.status ?? 1;
}

/**
 * Float the gateway, overlaying the runtime root's node_modules via `bun add
 * --no-save` so the read-only package.json / bun.lock are never written — only
 * the gateway moves; every other dep stays at its locked version.
 *
 * Resolution order:
 *   1. COPILOT_API_VERSION set  -> pin exactly that, cooldown bypassed.
 *   2. default                  -> newest release in [GATEWAY_MIN_VERSION,
 *                                  GATEWAY_MAX_VERSION] and >=7 days old (bunfig
 *                                  cooldown). Floats forward as releases age in,
 *                                  never below the floor or above the cap.
 *   3. (2) finds nothing yet    -> pin exactly GATEWAY_MIN_VERSION, cooldown
 *                                  bypassed, so the floor is always available.
 *
 * The resolved version is recorded in the `.gateway-checked` stamp (its content
 * is the version; its mtime is the weekly throttle). A registry re-resolution
 * runs only when forced (a baseline (re)install just happened), the gateway is
 * missing, no version is recorded yet, the recorded version falls outside the
 * [floor, max] window, or the last check was over a week ago. Otherwise it
 * self-heals: if the installed gateway drifted from the recorded target (e.g. a
 * plain `bun install` reinstalled a different release into the same node_modules),
 * it pins that exact version back + repatches. Offline policy: if a refresh fails
 * but a >=floor gateway is installed, we warn, keep it, and back off; if only a
 * sub-floor (or no) gateway is available, we fail loudly rather than run an
 * out-of-contract gateway.
 */
function floatGateway(cache: string, bun: string, force: boolean): void {
  const stamp = join(cache, ".gateway-checked");
  const present = gatewayInstalled(cache);
  const override = process.env[GATEWAY_VERSION_ENV]?.trim();

  // Misconfiguration guard: a ceiling below the floor can never be satisfied.
  if (GATEWAY_MAX_VERSION !== null && versionLessThan(GATEWAY_MAX_VERSION, GATEWAY_MIN_VERSION)) {
    die(
      `GATEWAY_MAX_VERSION (${GATEWAY_MAX_VERSION}) is below GATEWAY_MIN_VERSION (${GATEWAY_MIN_VERSION})`,
    );
  }

  const run = (spec: string, bypassCooldown: boolean, quiet = false): number => {
    const args = ["add", `${GATEWAY_PKG}@${spec}`, "--no-save", "--ignore-scripts"];
    if (bypassCooldown) {
      args.push("--minimum-release-age=0");
    }
    const result = spawnSync(bun, args, {
      cwd: cache,
      // Route bun's stdout to our stderr so it doesn't pollute the cache-path
      // capture in the bin shims (`CACHE="$(...)"`). `quiet` captures stderr so
      // an *expected* failure (e.g. the cooldown blocking the >=floor probe)
      // stays silent; we re-emit it only when the error is unexpected.
      stdio: ["ignore", process.stderr, quiet ? "pipe" : "inherit"],
    });
    if (quiet && result.status !== 0) {
      const err = result.stderr?.toString() ?? "";
      // The cooldown blocking the probe is the normal "nothing aged in yet"
      // case — swallow it. Surface anything else (real network/registry errors).
      if (!err.includes("minimum-release-age")) {
        process.stderr.write(err);
      }
    }
    const status = result.status ?? 1;
    return status === 0 ? applyPatches(cache, bun) : status;
  };

  if (override) {
    // An exact pin already installed is a no-op (dist-tags always re-resolve).
    if (SEMVER_RE.test(override) && installedGatewayVersion(cache) === override) {
      return;
    }
    process.stderr.write(`==> Pinning ${GATEWAY_PKG}@${override} (cooldown bypassed) ...\n`);
    const code = run(override, true);
    if (code !== 0 && !present) {
      die(`failed to install ${GATEWAY_PKG}@${override} (exit ${code})`);
    }
    if (code !== 0) {
      process.stderr.write(
        `user-cache: WARNING: could not pin ${GATEWAY_PKG}@${override} (offline?); using installed version\n`,
      );
    }
    return; // override never stamps — next unset run should re-check immediately
  }

  // Re-resolve from the registry only when forced (a baseline (re)install just
  // happened), the gateway is missing, no target is recorded yet, or the weekly
  // stamp has aged out. Otherwise we hold the recorded target and self-heal.
  const recorded = readRecordedVersion(stamp);
  let due = force || !present || recorded === null;
  // Re-resolve if the recorded target now falls outside the [floor, max] window
  // (e.g. the floor was raised, or a ceiling added/lowered, since it was recorded).
  if (!due && recorded !== null && !withinGatewayWindow(recorded)) {
    due = true;
  }
  if (!due) {
    try {
      due = Date.now() - statSync(stamp).mtimeMs > GATEWAY_CHECK_INTERVAL_MS;
    } catch {
      due = true; // no stamp yet — check now
    }
  }

  // Target range: >=floor, and <=max when a ceiling is configured.
  const rangeSpec = GATEWAY_MAX_VERSION
    ? `>=${GATEWAY_MIN_VERSION} <=${GATEWAY_MAX_VERSION}`
    : `>=${GATEWAY_MIN_VERSION}`;

  if (due) {
    // Newest in-range release past the 7-day cooldown. Quiet: a cooldown block
    // here just means "nothing aged in yet" and is handled below.
    process.stderr.write(
      `==> Checking ${GATEWAY_PKG} for updates (${rangeSpec}, >=7-day-old) ...\n`,
    );
    let code = run(rangeSpec, false, true);

    // Nothing in range has cleared the cooldown yet — guarantee the floor itself.
    // Quiet too: if the probe already failed for a real reason (e.g. offline) it
    // printed once; the WARNING/die below conveys the final outcome.
    if (code !== 0) {
      process.stderr.write(
        `==> No ${rangeSpec} release is 7 days old yet; pinning the ${GATEWAY_MIN_VERSION} floor (cooldown bypassed) ...\n`,
      );
      code = run(GATEWAY_MIN_VERSION, true, true);
    }

    if (code === 0) {
      // Record the resolved version (content); mtime = now is the weekly
      // throttle. We hold this exact version until the next resolution.
      try {
        writeFileSync(stamp, `${installedGatewayVersion(cache) ?? GATEWAY_MIN_VERSION}\n`);
      } catch {
        // non-fatal; we just re-check on the next run
      }
      return;
    }

    // Resolution failed (e.g. offline). Never run a sub-floor gateway: if the
    // installed version is below the floor (or absent), fail loudly. Otherwise
    // keep the installed >=floor gateway; back off (re-stamp with it) when it's
    // in-window so we don't re-probe the registry on every bootstrap.
    const installedOnFail = installedGatewayVersion(cache);
    if (installedOnFail === null || versionLessThan(installedOnFail, GATEWAY_MIN_VERSION)) {
      die(
        `could not install ${GATEWAY_PKG} ${rangeSpec} (offline?) and the installed version (${installedOnFail ?? "none"}) is below the ${GATEWAY_MIN_VERSION} floor`,
      );
    }
    process.stderr.write(
      `user-cache: WARNING: could not refresh ${GATEWAY_PKG} (offline?); keeping installed ${installedOnFail}\n`,
    );
    if (withinGatewayWindow(installedOnFail)) {
      try {
        writeFileSync(stamp, `${installedOnFail}\n`);
      } catch {
        // non-fatal; we just re-check on the next run
      }
    }
    return;
  }

  // Not due: hold the recorded target. If the installed gateway drifted from it
  // (e.g. a plain `bun install` pulled a different >=7-day-old release into the
  // same node_modules), pin that exact version back + repatch — no registry
  // round-trip, since `recorded` was already vetted by a prior resolution.
  const installed = installedGatewayVersion(cache);
  if (recorded !== null && installed !== recorded) {
    process.stderr.write(
      `==> Installed ${GATEWAY_PKG}@${installed ?? "none"} != pinned ${recorded}; reinstalling + repatching ...\n`,
    );
    const code = run(recorded, true);
    if (code !== 0 && !present) {
      die(`failed to reinstall ${GATEWAY_PKG}@${recorded} (exit ${code})`);
    }
    if (code !== 0) {
      process.stderr.write(
        `user-cache: WARNING: could not reinstall ${GATEWAY_PKG}@${recorded} (offline?); using installed version\n`,
      );
    }
  }
}

/**
 * Mirror every top-level snapshot entry into the cache (symlinks or copies),
 * then prune cache entries that no longer exist in the snapshot so a removed
 * source file doesn't leave a dangling link/copy behind. Auto-discovery — new
 * top-level files become available at runtime without editing this file.
 */
function mirrorSnapshot(snap: string, cache: string, symlink: boolean): void {
  // The only exclusions are entries the cache itself owns or mustn't replace:
  //   - node_modules: written by `bun install` into the cache
  //   - .installed-from-lock: bookkeeping written by this script
  //   - .gateway-checked: weekly float timestamp written by this script
  //   - .symlink-cache: mirror-mode marker written by this script
  //   - .git: VCS metadata; symlinking would alias git operations into the
  //     snapshot's git dir. Cheap defense even if .git is unlikely to exist
  //     inside a readonly snapshot.
  const CACHE_OWNED = new Set([
    "node_modules",
    ".installed-from-lock",
    ".gateway-checked",
    SYMLINK_MARKER,
    ".git",
  ]);

  // `bun add --no-save` (the gateway float) opens package.json *writable* even
  // though it won't persist changes. A symlink to the read-only snapshot
  // therefore fails with EACCES on a genuinely read-only snapshot (e.g. cluster
  // NFS). Mirror package.json as a writable copy instead so the float can run;
  // its content is identical to the snapshot's, so the frozen baseline install
  // still agrees with bun.lock.
  const COPY_AS_WRITABLE = new Set(["package.json"]);

  const snapEntries = readdirSync(snap).filter((e) => !CACHE_OWNED.has(e));
  for (const entry of snapEntries) {
    const src = join(snap, entry);
    const dst = join(cache, entry);
    if (COPY_AS_WRITABLE.has(entry)) {
      ensureWritableCopy(src, dst);
    } else if (symlink) {
      ensureSymlink(src, dst);
    } else {
      ensureCopyTree(src, dst);
    }
  }

  const expected = new Set(snapEntries);
  for (const entry of readdirSync(cache)) {
    if (CACHE_OWNED.has(entry) || expected.has(entry)) continue;
    try {
      rmSync(join(cache, entry), { recursive: true, force: true });
    } catch {
      // best effort; stale entry is harmless
    }
  }
}

function main(): void {
  const snap = process.argv[2];
  if (!snap) die("snapshot directory required");
  const snapPkg = join(snap, "package.json");
  if (!existsSync(snapPkg)) die(`${snapPkg} not found`);

  const mode = resolveMirrorMode();
  const noFloat = process.argv.includes(NO_FLOAT_FLAG);

  // Where deps get installed / the gateway floated, and where cli.ts runs from:
  //   inplace      -> the checkout itself (no cache, no mirror)
  //   symlink/copy -> a per-user cache, with the source mirrored into it first
  let target: string;
  if (mode === "inplace") {
    target = snap;
  } else {
    target = cacheDir();
    mkdirSync(target, { recursive: true });
    // Flip the mode marker (bookkeeping: present => symlink mirror).
    const marker = join(target, SYMLINK_MARKER);
    if (mode === "symlink") {
      writeFileSync(marker, `${new Date().toISOString()}\n`);
    } else {
      rmSync(marker, { force: true });
    }
    mirrorSnapshot(snap, target, mode === "symlink");
  }

  // bun install only when the lockfile changed since the last successful install
  // (or node_modules / the gateway is missing — e.g. a fresh checkout, so the
  // frozen install restores the lockfile baseline before floatGateway upgrades
  // it; this keeps startup offline-safe even when the float can't reach the
  // registry).
  const stamp = join(target, ".installed-from-lock");
  const lock = join(snap, "bun.lock");
  const needInstall =
    !existsSync(join(target, "node_modules")) ||
    !existsSync(stamp) ||
    !filesEqual(lock, stamp) ||
    !gatewayInstalled(target);

  const bun = detectBunCmd();

  if (needInstall) {
    process.stderr.write(`==> Installing copilot-env node_modules under ${target} ...\n`);
    // Run patch-package directly below. On Windows, Bun can fail to remap the
    // postinstall bin shim even though the installed package itself is valid.
    const result = spawnSync(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: target,
      // Route bun's stdout to our stderr so it doesn't pollute the target-path
      // capture in the bin shims (`CACHE="$(...)"`).
      stdio: ["ignore", process.stderr, "inherit"],
    });
    if (result.status !== 0) {
      die(`bun install failed (exit ${result.status ?? "signal"})`);
    }
    const patchStatus = applyPatches(target, bun);
    if (patchStatus !== 0) {
      die(`patch-package failed (exit ${patchStatus})`);
    }
    copyFileSync(lock, stamp);
    try {
      chmodSync(stamp, 0o644);
    } catch {
      // Windows ignores chmod beyond read-only bit; non-fatal.
    }
  }

  // Float the gateway to the newest >=7-day-old release (unless --no-float).
  // Forced right after a baseline (re)install so a lock change can't leave us
  // on a stale pin.
  if (!noFloat) {
    floatGateway(target, bun, needInstall);
  }

  // Print the resolved target dir on stdout so launchers can `exec` into it.
  process.stdout.write(`${target}\n`);
}

main();
