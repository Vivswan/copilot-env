// Set up the per-user node_modules cache from the copilot-env source dir:
// source stays in place, deps live in a writable cache via symlinks.
//
// Cross-platform — runs on Linux, macOS, Windows. Uses only node builtins so
// it works before any dep is installed.
//
// Usage:  node cache_setup.js <snapshot-dir>
//
// (Despite the .ts extension we invoke via `bun run` or `node --experimental-strip-types`
// from the bin shims so no compile step is needed.)

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
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

// Override: set COPILOT_API_VERSION to a specific version (e.g. "1.10.30") or a
// dist-tag to pin the gateway, bypassing both the floor and the 7-day cooldown.
// Lets you adopt a fresh release immediately when you trust it. Unset = float
// per GATEWAY_MIN_VERSION above.
const GATEWAY_VERSION_ENV = "COPILOT_API_VERSION";

function die(msg: string): never {
  process.stderr.write(`cache-setup: ${msg}\n`);
  process.exit(1);
}

function ensureSymlink(target: string, link: string): void {
  // On Windows, normal users can't create symlinks. Fall back to a junction
  // (directories) or a file copy (files) when symlinkSync fails.
  try {
    if (lstatSync(link).isSymbolicLink()) {
      if (readlinkSync(link) === target) return; // already correct
    }
    unlinkSync(link);
  } catch {
    // doesn't exist yet — fine
  }

  const isDir = existsSync(target) && lstatSync(target).isDirectory();
  try {
    symlinkSync(target, link, isDir ? "junction" : "file");
  } catch {
    // Symlink creation failed (Windows w/o privilege). Copy instead.
    if (isDir) {
      cpSync(target, link, { recursive: true, force: true, dereference: false });
    } else {
      copyFileSync(target, link);
    }
  }
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

function applyPatches(cache: string, bun: string): number {
  const result = spawnSync(bun, [join(cache, "node_modules", "patch-package", "index.js")], {
    cwd: cache,
    stdio: ["ignore", process.stderr, "inherit"],
  });
  return result.status ?? 1;
}

/**
 * Float the gateway, overlaying the cache's node_modules via `bun add --no-save`
 * so the read-only symlinked package.json / bun.lock are never written — only
 * the gateway moves; every other dep stays at its locked version.
 *
 * Resolution order:
 *   1. COPILOT_API_VERSION set  -> pin exactly that, cooldown bypassed.
 *   2. default                  -> newest release >=GATEWAY_MIN_VERSION and
 *                                  >=7 days old (bunfig cooldown). Floats forward
 *                                  as newer releases age in, never below the floor.
 *   3. (2) finds nothing yet    -> pin exactly GATEWAY_MIN_VERSION, cooldown
 *                                  bypassed, so the floor is always available.
 *
 * Best-effort and throttled: the default float runs only when forced (a baseline
 * (re)install just happened), the gateway is missing, or the last check was over
 * a week ago. Offline-safe — if every attempt fails but a version is already
 * installed, we warn and keep using it rather than breaking startup.
 */
function floatGateway(cache: string, bun: string, force: boolean): void {
  const stamp = join(cache, ".gateway-checked");
  const present = gatewayInstalled(cache);
  const override = process.env[GATEWAY_VERSION_ENV]?.trim();

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
    process.stderr.write(`==> Pinning ${GATEWAY_PKG}@${override} (cooldown bypassed) ...\n`);
    const code = run(override, true);
    if (code !== 0 && !present) {
      die(`failed to install ${GATEWAY_PKG}@${override} (exit ${code})`);
    }
    if (code !== 0) {
      process.stderr.write(
        `cache-setup: WARNING: could not pin ${GATEWAY_PKG}@${override} (offline?); using installed version\n`,
      );
    }
    return; // override never stamps — next unset run should re-check immediately
  }

  let due = force || !present;
  if (!due) {
    try {
      due = Date.now() - statSync(stamp).mtimeMs > GATEWAY_CHECK_INTERVAL_MS;
    } catch {
      due = true; // no stamp yet — check now
    }
  }
  if (!due) return;

  // Newest release that is both >=floor and past the 7-day cooldown. Quiet: a
  // cooldown block here just means "nothing aged in yet" and is handled below.
  process.stderr.write(
    `==> Checking ${GATEWAY_PKG} for updates (>=${GATEWAY_MIN_VERSION}, >=7-day-old) ...\n`,
  );
  let code = run(`>=${GATEWAY_MIN_VERSION}`, false, true);

  // Nothing >=floor has cleared the cooldown yet — guarantee the floor itself.
  // Quiet too: if the probe already failed for a real reason (e.g. offline) it
  // printed once; the WARNING/die below conveys the final outcome.
  if (code !== 0) {
    process.stderr.write(
      `==> No >=${GATEWAY_MIN_VERSION} release is 7 days old yet; pinning the ${GATEWAY_MIN_VERSION} floor (cooldown bypassed) ...\n`,
    );
    code = run(GATEWAY_MIN_VERSION, true, true);
  }

  if (code === 0) {
    try {
      writeFileSync(stamp, `${new Date().toISOString()}\n`);
    } catch {
      // non-fatal; we just re-check on the next run
    }
  } else if (present) {
    process.stderr.write(
      `cache-setup: WARNING: could not refresh ${GATEWAY_PKG} (offline?); using installed version\n`,
    );
  } else {
    die(`failed to install ${GATEWAY_PKG} (exit ${code})`);
  }
}

function main(): void {
  const snap = process.argv[2];
  if (!snap) die("snapshot directory required");
  const snapPkg = join(snap, "package.json");
  if (!existsSync(snapPkg)) die(`${snapPkg} not found`);

  // Optional subcommand (forwarded by the bin shims). On `start` we refresh just
  // the gateway (drop its installed copy + the weekly stamp) so floatGateway
  // re-resolves it fresh each launch. We deliberately do NOT wipe the whole
  // cache: on a network filesystem (e.g. cluster NFS) bun can't clonefile or
  // hardlink, so wiping node_modules forces a slow byte-copy of all ~220
  // packages every start (~27s observed). Reusing the rest keeps start fast;
  // only the single gateway package is re-fetched.
  const subcommand = process.argv[3];

  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });

  if (subcommand === "start") {
    process.stderr.write("==> Refreshing gateway package ...\n");
    rmSync(join(cache, "node_modules", "@jeffreycao", "copilot-api"), {
      recursive: true,
      force: true,
    });
    rmSync(join(cache, ".gateway-checked"), { force: true });
  }

  // Mirror every snapshot top-level entry. Auto-discovery — new top-level
  // files become available at runtime without editing this file. It's fine to
  // mirror things we don't strictly need at runtime; the cost is one symlink.
  //
  // The only exclusions are entries the cache itself owns or mustn't replace:
  //   - node_modules: written by `bun install` into the cache
  //   - .installed-from-lock: bookkeeping written by this script
  //   - .gateway-checked: weekly float timestamp written by this script
  //   - .git: VCS metadata; symlinking would alias git operations into the
  //     snapshot's git dir. Cheap defense even if .git is unlikely to exist
  //     inside a readonly snapshot.
  const CACHE_OWNED = new Set(["node_modules", ".installed-from-lock", ".gateway-checked", ".git"]);

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
    } else {
      ensureSymlink(src, dst);
    }
  }

  // Prune anything in the cache that no longer exists in the snapshot, so
  // removing a file at the snapshot doesn't leave a dangling symlink behind.
  const expected = new Set(snapEntries);
  for (const entry of readdirSync(cache)) {
    if (CACHE_OWNED.has(entry) || expected.has(entry)) continue;
    try {
      rmSync(join(cache, entry), { recursive: true, force: true });
    } catch {
      // best effort; stale entry is harmless
    }
  }

  // bun install only when the lockfile changed since the last successful install
  // (or the gateway is missing — e.g. `start` just dropped it, so the frozen
  // install restores the lockfile baseline before floatGateway upgrades it; this
  // keeps `start` offline-safe even when the float can't reach the registry).
  const stamp = join(cache, ".installed-from-lock");
  const lock = join(snap, "bun.lock");
  const needInstall =
    !existsSync(join(cache, "node_modules")) ||
    !existsSync(stamp) ||
    !filesEqual(lock, stamp) ||
    !gatewayInstalled(cache);

  const bun = detectBunCmd();

  if (needInstall) {
    process.stderr.write(`==> Installing copilot-env node_modules under ${cache} ...\n`);
    // Run patch-package directly below. On Windows, Bun can fail to remap the
    // postinstall bin shim even though the installed package itself is valid.
    const result = spawnSync(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: cache,
      // Route bun's stdout to our stderr so it doesn't pollute the
      // cache-path capture in the bin shims (`CACHE="$(...)"`).
      stdio: ["ignore", process.stderr, "inherit"],
    });
    if (result.status !== 0) {
      die(`bun install failed (exit ${result.status ?? "signal"})`);
    }
    const patchStatus = applyPatches(cache, bun);
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

  // Float the gateway to the newest >=7-day-old release. Forced right after a
  // baseline (re)install so a lock change can't leave us on a stale pin.
  floatGateway(cache, bun, needInstall);

  // Print resolved cache dir on stdout so launchers can `exec` into it.
  process.stdout.write(`${cache}\n`);
}

main();
