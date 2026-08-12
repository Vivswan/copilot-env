import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALLER_PINS } from "../.github/scripts/release-assets.ts";
import { DOC_LINKS, PRESERVE } from "../src/install/release.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

// The bootstrap installers hand-roll two lists that release.ts owns, and nothing at
// runtime ties them together: the user-state paths backed up across the destructive
// reinstall (PRESERVE minus the paths `bun install`/`git clone` recreate), and the
// doc symlinks install.ps1 must tar-exclude then re-materialize as copies (DOC_LINKS).
// This guard parses the lists back out of the script text and pins them to the
// release.ts sets, so adding a durable path or a doc link in one place fails loudly
// instead of being silently dropped by the curl|bash path. Backup and restore sites
// are asserted separately: a deleted restore block must fail, not hide behind the
// surviving backup site.

const installSh = readFileSync(join(PROJECT_ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(PROJECT_ROOT, "install.ps1"), "utf8");

// The PRESERVE subset the installers must carry across the reinstall: .git is the
// clone itself and node_modules is rebuilt by `bun install`, so only user state remains.
const expectedSurvivors = [...PRESERVE].filter((p) => p !== ".git" && p !== "node_modules").sort();

function names(script: string, pattern: RegExp): string[] {
  return [...script.matchAll(pattern)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "")
    .sort();
}

test("install.sh backs up exactly the user-state PRESERVE paths", () => {
  // cp -a "$INSTALL_DIR/<name>" "$_tmp/<name>-backup"
  const backedUp = names(
    installSh,
    /cp\s+-a\s+"\$INSTALL_DIR\/([A-Za-z0-9._-]+)"\s+"\$_tmp\/\1-backup"/g,
  );
  expect(backedUp).toEqual(expectedSurvivors);
});

test("install.sh restores exactly the user-state PRESERVE paths", () => {
  // cp -a "$_tmp/<name>-backup[/.]" "$INSTALL_DIR/<name>[/]"
  const restored = names(
    installSh,
    /cp\s+-a\s+"\$_tmp\/([A-Za-z0-9._-]+)-backup(?:\/\.)?"\s+"\$INSTALL_DIR\/\1\/?"/g,
  );
  expect(restored).toEqual(expectedSurvivors);
});

test("install.ps1 backs up exactly the user-state PRESERVE paths", () => {
  // Copy-Item ... (Join-Path $InstallDir '<name>') $<var>Backup
  const backedUp = names(
    installPs1,
    /Copy-Item[^\r\n]*?\(Join-Path \$InstallDir ['"]([A-Za-z0-9._-]+)['"]\)\s+\$\w+Backup/g,
  );
  expect(backedUp).toEqual(expectedSurvivors);
});

test("install.ps1 restores exactly the user-state PRESERVE paths", () => {
  // Copy-Item ... $<var>Backup (Join-Path $InstallDir '<name>')
  const restored = names(
    installPs1,
    /Copy-Item[^\r\n]*?\$\w+Backup\s+\(Join-Path \$InstallDir ['"]([A-Za-z0-9._-]+)['"]\)/g,
  );
  expect(restored).toEqual(expectedSurvivors);
});

test("install.ps1 tar-excludes exactly the DOC_LINKS symlinks", () => {
  const excluded = names(installPs1, /--exclude=['"]\*\/([^'"]+)['"]/g);
  expect(excluded).toEqual([...DOC_LINKS].sort());
});

test("install.ps1 re-materializes exactly the DOC_LINKS symlinks", () => {
  const foreach = installPs1.match(/\$link in @\(([^)]*)\)/);
  expect(foreach).not.toBeNull();
  const copied = [...(foreach?.[1] ?? "").matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => (match[1] ?? "").replaceAll("\\", "/"))
    .sort();
  expect(copied).toEqual([...DOC_LINKS].sort());
});

// The release pipeline (release-assets.ts prepare) rewrites a handful of installer
// lines to the release tag by byte-exact needle. Nothing runs that script at PR time,
// so without this guard a cosmetic reformat of those lines merges green and breaks
// the main-branch release with "placeholder not found". Pin the needles here instead.
test("release-assets.ts pin needles match install.sh byte-for-byte", () => {
  for (const { needle } of INSTALLER_PINS["install.sh"]) {
    expect(installSh).toContain(needle);
  }
});

test("release-assets.ts pin needles match install.ps1 byte-for-byte", () => {
  for (const { needle } of INSTALLER_PINS["install.ps1"]) {
    expect(installPs1).toContain(needle);
  }
});

test("release-assets.ts pinned() forms carry the tag and drop the main ref", () => {
  // validate() derives from the same pinned() as prepare(), so it cannot catch a
  // bad transform; this guards the realistic typo class at PR time instead.
  for (const pins of Object.values(INSTALLER_PINS)) {
    for (const { pinned } of pins) {
      const form = pinned("v9.9.9-test");
      expect(form).toContain("v9.9.9-test");
      expect(form).not.toContain("/main/");
    }
  }
});
