// Apply a resolved release: swap in the new compiled binary, then let that new
// binary lay down its own runtime assets and run the due migrations. The one
// update implementation, shared by `agent update` (src/commands/update.ts) and
// the autoupdate preflight (./preflight.ts). Callers own the up-to-date /
// `--check` / dev-checkout gates.
//
// The pipeline is four ordered stages, and each one takes the token the
// previous stage produced (the tokens are branded, so they can only come from
// the real stage function). That is what makes "swapped a binary nobody
// verified" unrepresentable rather than merely untrue today:
//
//   download -> Downloaded -> verify -> Verified -> swap -> Swapped -> finalize
//
// Everything after the swap is best-effort. The instant the rename lands, the
// on-disk version has moved forward, so a later `agent update` would see "up to
// date" and never retry -- failing the update there would strand the install
// with stale assets or unrun migrations instead of fixing anything.
import { spawnSync, type StdioOptions } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";

import {
  type Checksums,
  expectedDigest,
  fileSha256,
  parseChecksums,
} from "../install/checksums.ts";
import type { Release } from "../install/resolve-release.ts";
import { currentReleaseTarget, installedBinaryName, releaseAssetName } from "../install/targets.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { stripV } from "../utils/semver.ts";

const REPO = "Vivswan/copilot-env";
const CHECKSUMS_NAME = "checksums.txt";

/** Points the download at a directory or base URL instead of the GitHub release.
 *  The same hook install.sh / install.ps1 honor, so a smoke test can drive the
 *  whole update against locally built artifacts. */
const DOWNLOAD_BASE_ENV = "COPILOT_ENV_DOWNLOAD_BASE";

/** Minimal sink so the preflight can route progress to a stderr-only logger. */
interface UpdateLogger {
  warn(message: string): void;
  success(message: string): void;
}

// Stage tokens. The brand is a module-private symbol, so no caller outside this
// file can fabricate one and skip a stage.
declare const stageBrand: unique symbol;

interface Downloaded {
  readonly [stageBrand]: "downloaded";
  /** The downloaded binary, still in the temp directory. */
  readonly path: string;
  /** Its release-asset name, i.e. the key to look up in the manifest. */
  readonly asset: string;
  readonly checksums: Checksums;
}

interface Verified {
  readonly [stageBrand]: "verified";
  readonly path: string;
  readonly sha256: string;
}

interface Swapped {
  readonly [stageBrand]: "swapped";
  /** The live binary path -- the one to spawn for the post-swap stages. */
  readonly path: string;
}

/** Where to fetch a release file from: a local directory or a URL prefix. */
type DownloadSource =
  | { kind: "directory"; path: string }
  | { kind: "url"; base: string };

function downloadSource(tag: string): DownloadSource {
  const override = process.env[DOWNLOAD_BASE_ENV];
  if (override) {
    // A directory override is what CI and the installer e2e use; anything else
    // is treated as a base URL (mirrors install.sh's `[ -d ... ]` branch).
    try {
      if (Deno.statSync(override).isDirectory) return { kind: "directory", path: override };
    } catch {
      // not a path on this machine: fall through and treat it as a URL
    }
    return { kind: "url", base: override.replace(/\/+$/, "") };
  }
  return { kind: "url", base: `https://github.com/${REPO}/releases/download/${tag}` };
}

/** Fetch one release file into `dest`, streaming rather than buffering: the
 *  binaries run to tens of megabytes. */
async function fetchReleaseFile(source: DownloadSource, name: string, dest: string): Promise<void> {
  if (source.kind === "directory") {
    copyFileSync(join(source.path, name), dest);
    return;
  }
  const url = `${source.base}/${name}`;
  const res = await fetch(url, { headers: { "User-Agent": "copilot-env" } });
  if (!res.ok || !res.body) {
    throw new Error(`failed to download ${name} (HTTP ${res.status})`);
  }
  using file = await Deno.open(dest, { write: true, create: true, truncate: true });
  await res.body.pipeTo(file.writable);
}

/** Stage 1: pull this platform's binary and the release manifest into `dir`. */
async function download(tag: string, dir: string): Promise<Downloaded> {
  const target = currentReleaseTarget();
  if (!target) {
    throw new Error(
      `copilot-env ships no compiled binary for ${process.platform}/${process.arch}.`,
    );
  }
  const asset = releaseAssetName(target);
  const source = downloadSource(tag);
  const path = join(dir, asset);
  await fetchReleaseFile(source, asset, path);
  const manifest = join(dir, CHECKSUMS_NAME);
  await fetchReleaseFile(source, CHECKSUMS_NAME, manifest);
  return {
    path,
    asset,
    checksums: parseChecksums(readFileSync(manifest, "utf8")),
  } as Downloaded;
}

/** Stage 2: hash what actually landed and refuse anything the release manifest
 *  does not vouch for. */
async function verify(downloaded: Downloaded): Promise<Verified> {
  const expected = expectedDigest(downloaded.checksums, downloaded.asset);
  const actual = await fileSha256(downloaded.path);
  if (actual !== expected) {
    throw new Error(
      `SHA256 verification failed for ${downloaded.asset}: expected ${expected}, got ${actual}`,
    );
  }
  return { path: downloaded.path, sha256: actual } as Verified;
}

/** Windows aside-files from earlier updates, swept best-effort on the next run:
 *  the process that was running from one is long gone by then, but a still-open
 *  handle just leaves the file for the run after. */
function sweepSupersededBinaries(binDir: string, liveName: string): void {
  let entries: string[];
  try {
    entries = readdirSync(binDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${liveName}.old-`)) continue;
    try {
      rmSync(join(binDir, entry), { force: true });
    } catch {
      // still locked; the next update sweeps it
    }
  }
}

/**
 * Stage 3: put the verified binary at `<root>/bin/agent-bin(.exe)`.
 *
 * POSIX renames straight over the live path: the running process keeps its open
 * inode, so replacing the file underneath it is safe and atomic. Windows
 * refuses to replace a running image at all, so the live binary is renamed
 * ASIDE first (which Windows does allow) and the new one takes its place; the
 * aside copy is swept on a later run.
 */
function swap(verified: Verified, root: string): Swapped {
  const binDir = join(root, "bin");
  const liveName = installedBinaryName();
  const live = join(binDir, liveName);
  if (process.platform === "win32") {
    sweepSupersededBinaries(binDir, liveName);
    try {
      renameSync(live, join(binDir, `${liveName}.old-${Date.now()}`));
    } catch {
      // No live binary to move aside (a repaired or partial install): the
      // rename below still lands the new one.
    }
  } else {
    Deno.chmodSync(verified.path, 0o755);
  }
  renameSync(verified.path, live);
  return { path: live } as Swapped;
}

/** Run the NEW binary. Every post-swap step goes through here: the freshly
 *  installed release is the only thing that knows its own assets and its own
 *  migrations, and this process still holds the pre-update code in memory. */
function runNewBinary(
  swapped: Swapped,
  root: string,
  args: string[],
  stdio: StdioOptions,
): number | null {
  const result = spawnSync(swapped.path, args, { cwd: root, stdio });
  if (result.error) throw result.error;
  return result.status;
}

export interface ApplyUpdateOptions {
  /** Where progress/warnings go (default: the global stdout consola). */
  logger?: UpdateLogger;
  /**
   * Send the child processes' stdout to stderr (so migration output can't
   * pollute stdout). The preflight sets this to protect the `agent env` stdout
   * contract on platforms where the launcher can't redirect streams.
   */
  childStdoutToStderr?: boolean;
  /** The install root to update. Defaults to the live one. */
  root?: string;
}

export async function applyUpdate(
  current: string,
  target: Release,
  opts: ApplyUpdateOptions = {},
): Promise<void> {
  const logger = opts.logger ?? consola;
  const root = opts.root ?? PROJECT_ROOT;
  // ["ignore", 2, 2] => stdin closed, child stdout AND stderr both go to our fd2.
  const stdio: StdioOptions = opts.childStdoutToStderr ? ["ignore", 2, 2] : "inherit";

  // Stage the download beside the install root, not in the system temp dir:
  // the swap is a rename, and a rename only works within one filesystem.
  const staging = mkdtempSync(join(root, ".update-"));
  let swapped: Swapped;
  try {
    swapped = swap(await verify(await download(target.tag, staging)), root);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // Lay down the new release's runtime assets (shell payload, proxy-token
  // scripts, skills, the deno config the daemon spawn reads). Without this an
  // updated install would run the previous release's files.
  if (runNewBinary(swapped, root, ["install", "--assets-only"], stdio) !== 0) {
    logger.warn("Refreshing the installed runtime files reported a problem; see the output above.");
  }

  if (
    runNewBinary(swapped, root, ["__migrate", stripV(current), stripV(target.tag)], stdio) !== 0
  ) {
    logger.warn("Post-update migrations reported a problem; see the output above.");
  }

  logger.success(
    `Updated copilot-env ${current} -> ${target.tag}. Restart your agents to pick it up.`,
  );
}
