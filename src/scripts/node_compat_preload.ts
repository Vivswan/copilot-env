// Restore node's `fs.existsSync` contract for the proxy, on every proxy spawn.
//
// Node documents `existsSync` as never throwing: it answers a question, and any error --
// missing, unreadable, permission-denied -- is reported as `false`. Deno's node compat
// throws instead, and on Linux that is fatal for us: deno gates the ENTIRE `/proc` tree
// behind the all-access permission descriptor, `@jeffreycao/copilot-api` pulls in
// clipboardy -> is-wsl, and is-wsl probes `/proc/sys/fs/binfmt_misc/WSLInterop` at module
// load. The daemon dies before it ever listens. macOS and Windows have no `/proc`, which
// is why only a Linux run shows it.
//
// Nothing needs that file's CONTENTS. is-wsl only asks "am I WSL", and on Linux the true
// answer is `false` -- which is exactly what an all-access run produces, because the file
// does not exist. So this is not a permission problem to buy off: no granular grant can
// express it (`--allow-read=/proc` does not satisfy the descriptor, and any `--deny-*`
// stops a grant counting as "all"), and widening the daemon to all-access to answer a
// question it already knows the answer to would hand a third-party npm tree FFI and
// subprocess spawning for nothing.
//
// Narrowed to `NotCapable` on purpose: a permission gap anywhere else in the daemon stays
// loud instead of silently reading as "absent".
//
// Deliberately NOT applied to `readFileSync`/`statSync`. Node throws there too, so a
// NotCapable is the honest analogue of an EACCES and well-behaved dependencies already
// handle it -- is-wsl wraps its own `/proc/version` read in try/catch for that reason.
//
// Scope: this patches the `node:fs` module object, so it covers callers that reach the
// function through it (`import fs from "node:fs"; fs.existsSync(...)` -- is-wsl's form).
// A caller holding a direct binding from `import { existsSync }` keeps the original;
// deno offers no way to replace a builtin module wholesale.
import fs from "node:fs";

const realExistsSync = fs.existsSync;

fs.existsSync = (path: Parameters<typeof fs.existsSync>[0]): boolean => {
  try {
    return realExistsSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return false;
    throw error;
  }
};
