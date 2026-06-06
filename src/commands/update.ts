import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consola } from "consola";
import { extract as tarExtract } from "tar";
import { resolveTarget } from "../install/resolve-release.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";

// `agent update` brings the checkout up to the newest GitHub release WITHOUT git:
//  - discovery (which release, and its tarball URL) is resolveTarget() from
//    ../install/resolve-release.ts -- the SAME module the installers download + run,
//    so the release-pick logic has one home. Then
//  - apply downloads that release's `tarball_url` and SYNCS it onto the checkout:
//    tracked files are replaced, files the release no longer ships (and OS junk)
//    are pruned, and node_modules/.git are preserved; then `bun install`.

/** Current version from package.json (release-please-maintained), as `vX.Y.Z`. */
function currentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as {
    version?: unknown;
  };
  return `v${typeof pkg.version === "string" ? pkg.version : "0.0.0"}`;
}

const stripV = (v: string): string => v.replace(/^v/, "");

// Files that live in the checkout but are NOT shipped in a release: keep them across
// an update. node_modules is restored by `bun install`; .git is the clone's VCS dir.
// Everything else under the checkout is release-tracked source, so the sync may prune
// it -- removing files a new release dropped, plus OS junk (.DS_Store, Thumbs.db).
const PRESERVE = new Set([".git", "node_modules"]);

// A complete release tree contains these. node-tar warns-and-SKIPS unrecoverable
// entries rather than failing, so we verify the extract before the destructive sync:
// a partial tree must never be allowed to prune the live checkout.
const REQUIRED_FILES = ["package.json", "bun.lock", "bin/agent", "src/cli.ts"];

/** True only if `p` is a real directory (NOT a symlink to one). Uses lstat so the
 *  sync never recurses through a link that points outside the checkout. */
const isRealDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Make `dest` mirror `src` exactly: replace tracked files, recurse into dirs, and
 *  delete anything in `dest` not in `src` -- except `keep` names at the top level.
 *  Symlinks are copied verbatim (not dereferenced). */
function mirror(src: string, dest: string, keep: Set<string>): void {
  const srcEntries = readdirSync(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));
  for (const name of readdirSync(dest)) {
    if (keep.has(name) || srcNames.has(name)) continue;
    rmSync(join(dest, name), { recursive: true, force: true }); // dropped file or OS junk
  }
  for (const entry of srcEntries) {
    if (keep.has(entry.name)) continue; // never copy over a preserved name (node_modules/.git)
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      // Anything but a real dir in the way (a file, or a symlink -- even one to a
      // dir) is removed first, so recursion stays inside the checkout.
      if (!isRealDir(d)) rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
      mirror(s, d, new Set()); // the preserve list only applies at the checkout root
    } else {
      rmSync(d, { recursive: true, force: true });
      cpSync(s, d, { dereference: false }); // copy files and symlinks verbatim
    }
  }
}

/** Download the release's source tarball (URL from the API) and sync it onto the
 *  checkout. Extraction uses the `tar` lib (gzip + symlinks, cross-platform). */
async function applyRelease(tarballUrl: string): Promise<void> {
  const res = await fetch(tarballUrl, { headers: { "User-Agent": "copilot-env" } });
  if (!res.ok) throw new Error(`failed to download release tarball (HTTP ${res.status})`);

  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-update-"));
  try {
    const tarball = join(tmp, "release.tar.gz");
    writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));
    const tree = join(tmp, "tree");
    mkdirSync(tree, { recursive: true });
    // strip:1 drops the `Vivswan-copilot-env-<sha>/` wrapper dir.
    await tarExtract({ file: tarball, cwd: tree, strip: 1 });
    for (const required of REQUIRED_FILES) {
      if (!existsSync(join(tree, required))) {
        throw new Error(`release tarball is incomplete (missing ${required}); update aborted`);
      }
    }
    mirror(tree, PROJECT_ROOT, PRESERVE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runUpdate(args: {
  check?: boolean;
  cooldown?: boolean;
  cooldownDays?: string;
  force?: boolean;
}): Promise<void> {
  let cooldownDays: number | null = null;
  if (args.cooldown) {
    const raw = args.cooldownDays ?? "7";
    if (!/^\d+$/.test(raw)) {
      throw new Error(`--cooldown-days must be a non-negative whole number (got '${raw}')`);
    }
    cooldownDays = Number.parseInt(raw, 10);
  }

  const current = currentVersion();
  const target = await resolveTarget(cooldownDays);
  if (!target) {
    consola.warn("No copilot-env release found upstream (or the network is unavailable).");
    process.exitCode = 2; // distinct from "update available" (1) and "up to date" (0)
    return;
  }

  if (!versionLessThan(stripV(current), stripV(target.tag))) {
    consola.success(`copilot-env is up to date (${current}).`);
    return;
  }

  consola.info(`Update available: ${current} -> ${target.tag}`);
  if (args.check) {
    process.exitCode = 1; // an update is available
    return;
  }

  // The sync overwrites/prunes the checkout in place. A `.git` dir means this is a git
  // checkout (a dev/manual clone, not a tarball install) that may hold uncommitted or
  // untracked work -- refuse unless --force so an update can't silently destroy it.
  // (existsSync is a file probe, not a git command; tarball installs have no .git and
  // update freely.)
  if (!args.force && existsSync(join(PROJECT_ROOT, ".git"))) {
    throw new Error(
      "this is a git checkout (.git present) and `agent update` overwrites files in place; " +
        "commit or stash your changes and re-run with --force (or update via git).",
    );
  }

  consola.start(`Updating copilot-env ${current} -> ${target.tag} ...`);
  await applyRelease(target.tarballUrl);

  // Refresh deps for the new release (HUSKY=0 mirrors the bin shims).
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  if (install.status !== 0) throw new Error("bun install failed after update");

  consola.success(
    `Updated copilot-env ${current} -> ${target.tag}. Restart your agents to pick it up.`,
  );
}
