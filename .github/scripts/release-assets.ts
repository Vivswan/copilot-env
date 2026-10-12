// The per-release installer assets: install.sh/install.ps1 pinned to the release tag (prepare and
// validate, run by update-release.yml and release-gate.yml), and the proof that every compiled
// release asset is real (assert-assets, run by release-gate.yml after `bun run build`).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentReleaseTarget,
  RELEASE_TARGETS,
  releaseAssetName,
} from "../../src/utils/targets.ts";

const OUT_DIR = process.env.RELEASE_ASSETS_DIR ?? "release-assets";

function usage(): never {
  console.error("usage: release-assets.ts prepare|validate <vX.Y.Z> | assert-assets");
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
// it with `pinned(tag)` and validate() asserts the result. test/install/installer_pinning.e2e.test.ts pins
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

// scripts/compile.ts already fails `bun run build` when a target does not compile. What only this
// catches is a zero-exit compile that left a stub or a truncated artifact (a bun runtime that
// failed to embed, a download cut short): the size floor and the host's --help run expose both.
// The expected names come from the targets' one source of truth (src/utils/targets.ts), since
// checksums.txt lists only what compile wrote.
const COMPILED_BINARY_SIZE_FLOOR = 10_000_000;

function assertAssets(): void {
  for (const target of RELEASE_TARGETS) {
    const path = `dist/${releaseAssetName(target)}`;
    const size = statSync(path).size;
    console.log(`${path}: ${size} bytes`);
    if (size <= COMPILED_BINARY_SIZE_FLOOR) {
      console.log(`::error::${path} is ${size} bytes, not a compiled binary`);
      process.exit(1);
    }
  }
  const host = currentReleaseTarget();
  if (host === null) throw new Error("no release target for this runner");
  const hostPath = `./dist/${releaseAssetName(host)}`;
  chmodSync(hostPath, 0o755);
  const run = spawnSync(hostPath, ["--help"], { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`${hostPath} --help exited with ${run.status ?? `signal ${run.signal}`}`);
  }
}

function main(): void {
  const [command, tag] = process.argv.slice(2);
  if (command === "assert-assets") {
    if (tag !== undefined) usage();
    assertAssets();
    return;
  }
  if (!command || !tag) usage();
  if (command === "prepare") {
    prepare(tag);
  } else if (command === "validate") {
    validate(tag);
  } else {
    usage();
  }
}

// test/install/installer_pinning.e2e.test.ts imports INSTALLER_PINS, so nothing runs on import.
if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
