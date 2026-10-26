// Which platforms get a compiled `agent` binary, and what the release asset is called. The ONE
// source of truth: scripts/compile.ts imports it, and two shell files that cannot are pinned to
// it by test/install/installer_pinning.e2e.test.ts:
//   install.sh    resolve_target()   (POSIX platform -> triple)
//   install.ps1   Resolve-Target     (Windows platform -> triple)

export interface ReleaseTarget {
  /** Names the asset: a rust-style triple, now a disk and URL contract outliving its compiler. */
  triple: string;

  /** What `bun build --compile --target` takes for this platform. */
  bunTarget: string;

  /** Matched against process.platform by currentReleaseTarget. */
  os: "darwin" | "linux" | "win32";

  /** Matched against process.arch by currentReleaseTarget. */
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

/** Platform-free, unlike the asset: a root holds one platform's binary; the shims hardcode it. */
export const INSTALLED_BINARY_POSIX = "copilot-env";

/** The same name with the `.exe` Windows needs to run it. */
export const INSTALLED_BINARY_WINDOWS = "copilot-env.exe";

/** The `bin/agent` (`.ps1`) shim beside the binary IS the `agent` alias. */
export function installedBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? INSTALLED_BINARY_WINDOWS : INSTALLED_BINARY_POSIX;
}
