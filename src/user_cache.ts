// Prepare copilot-env's node_modules so cli.ts can run, then print (on stdout)
// the directory cli.ts should be run from. This file is intentionally independent
// of the gateway float (src/gateway_float.ts): it only mirrors the source into a
// per-user cache when asked, then runs `bun install`. The float runs as that
// install's *postinstall* hook (src/gateway_float.ts), so the two never import
// each other — the install is the only handoff.
//
// Three mirror modes, chosen by flag (default = no cache):
//   (no flag)      in-place: install directly in the source checkout and run
//                  cli.ts from there. No cache, no mirror.
//   --symlink      mirror the source into a per-user cache as symlinks, then
//                  install in the cache (macOS + Linux).
//   --copy         mirror the source into the cache as real copies, then install
//                  in the cache (works on every OS).
//   --local-cache  pick per-OS: --symlink on macOS/Linux, --copy on Windows.
//
// `bun install` runs on every invocation (not gated on a stamp) so its postinstall
// gateway float fires each time — the float self-throttles its registry re-check
// via the weekly `.gateway-checked` stamp. Scripts stay enabled (no
// --ignore-scripts) so postinstall runs; HUSKY=0 keeps husky's `prepare` from
// reinstalling git hooks on every call.
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
// Usage:  bun run user_cache.ts <snapshot-dir> [--symlink|--copy|--local-cache]
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

// Mirror-mode flags. Default (no flag) = no cache: install directly in the source
// checkout and run cli.ts from there. The flags opt into a separate per-user
// cache instead:
//   --symlink      mirror the source into the cache as symlinks (macOS + Linux)
//   --copy         mirror the source into the cache as real copies (any OS)
//   --local-cache  pick per-OS: --symlink on macOS/Linux, --copy on Windows
const SYMLINK_FLAG = "--symlink";
const COPY_FLAG = "--copy";
const LOCAL_CACHE_FLAG = "--local-cache";

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

/**
 * Mirror every top-level snapshot entry into the cache (symlinks or copies),
 * then prune cache entries that no longer exist in the snapshot so a removed
 * source file doesn't leave a dangling link/copy behind. Auto-discovery — new
 * top-level files become available at runtime without editing this file.
 */
function mirrorSnapshot(snap: string, cache: string, symlink: boolean): void {
  // The only exclusions are entries the cache itself owns or mustn't replace:
  //   - node_modules: written by `bun install` into the cache
  //   - .gateway-checked: weekly float timestamp written by the postinstall float
  //   - .symlink-cache: mirror-mode marker written by this script
  //   - .git: VCS metadata; symlinking would alias git operations into the
  //     snapshot's git dir. Cheap defense even if .git is unlikely to exist
  //     inside a readonly snapshot.
  const CACHE_OWNED = new Set(["node_modules", ".gateway-checked", SYMLINK_MARKER, ".git"]);

  // `bun add --no-save` (the postinstall gateway float) opens package.json
  // *writable* even though it won't persist changes. A symlink to the read-only
  // snapshot therefore fails with EACCES on a genuinely read-only snapshot (e.g.
  // cluster NFS). Mirror package.json as a writable copy instead so the float can
  // run; its content is identical to the snapshot's, so the frozen baseline
  // install still agrees with bun.lock.
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

  // Where deps get installed / the gateway floats, and where cli.ts runs from:
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

  const bun = detectBunCmd();

  // Always run a frozen install so `bun install`'s postinstall (the gateway float
  // in src/gateway_float.ts) fires on every invocation; --frozen-lockfile keeps
  // the committed bun.lock authoritative (no re-resolution, no lock rewrite).
  // Scripts stay enabled (no --ignore-scripts) so postinstall runs; HUSKY=0 keeps
  // husky's `prepare` from reinstalling git hooks on every call.
  process.stderr.write(`==> Installing copilot-env node_modules under ${target} ...\n`);
  const result = spawnSync(bun, ["install", "--frozen-lockfile"], {
    cwd: target,
    env: { ...process.env, HUSKY: "0" },
    // Route bun's stdout (and its postinstall children's) to our stderr so it
    // doesn't pollute the target-path capture in the bin shims (`CACHE="$(...)"`).
    stdio: ["ignore", process.stderr, "inherit"],
  });
  if (result.status !== 0) {
    die(`bun install failed (exit ${result.status ?? "signal"})`);
  }

  // Print the resolved target dir on stdout so launchers can `exec` into it.
  process.stdout.write(`${target}\n`);
}

main();
