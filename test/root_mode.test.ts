// The two roots src/utils/root.ts resolves, and the policy their kinds carry.
//
// Running under `deno test` is always checkout mode, so the compiled-mode half of
// the contract cannot be asserted in-process. What IS pinned here is everything a
// compiled binary would break if the detection regressed: the on-disk shape of
// PROJECT_ROOT, the paths handed to other programs, and the kind -> protection
// policy every destructive gate reads. Verifying the compiled half means building a
// binary and running it from an install root.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import {
  AGENT_AUTH_GET_ARGS,
  ASSET_ROOT,
  devDenoExecPath,
  INSTALL_MANIFEST_FILE,
  INSTALL_ROOT_MARKERS,
  isProtectedRoot,
  looksLikeInstallRoot,
  PROJECT_ROOT,
  proxyTokenArgs,
  proxyTokenCommand,
  rootMode,
} from "../src/utils/root.ts";
import { PROJECT_CONFIG_FILE, readProjectConfig } from "../src/utils/project_config.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { expect, test } from "./helpers/testing.ts";

test("the suite runs in checkout mode, where both roots are the source tree", () => {
  const mode = rootMode();
  expect(mode.kind).toBe("checkout");
  expect(mode.root).toBe(PROJECT_ROOT);
  // Nothing distinguishes the two roots when the code we run and the files we
  // manage are the same directory; a compiled binary is what splits them.
  expect(ASSET_ROOT).toBe(PROJECT_ROOT);
  expect(existsSync(join(PROJECT_ROOT, "package.json"))).toBe(true);
});

test("PROJECT_ROOT is a real absolute directory on disk", () => {
  // The contract compiled mode exists to keep: external programs (codex, claude)
  // are handed paths under this root and must be able to open them.
  expect(isAbsolute(PROJECT_ROOT)).toBe(true);
  expect(existsSync(PROJECT_ROOT)).toBe(true);
  // The resolver the agent configs invoke is the launcher itself (`agent proxy-token`),
  // per platform. On Windows the argv is `powershell -NoProfile ... -File <launcher>`,
  // so pick the path off `-File` rather than a fixed index (args[0] there is a flag,
  // which would assert nothing).
  const { command, args } = proxyTokenCommand();
  const launcherPath = process.platform === "win32" ? args[args.indexOf("-File") + 1] : command;
  expect(launcherPath).toBeDefined();
  expect(isAbsolute(String(launcherPath))).toBe(true);
  expect(existsSync(String(launcherPath))).toBe(true);
  if (process.platform !== "win32") expect(launcherPath).toBe(join(PROJECT_ROOT, "bin", "agent"));
});

test("protection follows the RootMode kind, with no filesystem probe", () => {
  // A source checkout is protected whether or not it carries a .git dir, and an
  // installed binary root is deletable whether or not it does. The ambient probe
  // this replaced got both backwards in a container and in a non-git copy.
  expect(isProtectedRoot({ kind: "checkout", root: "/nowhere/clone" })).toBe(true);
  expect(isProtectedRoot({ kind: "compiled", root: "/nowhere/install" })).toBe(false);
  expect(isProtectedRoot()).toBe(true); // the ambient mode, under `deno test`
});

test("looksLikeInstallRoot gates the recursive delete on the marker layout", () => {
  // The compiled root is DERIVED (two levels up from the binary), so a binary copied
  // to ~/.local/bin would aim the uninstall rm -rf at ~/.local. Markers, not kind,
  // are what stop that.
  expect(looksLikeInstallRoot(PROJECT_ROOT)).toBe(true);
  expect(looksLikeInstallRoot(homedir())).toBe(false);
  expect(looksLikeInstallRoot(parse(PROJECT_ROOT).root)).toBe(false); // a filesystem root
  const strayBinOnly = join(PROJECT_ROOT, "bin");
  expect(looksLikeInstallRoot(strayBinOnly)).toBe(false); // has no shell/ or src/scripts
});

test("a valid manifest alone qualifies a root; unreadable fails closed", () => {
  // The manifest `agent install` writes is the install's own record: a valid one
  // qualifies the root by itself, so a user-deleted asset dir cannot make a real
  // install invisible to uninstall. Absent or invalid falls back to the marker
  // layout (checkouts and pre-manifest installs have no manifest to read).
  const root = mkdtempSync(join(tmpdir(), "copilot-root-mode-"));
  try {
    const manifestPath = join(root, INSTALL_MANIFEST_FILE);
    const valid = JSON.stringify({ "version": "0.0.1", "kind": "installed", "assets": ["shell"] });

    expect(looksLikeInstallRoot(root)).toBe(false); // empty: no manifest, no markers
    writeFileSync(manifestPath, valid);
    expect(looksLikeInstallRoot(root)).toBe(true); // the manifest alone qualifies

    writeFileSync(manifestPath, "not json");
    expect(looksLikeInstallRoot(root)).toBe(false); // invalid, and no markers either

    // Each fixture isolates ONE wrong field against the valid form above, so
    // dropping any one validation in readInstallManifest breaks exactly one of
    // them -- the recursive-delete gate must not trust a foreign file.
    for (
      const text of [
        '{"version":"1.0.0","kind":"checkout","assets":[]}',
        '{"version":1,"kind":"installed","assets":[]}',
        '{"version":"1.0.0","kind":"installed","assets":"shell"}',
        '{"version":"1.0.0","kind":"installed","assets":[1]}',
      ]
    ) {
      writeFileSync(manifestPath, text);
      expect(looksLikeInstallRoot(root)).toBe(false);
    }
    writeFileSync(manifestPath, "not json");

    for (const marker of INSTALL_ROOT_MARKERS) {
      mkdirSync(join(root, marker), { recursive: true });
    }
    expect(looksLikeInstallRoot(root)).toBe(true); // invalid manifest: markers decide

    // Unreadable is NOT absent: a manifest we cannot read leaves ownership
    // unproven, and a root we cannot inspect is not one we may rm -rf. A
    // directory at the manifest path makes every platform's read fail.
    rmSync(manifestPath);
    mkdirSync(manifestPath);
    expect(looksLikeInstallRoot(root)).toBe(false);

    if (process.platform !== "win32") {
      // A dangling symlink reads as ENOENT but IS a directory entry, so it must
      // classify as unreadable, not absent. (Symlink creation needs privileges
      // on Windows; the unreadable class itself is covered above.)
      rmSync(manifestPath, { recursive: true });
      symlinkSync(join(root, "no-such-target"), manifestPath);
      expect(looksLikeInstallRoot(root)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copilot-env.config is read from ASSET_ROOT by default", () => {
  // It is embedded in the compiled binary and never materialized onto disk, so the
  // default root must be the asset root; an install root has no copy to read.
  expect(existsSync(join(ASSET_ROOT, PROJECT_CONFIG_FILE))).toBe(true);
  expect(readProjectConfig().proxyMinVersion).toMatch(/^\d+\.\d+\.\d+/);
  // The default must be ASSET_ROOT specifically, not "whatever root happens to work":
  // a directory with no config must throw rather than silently fall back.
  expect(() => readProjectConfig(join(ASSET_ROOT, "src"))).toThrow();
});

test("the credential resolver argvs stay byte-identical", () => {
  // Writers (Codex auth.command, Claude apiKeyHelper) and the health verifier
  // compare these strings; a root refactor must not disturb them.
  expect(AGENT_AUTH_GET_ARGS).toEqual(["auth", "--get"]);
  expect(proxyTokenArgs()).toEqual(["proxy-token", "--yes"]);
  expect(proxyTokenArgs(parseProfileName("work"))).toEqual([
    "proxy-token",
    "--yes",
    "--profile",
    "work",
  ]);
});

test("devDenoExecPath is the runtime binary under a real deno (the compiled half is CI's)", () => {
  // Under `deno test` this process IS a real deno, so the dev fast path answers
  // with its executable. The compiled half of the contract (null, so a compiled
  // binary never classifies itself as a dev deno) is pinned by the installer
  // smoke's compiled-health invariants, which run the real built binary.
  expect(devDenoExecPath()).toBe(Deno.execPath());
});
