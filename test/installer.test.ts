import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInstallPlan,
  buildInstallPlan,
  EMBEDDED_ASSET_DIRS,
  EMBEDDED_ASSET_FILES,
  type InstallOptions,
  type InstallPlan,
  LEGACY_ARTIFACTS,
  parseInstallArgs,
  POSIX_SHIM,
  POWERSHELL_SHIM,
} from "../src/install/installer.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

const OPTIONS: InstallOptions = { noShellIntegration: false, allHosts: false, assetsOnly: false };

let root = "";
let source = "";
let dest = "";

/** A stand-in for the compiled VFS: every embedded asset the plan requires. */
function writeAssetSource(dir: string): void {
  for (const assetDir of EMBEDDED_ASSET_DIRS) {
    mkdirSync(join(dir, assetDir), { recursive: true });
    writeFileSync(join(dir, assetDir, "payload.txt"), `content of ${assetDir}`);
  }
  mkdirSync(join(dir, "src", "scripts"), { recursive: true });
  writeFileSync(join(dir, "src", "scripts", "proxy-token.sh"), "#!/bin/sh\n");
  for (const file of EMBEDDED_ASSET_FILES) {
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

  test("a compiled binary plans copies for every embedded asset", () => {
    const plan = installedPlan();
    if (plan.kind !== "installed") throw new Error("expected an installed plan");

    const targets = plan.copies.map((c) => c.to);
    for (const file of EMBEDDED_ASSET_FILES) {
      expect(targets).toContain(join(dest, file));
    }
    for (const dir of EMBEDDED_ASSET_DIRS) {
      expect(targets.some((t) => t.startsWith(join(dest, dir)))).toBe(true);
    }
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
    // Anything the plan expects to find in the VFS but that compile.sh never
    // embedded has to fail loudly here, not produce a half-built install.
    rmSync(join(source, "shell"), { recursive: true, force: true });
    expect(() => installedPlan()).toThrow("embedded assets are missing shell");

    writeAssetSource(source);
    rmSync(join(source, "deno.json"));
    expect(() => installedPlan()).toThrow("embedded assets are missing deno.json");
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

    expect(readFileSync(join(dest, "deno.json"), "utf8")).toBe("content of deno.json");
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
