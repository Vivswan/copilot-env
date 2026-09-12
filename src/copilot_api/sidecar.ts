// Which `deno` binary copilot-env's own subprocess work runs on, and how a deno-less machine gets one.
//   .dvmrc              -> the TESTED REFERENCE version alone (what CI runs on, what health compares a PATH deno against); nothing here installs it
//   no sha256 expected  -> a REFUSAL, never a skip; the archive is hashed as it streams, so an unverified byte never lands unpacked
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { ASSET_ROOT, devDenoExecPath, isStandaloneBinary } from "../utils/root.ts";
import { resolveExecutablePath } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import {
  chmodReported,
  mkdirReported,
  removeScratchDir,
  renameReported,
  scratchDir,
} from "../utils/report_write.ts";
import { resolveRootHome } from "./paths.ts";
import { crypto } from "@std/crypto";

/** Set by the compiled launcher. */
export const SIDECAR_DENO_ENV = "COPILOT_ENV_SIDECAR_DENO";

export const DVMRC_FILENAME = ".dvmrc";

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

/**
 * The ONE owner of the fast-path order: the override (the documented recovery hatch), then our own
 * runtime binary when it is a real deno. A checkout's subprocesses must run on the SAME deno as the
 * parent, which is why dev outranks even a PATH deno.
 */
function sidecarFastPath(
  env: Record<string, string | undefined>,
  runtimeExecPath: string | null | undefined,
): { kind: "override" | "dev"; denoBin: AbsolutePath } | null {
  const override = env[SIDECAR_DENO_ENV]?.trim();
  if (override) return { "kind": "override", "denoBin": parseAbsolutePath(override) };
  const exec = runtimeExecPath === undefined ? devDenoExecPath() : runtimeExecPath;
  if (exec !== null) return { "kind": "dev", "denoBin": parseAbsolutePath(exec) };
  return null;
}

/**
 * `rootHome` defaults to the resolved root so every bare call site (the daemon spawn, the proxy float,
 * the device-flow login) finds the sidecar a compiled install provisioned there. The standalone case
 * is why the sidecar exists: a compiled binary IS a deno runtime but not a deno CLI, so it can neither
 * warm the float's cache nor spawn the proxy.
 */
export function resolveDenoBin(
  env: Record<string, string | undefined> = process.env,
  rootHome: string = resolveRootHome(),
  opts: Omit<SidecarDetectOptions, "env"> = {},
): AbsolutePath {
  const state = detectSidecar(rootHome, { ...opts, "env": env });
  if (state.kind !== "absent") return state.denoBin;
  throw new Error(
    `no usable deno binary: this is a compiled build, no deno is on PATH, and no sidecar ` +
      `is provisioned. Install deno (https://deno.com), run \`agent start\` to provision ` +
      `one, or set ${SIDECAR_DENO_ENV} to a deno binary.`,
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
 *    dev          -> a checkout under Deno itself reuses its own runtime binary
 *    path         -> a deno on PATH
 *    provisioned  -> the newest `<rootHome>/deno/<x.y.z>/` from an earlier download
 *    absent       -> ensureSidecar downloads the LATEST release */
export type SidecarState =
  | { kind: "override"; denoBin: AbsolutePath }
  | { kind: "dev"; denoBin: AbsolutePath }
  | { kind: "path"; denoBin: AbsolutePath }
  | { kind: "provisioned"; denoBin: AbsolutePath; version: string }
  | { kind: "absent" };

export interface SidecarDetectOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** The default applies the standalone guard (devDenoExecPath): a compiled binary must never
   *  classify itself as the `dev` deno, since it cannot act as one. */
  runtimeExecPath?: string | null;
  /** An ABSOLUTE path, or null. */
  findDeno?: () => string | null;
}

export function detectSidecar(
  rootHome: string,
  opts: SidecarDetectOptions = {},
): SidecarState {
  const env = opts.env ?? process.env;
  const fast = sidecarFastPath(env, opts.runtimeExecPath);
  if (fast !== null) return fast;
  const findDeno = opts.findDeno ?? (() => resolveExecutablePath("deno"));
  const onPath = findDeno();
  if (onPath !== null) return { "kind": "path", "denoBin": parseAbsolutePath(onPath) };
  return provisionedSidecar(rootHome, opts.platform) ?? { "kind": "absent" };
}

const DENO_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** null when either side is not x.y.z, so an unparseable version never compares and never warns. */
export function compareDenoVersions(a: string, b: string): number | null {
  if (!DENO_VERSION_RE.test(a) || !DENO_VERSION_RE.test(b)) return null;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const diff = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Highest version wins, so a copy provisioned under an older release stays usable and a fresh
 *  download supersedes it without any cleanup step. */
export function provisionedSidecar(
  rootHome: string,
  platform: string = process.platform,
): Extract<SidecarState, { kind: "provisioned" }> | null {
  let entries: string[];
  try {
    entries = readdirSync(join(rootHome, "deno"));
  } catch {
    return null;
  }
  const best = entries
    .filter((name) => DENO_VERSION_RE.test(name))
    .filter((version) => existsSync(sidecarBinPath(rootHome, version, platform)))
    .sort((a, b) => compareDenoVersions(b, a) ?? 0)[0];
  if (best === undefined) return null;
  return {
    "kind": "provisioned",
    "denoBin": parseAbsolutePath(sidecarBinPath(rootHome, best, platform)),
    "version": best,
  };
}

export function parseDvmrcPin(content: string, source: string = DVMRC_FILENAME): string {
  const trimmed = content.trim();
  if (!DENO_VERSION_RE.test(trimmed)) {
    throw new Error(
      `${source}: expected a single x.y.z Deno version line, got '${trimmed.slice(0, 64)}'`,
    );
  }
  return trimmed;
}

/** Defaults to ASSET_ROOT, not the install root: `.dvmrc` is embedded in the binary at build time and
 *  never materialized onto disk, so an installed root has no copy. */
export function readDvmrcPin(projectRoot: string = ASSET_ROOT): string {
  const path = join(projectRoot, DVMRC_FILENAME);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read the Deno version pin ${path}: ${String(e)}`);
  }
  return parseDvmrcPin(content, path);
}

/** Keys follow process.platform/process.arch vocabulary. */
export const DENO_RELEASE_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
} as const;

export type DenoReleaseTarget = (typeof DENO_RELEASE_TARGETS)[keyof typeof DENO_RELEASE_TARGETS];

export function denoReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): DenoReleaseTarget {
  const key = `${platform}-${arch}`;
  const target = (DENO_RELEASE_TARGETS as Record<string, DenoReleaseTarget | undefined>)[key];
  if (target === undefined) {
    throw new Error(
      `no Deno sidecar build for ${key} (supported: ${
        Object.keys(DENO_RELEASE_TARGETS).join(", ")
      })`,
    );
  }
  return target;
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
    return parseDvmrcPin(body.replace(/^\s*v/, ""), DENO_LATEST_URL);
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

export interface UnzipRunResult {
  status: number;
  stderr: string;
}

export interface SidecarDownloadSeams {
  fetchLike?: typeof fetch;
  runner?: (command: string, args: string[]) => UnzipRunResult | Promise<UnzipRunResult>;
  platform?: string;
  arch?: string;
}

function defaultUnzipRunner(command: string, args: string[]): UnzipRunResult {
  const result = spawnSync(command, args, { "stdio": ["ignore", "ignore", "pipe"] });
  return { "status": result.status ?? 1, "stderr": result.stderr?.toString() ?? "" };
}

async function writeStreamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const file = await open(path, "w");
  try {
    for await (const chunk of stream) {
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
}

function hexDigest(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
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
  mkdirReported(destDir);
  // Scratch sits beside the destination (one filesystem, so the final placement is a rename): only a
  // verified, fully extracted binary ever appears at the sidecar path.
  const scratch = scratchDir(join(destDir, ".download-"));
  const zipPath = join(scratch, `deno-${target}.zip`);
  try {
    const [toDisk, toHash] = response.body.tee();
    const [digest] = await Promise.all([
      crypto.subtle.digest("SHA-256", toHash),
      writeStreamToFile(toDisk, zipPath),
    ]);
    const actual = hexDigest(digest);
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
    if (!existsSync(extracted)) {
      throw new Error(`extraction of ${zipPath} did not produce ${extracted}`);
    }
    renameReported(extracted, bin);
    if (platform !== "win32") {
      chmodReported(bin, 0o755);
    }
    return parseAbsolutePath(bin);
  } finally {
    removeScratchDir(scratch);
  }
}

/**
 * Downloads only when nothing resolves at all; a checkout's own deno, a PATH deno, and an earlier
 * provisioned copy all answer without the network. Errors propagate: a compiled install with no deno
 * cannot start the proxy, so failing loudly here beats an opaque spawn failure later.
 */
export async function ensureSidecar(
  rootHome: string,
  seams:
    & SidecarDownloadSeams
    & Pick<SidecarDetectOptions, "runtimeExecPath" | "findDeno"> = {},
): Promise<AbsolutePath> {
  const { runtimeExecPath, findDeno, ...download } = seams;
  const state = detectSidecar(rootHome, {
    "platform": download.platform,
    "runtimeExecPath": runtimeExecPath,
    "findDeno": findDeno,
  });
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

export function denoBinaryVersion(bin: string): string | null {
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
  /** The TESTED REFERENCE version (.dvmrc, what CI runs on). */
  referenceVersion: string;
  denoBin: string | null;
  /** The provisioned dir's name, or `deno --version` for a path/override/dev binary (null when it
   *  could not be read). */
  version: string | null;
  /** True when the running process is a compiled binary, so SOME deno is REQUIRED. */
  standalone: boolean;
}

/** Never downloads: health reports, it does not provision. `denoVersionOf` is the test seam. */
export function sidecarStatus(
  rootHome: string,
  denoVersionOf: (bin: string) => string | null = denoBinaryVersion,
): SidecarStatus {
  const referenceVersion = readDvmrcPin();
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
