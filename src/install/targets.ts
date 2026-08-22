// The release target list: which platforms get a compiled `agent` binary, and
// what that binary is called as a release asset.
//
// This module is the ONE source of truth. Three other places must agree with it
// and cannot import it (they are shell), so test/release_targets.test.ts parses
// them and pins the match at PR time:
//   - scripts/compile.sh   TARGETS  (what gets built)
//   - install.sh           resolve_target()  (POSIX platform -> triple)
//   - install.ps1          Resolve-Target    (Windows platform -> triple)

/** A platform we ship a compiled binary for. `os`/`arch` are the values
 *  `process.platform` / `process.arch` report on it. */
export interface ReleaseTarget {
  /** The rust-style triple `deno compile --target` takes. */
  triple: string;
  os: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64";
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { triple: "x86_64-apple-darwin", os: "darwin", arch: "x64" },
  { triple: "aarch64-apple-darwin", os: "darwin", arch: "arm64" },
  { triple: "x86_64-unknown-linux-gnu", os: "linux", arch: "x64" },
  { triple: "aarch64-unknown-linux-gnu", os: "linux", arch: "arm64" },
  { triple: "x86_64-pc-windows-msvc", os: "win32", arch: "x64" },
];

/** The release-asset name for a target: `agent-<triple>`, `.exe` on Windows.
 *  scripts/compile.sh writes exactly these names into dist/. */
export function releaseAssetName(target: ReleaseTarget): string {
  return target.os === "win32" ? `agent-${target.triple}.exe` : `agent-${target.triple}`;
}

/** The target this process is running on, or null when copilot-env ships no
 *  binary for it (the caller decides whether that is fatal). */
export function currentReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleaseTarget | null {
  return RELEASE_TARGETS.find((t) => t.os === platform && t.arch === arch) ?? null;
}

/** The installed name of the compiled binary inside `<root>/bin`. Unlike the
 *  release asset it is platform-independent: one install root only ever holds
 *  its own platform's binary, and the launcher shims hardcode this name. */
export const INSTALLED_BINARY_POSIX = "agent-bin";
/** Windows twin of `INSTALLED_BINARY_POSIX`. */
export const INSTALLED_BINARY_WINDOWS = "agent-bin.exe";

export function installedBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? INSTALLED_BINARY_WINDOWS : INSTALLED_BINARY_POSIX;
}
