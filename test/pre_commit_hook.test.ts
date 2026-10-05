import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The fleet's hook rule, which only a run of the hook enforces: a pre-commit hook installs
// nothing, so one that finds deno or node_modules missing fails naming the one-time bootstrap
// and writes nothing. POSIX-only: the hook is `#!/bin/sh`, run here through /bin/sh.
const HOOK = join(ROOT, ".githooks", "pre-commit");
const BOOTSTRAP = "run scripts/setup-env.sh (scripts/setup-env.ps1 on Windows) once";

/** A scratch repo root whose PATH holds only its `bin`, so no real deno is reachable. */
function scratch(layout: { deno: boolean; nodeModules: boolean }): { root: string; bin: string } {
  const root = tempDir("copilot-pre-commit-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (layout.deno) {
    // A deno the hook must never reach: running it would show on stderr and in the exit code.
    writeFileSync(join(bin, "deno"), "#!/bin/sh\necho 'stub deno ran' >&2\nexit 7\n");
    chmodSync(join(bin, "deno"), 0o755);
  }
  if (layout.nodeModules) mkdirSync(join(root, "node_modules"));
  return { root, bin };
}

test.skipIf(process.platform === "win32")(
  "pre-commit fails before any task, naming the bootstrap, when deno or node_modules is missing, and writes nothing",
  () => {
    const cases = [
      [{ deno: false, nodeModules: true }, "deno is not installed"],
      [{ deno: true, nodeModules: false }, "node_modules is missing"],
    ] as const;
    for (const [layout, missing] of cases) {
      const { root, bin } = scratch(layout);
      const before = readdirSync(root, { recursive: true }).sort();
      const res = runSync("/bin/sh", [HOOK], {
        cwd: root,
        env: { PATH: bin, HOME: root, DENO_INSTALL: join(root, "deno-install") },
      });
      expect(res).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `pre-commit: ${missing}; ${BOOTSTRAP}\n`,
      });
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    }
  },
);
