import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import {
  applyInstallPlan,
  buildInstallPlan,
  BUNDLED_ONLY_ASSETS,
  CHECKOUT_MARKERS,
  CURRENT_LINK,
  currentLinkPath,
  INSTALL_ROOT_ENV,
  type InstallOptions,
  type InstallPlan,
  isCheckoutShapedRoot,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
  pointCurrentAt,
  POSIX_CURRENT_SHIM,
  POSIX_SHIM,
  POWERSHELL_CURRENT_SHIM,
  POWERSHELL_SHIM,
  readCurrentVersionName,
  removeVersionDirsExcept,
  versionDirName,
  VERSIONS_DIR,
  writeTopLevelShims,
} from "../src/install/installer.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { installedBinaryName } from "../src/install/targets.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../src/shell/integration.ts";
import { INSTALL_MANIFEST_FILE, INSTALL_ROOT_MARKERS } from "../src/utils/root.ts";
import { packageVersion } from "../src/utils/version.ts";
import { envSnapshot } from "./helpers/env.ts";
import { runSync } from "./helpers/run.ts";
import { afterEach, beforeEach, describe, expect, tempDir, test } from "./helpers/testing.ts";

const OPTIONS: InstallOptions = { noShellIntegration: false, allHosts: false, assetsOnly: false };
/** Plans no shell wiring: applying spawns the binary only for a migration over a prior version. */
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
  writeFileSync(join(dir, "src", "scripts", "example.sh"), "#!/bin/sh\n");
  for (const file of MATERIALIZED_ASSET_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `content of ${file}`);
  }
  for (const file of BUNDLED_ONLY_ASSETS) {
    writeFileSync(join(dir, file), `content of ${file}`);
  }
}

function assetsOnlyPlan(options: InstallOptions = ASSETS_ONLY): InstallPlan {
  return buildInstallPlan(options, dest, source);
}

function versionedPlan(
  options: InstallOptions = QUIET,
  binarySource: string | null = null,
): InstallPlan {
  return buildInstallPlan(options, dest, source, binarySource);
}

const VERSION_NAME = versionDirName(packageVersion());

function writeFakeBinary(path: string, content = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  root = tempDir("copilot-installer-");
  source = join(root, "vfs");
  dest = join(root, "install");
  mkdirSync(source, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeAssetSource(source);
  // Redirect any rc/profile inspection at an empty sandbox, so nothing here reads this
  // machine's real shell files.
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
    // A checkout has its own bin/agent and working files, so an install never overwrites
    // them. In-place applies before the checkout refusal, so a checkout installing into
    // itself never trips it.
    writeFileSync(join(source, "package.json"), "{}");
    mkdirSync(join(source, ".git"));
    const plan = buildInstallPlan(OPTIONS, source, source);
    expect(plan.kind).toBe("in-place");
    if (plan.kind !== "in-place") throw new Error("expected an in-place plan");
    expect(plan.shell).toEqual({ allHosts: false });
  });

  test("bundled-only assets are verified but never written", () => {
    // They are read out of the VFS through ASSET_ROOT. A copy in the install
    // root would be a second source of truth that an update can leave stale.
    const plan = assetsOnlyPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    for (const file of BUNDLED_ONLY_ASSETS) {
      expect(plan.writes.map((w) => w.to)).not.toContain(join(dest, file));
    }
  });

  test("refuses a binary whose embedded assets are incomplete, naming the missing one", () => {
    // Anything the plan expects to find in the VFS but that compile.ts never
    // embedded has to fail loudly here, not produce a half-built install.
    const missing = ["shell", ".dvmrc", "src/utils/json.ts", "copilot-env.config"];
    for (const asset of missing) {
      writeAssetSource(source);
      rmSync(join(source, asset), { recursive: true, force: true });
      expect(() => assetsOnlyPlan(), asset).toThrow(`embedded assets are missing ${asset}`);
    }
  });
});

describe("the versioned full-install plan", () => {
  test("targets versions/v<packageVersion> and the current link at the top", () => {
    const plan = versionedPlan();
    if (plan.kind !== "versioned") throw new Error("expected a versioned plan");

    expect(plan.top).toBe(dest);
    expect(plan.versionName).toBe(VERSION_NAME);
    expect(plan.versionRoot).toBe(join(dest, VERSIONS_DIR, VERSION_NAME));
    // Every write aims INSIDE the version root; nothing lands flat at the top. The manifest is
    // the LAST write: root detection reads it, so a half-laid root never reads as installed.
    const planned = plan.writes.map((w) => w.to);
    for (const to of planned) expect(to.startsWith(plan.versionRoot)).toBe(true);
    expect(planned.at(-1)).toBe(join(plan.versionRoot, INSTALL_MANIFEST_FILE));
    expect(planned).toContain(join(plan.versionRoot, "bin", "agent"));
    expect(planned).toContain(join(plan.versionRoot, "bin", "agent.ps1"));
    expect(plan.topShims.map((s) => s.to)).toEqual([
      join(dest, "bin", "agent"),
      join(dest, "bin", "agent.ps1"),
    ]);
    expect(plan.topShims.map((s) => s.body)).toEqual([
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

  test("re-applying over an existing install is idempotent, versioned and assets-only alike", () => {
    // `current` after the second apply: the versioned layout must still be linked, and
    // assets-only never lays that layout.
    const rows: {
      name: string;
      plan: () => InstallPlan;
      runtimeRoot: string;
      current: string | null;
    }[] = [
      {
        name: "versioned",
        plan: () => versionedPlan(),
        runtimeRoot: join(dest, VERSIONS_DIR, VERSION_NAME),
        current: VERSION_NAME,
      },
      { name: "assets-only", plan: () => assetsOnlyPlan(), runtimeRoot: dest, current: null },
    ];
    for (const { name, plan, runtimeRoot, current } of rows) {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      applyInstallPlan(plan());
      writeFileSync(join(runtimeRoot, "shell", "payload.txt"), "locally edited");
      applyInstallPlan(plan());
      expect(readFileSync(join(runtimeRoot, "shell", "payload.txt"), "utf8"), name).toBe(
        "content of shell",
      );
      expect(readCurrentVersionName(dest), name).toBe(current);
    }
  });

  test("applying a plan names exactly the plan's paths: no live write without a plan entry", () => {
    // The bootstrap binary sits at <top>/bin, where install.sh put it, and is relocated.
    const binarySource = writeFakeBinary(join(dest, "bin", installedBinaryName()), "BINARY");
    const plan = versionedPlan(QUIET, binarySource);
    if (plan.kind !== "versioned" || plan.binary === null) throw new Error("expected a binary");
    expect(plan.bootstrapBinaryRemovals).toEqual([binarySource]);

    const created = [
      ...plan.writes.map((w) => w.to),
      plan.binary.to,
      ...plan.topShims.map((s) => s.to),
    ];
    // Every directory the planned files need that does not exist yet, outermost first
    // per file -- the seam names each one it makes.
    const dirs: string[] = [];
    for (const file of created) {
      const missing: string[] = [];
      for (let dir = dirname(file); !existsSync(dir) && !dirs.includes(dir); dir = dirname(dir)) {
        missing.unshift(dir);
      }
      dirs.push(...missing);
    }
    const expected = [
      ...dirs.map((d) => `created -> ${d}`),
      ...created.map((f) => `created -> ${f}`),
      `linked -> ${plan.currentLink.path} (to ${plan.currentLink.target})`,
      ...plan.bootstrapBinaryRemovals.map((p) => `deleted -> ${p}`),
    ];

    deferWriteReports();
    applyInstallPlan(plan);
    const reported = flushWriteReports();
    expect(reported.sort()).toEqual(expected.sort());
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

  skipWin("an install over a prior version runs the migrations it leaves behind", () => {
    // The same post-flip step `agent update` runs: `migrate <from> <to>` on the installed
    // binary aimed at the current link. The fake binary records every invocation.
    const recorder = `#!/bin/sh
echo "\${${INSTALL_ROOT_ENV}:-} $@" >> "$(dirname "$0")/../../../wires.log"
`;
    const binarySource = writeFakeBinary(join(root, "recorder.sh"), recorder);

    // Fresh: nothing was live, so there is no version to migrate away from.
    const fresh = versionedPlan(QUIET, binarySource);
    if (fresh.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(fresh.migration).toBeNull();
    applyInstallPlan(fresh);
    expect(existsSync(join(dest, "wires.log"))).toBe(false);

    // Over a prior version: `current` moves from it to this one, and the range runs.
    pointCurrentAt(dest, "v0.0.1");
    const upgrade = versionedPlan(QUIET, binarySource);
    if (upgrade.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(upgrade.migration).toEqual({ from: "v0.0.1", to: VERSION_NAME });
    applyInstallPlan(upgrade);
    expect(readFileSync(join(dest, "wires.log"), "utf8").trim()).toBe(
      `${join(dest, CURRENT_LINK)} migrate 0.0.1 ${packageVersion()}`,
    );

    // The same version refreshed in place leaves nothing behind.
    const refresh = versionedPlan(QUIET, binarySource);
    if (refresh.kind !== "versioned") throw new Error("expected a versioned plan");
    expect(refresh.migration).toBeNull();
  });

  skipWin("a refused top-level shim write skips neither the other shim nor the migrations", () => {
    // Post-flip, the install has landed: a locked `agent` must still leave a working `agent.ps1`
    // and run the migrations (the bootstrap binary is swept right after).
    const recorder = `#!/bin/sh
echo "\${${INSTALL_ROOT_ENV}:-} $@" >> "$(dirname "$0")/../../../wires.log"
`;
    const binarySource = writeFakeBinary(join(root, "recorder.sh"), recorder);
    pointCurrentAt(dest, "v0.0.1");
    mkdirSync(join(dest, "bin", "agent"), { recursive: true });

    applyInstallPlan(versionedPlan(QUIET, binarySource));

    expect(readFileSync(join(dest, "bin", "agent.ps1"), "utf8")).toBe(POWERSHELL_CURRENT_SHIM);
    expect(readFileSync(join(dest, "wires.log"), "utf8").trim()).toBe(
      `${join(dest, CURRENT_LINK)} migrate 0.0.1 ${packageVersion()}`,
    );
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
    // Junction-ness read from the reparse point itself (LinkType is derived from
    // the reparse tag): a directory SYMLINK (privilege-gated) or a plain copied
    // directory would both traverse fine, so traversal alone proves nothing.
    const link = currentLinkPath(dest).replace(/'/g, "''");
    const linkType = runSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath '${link}' -Force).LinkType`,
    ]);
    expect(linkType.exitCode).toBe(0);
    expect(linkType.stdout.trim()).toBe("Junction");
    expect(readCurrentVersionName(dest)).toBe("v1.0.0");
    expect(readFileSync(join(dest, CURRENT_LINK, "who"), "utf8")).toBe("one");
    // And the flip-while-open property: replacing the junction never touches
    // the target dir's contents.
    mkdirSync(join(dest, VERSIONS_DIR, "v1.0.1"), { recursive: true });
    pointCurrentAt(dest, "v1.0.1");
    expect(readFileSync(join(dest, VERSIONS_DIR, "v1.0.0", "who"), "utf8")).toBe("one");
  });

  skipWin("writeTopLevelShims repairs a lost exec bit even when the text is current", () => {
    // The identical-text shortcut must not freeze a broken mode: a crash
    // between an earlier write and its chmod would otherwise persist forever.
    writeTopLevelShims(dest);
    chmodSync(join(dest, "bin", "agent"), 0o655); // others may run it, the owner may not
    writeTopLevelShims(dest);
    expect(statSync(join(dest, "bin", "agent")).mode & 0o100).not.toBe(0);
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
});

describe("the unsafe-target canonical guard", () => {
  // The canonical refusal lives in the plan: the install root is derived (binary location or
  // COPILOT_ENV_INSTALL_ROOT) and the plan's writes aim at it; the shell installers keep only
  // a lexical pre-check. Building a plan writes nothing, so aiming one at the real home is safe.
  test("refuses the home directory, a filesystem root, and every alias of them; a fresh subdir plans", () => {
    const posix = process.platform !== "win32";
    const rows: {
      name: string;
      on: boolean;
      target: () => string;
      options: InstallOptions[];
      refusal: string | null;
    }[] = [
      {
        name: "home",
        on: true,
        target: homedir,
        options: [OPTIONS, ASSETS_ONLY],
        refusal: "it is the home directory",
      },
      {
        name: "filesystem root",
        on: true,
        target: () => parse(dest).root,
        options: [OPTIONS],
        refusal: "it is a filesystem root",
      },
      // Exactly what a lexical string comparison cannot catch: the reason the check is canonical.
      {
        name: "symlink alias of home",
        on: posix,
        target: () => {
          const alias = join(root, "home-alias");
          symlinkSync(homedir(), alias);
          return alias;
        },
        options: [OPTIONS],
        refusal: "it is the home directory",
      },
      // The Windows spelling of the same alias class; realpath resolves junctions too.
      {
        name: "junction alias of home",
        on: !posix,
        target: () => {
          const alias = join(root, "home-alias");
          symlinkSync(homedir(), alias, "junction");
          return alias;
        },
        options: [OPTIONS],
        refusal: "it is the home directory",
      },
      // A dangling symlink IS a directory entry, so it must not be peeled as a not-yet-existing
      // tail: realpath cannot prove where it leads.
      {
        name: "dangling symlink",
        on: posix,
        target: () => {
          const dangling = join(root, "dangling");
          symlinkSync(join(root, "nowhere"), dangling);
          return dangling;
        },
        options: [OPTIONS],
        refusal: "cannot be resolved",
      },
      // The positive control: a not-yet-existing target under a safe parent still plans.
      {
        name: "fresh subdir",
        on: true,
        target: () => join(dest, "not-yet", "there"),
        options: [OPTIONS],
        refusal: null,
      },
    ];
    for (const { name, on, target, options, refusal } of rows) {
      if (!on) continue;
      const aim = target();
      for (const opts of options) {
        if (refusal === null) {
          expect(buildInstallPlan(opts, aim, source).kind, name).toBe("versioned");
        } else expect(() => buildInstallPlan(opts, aim, source), name).toThrow(refusal);
      }
    }
  });
});

describe("the checkout guard and the install manifest sentinel", () => {
  // An installed-mode plan can be aimed at a dev checkout through COPILOT_ENV_INSTALL_ROOT, and
  // its writes would replace the checkout's bin/agent and src/scripts.
  //   .git present (dir or file)  -> a checkout: refuse
  test("refuses a root with a checkout marker and .git, as a dir or a worktree file, manifest or not", () => {
    // Order matters: the manifest row leaves a real install in dest, so it runs last.
    const rows: { git: "dir" | "file"; manifest: boolean; options: InstallOptions[] }[] = [
      { git: "dir", manifest: false, options: [OPTIONS, ASSETS_ONLY] },
      { git: "file", manifest: false, options: [OPTIONS] },
      // Even a valid manifest does not override .git: a live checkout always refuses.
      { git: "dir", manifest: true, options: [OPTIONS] },
    ];
    for (const { git, manifest, options } of rows) {
      if (manifest) applyInstallPlan(assetsOnlyPlan());
      for (const marker of CHECKOUT_MARKERS) {
        const name = `${marker} + .git ${git}${manifest ? " + manifest" : ""}`;
        writeFileSync(join(dest, marker), "{}");
        if (git === "dir") mkdirSync(join(dest, ".git"));
        else writeFileSync(join(dest, ".git"), "gitdir: /elsewhere");
        for (const opts of options) {
          expect(() => buildInstallPlan(opts, dest, source), name).toThrow(
            `refusing to install into ${dest}`,
          );
          expect(() => buildInstallPlan(opts, dest, source), name).toThrow(marker);
          expect(() => buildInstallPlan(opts, dest, source), name).toThrow(".git");
        }
        expect(isCheckoutShapedRoot(dest), name).toBe(true);
        rmSync(join(dest, ".git"), { recursive: true });
        rmSync(join(dest, marker));
      }
    }
  });

  test("applying writes the per-version manifest wholesale, whether none or a stale one was there", () => {
    // A stale manifest (older release, superseded inventory) is rewritten wholesale by the
    // release that owns the assets; the manifest vouches for what is on disk.
    const rows: { name: string; prior: string | null }[] = [
      { name: "fresh root", prior: null },
      {
        name: "stale manifest",
        prior: JSON.stringify({ "version": "0.0.1", "kind": "installed", "assets": [] }),
      },
    ];
    for (const { name, prior } of rows) {
      if (prior !== null) writeFileSync(join(dest, INSTALL_MANIFEST_FILE), prior);
      applyInstallPlan(assetsOnlyPlan());
      const manifest = JSON.parse(readFileSync(join(dest, INSTALL_MANIFEST_FILE), "utf8"));
      expect(manifest, name).toEqual({
        version: packageVersion(),
        kind: "installed",
        assets: [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES],
      });
      for (const asset of manifest.assets as string[]) {
        expect(existsSync(join(dest, asset)), `${name}: ${asset}`).toBe(true);
      }
    }
  });
});

describe("applyInstallPlan (assets-only)", () => {
  skipWin("makes the shim and the .sh assets executable", () => {
    applyInstallPlan(assetsOnlyPlan());

    expect(statSync(join(dest, "bin", "agent")).mode & 0o111).not.toBe(0);
    // The .sh exec-bit rule, on this synthetic fixture (no shipped .sh lives there today).
    expect(statSync(join(dest, "src", "scripts", "example.sh")).mode & 0o111).not.toBe(0);
    // The PowerShell shim is never exec'd by an OS loader, and no other asset is.
    expect(statSync(join(dest, "bin", "agent.ps1")).mode & 0o111).toBe(0);
    expect(statSync(join(dest, "shell", "payload.txt")).mode & 0o111).toBe(0);
  });
});

describe("launcher shims", () => {
  skipWin(
    "the written shims dispatch: per-version to the binary beside them, top-level through the current link",
    () => {
      // The stable PATH entry is one release-independent hop, so a user's PATH (or a persisted
      // config) stays valid across updates; the per-version shim reaches the binary beside it.
      const binarySource = writeFakeBinary(
        join(root, "downloaded-binary"),
        '#!/bin/sh\necho "ran from $(cd "$(dirname "$0")" && pwd -P) with $@"\n',
      );
      applyInstallPlan(versionedPlan(QUIET, binarySource));
      const versionBin = join(dest, VERSIONS_DIR, VERSION_NAME, "bin");
      for (const shim of [join(dest, "bin", "agent"), join(versionBin, "agent")]) {
        const res = runSync("sh", [shim, "hello", "world"]);
        expect(res.exitCode, shim).toBe(0);
        expect(res.stdout.trim(), shim).toBe(
          `ran from ${realpathSync(versionBin)} with hello world`,
        );
      }
    },
  );
});

describe("the install root carries the markers uninstall requires", () => {
  // root.ts refuses a root missing these markers, so narrowing MATERIALIZED_ASSET_DIRS below them
  // turns uninstall into a silent no-op on every install. The reason: a compiled install derives
  // its root from the binary's location, and a binary dropped in ~/.local/bin would otherwise
  // aim uninstall's `rm -rf` at ~/.local.
  test("applying a plan produces every marker directory", () => {
    applyInstallPlan(assetsOnlyPlan());

    for (const marker of INSTALL_ROOT_MARKERS) {
      expect(statSync(join(dest, marker)).isDirectory()).toBe(true);
    }
  });
});
