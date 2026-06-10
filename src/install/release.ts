// Release applier: downloads, verifies, extracts, and mirrors a GitHub source archive.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract as tarExtract, list as tarList } from "tar";
import { PROJECT_ROOT } from "../utils/root.ts";
import { verifySourceArchiveEntry, verifySourceArchiveSha256 } from "./verify-source-archive.ts";

// Files that live in the checkout but are NOT shipped in a release: keep them across
// an update. node_modules is restored by `bun install`; .git is the clone's VCS dir;
// .autoupdate holds the opt-in autoupdate state/lock, which must survive the very
// update it triggers. Everything else under the checkout is release-tracked source, so
// the sync may prune it -- removing files a new release dropped, plus OS junk.
const PRESERVE = new Set([".git", "node_modules", ".autoupdate"]);

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

async function verifySourceArchive(
  file: string,
  expectedSha: string,
  expectedSha256: string | null,
): Promise<void> {
  if (expectedSha256) verifySourceArchiveSha256(file, expectedSha256);
  let firstEntry: string | null = null;
  await tarList({
    file,
    onReadEntry: (entry) => {
      firstEntry ??= entry.path;
    },
  });
  if (!firstEntry) throw new Error("release archive is empty; update aborted");
  verifySourceArchiveEntry(firstEntry, expectedSha);
}

/** Download the release's source tarball (URL from the API), verify its SHA256
 *  digest when available plus its source SHA marker, and sync it onto the checkout.
 *  Extraction uses the `tar` lib (gzip + symlinks, cross-platform). */
export async function applyRelease(
  tarballUrl: string,
  sourceSha: string,
  sourceSha256: string | null = null,
): Promise<void> {
  const res = await fetch(tarballUrl, { headers: { "User-Agent": "copilot-env" } });
  if (!res.ok) throw new Error(`failed to download release archive (HTTP ${res.status})`);

  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-update-"));
  try {
    const tarball = join(tmp, "release.tar.gz");
    writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));
    await verifySourceArchive(tarball, sourceSha, sourceSha256);
    const tree = join(tmp, "tree");
    mkdirSync(tree, { recursive: true });
    // strip:1 drops the `Vivswan-copilot-env-<sha>/` wrapper dir.
    await tarExtract({ file: tarball, cwd: tree, strip: 1 });
    for (const required of REQUIRED_FILES) {
      if (!existsSync(join(tree, required))) {
        throw new Error(`release archive is incomplete (missing ${required}); update aborted`);
      }
    }
    mirror(tree, PROJECT_ROOT, PRESERVE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
