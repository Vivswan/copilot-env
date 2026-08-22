import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALLER_PINS } from "../.github/scripts/release-assets.ts";
import {
  EMBEDDED_ASSET_DIRS,
  EMBEDDED_ASSET_FILES,
  LEGACY_ARTIFACTS,
} from "../src/install/installer.ts";
import { RELEASE_TARGETS } from "../src/install/targets.ts";
import { ROOT } from "./helpers/run.ts";
import { describe, expect, test } from "./helpers/testing.ts";

// The installers and the compile script hand-roll lists that TypeScript modules
// own, and nothing at runtime ties them together: shell cannot import TS. Each
// guard below parses a list back out of the script text and pins it to its TS
// source of truth, so a drift fails at PR time instead of at release time or,
// worse, as a silently broken install.

const installSh = readFileSync(join(ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
const compileSh = readFileSync(join(ROOT, "scripts", "compile.sh"), "utf8");

/** The values of a `NAME=(a b c)` bash array literal in `script`. */
function bashArray(script: string, name: string): string[] {
  const body = script.match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"))?.[1] ?? "";
  return body.split(/\s+/).filter((entry) => entry !== "");
}

describe("release-assets.ts pin needles", () => {
  // The release pipeline rewrites a handful of installer lines to the release
  // tag by byte-exact needle. Nothing runs that script at PR time, so without
  // this guard a cosmetic reformat of those lines merges green and then breaks
  // the main-branch release with "placeholder not found".
  test("match install.sh byte-for-byte", () => {
    for (const { needle } of INSTALLER_PINS["install.sh"]) {
      expect(installSh).toContain(needle);
    }
  });

  test("match install.ps1 byte-for-byte", () => {
    for (const { needle } of INSTALLER_PINS["install.ps1"]) {
      expect(installPs1).toContain(needle);
    }
  });

  test("pinned() forms carry the tag and drop the floating default", () => {
    // validate() derives from the same pinned() as prepare(), so it cannot
    // catch a bad transform; this guards the realistic typo class instead.
    for (const pins of Object.values(INSTALLER_PINS)) {
      for (const { pinned } of pins) {
        const form = pinned("v9.9.9-test");
        expect(form).toContain("v9.9.9-test");
        expect(form).not.toContain("latest");
      }
    }
  });
});

describe("compile targets match the installers", () => {
  // scripts/compile.sh decides which binaries exist; the installers decide
  // which one to download on a given machine. A target in one list and not the
  // other is either a binary nobody can install or an install that 404s.
  const triples = RELEASE_TARGETS.map((t) => t.triple).sort();

  test("scripts/compile.sh builds exactly the RELEASE_TARGETS triples", () => {
    expect(bashArray(compileSh, "TARGETS").sort()).toEqual(triples);
  });

  test("install.sh maps its platforms onto RELEASE_TARGETS triples", () => {
    const mapped = [...installSh.matchAll(/TARGET="([a-z0-9_-]+)"/g)].map((m) => m[1] ?? "");
    expect(mapped.length).toBeGreaterThan(0);
    for (const triple of mapped) {
      expect(triples).toContain(triple);
    }
    // Every non-Windows target must be reachable from install.sh.
    for (const target of RELEASE_TARGETS.filter((t) => t.os !== "win32")) {
      expect(mapped).toContain(target.triple);
    }
  });

  test("install.ps1 maps Windows onto a RELEASE_TARGETS triple", () => {
    const mapped = [...installPs1.matchAll(/return '([a-z0-9_-]+)'/g)].map((m) => m[1] ?? "");
    for (const target of RELEASE_TARGETS.filter((t) => t.os === "win32")) {
      expect(mapped).toContain(target.triple);
    }
  });
});

describe("compile embeds every asset the installer materializes", () => {
  // buildInstallPlan reads these paths out of the compiled VFS and throws if
  // one is absent. That throw is the LAST line of defense and it only fires
  // once a binary exists; this pins the two lists at PR time instead.
  test("scripts/compile.sh --include covers EMBEDDED_ASSET_DIRS and _FILES", () => {
    const includes = bashArray(compileSh, "INCLUDES");
    for (const entry of [...EMBEDDED_ASSET_DIRS, ...EMBEDDED_ASSET_FILES]) {
      expect(includes).toContain(entry);
    }
  });
});

describe("installers and the installer share one artifact list", () => {
  // install.sh / install.ps1 sweep the superseded source-install artifacts
  // before handing off, and `agent install` sweeps them again after. Both
  // lists have to name the same things or one of them leaves debris.
  const expected = [...LEGACY_ARTIFACTS].sort();

  test("install.sh LEGACY_ARTIFACTS matches", () => {
    const list = installSh.match(/^LEGACY_ARTIFACTS="([^"]*)"/m)?.[1] ?? "";
    expect(list.split(/\s+/).filter(Boolean).sort()).toEqual(expected);
  });

  test("install.ps1 $LegacyArtifacts matches", () => {
    const body = installPs1.match(/\$LegacyArtifacts = @\(([^)]*)\)/)?.[1] ?? "";
    const names = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "").sort();
    expect(names).toEqual(expected);
  });
});
