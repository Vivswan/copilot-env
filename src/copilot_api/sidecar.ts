// The Deno sidecar: which `deno` binary copilot-env's own subprocess work runs
// on (the proxy cache/daemon), and how a machine with no deno at all gets one.
//
// Five states, modeled as a discriminated union so callers never juggle
// nullable paths or "downloaded?" booleans:
//   - override:     COPILOT_ENV_SIDECAR_DENO points at an explicit binary.
//   - dev:          running from a checkout under Deno itself -> reuse our own
//                   runtime binary (Deno.execPath()).
//   - path:         a deno already on PATH -- the user's toolchain always wins.
//   - provisioned:  a standalone binary under <rootHome>/deno/<x.y.z>/ (the
//                   newest one), from an earlier download on a deno-less machine.
//   - absent:       nothing usable; ensureSidecar downloads the LATEST release.
//
// .dvmrc (one trimmed x.y.z line at the project root, embedded into compiled
// builds) is only the TESTED REFERENCE version -- what CI runs on and what
// health compares a PATH deno against. Nothing here installs it. Downloads are
// refused without a sha256 expectation -- a missing hash is a refusal, never a
// skip -- and the archive is hashed while it streams to disk, so an unverified
// byte never lands unpacked; the expectation is the release's own published
// `.sha256sum`, fetched at download time.
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

/** Env var carrying an explicit deno binary path (set by the compiled launcher). */
export const SIDECAR_DENO_ENV = "COPILOT_ENV_SIDECAR_DENO";

/** The Deno version pin file at the project root: one trimmed x.y.z line. */
export const DVMRC_FILENAME = ".dvmrc";

/**
 * A VALIDATED absolute filesystem path. Only `parseAbsolutePath` mints one, so
 * holding the type is the proof -- the sidecar states below can never carry a
 * relative path that would silently resolve against a drifting cwd.
 */
export type AbsolutePath = string & {
  // biome-ignore lint/style/useNamingConvention: the dunder phantom key is the branded-type convention; it never exists at runtime
  readonly __brand: "AbsolutePath";
};

/** Parse boundary for `AbsolutePath`: non-empty and absolute, or a clear throw. */
export function parseAbsolutePath(path: string): AbsolutePath {
  const trimmed = path.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    throw new Error(`expected an absolute path, got '${trimmed}'`);
  }
  return trimmed as AbsolutePath;
}

/**
 * The two fast paths every sidecar resolution applies first, the ONE owner of their
 * order: the COPILOT_ENV_SIDECAR_DENO override (the documented recovery hatch), then our
 * own runtime binary when that is a real deno -- a checkout's subprocesses must run on
 * the SAME deno as the parent, so the dev path outranks even a PATH deno. Null means
 * "look for a system or provisioned binary".
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
 * The deno binary copilot-env spawns for its own subprocess work: the fast paths above, else
 * the deno already on PATH (the user's toolchain always wins), else the newest provisioned
 * sidecar under `rootHome`, else a hard error. `rootHome` defaults to the resolved root
 * home, so every bare call site -- the daemon spawn, the proxy float, the device-flow login
 * -- finds the sidecar a compiled install provisioned there. The standalone case is why the
 * sidecar exists: a compiled binary IS a deno runtime, but not a deno CLI, so it can neither
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

/** Where the sidecar for `version`'s standalone binary lives under the root home. */
export function sidecarBinPath(
  rootHome: string,
  version: string,
  platform: string = process.platform,
): string {
  return join(rootHome, "deno", version, platform === "win32" ? "deno.exe" : "deno");
}

/** The sidecar's resolution state -- see the module comment for the five kinds. */
export type SidecarState =
  | { kind: "override"; denoBin: AbsolutePath }
  | { kind: "dev"; denoBin: AbsolutePath }
  | { kind: "path"; denoBin: AbsolutePath }
  | { kind: "provisioned"; denoBin: AbsolutePath; version: string }
  | { kind: "absent" };

/** Seams for `detectSidecar`; the defaults read the live process/runtime/PATH. */
export interface SidecarDetectOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Our own runtime binary when running under a real (non-compiled) deno, else null.
   *  The default applies the standalone guard (devDenoExecPath): a compiled binary
   *  must never classify itself as the `dev` deno -- it cannot act as one. */
  runtimeExecPath?: string | null;
  /** PATH lookup for a system deno (an ABSOLUTE path, or null). */
  findDeno?: () => string | null;
}

/**
 * Detect the sidecar state: the shared fast paths (sidecarFastPath above), then the deno
 * already on PATH, then the newest provisioned binary on disk, else absent.
 */
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

/** Numeric x.y.z order: negative a < b, 0 equal, positive a > b; null when either
 *  side is not x.y.z (an unparseable version never compares, so it never warns). */
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

/** The NEWEST provisioned sidecar under `<rootHome>/deno/<x.y.z>/`, or null. Highest
 *  version wins, so a copy provisioned under an older release stays usable and a
 *  fresh download supersedes it without any cleanup step. */
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

/** Parse boundary for a version pin/pointer: exactly one trimmed x.y.z line. */
export function parseDvmrcPin(content: string, source: string = DVMRC_FILENAME): string {
  const trimmed = content.trim();
  if (!DENO_VERSION_RE.test(trimmed)) {
    throw new Error(
      `${source}: expected a single x.y.z Deno version line, got '${trimmed.slice(0, 64)}'`,
    );
  }
  return trimmed;
}

/** The TESTED REFERENCE Deno version (what CI runs on; a PATH deno older than it
 *  gets a warning, never a reinstall). Defaults to ASSET_ROOT, not the install
 *  root: `.dvmrc` is build-time metadata embedded in the binary and never
 *  materialized onto disk, so an installed root has no copy. `projectRoot` is
 *  for tests. */
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

/** platform-arch -> the deno release asset target triple. Keys follow
 *  process.platform/process.arch vocabulary. */
export const DENO_RELEASE_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
} as const;

export type DenoReleaseTarget = (typeof DENO_RELEASE_TARGETS)[keyof typeof DENO_RELEASE_TARGETS];

/** The release target triple for a platform/arch pair, or a clear throw. */
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

/** The GitHub release asset URL for a deno build (always a .zip; the Windows
 *  one contains deno.exe). */
export function denoReleaseUrl(version: string, target: DenoReleaseTarget): string {
  return `https://github.com/denoland/deno/releases/download/v${version}/deno-${target}.zip`;
}

/** The official latest-release pointer: one "v2.x.y" line. */
export const DENO_LATEST_URL = "https://dl.deno.land/release-latest.txt";

/** The latest deno release version ("2.x.y"), or a clear throw naming the manual
 *  escapes -- a deno-less machine cannot proceed without it. A malformed 200 body
 *  fails inside the same wrapper as a dead endpoint: every arm carries the
 *  recovery guidance. */
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
 * The release's own published sha256 for the target's zip (`<asset>.sha256sum`),
 * fetched at download time. Two formats ship side by side: the POSIX `sha256sum`
 * line (`<hex>  <file>`) and, for the Windows targets, PowerShell Get-FileHash
 * output (`Hash : <HEX>`); the first 64-hex-digit token serves both, normalised
 * to lower case.
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

/**
 * The platform command that extracts a deno release zip into `destDir`.
 * Windows always ships bsdtar (which reads zip archives); POSIX uses `unzip`
 * (present on macOS; a hard requirement on Linux hosts).
 */
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

/** Result of one spawned extraction command. */
export interface UnzipRunResult {
  status: number;
  stderr: string;
}

/** Seams for `downloadSidecar`; defaults hit the real network/process. */
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

/** Drain a web stream into `path` (created fresh, overwritten if present). */
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
 * Download and provision a deno sidecar for the CURRENT platform: stream the
 * release zip to disk while hashing it (a teed stream, so the bytes on disk are
 * exactly the bytes hashed), verify the sha256 against the caller-supplied
 * expectation, extract, and mark executable. Returns the provisioned binary path.
 *
 * `expectedSha256` is the release's own published digest (fetchReleaseSha256);
 * passing `undefined` -- no expectation known -- is a REFUSAL, not a skip: an
 * unverifiable binary is never downloaded.
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
  // The archive and its extraction stay in scratch beside the destination (one
  // filesystem, so the final placement is a rename): only a verified, fully
  // extracted binary ever appears at the sidecar path.
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
 * Make sure a usable deno exists for `rootHome`, downloading the LATEST release only
 * when nothing resolves at all: a checkout's own deno, a PATH deno, and an earlier
 * provisioned copy all answer without touching the network. The download verifies the
 * release's own published sha256 (fetchReleaseSha256) before anything lands.
 *
 * Returns the binary every proxy spawn will use. Errors propagate -- a compiled install
 * with no deno cannot start the proxy at all, so failing loudly here beats an opaque
 * spawn failure later.
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

/** `deno --version`'s reported version for `bin`, or null when it does not run. */
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

/** The sidecar as `agent health` reports it: what would run, and whether it is here. */
export interface SidecarStatus {
  kind: SidecarState["kind"];
  /** The TESTED REFERENCE version (.dvmrc -- what CI runs on). */
  referenceVersion: string;
  /** The resolved binary, or null when nothing resolves. */
  denoBin: string | null;
  /** The resolved binary's version: the provisioned dir's name, or `deno
   *  --version` for a path/override/dev binary (null when it could not be read). */
  version: string | null;
  /** True when the running process is a compiled binary, so SOME deno is REQUIRED. */
  standalone: boolean;
}

/** Read-only sidecar facts. Never downloads -- health reports, it does not
 *  provision. `denoVersionOf` is a test seam over the one live `--version` spawn. */
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
