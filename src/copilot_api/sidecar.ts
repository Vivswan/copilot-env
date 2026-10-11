// Which `deno` binary copilot-env's proxy work runs on, and how a deno-less machine gets one. The
// CLI itself runs on Bun; the proxy daemon runs on this sidecar, with the preload shims under
// src/scripts/.
//   SIDECAR_DENO_VERSION  -> the TESTED REFERENCE version alone (copilot-env.config: what CI runs
//                            the daemon tests on, what health compares a found deno against);
//                            nothing here installs it
//   no sha256 expected    -> a REFUSAL, never a skip; the archive is hashed as it streams, so an
//                            unverified byte never lands unpacked
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join } from "node:path";
import { currentReleaseTarget, RELEASE_TARGETS, type ReleaseTarget } from "../install/targets.ts";
import { isStandaloneBinary } from "../utils/root.ts";
import { resolveExecutablePath } from "../utils/command.ts";
import { sha256Hex } from "../utils/digest.ts";
import { errMessage } from "../utils/error.ts";
import { readSidecarDenoVersion } from "../utils/project_config.ts";
import { isStableVersion, versionLessThan } from "../utils/semver.ts";
import * as fs from "../utils/fs_facade.ts";
import { resolveRootHome } from "./paths.ts";

/** Set by the compiled launcher. */
export const SIDECAR_DENO_ENV = "COPILOT_ENV_SIDECAR_DENO";

/** Only `parseAbsolutePath` mints one, so holding the type is the proof: no sidecar state can carry a
 *  relative path that would silently resolve against a drifting cwd. */
export type AbsolutePath = string & {
  // biome-ignore lint/style/useNamingConvention: the dunder phantom key is the branded-type convention; it never exists at runtime
  readonly __brand: "AbsolutePath";
};

export function parseAbsolutePath(path: string): AbsolutePath {
  const trimmed = path.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    throw new Error(`expected an absolute path, got '${trimmed}'`);
  }
  return trimmed as AbsolutePath;
}

/** The override is the documented recovery hatch and outranks every discovery. */
function sidecarOverride(
  env: Record<string, string | undefined>,
): { kind: "override"; denoBin: AbsolutePath } | null {
  const override = env[SIDECAR_DENO_ENV]?.trim();
  if (override) return { "kind": "override", "denoBin": parseAbsolutePath(override) };
  return null;
}

/**
 * `rootHome` defaults to the resolved root so every bare call site (the daemon spawn, the proxy float)
 * finds the sidecar an install provisioned there. The sidecar exists because the CLI's own runtime
 * is Bun: nothing in this process can warm the float's cache or spawn the proxy, checkout and
 * compiled binary alike.
 */
export function resolveDenoBin(
  env: Record<string, string | undefined> = process.env,
  rootHome: string = resolveRootHome(),
  opts: Omit<SidecarDetectOptions, "env"> = {},
): AbsolutePath {
  const state = detectSidecar(rootHome, { ...opts, "env": env });
  if (state.kind !== "absent") return state.denoBin;
  throw new Error(
    `no usable deno binary: no deno is on PATH, and no sidecar is provisioned. Install deno ` +
      `(https://deno.com), run \`agent start\` to provision one, or set ${SIDECAR_DENO_ENV} to ` +
      `a deno binary.`,
  );
}

export function sidecarBinPath(
  rootHome: string,
  version: string,
  platform: string = process.platform,
): string {
  return join(rootHome, "deno", version, platform === "win32" ? "deno.exe" : "deno");
}

/** Precedence is detectSidecar's; the user's PATH deno always beats a provisioned one.
 *    override     -> COPILOT_ENV_SIDECAR_DENO
 *    path         -> a deno on PATH
 *    provisioned  -> the newest `<rootHome>/deno/<x.y.z>/` from an earlier download
 *    absent       -> ensureSidecar downloads the LATEST release */
type SidecarState =
  | { kind: "override"; denoBin: AbsolutePath }
  | { kind: "path"; denoBin: AbsolutePath }
  | { kind: "provisioned"; denoBin: AbsolutePath; version: string }
  | { kind: "absent" };

interface SidecarDetectOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** An ABSOLUTE path, or null. */
  findDeno?: () => string | null;
}

export function detectSidecar(
  rootHome: string,
  opts: SidecarDetectOptions = {},
): SidecarState {
  const env = opts.env ?? process.env;
  const override = sidecarOverride(env);
  if (override !== null) return override;
  const findDeno = opts.findDeno ?? (() => resolveExecutablePath("deno"));
  const onPath = findDeno();
  if (onPath !== null) return { "kind": "path", "denoBin": parseAbsolutePath(onPath) };
  return provisionedSidecar(rootHome, opts.platform) ?? { "kind": "absent" };
}

/** Highest version wins, so a copy provisioned under an older release stays usable and a fresh
 *  download supersedes it without any cleanup step. */
export function provisionedSidecar(
  rootHome: string,
  platform: string = process.platform,
): Extract<SidecarState, { kind: "provisioned" }> | null {
  let entries: string[];
  try {
    entries = fs.readdir(join(rootHome, "deno"));
  } catch {
    return null;
  }
  const best = entries
    .filter(isStableVersion)
    .filter((version) => fs.exists(sidecarBinPath(rootHome, version, platform)))
    .sort((a, b) => versionLessThan(a, b) ? 1 : versionLessThan(b, a) ? -1 : 0)[0];
  if (best === undefined) return null;
  return {
    "kind": "provisioned",
    "denoBin": parseAbsolutePath(sidecarBinPath(rootHome, best, platform)),
    "version": best,
  };
}

/** One x.y.z line, as the latest-release endpoint and the project config both carry it. */
export function parseDenoVersionLine(content: string, source: string): string {
  const trimmed = content.trim();
  if (!isStableVersion(trimmed)) {
    throw new Error(
      `${source}: expected a single x.y.z Deno version line, got '${trimmed.slice(0, 64)}'`,
    );
  }
  return trimmed;
}

/** Deno names its release archives by the same rust triples copilot-env's own binaries carry
 *  (src/install/targets.ts), and ships one for every platform copilot-env does, so the release
 *  target table is the one owner of the mapping. */
type DenoReleaseTarget = ReleaseTarget["triple"];

export function denoReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): DenoReleaseTarget {
  const target = currentReleaseTarget(platform, arch);
  if (target === null) {
    throw new Error(
      `no Deno sidecar build for ${platform}-${arch} (supported: ${
        RELEASE_TARGETS.map((known) => `${known.os}-${known.arch}`).join(", ")
      })`,
    );
  }
  return target.triple;
}

/** Always a .zip; the Windows one contains deno.exe. */
export function denoReleaseUrl(version: string, target: DenoReleaseTarget): string {
  return `https://github.com/denoland/deno/releases/download/v${version}/deno-${target}.zip`;
}

/** One "v2.x.y" line. */
export const DENO_LATEST_URL = "https://dl.deno.land/release-latest.txt";

/** A malformed 200 body fails inside the same wrapper as a dead endpoint, so every arm carries the
 *  recovery guidance a deno-less machine needs. */
export async function fetchLatestDenoVersion(fetchLike: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchLike(DENO_LATEST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    return parseDenoVersionLine(body.replace(/^\s*v/, ""), DENO_LATEST_URL);
  } catch (e) {
    throw new Error(
      `could not resolve the latest deno release from ${DENO_LATEST_URL} (${errMessage(e)}): ` +
        `install deno yourself (https://deno.com), or set ${SIDECAR_DENO_ENV} to a deno binary`,
    );
  }
}

/**
 * The release publishes `<asset>.sha256sum` in two formats; the first 64-hex-digit token serves both.
 *   POSIX targets    -> `<hex>  <file>` (sha256sum)
 *   Windows targets  -> `Hash : <HEX>` (Get-FileHash)
 */
export async function fetchReleaseSha256(
  version: string,
  target: DenoReleaseTarget,
  fetchLike: typeof fetch = fetch,
): Promise<string> {
  const url = `${denoReleaseUrl(version, target)}.sha256sum`;
  const response = await fetchLike(url);
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  const digest = /\b[0-9a-fA-F]{64}\b/.exec(text)?.[0];
  if (digest === undefined) {
    throw new Error(`${url} did not yield a sha256 (got '${text.trim().slice(0, 40)}')`);
  }
  return digest.toLowerCase();
}

/** Windows always ships bsdtar, which reads zip archives; POSIX `unzip` is present on macOS and a hard
 *  requirement on Linux hosts. */
export function unzipCommand(
  zipPath: string,
  destDir: string,
  platform: string = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { "command": "tar", "args": ["-xf", zipPath, "-C", destDir] };
  }
  return { "command": "unzip", "args": ["-o", "-q", zipPath, "-d", destDir] };
}

interface UnzipRunResult {
  status: number;
  stderr: string;
}

interface SidecarDownloadSeams {
  fetchLike?: typeof fetch;
  runner?: (command: string, args: string[]) => UnzipRunResult | Promise<UnzipRunResult>;
  platform?: string;
  arch?: string;
}

function defaultUnzipRunner(command: string, args: string[]): UnzipRunResult {
  const result = spawnSync(command, args, { "stdio": ["ignore", "ignore", "pipe"] });
  return { "status": result.status ?? 1, "stderr": result.stderr?.toString() ?? "" };
}

/** pipeTo closes the file with the stream, on success and on abort alike. */
async function writeStreamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  await stream.pipeTo(await fs.openWritable(path));
}

/**
 * The response is teed so the bytes on disk are exactly the bytes hashed. An `undefined`
 * `expectedSha256` (no expectation known) is a REFUSAL, not a skip: an unverifiable binary is never downloaded.
 */
export async function downloadSidecar(
  version: string,
  rootHome: string,
  expectedSha256: string | undefined,
  seams: SidecarDownloadSeams = {},
): Promise<AbsolutePath> {
  const platform = seams.platform ?? process.platform;
  const target = denoReleaseTarget(platform, seams.arch ?? process.arch);
  if (expectedSha256 === undefined) {
    throw new Error(
      `no sha256 for deno v${version} (${target}); refusing to download an unverifiable binary`,
    );
  }
  const fetchLike = seams.fetchLike ?? fetch;
  const url = denoReleaseUrl(version, target);
  const response = await fetchLike(url);
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error(`download failed for ${url}: empty response body`);
  }

  const destDir = join(rootHome, "deno", version);
  fs.mkdir(destDir);
  // Scratch sits beside the destination (one filesystem, so the final placement is a rename): only a
  // verified, fully extracted binary ever appears at the sidecar path.
  const scratch = fs.scratchDir(join(destDir, ".download-"));
  const zipPath = join(scratch, `deno-${target}.zip`);
  try {
    const [toDisk, toHash] = response.body.tee();
    const [actual] = await Promise.all([sha256Hex(toHash), writeStreamToFile(toDisk, zipPath)]);
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `sha256 mismatch for ${url}: expected ${expectedSha256.toLowerCase()}, got ${actual}; refusing to install`,
      );
    }

    const { command, args } = unzipCommand(zipPath, scratch, platform);
    const runner = seams.runner ?? defaultUnzipRunner;
    const result = await runner(command, args);
    if (result.status !== 0) {
      throw new Error(
        `could not extract ${zipPath} with ${command}: exit ${result.status}${
          result.stderr.trim() ? `: ${result.stderr.trim()}` : ""
        }`,
      );
    }

    const bin = sidecarBinPath(rootHome, version, platform);
    const extracted = join(scratch, basename(bin));
    if (!fs.exists(extracted)) {
      throw new Error(`extraction of ${zipPath} did not produce ${extracted}`);
    }
    fs.rename(extracted, bin);
    if (platform !== "win32") {
      fs.chmod(bin, 0o755);
    }
    return parseAbsolutePath(bin);
  } finally {
    fs.removeScratchDir(scratch);
  }
}

/**
 * Downloads only when nothing resolves at all; a PATH deno and an earlier provisioned copy answer
 * without the network. Errors propagate: an install with no deno cannot start the proxy, so failing
 * loudly here beats an opaque spawn failure later.
 */
export async function ensureSidecar(
  rootHome: string,
  seams: SidecarDownloadSeams & Pick<SidecarDetectOptions, "findDeno"> = {},
): Promise<AbsolutePath> {
  const { findDeno, ...download } = seams;
  const state = detectSidecar(rootHome, { "platform": download.platform, "findDeno": findDeno });
  if (state.kind !== "absent") return state.denoBin;
  const fetchLike = download.fetchLike ?? fetch;
  const version = await fetchLatestDenoVersion(fetchLike);
  const target = denoReleaseTarget(
    download.platform ?? process.platform,
    download.arch ?? process.arch,
  );
  const sha256 = await fetchReleaseSha256(version, target, fetchLike);
  return await downloadSidecar(version, rootHome, sha256, download);
}

function denoBinaryVersion(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], {
    "encoding": "utf8",
    "stdio": ["ignore", "pipe", "ignore"],
    "windowsHide": true,
    "timeout": 5000,
  });
  if (result.error || result.status !== 0) return null;
  return /^deno (\S+)/.exec(result.stdout ?? "")?.[1] ?? null;
}

export interface SidecarStatus {
  kind: SidecarState["kind"];
  /** The TESTED REFERENCE version (SIDECAR_DENO_VERSION, what CI runs the daemon tests on). */
  referenceVersion: string;
  denoBin: string | null;
  /** The provisioned dir's name, or `deno --version` for a path/override binary (null when it
   *  could not be read). */
  version: string | null;
  /** True when the running process is a compiled binary: no node_modules exists to read an
   *  installed proxy version from, so the proxy runs only once floated. */
  standalone: boolean;
}

/** Never downloads: health reports, it does not provision. `denoVersionOf` is the test seam. */
export function sidecarStatus(
  rootHome: string,
  denoVersionOf: (bin: string) => string | null = denoBinaryVersion,
): SidecarStatus {
  const referenceVersion = readSidecarDenoVersion();
  const state = detectSidecar(rootHome);
  return {
    "kind": state.kind,
    "referenceVersion": referenceVersion,
    "denoBin": state.kind === "absent" ? null : state.denoBin,
    "version": state.kind === "absent"
      ? null
      : state.kind === "provisioned"
      ? state.version
      : denoVersionOf(state.denoBin),
    "standalone": isStandaloneBinary(),
  };
}
