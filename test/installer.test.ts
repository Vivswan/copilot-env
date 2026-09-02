import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import {
  applyInstallPlan,
  buildInstallPlan,
  BUNDLED_ONLY_ASSETS,
  CHECKOUT_MARKERS,
  type InstallOptions,
  type InstallPlan,
  LEGACY_ARTIFACTS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
  POSIX_SHIM,
  POWERSHELL_SHIM,
} from "../src/install/installer.ts";
import { INSTALL_MANIFEST_FILE, INSTALL_ROOT_MARKERS } from "../src/utils/root.ts";
import { packageVersion } from "../src/utils/version.ts";
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
  for (const file of MATERIALIZED_ASSET_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `content of ${file}`);
  }
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

describe("buildInstallPlan", () => {
  test("a checkout (asset source IS the root) plans no file writes", () => {
    // A dev checkout already has its own bin/agent and working files; an
    // install must never overwrite them. In-place applies before the checkout
    // refusal, so a checkout installing into itself never trips it either.
    writeFileSync(join(source, "package.json"), "{}");
    mkdirSync(join(source, ".git"));
    const plan = buildInstallPlan(OPTIONS, source, source);
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
    for (const file of MATERIALIZED_ASSET_FILES) {
      expect(targets).toContain(join(dest, file));
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

    writeAssetSource(source);
    rmSync(join(source, "src", "utils", "json.ts"));
    expect(() => installedPlan()).toThrow("embedded assets are missing src/utils/json.ts");
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

describe("the unsafe-target canonical guard", () => {
  // The shell installers keep only a lexical pre-check before they download;
  // the CANONICAL refusal lives in the plan, because the install root is
  // DERIVED (binary location or COPILOT_ENV_INSTALL_ROOT) and the plan's
  // writes and legacy removals aim at it. Building a plan writes nothing, so
  // aiming one at the real home directory here is safe.
  const skipWin = test.skipIf(process.platform === "win32");
  const winOnly = test.skipIf(process.platform !== "win32");

  test("refuses the home directory as an installed-mode target", () => {
    expect(() => buildInstallPlan(OPTIONS, homedir(), source)).toThrow(
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
    expect(buildInstallPlan(OPTIONS, fresh, source).kind).toBe("installed");
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
      expect(() => installedPlan()).toThrow(`refusing to install into ${dest}`);
      expect(() => installedPlan()).toThrow(marker);
      expect(() => installedPlan()).toThrow(".git");
      rmSync(join(dest, ".git"), { recursive: true });
      // A worktree carries .git as a FILE; both spellings must refuse.
      writeFileSync(join(dest, ".git"), "gitdir: /elsewhere");
      expect(() => installedPlan()).toThrow(`refusing to install into ${dest}`);
      rmSync(join(dest, ".git"));
      rmSync(join(dest, marker));
    }
    expect(CHECKOUT_MARKERS).toContain("package.json");
    expect(CHECKOUT_MARKERS).toContain("deno.json");
  });

  test("even a valid manifest does not override .git: a live checkout always refuses", () => {
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));
    writeFileSync(join(dest, "package.json"), "{}");
    mkdirSync(join(dest, ".git"));
    expect(() => installedPlan()).toThrow(`refusing to install into ${dest}`);
  });

  test("a legacy source-archive root (markers, no .git) is swept and installed over", () => {
    // The source-archive installer era left roots byte-indistinguishable from a
    // checkout minus .git; their first binary update must proceed, remove the
    // stale markers alongside the other superseded artifacts, and write the
    // manifest so the root is positively an install from then on.
    writeFileSync(join(dest, "package.json"), "{}");
    writeFileSync(join(dest, "deno.json"), "{}");
    mkdirSync(join(dest, "node_modules"), { recursive: true });

    const plan = installedPlan({ ...OPTIONS, assetsOnly: true });
    if (plan.kind !== "installed") throw new Error("expected an installed plan");
    expect(plan.legacyRemovals).toContain(join(dest, "package.json"));
    expect(plan.legacyRemovals).toContain(join(dest, "deno.json"));
    expect(plan.legacyRemovals).toContain(join(dest, "node_modules"));

    applyInstallPlan(plan);
    expect(existsSync(join(dest, "package.json"))).toBe(false);
    expect(existsSync(join(dest, "deno.json"))).toBe(false);
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(true);
  });

  test("a fresh root installs and gains the manifest", () => {
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

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

    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));

    const manifest = JSON.parse(readFileSync(join(dest, INSTALL_MANIFEST_FILE), "utf8"));
    expect(manifest.version).toBe(packageVersion());
    expect(manifest.assets).toEqual([...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES]);
  });

  test("a pre-manifest install (no manifest, no checkout markers) still updates", () => {
    // Every binary install that predates the manifest looks like this; its
    // first `agent update` must proceed and write the sentinel for the next one.
    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));
    rmSync(join(dest, INSTALL_MANIFEST_FILE));

    applyInstallPlan(installedPlan({ ...OPTIONS, assetsOnly: true }));
    expect(existsSync(join(dest, INSTALL_MANIFEST_FILE))).toBe(true);
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
    // The .sh exec-bit rule now mostly guards the one-release proxy-token FORWARDER
    // (and this synthetic fixture): the resolver itself is `agent proxy-token`.
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
    // (which writes the binary to bin/copilot-env) and with the update swap.
    expect(POSIX_SHIM).toContain('exec "$HERE/copilot-env" "$@"');
    expect(POSIX_SHIM.startsWith("#!/bin/sh\n")).toBe(true);
    expect(POWERSHELL_SHIM).toContain("copilot-env.exe");
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
