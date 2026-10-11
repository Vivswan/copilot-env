// Which platforms get a compiled `agent` binary, and what the release asset is called. The ONE
// source of truth: scripts/compile.ts imports it, and two shell files that cannot are pinned to
// it by test/install/installer_pinning.test.ts:
//   install.sh    resolve_target()   (POSIX platform -> triple)
//   install.ps1   Resolve-Target     (Windows platform -> triple)

export interface ReleaseTarget {
  /** The rust-style triple the release asset is named after: an on-disk and URL contract that
   *  outlived the compiler that first took it. */
  triple: string;
  /** What `bun build --compile --target` takes for this platform. */
  bunTarget: string;
  os: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64";
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { triple: "x86_64-apple-darwin", bunTarget: "bun-darwin-x64", os: "darwin", arch: "x64" },
  { triple: "aarch64-apple-darwin", bunTarget: "bun-darwin-arm64", os: "darwin", arch: "arm64" },
  { triple: "x86_64-unknown-linux-gnu", bunTarget: "bun-linux-x64", os: "linux", arch: "x64" },
  { triple: "aarch64-unknown-linux-gnu", bunTarget: "bun-linux-arm64", os: "linux", arch: "arm64" },
  { triple: "x86_64-pc-windows-msvc", bunTarget: "bun-windows-x64", os: "win32", arch: "x64" },
];

/** scripts/compile.ts writes exactly these names into dist/. */
export function releaseAssetName(target: ReleaseTarget): string {
  return target.os === "win32"
    ? `copilot-env-${target.triple}.exe`
    : `copilot-env-${target.triple}`;
}

export function currentReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleaseTarget | null {
  return RELEASE_TARGETS.find((t) => t.os === platform && t.arch === arch) ?? null;
}

/** Platform-independent, unlike the release asset: one install root only ever holds its own
 *  platform's binary, and the launcher shims hardcode this name. The `bin/agent`(`.ps1`) shim
 *  beside it IS the `agent` alias. */
export const INSTALLED_BINARY_POSIX = "copilot-env";
export const INSTALLED_BINARY_WINDOWS = "copilot-env.exe";

export function installedBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? INSTALLED_BINARY_WINDOWS : INSTALLED_BINARY_POSIX;
}
