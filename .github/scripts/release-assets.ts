// Prepare/validate the per-release installer assets: copies of
// install.sh/install.ps1 pinned to the release tag.
// Run by the release workflow:
//   deno run --allow-read --allow-write --allow-env .github/scripts/release-assets.ts <command> <tag>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.RELEASE_ASSETS_DIR ?? "release-assets";

function usage(): never {
  console.error("usage: release-assets.ts prepare|validate <vX.Y.Z>");
  process.exit(2);
}

function pin(path: string, needle: string, replacement: string): void {
  const before = readFileSync(path, "utf8");
  if (!before.includes(needle)) {
    throw new Error(`${path}: placeholder not found: ${needle}`);
  }
  writeFileSync(path, before.replace(needle, replacement));
}

function assertIncludes(path: string, text: string): void {
  if (!readFileSync(path, "utf8").includes(text)) {
    throw new Error(`${path}: expected to contain ${text}`);
  }
  console.log(`${path}: contains ${text}`);
}

interface InstallerPin {
  needle: string;
  pinned: (tag: string) => string;
}

// The lines this script rewrites to the release tag, one entry per pinned line:
// `needle` is the unpinned line as it appears in the repo installer (byte-exact)
// and `pinned(tag)` is the release-asset form -- prepare() replaces the first
// with the second, validate() asserts the second. Since the installers became
// runtime-free binary fetchers there is exactly one pinned line each: the
// default release ref. The needles MUST stay byte-for-byte in sync with
// install.sh/install.ps1; test/installer_pinning.test.ts pins that match at PR
// time so an installer reformat fails in CI instead of at release.
export const INSTALLER_PINS: Record<"install.sh" | "install.ps1", InstallerPin[]> = {
  "install.sh": [
    {
      needle: 'INSTALL_REF="${COPILOT_ENV_INSTALL_REF:-latest}"',
      pinned: (tag) => `INSTALL_REF="\${COPILOT_ENV_INSTALL_REF:-${tag}}"`,
    },
  ],
  "install.ps1": [
    {
      needle:
        "$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }",
      pinned: (tag) =>
        `$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { '${tag}' }`,
    },
  ],
};

function prepare(tag: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync("install.sh", join(OUT_DIR, "install.sh"));
  copyFileSync("install.ps1", join(OUT_DIR, "install.ps1"));

  for (const [file, pins] of Object.entries(INSTALLER_PINS)) {
    const path = join(OUT_DIR, file);
    for (const { needle, pinned } of pins) {
      pin(path, needle, pinned(tag));
    }
  }
}

function validate(tag: string): void {
  for (const [file, pins] of Object.entries(INSTALLER_PINS)) {
    const path = join(OUT_DIR, file);
    for (const { pinned } of pins) {
      assertIncludes(path, pinned(tag));
    }
  }
}

function main(): void {
  const [command, tag] = process.argv.slice(2);
  if (!command || !tag) usage();
  if (command === "prepare") {
    prepare(tag);
  } else if (command === "validate") {
    validate(tag);
  } else {
    usage();
  }
}

// Importable (test/installer_pinning.test.ts reads INSTALLER_PINS); only run
// the CLI when invoked directly.
if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
