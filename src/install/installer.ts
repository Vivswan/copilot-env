// The in-binary `agent install` implementation: finalize an install root
// around the compiled agent binary that install.sh / install.ps1 just
// downloaded to <root>/bin/copilot-env(.exe).
//
// The work is a plan/apply split (build one typed plan up front, then execute
// it -- the same shape as planImport/applyImportPlan in src/agents/transfer.ts):
//
// - installed mode (compiled binary): materialize the embedded runtime assets
//   from the compiled VFS onto real disk, write the bin/agent(.ps1) launcher
//   shims, remove superseded source-install artifacts, wire shell integration.
// - in-place mode (dev checkout, where the asset source IS the install root):
//   only shell integration applies -- the checkout's own bin/agent launchers
//   and working files are never overwritten.
//
// Assets are read via URLs relative to import.meta.url, which resolves inside
// the compiled VFS (a virtual path readable in-process only) and inside a dev
// checkout alike; comparing that source root to the install root is what
// discriminates the two modes.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { consola } from "consola";

import { runShellIntegration } from "../shell/integration.ts";
import {
  ASSET_ROOT,
  INSTALL_MANIFEST_FILE,
  type InstallManifest,
  PROJECT_ROOT,
} from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import { INSTALLED_BINARY_POSIX, INSTALLED_BINARY_WINDOWS } from "./targets.ts";

/** Embedded AND materialized: something outside this process opens these by
 *  path, so they have to exist on real disk in the install root - the daemon's
 *  `--preload` shims and the one-release proxy-token forwarders, the
 *  shell-integration payload the rc block sources, and the plugin/skill surface
 *  other tools read.
 *
 *  `src/scripts` is materialized WHOLE rather than by naming the shims. The
 *  daemon loads a per-credential subset of `DAEMON_SHIM_FILES`
 *  (src/copilot_api/shims.ts) by absolute path, and those entrypoints import
 *  further siblings; copying the directory covers the in-dir ones by
 *  construction. Imports reaching OUTSIDE the directory are
 *  `MATERIALIZED_ASSET_FILES` below. */
export const MATERIALIZED_ASSET_DIRS = [
  "src/scripts",
  "shell",
  "skills",
  ".claude-plugin",
] as const;

/** Embedded and materialized as INDIVIDUAL files: the daemon shims in
 *  `src/scripts` import these siblings from `src/copilot_api` and `src/utils`,
 *  and the sidecar deno resolves those imports on real disk in the install
 *  root -- a missing one kills the daemon at module load. The list is the
 *  shims' full local import closure OUTSIDE the materialized dirs, pinned
 *  bidirectionally to the computed closure by test/installer_pinning.test.ts
 *  so a new shim import cannot silently break installs again. */
export const MATERIALIZED_ASSET_FILES = [
  "src/copilot_api/config.ts",
  "src/copilot_api/env_config.ts",
  "src/copilot_api/paths.ts",
  "src/copilot_api/profile.ts",
  "src/copilot_api/state.ts",
  "src/utils/file_lock.ts",
  "src/utils/fs.ts",
  "src/utils/hostname.ts",
  "src/utils/json.ts",
  "src/utils/pid.ts",
  "src/utils/time.ts",
] as const;

/** Embedded and NEVER materialized: read in-process through `ASSET_ROOT`, which
 *  resolves inside the compiled VFS. The rule these follow is general - if a
 *  file ships with the build and is read in-process, it is an ASSET_ROOT read,
 *  and writing a second copy into the install root would only create something
 *  nothing reads and that can drift from the binary that shipped it.
 *
 *  `copilot-env.config` is the proxy-float floor/ceiling (`readProjectConfig`),
 *  `.dvmrc` is the deno version the sidecar provisions against
 *  (`readDvmrcPin`), and `deno.json` is the import map the daemon config is
 *  generated from (`writeDaemonConfig`); all default to ASSET_ROOT.
 *
 *  `deno.json` MUST stay bundled-only for a second reason: on disk it is a
 *  CHECKOUT_MARKERS entry, so materializing it would make every install root
 *  read as checkout debris.
 *
 *  They are still verified present at plan time: absent from the VFS means the
 *  build is broken, and failing here beats failing at first proxy start. */
export const BUNDLED_ONLY_ASSETS = ["copilot-env.config", ".dvmrc", "deno.json"] as const;

/** Superseded files a pre-binary source install leaves in the root. The binary
 *  install has no runtime bootstrap left to use them and `node_modules` alone
 *  is hundreds of megabytes, so they are removed outright (clean break --
 *  there is no upgrade bridge). install.sh / install.ps1 carry the same list
 *  for the sweep they do before handing off. */
export const LEGACY_ARTIFACTS = ["node_modules", "bun.lock", "bunfig.toml"] as const;

/** Installed-mode bin/agent: a thin dispatcher to the adjacent compiled
 *  binary. The checkout's bin/agent is the dev-mode variant; an install never
 *  overwrites a checkout (in-place mode writes no shims), so the two texts
 *  never compete for the same file. */
export const POSIX_SHIM = `#!/bin/sh
# copilot-env launcher (installed): dispatch to the compiled agent binary.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/${INSTALLED_BINARY_POSIX}" "$@"
`;

/** Installed-mode bin/agent.ps1 (Windows twin of POSIX_SHIM). */
export const POWERSHELL_SHIM =
  `# copilot-env launcher (installed): dispatch to the compiled agent binary.
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Here '${INSTALLED_BINARY_WINDOWS}') @args
exit $LASTEXITCODE
`;

export interface InstallOptions {
  noShellIntegration: boolean;
  allHosts: boolean;
  /**
   * Materialize the embedded assets and launcher shims and nothing else: no
   * shell wiring, no next-steps epilogue. `agent update` runs the NEW binary
   * this way after the swap, so the release that owns the assets is the one
   * that writes them.
   */
  assetsOnly: boolean;
}

/** Files only a source checkout OR a legacy source-archive install carries at
 *  its root. With `.git` beside them they mark a live checkout an installed-mode
 *  plan must refuse to clobber; without `.git` they are debris the old
 *  source-archive installer left behind, swept like `LEGACY_ARTIFACTS`. */
export const CHECKOUT_MARKERS = ["package.json", "deno.json"] as const;

interface ShellWiring {
  allHosts: boolean;
}

interface AssetCopy {
  from: string;
  to: string;
  executable: boolean;
}

interface ShimWrite {
  to: string;
  text: string;
  executable: boolean;
}

/** The sentinel manifest write: `INSTALL_MANIFEST_FILE` at the root. */
interface ManifestWrite {
  to: string;
  text: string;
}

export type InstallPlan =
  | { kind: "in-place"; root: string; shell: ShellWiring | null }
  | {
    kind: "installed";
    root: string;
    copies: AssetCopy[];
    shims: ShimWrite[];
    manifest: ManifestWrite;
    legacyRemovals: string[];
    shell: ShellWiring | null;
  };

/** Collect every file under `dir` (recursively, sorted for determinism) as
 *  install-root-relative copies. `.sh` files get the executable bit: they are
 *  the only embedded assets ever handed to an OS exec directly. */
function collectAssetCopies(sourceRoot: string, root: string, dir: string): AssetCopy[] {
  const copies: AssetCopy[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(join(sourceRoot, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryRel = join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(entryRel);
      } else {
        copies.push({
          from: join(sourceRoot, entryRel),
          to: join(root, entryRel),
          executable: entry.name.endsWith(".sh"),
        });
      }
    }
  };
  walk(dir);
  return copies;
}

/** Build the full typed plan. Exported for tests; `runInstall` is the composed
 *  entry point. `root`/`sourceRoot` default to the live install root and the
 *  embedded asset source. */
export function buildInstallPlan(
  options: InstallOptions,
  root: string = PROJECT_ROOT,
  sourceRoot: string = ASSET_ROOT,
): InstallPlan {
  const shell: ShellWiring | null = options.noShellIntegration || options.assetsOnly
    ? null
    : { allHosts: options.allHosts };

  // The discriminant IS rootMode's, expressed over the arguments rather than
  // read from ambient state: root.ts sets ASSET_ROOT === PROJECT_ROOT for a
  // checkout (both resolve to the checkout) and splits them for a compiled
  // binary (VFS vs install root). Comparing the injected pair therefore gives
  // the same answer as `rootMode().kind`, and keeps the parameters meaningful -
  // gating on `rootMode()` instead would ignore them and make the installed
  // branch unreachable from a test, which is exactly the branch worth testing.
  if (resolve(sourceRoot) === resolve(root)) {
    return { kind: "in-place", root, shell };
  }

  // Installed-mode writes replace bin/agent with the dispatch shim and
  // materialize src/scripts over whatever is there -- exactly the files a dev
  // checkout authored. But the markers alone cannot condemn a root: the
  // source-archive installer era laid down roots byte-indistinguishable from a
  // checkout (it extracted release source archives), and LEGACY_ARTIFACTS never
  // swept package.json/deno.json out of them. `.git` (a directory, or a file in
  // a worktree) is the one honest discriminant: archives never carry it.
  // Markers + .git is a live checkout reached through COPILOT_ENV_INSTALL_ROOT
  // -- refuse before planning any write. Markers without .git is a legacy
  // source install: sweep the markers with the other superseded artifacts.
  const presentMarkers = CHECKOUT_MARKERS.filter((marker) => existsSync(join(root, marker)));
  if (presentMarkers.length > 0 && existsSync(join(root, ".git"))) {
    throw new Error(
      `refusing to install into ${root}: it holds ${presentMarkers[0]} and .git, so it is a ` +
        `source checkout, and installing would overwrite its bin/agent and working files`,
    );
  }

  const copies: AssetCopy[] = [];
  for (const dir of MATERIALIZED_ASSET_DIRS) {
    if (!existsSync(join(sourceRoot, dir))) {
      throw new Error(
        `embedded assets are missing ${dir}; deno.json compile.include did not embed it`,
      );
    }
    copies.push(...collectAssetCopies(sourceRoot, root, dir));
  }
  for (const file of MATERIALIZED_ASSET_FILES) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(
        `embedded assets are missing ${file}; deno.json compile.include did not embed it`,
      );
    }
    copies.push({
      from: join(sourceRoot, file),
      to: join(root, file),
      executable: file.endsWith(".sh"),
    });
  }
  // Verified, never copied: these are read out of the VFS in-process.
  for (const file of BUNDLED_ONLY_ASSETS) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(
        `embedded assets are missing ${file}; deno.json compile.include did not embed it`,
      );
    }
  }

  const manifest: InstallManifest = {
    version: packageVersion(),
    kind: "installed",
    assets: [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES],
  };
  return {
    kind: "installed",
    root,
    copies,
    shims: [
      { to: join(root, "bin", "agent"), text: POSIX_SHIM, executable: true },
      { to: join(root, "bin", "agent.ps1"), text: POWERSHELL_SHIM, executable: false },
    ],
    manifest: {
      to: join(root, INSTALL_MANIFEST_FILE),
      text: JSON.stringify(manifest, null, 2) + "\n",
    },
    legacyRemovals: [...LEGACY_ARTIFACTS, ...presentMarkers]
      .map((name) => join(root, name))
      .filter(existsSync),
    shell,
  };
}

export function applyInstallPlan(plan: InstallPlan): void {
  if (plan.kind === "installed") {
    // read+write instead of copyFileSync: the source side may be a compiled
    // VFS path, which is only guaranteed readable through in-process reads.
    for (const copy of plan.copies) {
      mkdirSync(dirname(copy.to), { recursive: true });
      writeFileSync(copy.to, readFileSync(copy.from));
      if (copy.executable) chmodSync(copy.to, 0o755);
    }
    for (const shim of plan.shims) {
      mkdirSync(dirname(shim.to), { recursive: true });
      writeFileSync(shim.to, shim.text);
      if (shim.executable) chmodSync(shim.to, 0o755);
    }
    mkdirSync(dirname(plan.manifest.to), { recursive: true });
    writeFileSync(plan.manifest.to, plan.manifest.text);
    consola.success(`Installed the copilot-env runtime files into ${plan.root}`);
    for (const path of plan.legacyRemovals) {
      consola.info(`Removing superseded ${path} ...`);
      rmSync(path, { recursive: true, force: true });
    }
  }

  if (plan.shell === null) return;
  runShellIntegration({ kind: "wire", allHosts: plan.shell.allHosts });
}

/** What to tell the user once a real install finishes. Skipped for
 *  `--assets-only`, which is a machine-to-machine step inside `agent update`. */
function printEpilogue(options: InstallOptions): void {
  console.log("");
  if (options.noShellIntegration) {
    console.log("Done. Shell integration was skipped; run 'agent shell' to enable it.");
  } else {
    console.log(
      process.platform === "win32"
        ? "Done. Restart PowerShell to load the integration."
        : "Done. Restart your shell to load the integration.",
    );
  }
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Run 'agent init' to set up Codex + Claude (it picks GitHub Copilot Direct or the local proxy), then tells you whether you need 'agent start' (only for the proxy).",
  );
  console.log(
    "  2. Optionally run 'agent shell --clis --launchers' to install the CLIs plus the cl/co/cx shortcuts.",
  );
}

export function runInstall(options: InstallOptions): void {
  applyInstallPlan(buildInstallPlan(options));
  if (options.assetsOnly) return;
  if (options.noShellIntegration) {
    consola.info("Skipping shell integration (--no-shell-integration).");
  }
  printEpilogue(options);
}
