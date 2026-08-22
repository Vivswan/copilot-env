import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInstallPlan,
  buildInstallPlan,
  BUNDLED_ONLY_ASSETS,
  type InstallOptions,
  type InstallPlan,
  LEGACY_ARTIFACTS,
  MATERIALIZED_ASSET_DIRS,
  parseInstallArgs,
  POSIX_SHIM,
  POWERSHELL_SHIM,
} from "../src/install/installer.ts";
import { INSTALL_ROOT_MARKERS } from "../src/utils/root.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

const OPTIONS: InstallOptions = { noShellIntegration: false, allHosts: false, assetsOnly: false };

let root = "";
let source = "";
let dest = "";

/** A stand-in for the compiled VFS: every embedded asset the plan requires. */
function writeAssetSource(dir: string): void {
  for (const assetDir of MATERIALIZED_ASSET_DIRS) {
    mkdirSync(join(dir, assetDir), { recursive: true });
    writeFileSync(join(dir, assetDir, "payload.txt"), `content of ${assetDir}`);
  }
  mkdirSync(join(dir, "src", "scripts"), { recursive: true });
  writeFileSync(join(dir, "src", "scripts", "proxy-token.sh"), "#!/bin/sh\n");
  for (const file of BUNDLED_ONLY_ASSETS) {
    writeFileSync(join(dir, file), `content of ${file}`);
  }
}

/** The plan for a compiled binary: asset source and install root differ. */
function installedPlan(options: InstallOptions = OPTIONS): InstallPlan {
  return buildInstallPlan(options, dest, source);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "copilot-installer-"));
  source = join(root, "vfs");
  dest = join(root, "install");
  mkdirSync(source, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeAssetSource(source);
});

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("parseInstallArgs", () => {
  test("defaults to a full install", () => {
    expect(parseInstallArgs(["install"])).toEqual({
      noShellIntegration: false,
      allHosts: false,
      assetsOnly: false,
    });
  });

  test("parses every wiring flag", () => {
    expect(parseInstallArgs(["install", "--no-shell-integration", "--all-hosts"])).toEqual({
      noShellIntegration: true,
      allHosts: true,
      assetsOnly: false,
    });
    expect(parseInstallArgs(["install", "--assets-only"]).assetsOnly).toBe(true);
  });

  test("rejects unknown commands and flags", () => {
    expect(() => parseInstallArgs([])).toThrow("usage:");
    expect(() => parseInstallArgs(["repair"])).toThrow("usage:");
    expect(() => parseInstallArgs(["install", "--launchers"])).toThrow("unknown argument");
  });
});

describe("buildInstallPlan", () => {
  test("a checkout (asset source IS the root) plans no file writes", () => {
    const plan = buildInstallPlan(OPTIONS, source, source);
    // A dev checkout already has its own bin/agent and working files; an
    // install must never overwrite them.
    expect(plan.kind).toBe("in-place");
    expect(plan.shell).toEqual({ allHosts: false });
  });

  test("a compiled binary plans copies for every materialized asset", () => {
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    const targets = plan.copies.map((c) => c.to);
    for (const dir of MATERIALIZED_ASSET_DIRS) {
      expect(targets.some((t) => t.startsWith(join(dest, dir)))).toBe(true);
    }
  });

  test("bundled-only assets are verified but never written", () => {
    // They are read out of the VFS through ASSET_ROOT. A copy in the install
    // root would be a second source of truth that an update can leave stale.
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    for (const file of BUNDLED_ONLY_ASSETS) {
      expect(plan.copies.map((c) => c.to)).not.toContain(join(dest, file));
    }
  });

  test("a missing bundled-only asset still fails the plan", () => {
    rmSync(join(source, "copilot-env.config"));
    expect(() => installedPlan()).toThrow("embedded assets are missing copilot-env.config");
  });

  test("plans the launcher shims beside the binary", () => {
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    expect(plan.shims.map((s) => s.to)).toEqual([
      join(dest, "bin", "agent"),
      join(dest, "bin", "agent.ps1"),
    ]);
  });

  test("only .sh assets are planned executable", () => {
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    for (const copy of plan.copies) {
      expect(copy.executable).toBe(copy.to.endsWith(".sh"));
    }
  });

  test("refuses a binary whose embedded assets are incomplete", () => {
    // Anything the plan expects to find in the VFS but that compile.ts never
    // embedded has to fail loudly here, not produce a half-built install.
    rmSync(join(source, "shell"), { recursive: true, force: true });
    expect(() => installedPlan()).toThrow("embedded assets are missing shell");

    writeAssetSource(source);
    rmSync(join(source, ".dvmrc"));
    expect(() => installedPlan()).toThrow("embedded assets are missing .dvmrc");
  });

  test("plans removal of only the superseded artifacts actually present", () => {
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    // Only what is actually there: an install must not report removing files
    // it never found.
    expect(plan.legacyRemovals).toEqual([join(dest, "node_modules")]);
    expect(LEGACY_ARTIFACTS.length).toBeGreaterThan(0);
  });

  test("--assets-only and --no-shell-integration both plan no shell wiring", () => {
    expect(installedPlan({ ...OPTIONS, assetsOnly: true }).shell).toBeNull();
    expect(installedPlan({ ...OPTIONS, noShellIntegration: true }).shell).toBeNull();
    expect(installedPlan({ ...OPTIONS, allHosts: true }).shell).toEqual({ allHosts: true });
  });
});

describe("applyInstallPlan", () => {
  const skipWin = test.skipIf(process.platform === "win32");

  test("materializes the assets and shims, and removes superseded artifacts", () => {
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    writeFileSync(join(dest, "node_modules", "stale"), "stale");

    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

    expect(readFileSync(join(dest, "shell", "payload.txt"), "utf8")).toBe("content of shell");
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe(POSIX_SHIM);
    expect(readFileSync(join(dest, "bin", "agent.ps1"), "utf8")).toBe(POWERSHELL_SHIM);
    expect(() => statSync(join(dest, "node_modules"))).toThrow();
  });

  skipWin("makes the shim and the .sh assets executable", () => {
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

    expect(statSync(join(dest, "bin", "agent")).mode & 0o111).not.toBe(0);
    expect(statSync(join(dest, "src", "scripts", "proxy-token.sh")).mode & 0o111).not.toBe(0);
    // The PowerShell shim is never exec'd by an OS loader.
    expect(statSync(join(dest, "bin", "agent.ps1")).mode & 0o111).toBe(0);
  });

  test("re-applying over an existing install is idempotent", () => {
    const plan = installedPlan({ ...OPTIONS, assetsOnly: true });
    applyInstallPlan(plan);
    writeFileSync(join(dest, "shell", "payload.txt"), "locally edited");
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

    expect(readFileSync(join(dest, "shell", "payload.txt"), "utf8")).toBe("content of shell");
  });
});

describe("launcher shims", () => {
  test("dispatch to the compiled binary next to them", () => {
    // The shims are the ONLY thing standing between `agent` on a user's PATH
    // and the binary, so their dispatch target is a contract with install.sh
    // (which writes the binary to bin/agent-bin) and with the update swap.
    expect(POSIX_SHIM).toContain('exec "$HERE/agent-bin" "$@"');
    expect(POSIX_SHIM.startsWith("#!/bin/sh\n")).toBe(true);
    expect(POWERSHELL_SHIM).toContain("agent-bin.exe");
    expect(POWERSHELL_SHIM).toContain("exit $LASTEXITCODE");
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
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

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
