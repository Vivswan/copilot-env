// The Deno sidecar: which `deno` binary copilot-env's own subprocess work runs
// on (the proxy cache/daemon in later chunks), and how a missing one is
// provisioned.
//
// Three states, modeled as a discriminated union so callers never juggle
// nullable paths or "downloaded?" booleans:
//   - dev:          running from a checkout under Deno itself -> reuse our own
//                   runtime binary (Deno.execPath()).
//   - provisioned:  a pinned standalone binary under <rootHome>/deno/<pin>/.
//   - absent:       nothing usable yet; `wantedVersion` says what to download.
//
// The pin's single source of truth is the .dvmrc file at the project root (one
// trimmed x.y.z line). Downloads are refused without a caller-supplied sha256
// expectation -- a missing hash is a refusal, never a skip -- and the archive is
// hashed while it streams to disk, so an unverified byte never lands unpacked.
//
// COPILOT_ENV_SIDECAR_DENO (env) overrides all detection: an operator can point it
// at a known-good deno, and tests point it anywhere. Per the repo-wide precedence it
// beats every derived answer.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ASSET_ROOT, devDenoExecPath, isStandaloneBinary } from "../utils/root.ts";
import { sidecarSha256 } from "./sidecar_pins.ts";
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
 * The deno binary copilot-env spawns for its own subprocess work. Precedence:
 * the COPILOT_ENV_SIDECAR_DENO env override, else our own runtime binary when that is a
 * real deno, else the provisioned sidecar under `rootHome`. Anything else is a hard
 * error -- there is no PATH probing, so the answer can never drift to a system deno of
 * an unpinned version.
 *
 * The standalone case is why the sidecar exists: a compiled binary IS a deno runtime,
 * but not a deno CLI, so it can neither warm the float's cache nor spawn the proxy.
 */
export function resolveDenoBin(
  env: Record<string, string | undefined> = process.env,
  rootHome?: string,
): string {
  const override = env[SIDECAR_DENO_ENV]?.trim();
  if (override) return parseAbsolutePath(override);
  const devDeno = devDenoExecPath();
  if (devDeno !== null) return devDeno;

  if (rootHome !== undefined) {
    const state = detectSidecar(rootHome, readDvmrcPin(), { "env": env });
    if (state.kind === "provisioned") return state.denoBin;
  }
  throw new Error(
    `no usable deno binary: this is a compiled build with no provisioned sidecar. ` +
      `Run \`agent start\` to provision it, or set ${SIDECAR_DENO_ENV} to a deno of the pinned version.`,
  );
}

/** Where the sidecar for `pin`'s standalone binary lives under the root home. */
export function sidecarBinPath(
  rootHome: string,
  pin: string,
  platform: string = process.platform,
): string {
  return join(rootHome, "deno", pin, platform === "win32" ? "deno.exe" : "deno");
}

/** The sidecar's resolution state -- see the module comment for the three kinds. */
export type SidecarState =
  | { kind: "dev"; denoBin: AbsolutePath }
  | { kind: "provisioned"; denoBin: AbsolutePath; version: string }
  | { kind: "absent"; wantedVersion: string };

/** Seams for `detectSidecar`; the defaults read the live process/runtime. */
export interface SidecarDetectOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Our own runtime binary when running under a real (non-compiled) deno, else null.
   *  The default applies the same standalone guard as resolveDenoBin: a compiled
   *  binary must never classify itself as the `dev` deno -- it cannot act as one. */
  runtimeExecPath?: string | null;
}

/**
 * Detect the sidecar state for `pin`. Order mirrors resolveDenoBin: the env
 * override wins (reported as `provisioned` at the pin -- an override is only ever
 * pointed at a usable binary), then the dev fast path (running under a real deno,
 * never a compiled binary), then the provisioned binary on disk, else absent.
 */
export function detectSidecar(
  rootHome: string,
  pin: string,
  opts: SidecarDetectOptions = {},
): SidecarState {
  const env = opts.env ?? process.env;
  const override = env[SIDECAR_DENO_ENV]?.trim();
  if (override) {
    return { "kind": "provisioned", "denoBin": parseAbsolutePath(override), "version": pin };
  }
  const runtimeExecPath = opts.runtimeExecPath === undefined
    ? devDenoExecPath()
    : opts.runtimeExecPath;
  if (runtimeExecPath !== null) {
    return { "kind": "dev", "denoBin": parseAbsolutePath(runtimeExecPath) };
  }
  const bin = sidecarBinPath(rootHome, pin, opts.platform);
  if (existsSync(bin)) {
    return { "kind": "provisioned", "denoBin": parseAbsolutePath(bin), "version": pin };
  }
  return { "kind": "absent", "wantedVersion": pin };
}

const DVMRC_PIN_RE = /^\d+\.\d+\.\d+$/;

/** Parse boundary for the .dvmrc content: exactly one trimmed x.y.z line. */
export function parseDvmrcPin(content: string, source: string = DVMRC_FILENAME): string {
  const trimmed = content.trim();
  if (!DVMRC_PIN_RE.test(trimmed)) {
    throw new Error(
      `${source}: expected a single x.y.z Deno version line, got '${trimmed.slice(0, 64)}'`,
    );
  }
  return trimmed;
}

/** The pinned sidecar Deno version from `<projectRoot>/.dvmrc`. */
/** The Deno version this build is pinned to. Defaults to ASSET_ROOT, not the install
 *  root: `.dvmrc` is build-time metadata embedded in the binary and never materialized
 *  onto disk, so an installed root has no copy. `projectRoot` is for tests and the
 *  checkout-only pin generator. */
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

/** The GitHub release asset URL for a pinned deno build (always a .zip; the
 *  Windows one contains deno.exe). */
export function denoReleaseUrl(pin: string, target: DenoReleaseTarget): string {
  return `https://github.com/denoland/deno/releases/download/v${pin}/deno-${target}.zip`;
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
 * Download and provision the pinned deno sidecar for the CURRENT platform:
 * stream the release zip to disk while hashing it (a teed stream, so the bytes
 * on disk are exactly the bytes hashed), verify the sha256 against the
 * caller-supplied expectation, extract, and mark executable. Returns the
 * provisioned binary path.
 *
 * `expectedSha256` comes from the checked-in pin table (sidecar_pins.ts); passing
 * `undefined` -- no expectation known for this pin/target -- is a REFUSAL, not
 * a skip: an unverifiable binary is never downloaded.
 */
export async function downloadSidecar(
  pin: string,
  rootHome: string,
  expectedSha256: string | undefined,
  seams: SidecarDownloadSeams = {},
): Promise<AbsolutePath> {
  const platform = seams.platform ?? process.platform;
  const target = denoReleaseTarget(platform, seams.arch ?? process.arch);
  if (expectedSha256 === undefined) {
    throw new Error(
      `no pinned sha256 for deno v${pin} (${target}); refusing to download an unverifiable binary`,
    );
  }
  const fetchLike = seams.fetchLike ?? fetch;
  const url = denoReleaseUrl(pin, target);
  const response = await fetchLike(url);
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error(`download failed for ${url}: empty response body`);
  }

  const destDir = join(rootHome, "deno", pin);
  await mkdir(destDir, { "recursive": true });
  const zipPath = join(destDir, `deno-${target}.zip.tmp.${process.pid}`);
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

    const { command, args } = unzipCommand(zipPath, destDir, platform);
    const runner = seams.runner ?? defaultUnzipRunner;
    const result = await runner(command, args);
    if (result.status !== 0) {
      throw new Error(
        `could not extract ${zipPath} with ${command}: exit ${result.status}${
          result.stderr.trim() ? `: ${result.stderr.trim()}` : ""
        }`,
      );
    }

    const bin = sidecarBinPath(rootHome, pin, platform);
    if (!existsSync(bin)) {
      throw new Error(`extraction of ${zipPath} did not produce ${bin}`);
    }
    if (platform !== "win32") {
      chmodSync(bin, 0o755);
    }
    return parseAbsolutePath(bin);
  } finally {
    rmSync(zipPath, { "force": true });
  }
}

/**
 * Make sure a usable deno exists for `rootHome`, provisioning the pinned sidecar when it
 * does not. A no-op unless we are a compiled standalone: running under a real deno, that
 * binary IS the answer and nothing needs downloading.
 *
 * Returns the binary every proxy spawn will use. Errors propagate -- a compiled install
 * with no sidecar cannot start the proxy at all, so failing loudly here beats an opaque
 * spawn failure later.
 */
export async function ensureSidecar(
  rootHome: string,
  seams: SidecarDownloadSeams = {},
): Promise<AbsolutePath> {
  const pin = readDvmrcPin();
  const state = detectSidecar(rootHome, pin, { "platform": seams.platform });
  switch (state.kind) {
    case "dev":
    case "provisioned":
      return state.denoBin;
    case "absent": {
      const target = denoReleaseTarget(
        seams.platform ?? process.platform,
        seams.arch ?? process.arch,
      );
      return await downloadSidecar(
        state.wantedVersion,
        rootHome,
        sidecarSha256(pin, target),
        seams,
      );
    }
    default: {
      const never: never = state;
      throw new Error(`unreachable sidecar state: ${JSON.stringify(never)}`);
    }
  }
}

/** The sidecar as `agent health` reports it: what would run, and whether it is here. */
export interface SidecarStatus {
  kind: SidecarState["kind"];
  /** The .dvmrc version this install wants. */
  pin: string;
  /** The resolved binary, or null when nothing is provisioned yet. */
  denoBin: string | null;
  /** True when the running process is a compiled binary, so a sidecar is REQUIRED. */
  standalone: boolean;
}

/** Read-only sidecar facts. Never downloads -- health reports, it does not provision. */
export function sidecarStatus(rootHome: string): SidecarStatus {
  const pin = readDvmrcPin();
  const state = detectSidecar(rootHome, pin);
  return {
    "kind": state.kind,
    "pin": pin,
    "denoBin": state.kind === "absent" ? null : state.denoBin,
    "standalone": isStandaloneBinary(),
  };
}
