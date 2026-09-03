import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import {
  adoptVersionedLayout,
  applyInstallPlan,
  buildInstallPlan,
  BUNDLED_ONLY_ASSETS,
  CHECKOUT_MARKERS,
  classifyInstallRoot,
  CURRENT_LINK,
  currentLinkPath,
  flatArtifactPaths,
  INSTALL_ROOT_ENV,
  type InstallOptions,
  type InstallPlan,
  isCheckoutShapedRoot,
  LEGACY_ARTIFACTS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
  pointCurrentAt,
  POSIX_CURRENT_SHIM,
  POSIX_SHIM,
  POWERSHELL_CURRENT_SHIM,
  POWERSHELL_SHIM,
  readCurrentVersionName,
  removeFlatBinaryResidue,
  removeVersionDirsExcept,
  versionDirName,
  versionRootPath,
  VERSIONS_DIR,
  wiredShellTargets,
  writeTopLevelShims,
} from "../src/install/installer.ts";
import { installedBinaryName } from "../src/install/targets.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../src/shell/integration.ts";
import { INSTALL_MANIFEST_FILE, INSTALL_ROOT_MARKERS } from "../src/utils/root.ts";
import { packageVersion } from "../src/utils/version.ts";
import { envSnapshot } from "./helpers.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

const OPTIONS: InstallOptions = { noShellIntegration: false, allHosts: false, assetsOnly: false };
/** Full-install options that plan no shell wiring (tests that APPLY plans use
 *  these, so nothing tries to spawn a binary or touch rc files). */
const QUIET: InstallOptions = { noShellIntegration: true, allHosts: false, assetsOnly: false };
const ASSETS_ONLY: InstallOptions = {
  noShellIntegration: false,
  allHosts: false,
  assetsOnly: true,
};

const skipWin = test.skipIf(process.platform === "win32");
const winOnly = test.skipIf(process.platform !== "win32");

let root = "";
let source = "";
let dest = "";
const restoreEnv = envSnapshot([CI_RC_DIR_ENV, CI_PS_DOCUMENTS_DIR_ENV]);

/** A stand-in for the compiled VFS: every embedded asset the plan requires. */
function writeAssetSource(dir: string): void {
  for (const assetDir of MATERIALIZED_ASSET_DIRS) {
    mkdirSync(join(dir, assetDir), { recursive: true });
    writeFileSync(join(dir, assetDir, "payload.txt"), `content of ${assetDir}`);
  }
  mkdirSync(join(dir, "src", "scripts"), { recursive: true });
  writeFileSync(join(dir, "src", "scripts", "proxy-token.sh"), "#!/bin/sh\n");
  for (const file of MATERIALIZED_ASSET_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `content of ${file}`);
  }
  for (const file of BUNDLED_ONLY_ASSETS) {
    writeFileSync(join(dir, file), `content of ${file}`);
  }
}

/** The assets-only plan for a compiled binary: materialize into `dest` as-is. */
function assetsOnlyPlan(options: InstallOptions = ASSETS_ONLY): InstallPlan {
  return buildInstallPlan(options, dest, source);
}

/** The FULL installed-mode plan: builds the versioned layout at `dest`. */
function versionedPlan(
  options: InstallOptions = QUIET,
  binarySource: string | null = null,
): InstallPlan {
  return buildInstallPlan(options, dest, source, binarySource);
}

/** The version-dir name every full plan in this suite targets. */
const VERSION_NAME = versionDirName(packageVersion());

/** A stand-in compiled binary next to nothing in particular. */
function writeFakeBinary(path: string, content = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "copilot-installer-"));
  source = join(root, "vfs");
  dest = join(root, "install");
  mkdirSync(source, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeAssetSource(source);
  // Redirect any rc/profile inspection at an empty sandbox, so wiredShellTargets
  // (used by layout adoption) never reads this machine's real shell files.
  process.env[CI_RC_DIR_ENV] = join(root, "rc");
  process.env[CI_PS_DOCUMENTS_DIR_ENV] = join(root, "rc");
  mkdirSync(join(root, "rc"), { recursive: true });
});

afterEach(() => {
  restoreEnv();
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("buildInstallPlan", () => {
  test("a checkout (asset source IS the root) plans no file writes", () => {
    // A dev checkout already has its own bin/agent and working files; an
    // install must never overwrite them. In-place applies before the checkout
    // refusal, so a checkout installing into itself never trips it either.
    writeFileSync(join(source, "package.json"), "{}");
    mkdirSync(join(source, ".git"));
    const plan = buildInstallPlan(OPTIONS, source, source);
    expect(plan.kind).toBe("in-place");
    if (plan.kind !== "in-place") throw new Error("expected an in-place plan");
    expect(plan.shell).toEqual({ allHosts: false });
  });

  test("assets-only plans copies for every materialized asset, into the aimed root", () => {
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    const targets = plan.copies.map((c) => c.to);
    for (const dir of MATERIALIZED_ASSET_DIRS) {
      expect(targets.some((t) => t.startsWith(join(dest, dir)))).toBe(true);
    }
    for (const file of MATERIALIZED_ASSET_FILES) {
      expect(targets).toContain(join(dest, file));
    }
    expect(plan.shell).toBeNull();
  });

  test("bundled-only assets are verified but never written", () => {
    // They are read out of the VFS through ASSET_ROOT. A copy in the install
    // root would be a second source of truth that an update can leave stale.
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    for (const file of BUNDLED_ONLY_ASSETS) {
      expect(plan.copies.map((c) => c.to)).not.toContain(join(dest, file));
    }
  });

  test("a missing bundled-only asset still fails the plan", () => {
    rmSync(join(source, "copilot-env.config"));
    expect(() => assetsOnlyPlan()).toThrow("embedded assets are missing copilot-env.config");
  });

  test("assets-only plans the launcher shims beside the binary", () => {
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    expect(plan.shims.map((s) => s.to)).toEqual([
      join(dest, "bin", "agent"),
      join(dest, "bin", "agent.ps1"),
    ]);
  });

  test("only .sh assets are planned executable", () => {
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    for (const copy of plan.copies) {
      expect(copy.executable).toBe(copy.to.endsWith(".sh"));
    }
  });

  test("refuses a binary whose embedded assets are incomplete", () => {
    // Anything the plan expects to find in the VFS but that compile.ts never
    // embedded has to fail loudly here, not produce a half-built install.
    rmSync(join(source, "shell"), { recursive: true, force: true });
    expect(() => assetsOnlyPlan()).toThrow("embedded assets are missing shell");

    writeAssetSource(source);
    rmSync(join(source, ".dvmrc"));
    expect(() => assetsOnlyPlan()).toThrow("embedded assets are missing .dvmrc");

    writeAssetSource(source);
    rmSync(join(source, "src", "utils", "json.ts"));
    expect(() => assetsOnlyPlan()).toThrow("embedded assets are missing src/utils/json.ts");
  });

  test("assets-only plans removal of only the superseded artifacts actually present", () => {
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    // Only what is actually there: an install must not report removing files
    // it never found.
    expect(plan.legacyRemovals).toEqual([join(dest, "node_modules")]);
    expect(LEGACY_ARTIFACTS.length).toBeGreaterThan(0);
  });
});

describe("the versioned full-install plan", () => {
  test("targets versions/v<packageVersion> and the current link at the top", () => {
    const plan = versionedPlan();
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");

    expect(plan.top).toBe(dest);
    expect(plan.versionName).toBe(VERSION_NAME);
    expect(plan.versionRoot).toBe(join(dest, VERSIONS_DIR, VERSION_NAME));
    // Every write aims INSIDE the version root; nothing lands flat at the top.
    for (const copy of plan.copies) {
      expect(copy.to.startsWith(plan.versionRoot)).toBe(true);
    }
    expect(plan.manifest.to).toBe(join(plan.versionRoot, INSTALL_MANIFEST_FILE));
    expect(plan.shims.map((s) => s.to)).toEqual([
      join(plan.versionRoot, "bin", "agent"),
      join(plan.versionRoot, "bin", "agent.ps1"),
    ]);
    expect(plan.topShims.map((s) => s.to)).toEqual([
      join(dest, "bin", "agent"),
      join(dest, "bin", "agent.ps1"),
    ]);
    expect(plan.topShims.map((s) => s.text)).toEqual([
      POSIX_CURRENT_SHIM,
      POWERSHELL_CURRENT_SHIM,
    ]);
  });

  test("a full plan aimed at the current link resolves to the same top", () => {
    // A versioned binary re-running `agent install` is rooted at `<top>/current`;
    // the layout work must land at the top, never nest inside the version dir.
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.0"), { recursive: true });
    pointCurrentAt(dest, "v1.0.0");
    const plan = buildInstallPlan(QUIET, join(dest, CURRENT_LINK), source);
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(plan.top).toBe(dest);
  });

  test("a binary reached through the current link is never copied onto itself", () => {
    // Canonical identity, not lexical: `<top>/current/bin/...` and the version
    // path name the same file, and copyFileSync onto the same inode TRUNCATES
    // the live binary before reading it.
    const inVersion = writeFakeBinary(
      join(dest, VERSIONS_DIR, VERSION_NAME, "bin", installedBinaryName()),
      "LIVE",
    );
    pointCurrentAt(dest, VERSION_NAME);
    const throughLink = join(dest, CURRENT_LINK, "bin", installedBinaryName());

    for (const alias of [inVersion, throughLink]) {
      const plan = versionedPlan(QUIET, alias);
      if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
      expect(plan.binary).toBeNull();
    }
    applyInstallPlan(versionedPlan(QUIET, throughLink));
    expect(readFileSync(inVersion, "utf8")).toBe("LIVE"); // never truncated
  });

  test("plans the binary copy, and skips it when the binary is already in place", () => {
    const binarySource = writeFakeBinary(join(root, "downloaded-binary"));
    const plan = versionedPlan(QUIET, binarySource);
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(plan.binary).toEqual({
      from: binarySource,
      to: join(plan.versionRoot, "bin", installedBinaryName()),
    });

    // Already at its target (a same-version refresh): nothing to copy.
    const inPlace = versionedPlan(
      QUIET,
      join(dest, VERSIONS_DIR, VERSION_NAME, "bin", installedBinaryName()),
    );
    if (inPlace.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(inPlace.binary).toBeNull();

    // No standalone binary running (a dev process): nothing to contribute.
    const none = versionedPlan(QUIET, null);
    if (none.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(none.binary).toBeNull();
  });

  test("applying builds the layout: version root, link, top shims, per-version manifest", () => {
    const binarySource = writeFakeBinary(join(dest, "bin", installedBinaryName()), "BINARY");
    applyInstallPlan(versionedPlan(QUIET, binarySource));

    const versionRoot = join(dest, VERSIONS_DIR, VERSION_NAME);
    // The version root is a complete install root of its own.
    expect(readFileSync(join(versionRoot, "shell", "payload.txt"), "utf8")).toBe(
      "content of shell",
    );
    expect(readFileSync(join(versionRoot, "bin", "agent"), "utf8")).toBe(POSIX_SHIM);
    expect(readFileSync(join(versionRoot, "bin", "agent.ps1"), "utf8")).toBe(POWERSHELL_SHIM);
    expect(readFileSync(join(versionRoot, "bin", installedBinaryName()), "utf8")).toBe("BINARY");
    const manifest = JSON.parse(
      readFileSync(join(versionRoot, INSTALL_MANIFEST_FILE), "utf8"),
    );
    expect(manifest.version).toBe(packageVersion());

    // The top carries only the layout: the current link and the stable shims.
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);
    expect(readFileSync(join(dest, "bin", "agent.ps1"), "utf8")).toBe(POWERSHELL_CURRENT_SHIM);
    // The flat binary was superseded by the copy inside the version root.
    expect(existsSync(join(dest, "bin", installedBinaryName()))).toBe(false);
    // No flat manifest: the sentinel lives per-version.
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(false);

    // The link DISPATCHES: reads through <top>/current reach the live version.
    expect(readFileSync(join(dest, CURRENT_LINK, "bin", installedBinaryName()), "utf8")).toBe(
      "BINARY",
    );
    expect(readFileSync(join(dest, CURRENT_LINK, "shell", "payload.txt"), "utf8")).toBe(
      "content of shell",
    );
  });

  test("re-applying over an existing versioned install is idempotent", () => {
    applyInstallPlan(versionedPlan());
    const versionRoot = join(dest, VERSIONS_DIR, VERSION_NAME);
    writeFileSync(join(versionRoot, "shell", "payload.txt"), "locally edited");
    applyInstallPlan(versionedPlan());
    expect(readFileSync(join(versionRoot, "shell", "payload.txt"), "utf8")).toBe(
      "content of shell",
    );
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
  });

  test("a flat root's runtime files are swept only AFTER the flip", () => {
    // Seed a flat-layout install: runtime files and manifest at the top.
    writeAssetSource(dest);
    rmSync(join(dest, "copilot-env.config"));
    rmSync(join(dest, ".dvmrc"));
    rmSync(join(dest, "deno.json")); // flat installs never materialized these
    writeFileSync(join(dest, INSTALL_MANIFEST_FILE), "{}");
    mkdirSync(join(dest, "node_modules"), { recursive: true });

    const plan = versionedPlan();
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(plan.flatRemovals).toContain(join(dest, "shell"));
    expect(plan.flatRemovals).toContain(join(dest, INSTALL_MANIFEST_FILE));
    expect(plan.flatRemovals).toContain(join(dest, "node_modules"));

    applyInstallPlan(plan);
    expect(existsSync(join(dest, "shell"))).toBe(false);
    expect(existsSync(join(dest, "skills"))).toBe(false);
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(false);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    // The per-file sweep also prunes the emptied src scaffolding.
    expect(existsSync(join(dest, "src"))).toBe(false);
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
  });

  skipWin("wires the shell through the INSTALLED binary, aimed at the current link", () => {
    // The installing process may be rooted at the flat top, so only the
    // installed binary (aimed at <top>/current) derives rc paths that survive
    // updates. The fake binary records its argv and the aim.
    const recorder = `#!/bin/sh
echo "\${${INSTALL_ROOT_ENV}:-} $@" >> "$(dirname "$0")/../../../wires.log"
`;
    const binarySource = writeFakeBinary(join(root, "recorder.sh"), recorder);
    const plan = versionedPlan({ ...OPTIONS, allHosts: false }, binarySource);
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(plan.shellWires).toEqual([{ allHosts: false }]);

    applyInstallPlan(plan);
    const log = readFileSync(join(dest, "wires.log"), "utf8").trim();
    expect(log).toBe(`${join(dest, CURRENT_LINK)} shell`);
  });

  skipWin("a failed shell rewire KEEPS the flat payload the rc block still sources", () => {
    // Sweeping shell/ after a failed rewire would leave the user's rc block
    // pointing at nothing; a stale payload that works beats that.
    mkdirSync(join(dest, "shell"), { recursive: true });
    writeFileSync(join(dest, "shell", "agents.bashrc"), "flat payload");
    writeFileSync(join(dest, INSTALL_MANIFEST_FILE), "{}");
    const failing = writeFakeBinary(join(root, "failing.sh"), "#!/bin/sh\nexit 1\n");

    applyInstallPlan(versionedPlan({ ...OPTIONS, allHosts: false }, failing));

    expect(readFileSync(join(dest, "shell", "agents.bashrc"), "utf8")).toBe("flat payload");
    // Everything else superseded still went.
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(false);
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
  });
});

describe("the current link primitives", () => {
  test("pointCurrentAt creates and REPLACES the link; readCurrentVersionName round-trips", () => {
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.0"), { recursive: true });
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.1"), { recursive: true });
    writeFileSync(join(dest, VERSIONS_DIR, "v1.0.0", "who"), "one");
    writeFileSync(join(dest, VERSIONS_DIR, "v1.0.1", "who"), "two");

    expect(readCurrentVersionName(dest)).toBeNull(); // no link yet

    pointCurrentAt(dest, "v1.0.0");
    expect(readCurrentVersionName(dest)).toBe("v1.0.0");
    expect(readFileSync(join(dest, CURRENT_LINK, "who"), "utf8")).toBe("one");

    // The flip: replace the live link (the update commit step).
    pointCurrentAt(dest, "v1.0.1");
    expect(readCurrentVersionName(dest)).toBe("v1.0.1");
    expect(readFileSync(join(dest, CURRENT_LINK, "who"), "utf8")).toBe("two");

    // ROLLBACK: pointing back at the kept previous version must just work.
    pointCurrentAt(dest, "v1.0.0");
    expect(readCurrentVersionName(dest)).toBe("v1.0.0");
    expect(readFileSync(join(dest, CURRENT_LINK, "who"), "utf8")).toBe("one");
  });

  skipWin("the POSIX link target is RELATIVE, so the install stays relocatable", () => {
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.0"), { recursive: true });
    pointCurrentAt(dest, "v1.0.0");
    expect(readlinkSync(currentLinkPath(dest))).toBe(join(VERSIONS_DIR, "v1.0.0"));
  });

  winOnly("the Windows link is a junction (usable without the symlink privilege)", () => {
    // CI's Windows matrix is what actually executes this: the junction is the
    // one reparse kind stock PowerShell 5.1 and unprivileged users both handle.
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.0"), { recursive: true });
    writeFileSync(join(dest, VERSIONS_DIR, "v1.0.0", "who"), "one");
    pointCurrentAt(dest, "v1.0.0");
    const stat = lstatSync(currentLinkPath(dest));
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
    expect(readCurrentVersionName(dest)).toBe("v1.0.0");
    expect(readFileSync(join(dest, CURRENT_LINK, "who"), "utf8")).toBe("one");
    // And the flip-while-open property: replacing the junction never touches
    // the target dir's contents.
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.1"), { recursive: true });
    pointCurrentAt(dest, "v1.0.1");
    expect(readFileSync(join(dest, VERSIONS_DIR, "v1.0.0", "who"), "utf8")).toBe("one");
  });

  test("classifyInstallRoot: flat, top-shaped, and current-shaped spellings", () => {
    expect(classifyInstallRoot(dest)).toEqual({ kind: "flat", top: dest });
    // The name `current` alone (no versions/ sibling) is just a directory.
    expect(classifyInstallRoot(join(dest, CURRENT_LINK))).toEqual({
      kind: "flat",
      top: join(dest, CURRENT_LINK),
    });

    // A REAL directory named `current` beside a versions/ dir is still not the
    // layout: only a link into versions/ is (coincidental names must never
    // reroute an install).
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.0"), { recursive: true });
    mkdirSync(join(dest, CURRENT_LINK));
    expect(classifyInstallRoot(dest)).toEqual({ kind: "flat", top: dest });
    rmSync(join(dest, CURRENT_LINK), { recursive: true });

    pointCurrentAt(dest, "v1.0.0");
    expect(classifyInstallRoot(dest)).toEqual({ kind: "versioned", top: dest });
    expect(classifyInstallRoot(join(dest, CURRENT_LINK))).toEqual({
      kind: "versioned",
      top: dest,
    });
  });

  skipWin("writeTopLevelShims repairs a lost exec bit even when the text is current", () => {
    // The identical-text shortcut must not freeze a broken mode: a crash
    // between an earlier write and its chmod would otherwise persist forever.
    writeTopLevelShims(dest);
    chmodSync(join(dest, "bin", "agent"), 0o644);
    writeTopLevelShims(dest);
    expect(statSync(join(dest, "bin", "agent")).mode & 0o111).not.toBe(0);
  });

  test("removeVersionDirsExcept keeps exactly the named versions", () => {
    for (const name of ["v1.0.0", "v1.0.1", "v1.0.2"]) {
      mkdirSync(join(dest, VERSIONS_DIR, name), { recursive: true });
      writeFileSync(join(dest, VERSIONS_DIR, name, "file"), name);
    }
    removeVersionDirsExcept(dest, new Set(["v1.0.2", "v1.0.1"]));
    expect(existsSync(join(dest, VERSIONS_DIR, "v1.0.0"))).toBe(false);
    expect(existsSync(join(dest, VERSIONS_DIR, "v1.0.1"))).toBe(true);
    expect(existsSync(join(dest, VERSIONS_DIR, "v1.0.2"))).toBe(true);
    // No versions dir at all: a silent no-op, never a throw.
    removeVersionDirsExcept(join(root, "nowhere"), new Set());
  });

  test("removeFlatBinaryResidue sweeps the flat binary and .old- aside files only", () => {
    const name = installedBinaryName();
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(dest, "bin", name), "flat");
    writeFileSync(join(dest, "bin", `${name}.old-123`), "aside");
    writeFileSync(join(dest, "bin", "agent"), "shim");
    removeFlatBinaryResidue(dest);
    expect(existsSync(join(dest, "bin", name))).toBe(false);
    expect(existsSync(join(dest, "bin", `${name}.old-123`))).toBe(false);
    expect(existsSync(join(dest, "bin", "agent"))).toBe(true);
  });
});

describe("the unsafe-target canonical guard", () => {
  // The shell installers keep only a lexical pre-check before they download;
  // the CANONICAL refusal lives in the plan, because the install root is
  // DERIVED (binary location or COPILOT_ENV_INSTALL_ROOT) and the plan's
  // writes and removals aim at it. Building a plan writes nothing, so
  // aiming one at the real home directory here is safe.
  test("refuses the home directory as an installed-mode target", () => {
    expect(() => buildInstallPlan(OPTIONS, homedir(), source)).toThrow(
      "it is the home directory",
    );
    expect(() => buildInstallPlan(ASSETS_ONLY, homedir(), source)).toThrow(
      "it is the home directory",
    );
  });

  test("refuses a filesystem root", () => {
    expect(() => buildInstallPlan(OPTIONS, parse(dest).root, source)).toThrow(
      "it is a filesystem root",
    );
  });

  skipWin("refuses a symlink alias of the home directory", () => {
    // Exactly what a lexical string comparison cannot catch -- the reason the
    // check is canonical.
    const alias = join(root, "home-alias");
    symlinkSync(homedir(), alias);
    expect(() => buildInstallPlan(OPTIONS, alias, source)).toThrow(
      "it is the home directory",
    );
  });

  winOnly("refuses a junction alias of the home directory", () => {
    // The Windows spelling of the same alias class the removed install.ps1
    // P/Invoke resolver used to catch; realpath resolves junctions too.
    const alias = join(root, "home-alias");
    symlinkSync(homedir(), alias, "junction");
    expect(() => buildInstallPlan(OPTIONS, alias, source)).toThrow(
      "it is the home directory",
    );
  });

  skipWin("refuses a target whose path cannot be canonicalized", () => {
    // A dangling symlink IS a directory entry, so it must not be peeled as a
    // not-yet-existing tail: realpath cannot prove where it leads.
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "nowhere"), dangling);
    expect(() => buildInstallPlan(OPTIONS, dangling, source)).toThrow(
      "cannot be resolved",
    );
  });

  test("a not-yet-existing target under a safe parent still plans", () => {
    const fresh = join(dest, "not-yet", "there");
    expect(buildInstallPlan(OPTIONS, fresh, source).kind).toBe("versioned");
  });
});

describe("the checkout guard and the install manifest sentinel", () => {
  // The install root is DERIVED (or an env override), so an installed-mode plan
  // can be aimed at a dev checkout via COPILOT_ENV_INSTALL_ROOT -- and its
  // writes would replace the checkout's bin/agent and src/scripts. The markers
  // alone cannot decide: the pre-binary installer extracted source archives, so
  // those roots carry package.json/deno.json too. `.git` is the discriminant
  // (archives never have one), and the manifest records what a real install is.
  test("refuses a root with checkout markers and .git", () => {
    for (const marker of CHECKOUT_MARKERS) {
      writeFileSync(join(dest, marker), "{}");
      mkdirSync(join(dest, ".git"));
      for (const options of [OPTIONS, ASSETS_ONLY]) {
        expect(() => buildInstallPlan(options, dest, source)).toThrow(
          `refusing to install into ${dest}`,
        );
        expect(() => buildInstallPlan(options, dest, source)).toThrow(marker);
        expect(() => buildInstallPlan(options, dest, source)).toThrow(".git");
      }
      expect(isCheckoutShapedRoot(dest)).toBe(true);
      expect(flatArtifactPaths(dest)).toEqual([]); // NEVER ours to sweep
      rmSync(join(dest, ".git"), { recursive: true });
      // A worktree carries .git as a FILE; both spellings must refuse.
      writeFileSync(join(dest, ".git"), "gitdir: /elsewhere");
      expect(() => buildInstallPlan(OPTIONS, dest, source)).toThrow(
        `refusing to install into ${dest}`,
      );
      rmSync(join(dest, ".git"));
      rmSync(join(dest, marker));
    }
    expect(CHECKOUT_MARKERS).toContain("package.json");
    expect(CHECKOUT_MARKERS).toContain("deno.json");
  });

  test("even a valid manifest does not override .git: a live checkout always refuses", () => {
    applyInstallPlan(assetsOnlyPlan());
    writeFileSync(join(dest, "package.json"), "{}");
    mkdirSync(join(dest, ".git"));
    expect(() => buildInstallPlan(OPTIONS, dest, source)).toThrow(
      `refusing to install into ${dest}`,
    );
  });

  test("a legacy source-archive root (markers, no .git) is swept and versioned over", () => {
    // The source-archive installer era left roots byte-indistinguishable from a
    // checkout minus .git; their first full install must proceed, remove the
    // stale markers alongside the other superseded artifacts, and leave a
    // versioned layout whose manifest is positively an install's.
    writeFileSync(join(dest, "package.json"), "{}");
    writeFileSync(join(dest, "deno.json"), "{}");
    mkdirSync(join(dest, "node_modules"), { recursive: true });

    const plan = versionedPlan();
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(plan.flatRemovals).toContain(join(dest, "package.json"));
    expect(plan.flatRemovals).toContain(join(dest, "deno.json"));
    expect(plan.flatRemovals).toContain(join(dest, "node_modules"));

    applyInstallPlan(plan);
    expect(existsSync(join(dest, "package.json"))).toBe(false);
    expect(existsSync(join(dest, "deno.json"))).toBe(false);
    expect(existsSync(join(dest, VERSIONS_DIR, VERSION_NAME, INSTALL_MANIFEST_FILE))).toBe(true);
  });

  test("a fresh root installs and gains the per-version manifest", () => {
    applyInstallPlan(assetsOnlyPlan());

    const manifest = JSON.parse(readFileSync(join(dest, INSTALL_MANIFEST_FILE), "utf8"));
    expect(manifest).toEqual({
      version: packageVersion(),
      kind: "installed",
      assets: [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES],
    });
  });

  test("an update over a manifest-carrying root refreshes the manifest", () => {
    // A stale manifest (older release, superseded inventory) is rewritten
    // wholesale by the release that owns the assets.
    writeFileSync(
      join(dest, INSTALL_MANIFEST_FILE),
      JSON.stringify({ "version": "0.0.1", "kind": "installed", "assets": [] }),
    );

    applyInstallPlan(assetsOnlyPlan());

    const manifest = JSON.parse(readFileSync(join(dest, INSTALL_MANIFEST_FILE), "utf8"));
    expect(manifest.version).toBe(packageVersion());
    expect(manifest.assets).toEqual([...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES]);
  });
});

describe("applyInstallPlan (assets-only)", () => {
  test("materializes the assets and shims, and removes superseded artifacts", () => {
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    writeFileSync(join(dest, "node_modules", "stale"), "stale");

    applyInstallPlan(assetsOnlyPlan());

    expect(readFileSync(join(dest, "shell", "payload.txt"), "utf8")).toBe("content of shell");
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe(POSIX_SHIM);
    expect(readFileSync(join(dest, "bin", "agent.ps1"), "utf8")).toBe(POWERSHELL_SHIM);
    expect(() => statSync(join(dest, "node_modules"))).toThrow();
  });

  skipWin("makes the shim and the .sh assets executable", () => {
    applyInstallPlan(assetsOnlyPlan());

    expect(statSync(join(dest, "bin", "agent")).mode & 0o111).not.toBe(0);
    // The .sh exec-bit rule now mostly guards the one-release proxy-token FORWARDER
    // (and this synthetic fixture): the resolver itself is `agent proxy-token`.
    expect(statSync(join(dest, "src", "scripts", "proxy-token.sh")).mode & 0o111).not.toBe(0);
    // The PowerShell shim is never exec'd by an OS loader.
    expect(statSync(join(dest, "bin", "agent.ps1")).mode & 0o111).toBe(0);
  });

  test("re-applying over an existing install is idempotent", () => {
    applyInstallPlan(assetsOnlyPlan());
    writeFileSync(join(dest, "shell", "payload.txt"), "locally edited");
    applyInstallPlan(assetsOnlyPlan());

    expect(readFileSync(join(dest, "shell", "payload.txt"), "utf8")).toBe("content of shell");
  });
});

describe("adoptVersionedLayout (the 3.5.6 migration core)", () => {
  /** A flat install fixture: the live binary plus flat runtime files at `top`. */
  function seedFlatInstall(top: string): string {
    const binary = writeFakeBinary(join(top, "bin", installedBinaryName()), "LIVE");
    for (const dir of ["shell", "skills"]) {
      mkdirSync(join(top, dir), { recursive: true });
      writeFileSync(join(top, dir, "payload.txt"), "flat");
    }
    writeFileSync(join(top, INSTALL_MANIFEST_FILE), "{}");
    return binary;
  }

  test("builds the layout around the live flat binary, then sweeps the flat files", () => {
    const binary = seedFlatInstall(dest);
    adoptVersionedLayout({
      mode: { kind: "compiled", root: dest },
      sourceRoot: source,
      binarySource: binary,
    });

    const versionRoot = versionRootPath(dest, VERSION_NAME);
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
    expect(readFileSync(join(versionRoot, "bin", installedBinaryName()), "utf8")).toBe("LIVE");
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);
    expect(existsSync(join(versionRoot, INSTALL_MANIFEST_FILE))).toBe(true);
    // Flat leftovers: runtime files and manifest swept, binary superseded.
    expect(existsSync(join(dest, "shell"))).toBe(false);
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(false);
    if (process.platform !== "win32") {
      expect(existsSync(join(dest, "bin", installedBinaryName()))).toBe(false);
    }
    // The version root carries every marker uninstall requires of a root.
    for (const marker of INSTALL_ROOT_MARKERS) {
      expect(existsSync(join(versionRoot, marker))).toBe(true);
    }
  });

  test("an already-versioned root REPAIRS the commit window (idempotent re-run)", () => {
    const binary = seedFlatInstall(dest);
    adoptVersionedLayout({
      mode: { kind: "compiled", root: dest },
      sourceRoot: source,
      binarySource: binary,
    });

    // A crashed earlier run: the flip landed, but the top shims were never
    // rewritten, flat debris reappeared, and the flat binary residue survived.
    // The retry must converge all of it, not just re-sweep.
    writeFileSync(join(dest, INSTALL_MANIFEST_FILE), "{}");
    writeFileSync(join(dest, "bin", "agent"), "stale adjacent-dispatch shim");
    writeFakeBinary(join(dest, "bin", installedBinaryName()), "FLAT-RESIDUE");
    adoptVersionedLayout({
      mode: { kind: "compiled", root: join(dest, CURRENT_LINK) },
      sourceRoot: source,
      binarySource: null,
    });

    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(false);
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);
    if (process.platform !== "win32") {
      expect(existsSync(join(dest, "bin", installedBinaryName()))).toBe(false);
    }
    expect(readCurrentVersionName(dest)).toBe(VERSION_NAME);
  });

  test("a dangling current link HALTS the repair instead of deleting the fallback", () => {
    const binary = seedFlatInstall(dest);
    adoptVersionedLayout({
      mode: { kind: "compiled", root: dest },
      sourceRoot: source,
      binarySource: binary,
    });

    // Break the layout: the live version dir is gone (the link dangles), and
    // the flat binary is the only thing that still runs. The repair must not
    // sweep it, or write shims that dispatch into nothing.
    rmSync(join(dest, VERSIONS_DIR, VERSION_NAME), { recursive: true, force: true });
    writeFakeBinary(join(dest, "bin", installedBinaryName()), "FALLBACK");
    writeFileSync(join(dest, INSTALL_MANIFEST_FILE), "{}");
    adoptVersionedLayout({
      mode: { kind: "compiled", root: join(dest, CURRENT_LINK) },
      sourceRoot: source,
      binarySource: null,
    });

    expect(readFileSync(join(dest, "bin", installedBinaryName()), "utf8")).toBe("FALLBACK");
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(true); // nothing swept
  });

  test("a checkout-shaped top is never repaired: launchers and wiring stay untouched", () => {
    // Reachable state: `agent update --force` on a dev clone builds versions/ +
    // current INSIDE the checkout (commit() skips the shims there), then the
    // post-flip migrate runs this adoption. The repair arm must apply the same
    // checkout guard -- the clone's bin/agent(.ps1) are TRACKED SOURCE, and
    // overwriting them breaks "a checkout can never be overwritten by an
    // install".
    writeFileSync(join(dest, "package.json"), "{}");
    mkdirSync(join(dest, ".git"));
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(dest, "bin", "agent"), "dev launcher");
    // A COMPLETE version behind the link (binary + matching manifest), so only
    // the checkout guard stands between the repair arm and the overwrite. The
    // binary is an EXECUTABLE recorder: any shell rewire attempt would leave
    // wires.log (non-executable, the absence would prove nothing).
    const versionRoot = versionRootPath(dest, VERSION_NAME);
    const recorder = writeFakeBinary(
      join(versionRoot, "bin", installedBinaryName()),
      `#!/bin/sh\necho "$@" >> "$(dirname "$0")/../../../wires.log"\n`,
    );
    chmodSync(recorder, 0o755);
    writeFileSync(
      join(versionRoot, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        "version": packageVersion(),
        "kind": "installed",
        "assets": ["shell"],
      }),
    );
    pointCurrentAt(dest, VERSION_NAME);
    // A wired rc block in the sandbox: without the guard it would be rewired.
    writeFileSync(join(root, "rc", ".bashrc"), "# copilot-env shell integration\n");

    adoptVersionedLayout({
      mode: { kind: "compiled", root: join(dest, CURRENT_LINK) },
      sourceRoot: source,
      binarySource: null,
    });

    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe("dev launcher");
    expect(existsSync(join(dest, "bin", "agent.ps1"))).toBe(false);
    expect(existsSync(join(dest, "wires.log"))).toBe(false); // no rewire spawned
    expect(existsSync(join(dest, "package.json"))).toBe(true); // nothing swept
  });

  test("a source checkout never adopts", () => {
    adoptVersionedLayout({
      mode: { kind: "checkout", root: dest },
      sourceRoot: source,
      binarySource: null,
    });
    expect(existsSync(join(dest, VERSIONS_DIR))).toBe(false);
    expect(existsSync(currentLinkPath(dest))).toBe(false);
  });
});

describe("wiredShellTargets", () => {
  /** The rc/profile file the adoption inspects in this suite's sandbox. */
  function sandboxRcFile(): string {
    return process.platform === "win32"
      ? join(root, "rc", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")
      : join(root, "rc", ".bashrc");
  }

  test("an unwired rc yields no rewire targets (the opt-out is honored)", () => {
    const file = sandboxRcFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export UNRELATED=1\n");
    expect(wiredShellTargets()).toEqual([]);
  });

  test("a launchers-only rc counts as wired: the shell pass must migrate its opt-in", () => {
    // A pre-`agent launch` user could carry ONLY the launchers block (main
    // integration removed by hand). The adoption's shell pass is what carries
    // that opt-in to the `launchers` config key and strips the retired block,
    // so such an rc must still be a rewire target.
    const file = sandboxRcFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# copilot-env launchers\n# copilot-env launchers end\n");
    expect(wiredShellTargets()).toEqual([{ allHosts: false }]);
  });
});

describe("launcher shims", () => {
  test("per-version shims dispatch to the compiled binary next to them", () => {
    // The per-version shims are what `<top>/current/bin/agent` resolves to, so
    // their dispatch target is a contract with the layout (the binary sits
    // beside them inside the version root).
    expect(POSIX_SHIM).toContain('exec "$HERE/copilot-env" "$@"');
    expect(POSIX_SHIM.startsWith("#!/bin/sh\n")).toBe(true);
    expect(POWERSHELL_SHIM).toContain("copilot-env.exe");
    expect(POWERSHELL_SHIM).toContain("exit $LASTEXITCODE");
  });

  test("top-level shims dispatch through the current link", () => {
    // The stable PATH entry: one release-independent hop, so updates never
    // rewrite the file a user's PATH (or a persisted config) points at.
    expect(POSIX_CURRENT_SHIM).toContain('exec "$HERE/../current/bin/copilot-env" "$@"');
    expect(POSIX_CURRENT_SHIM.startsWith("#!/bin/sh\n")).toBe(true);
    expect(POWERSHELL_CURRENT_SHIM).toContain("current\\bin\\copilot-env.exe");
    expect(POWERSHELL_CURRENT_SHIM).toContain("exit $LASTEXITCODE");
  });
});

describe("the install root carries the markers uninstall requires", () => {
  // `agent uninstall` deletes the resolved root wholesale, and in a compiled
  // install that root is DERIVED from the binary's location -- so root.ts
  // refuses any root missing these markers (a binary dropped in
  // ~/.local/bin would otherwise aim `rm -rf` at ~/.local). That makes them a
  // contract ON this installer: narrowing MATERIALIZED_ASSET_DIRS below them turns
  // uninstall into a silent no-op on every install.
  //
  test("applying a plan produces every marker directory", () => {
    applyInstallPlan(assetsOnlyPlan());

    for (const marker of INSTALL_ROOT_MARKERS) {
      expect(statSync(join(dest, marker)).isDirectory()).toBe(true);
    }
  });

  test("the asset lists cannot be narrowed below the markers", () => {
    // Fails at the list, not only at the applied result, so the intent is
    // visible when someone edits MATERIALIZED_ASSET_DIRS. `bin` is absent from it
    // on purpose: the shims create that directory.
    expect(MATERIALIZED_ASSET_DIRS).toContain("shell");
    expect(MATERIALIZED_ASSET_DIRS).toContain("src/scripts");
  });
});
