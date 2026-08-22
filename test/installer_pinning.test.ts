import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALLER_PINS } from "../.github/scripts/release-assets.ts";
import {
  BUNDLED_ONLY_ASSETS,
  LEGACY_ARTIFACTS,
  MATERIALIZED_ASSET_DIRS,
} from "../src/install/installer.ts";
import { RELEASE_TARGETS } from "../src/install/targets.ts";
import { ROOT } from "./helpers/run.ts";
import { describe, expect, test } from "./helpers/testing.ts";

// The installers hand-roll lists that TypeScript modules own, and nothing at
// runtime ties them together: shell cannot import TS. Each guard below parses
// a list back out of the script text and pins it to its TS source of truth, so
// a drift fails at PR time instead of at release time or, worse, as a silently
// broken install.
//
// scripts/compile.ts needs no such guard for its target list: it imports
// RELEASE_TARGETS directly, so that drift is impossible by construction.

const installSh = readFileSync(join(ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
const compileTs = readFileSync(join(ROOT, "scripts", "compile.ts"), "utf8");

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
  // scripts/compile.ts builds RELEASE_TARGETS by importing it; the installers
  // decide which binary to download on a given machine and cannot import TS. A
  // platform mapped onto a triple outside the list is an install that 404s.
  const triples = RELEASE_TARGETS.map((t) => t.triple).sort();

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

describe("compile.include matches what the binary actually needs", () => {
  // Two fates, one embed list. MATERIALIZED_* is written to the install root
  // because something outside this process opens it by path; BUNDLED_ONLY_* is
  // read in-process through ASSET_ROOT and must never be written. Both have to
  // be embedded, and nothing else should be: an entry with neither fate is dead
  // weight in all five binaries, and a fate with no entry is a file that is
  // missing exactly when it is first needed.
  //
  // The list lives in deno.json rather than in scripts/compile.ts on purpose:
  // a CLI --include MERGES with the config's list instead of replacing it, so
  // a second copy in the script would silently union rather than fail.
  const compileInclude: string[] = JSON.parse(
    readFileSync(join(ROOT, "deno.json"), "utf8"),
  ).compile?.include ?? [];
  const needed = [...MATERIALIZED_ASSET_DIRS, ...BUNDLED_ONLY_ASSETS];

  test("compile.include is exactly the union of the two fates", () => {
    expect([...compileInclude].sort()).toEqual([...needed].sort());
  });

  test("the two fates are disjoint", () => {
    // A path in both would be materialized AND read from the VFS, i.e. two
    // copies that can disagree after an update.
    for (const entry of BUNDLED_ONLY_ASSETS) {
      expect(MATERIALIZED_ASSET_DIRS).not.toContain(entry);
    }
  });

  test("scripts/compile.ts does not carry a second include list", () => {
    // Comments may mention --include; no executable line may pass it.
    const code = compileTs.split("\n").filter((line) => !line.trim().startsWith("//"));
    expect(code.some((line) => line.includes("--include"))).toBe(false);
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
