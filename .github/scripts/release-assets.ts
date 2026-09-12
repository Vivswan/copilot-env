// The per-release installer assets: install.sh/install.ps1 pinned to the release tag. Run by
// update-release.yml.
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

// `needle` is the unpinned line byte-exact as it sits in the repo installer; prepare() replaces
// it with `pinned(tag)` and validate() asserts the result. test/installer_pinning.test.ts pins
// the match at PR time, so an installer reformat fails in CI instead of at release.
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

// test/installer_pinning.test.ts imports INSTALLER_PINS, so nothing runs on import.
if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
