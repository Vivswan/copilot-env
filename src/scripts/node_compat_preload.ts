// Deno's node compat throws from `fs.existsSync` where Node returns false, and on Linux deno gates
// the whole `/proc` tree behind the all-access permission. copilot-api -> clipboardy -> is-wsl
// probes /proc/sys/fs/binfmt_misc/WSLInterop at module load, so the daemon died before it listened.
//
// No grant fixes it: `--allow-read=/proc` does not satisfy the descriptor, any `--deny-*` stops a
// grant counting as "all", and all-access would hand the npm tree FFI and spawning for "not WSL".
//
// `readFileSync`/`statSync` are left alone: Node throws there too, so dependencies already catch
// (is-wsl wraps its own /proc/version read).
import fs from "node:fs";

const realExistsSync = fs.existsSync;

// Only callers going through the module object (`import fs from "node:fs"`, is-wsl's form) see the
// patch; a direct `import { existsSync }` binding keeps the original, and deno cannot replace a
// builtin wholesale.
fs.existsSync = (path: Parameters<typeof fs.existsSync>[0]): boolean => {
  try {
    return realExistsSync(path);
  } catch (error) {
    // Narrowed to `NotCapable` on purpose: a permission gap anywhere else in the daemon
    // stays loud instead of silently reading as "absent".
    if (error instanceof Deno.errors.NotCapable) return false;
    throw error;
  }
};
