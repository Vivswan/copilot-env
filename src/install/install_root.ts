// Where this process should install to and update inside.
//
// A compiled binary cannot use the checkout-shaped PROJECT_ROOT for that. The
// walk-up-for-package.json discovery finds the package.json embedded in the
// binary's own VFS, so it resolves to a virtual path under the OS temp dir
// rather than the directory the user installed into. The executable's location
// is the reliable anchor instead: install.sh / install.ps1 place the binary at
// <root>/bin/agent-bin(.exe), so the root is two levels up.
//
// TEMPORARY -- delete this module when chunk 5's root.ts dual-mode lands.
// Its `PROJECT_ROOT` becomes mode-aware and answers exactly this question, so
// the swap is mechanical and needs no replacement logic:
//
//   src/install/installer.ts   `import { installRoot } from "./install_root.ts"`
//                              -> `import { ASSET_ROOT, PROJECT_ROOT, rootMode } from "../utils/root.ts"`
//                              `root = installRoot()`   -> `root = PROJECT_ROOT`
//                              `assetSourceRoot()`      -> `ASSET_ROOT`
//                              the in-place branch      -> `rootMode().kind === "checkout"`
//   src/autoupdate/apply.ts    `installRoot()`          -> `PROJECT_ROOT`
//
// That repoint was type-checked against a stand-in of the stated contract and
// compiles clean; it is kept out of this branch only because root.ts's new
// exports are not on any branch yet, and depending on them here would leave
// this one unable to run its own gate.
import { dirname } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

/** True when running as a `deno compile` binary rather than from a checkout. */
export function isCompiledBinary(): boolean {
  return Deno.build.standalone;
}

/**
 * The install root to operate on: the directory holding `bin/`, the runtime
 * assets, and everything `agent update` swaps. Falls back to PROJECT_ROOT in a
 * dev checkout, where the checkout IS the root.
 */
export function installRoot(): string {
  return isCompiledBinary() ? dirname(dirname(Deno.execPath())) : PROJECT_ROOT;
}
