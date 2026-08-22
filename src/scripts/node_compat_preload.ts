// Restore node's `fs.existsSync` contract for the proxy, on every proxy spawn.
//
// Node documents `existsSync` as never throwing: any error -- missing, unreadable,
// permission-denied -- is reported as `false`. Deno's node compat deviates for one
// class of path: reading anything under `/proc` demands the ALL-access permission
// descriptor, and a process without it gets a thrown `NotCapable` instead of `false`.
//
// That is fatal for us. `@jeffreycao/copilot-api` pulls in clipboardy -> is-wsl, which
// probes `/proc/sys/fs/binfmt_misc/WSLInterop` at module load on Linux, so the proxy
// dies during startup before it ever listens. macOS and Windows are unaffected (no
// `/proc`), which is why only a Linux run shows it.
//
// The alternative fix is granting the daemon all-access, and there is no middle ground:
// `--allow-read=/proc` does not satisfy the descriptor, and the only flag combination
// that does is every permission at once. Restoring the documented node behaviour is a
// far smaller change than handing the proxy FFI and subprocess spawning.
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
  } catch {
    return false;
  }
};
