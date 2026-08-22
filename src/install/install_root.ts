// Where this process should install to, update inside, and read runtime assets
// from.
//
// A compiled binary cannot use PROJECT_ROOT for any of that. PROJECT_ROOT walks
// up from the running module looking for package.json, and inside a compiled
// binary that module lives in the embedded VFS -- so it resolves to a virtual
// path under the OS temp dir, not to the directory the user installed into.
// The executable's own location is the reliable anchor instead: install.sh /
// install.ps1 place the binary at <root>/bin/agent-bin(.exe), so the root is
// two levels up.
//
// NOTE (cross-chunk seam): this is the narrow slice of "root.ts dual-mode" that
// the installer and the updater need. When root.ts grows its RootMode
// discriminated type, this module collapses into it and every caller here moves
// over -- there should not be two answers to "where is the install root".
import { dirname } from "node:path";
import { PROJECT_ROOT } from "../utils/root.ts";

/** True when running as a `deno compile` binary rather than from a checkout. */
export function isCompiledBinary(): boolean {
  return Deno.build.standalone;
}

/**
 * The install root to operate on: the directory holding `bin/`, the runtime
 * assets, and the deno config the daemon spawn reads. Falls back to
 * PROJECT_ROOT in a dev checkout, where the checkout IS the root.
 */
export function installRoot(): string {
  return isCompiledBinary() ? dirname(dirname(Deno.execPath())) : PROJECT_ROOT;
}
