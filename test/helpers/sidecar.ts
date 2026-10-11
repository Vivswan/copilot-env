// The deno the daemon tests run their sidecar-side children on: a real NotCapable, a daemon-shaped
// process the classifier recognises, the fake proxy with the preload shims. Found on PATH through
// the same finder production uses, once, when this helper loads: a test that narrows PATH to a
// scratch bin for its agent lookups must not lose the sidecar. Null when this machine has none,
// and a test that needs one skips naming the sidecar rather than failing the suite.
import { resolveExecutablePath } from "../../src/utils/command.ts";

const FOUND: string | null = resolveExecutablePath("deno");

export function sidecarDenoOnPath(): string | null {
  return FOUND;
}
