// Under the daemon's permission set (everything but --allow-run) the null signal throws Deno's
// NotCapable with code undefined, which an EPERM-only catch read as DEAD; pidAlive=false gates lock
// steals, tracking clears, and sweeps. The restricted run below produces the real NotCapable, so the
// "unproven" mapping and withUnprovablePidProbe (test/helpers.ts) are anchored to the genuine shape.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, pidLiveness } from "../src/utils/pid.ts";
import { denoRunArgs, importSpecifier, ROOT, runSync } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

test("pidLiveness: alive for our own pid, dead for a never-assigned pid", () => {
  expect(pidLiveness(process.pid)).toBe("alive");
  expect(pidLiveness(DEAD_PID)).toBe("dead");
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(DEAD_PID)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "pidLiveness: a denied signal (EPERM) is an EXISTING pid -- alive",
  () => {
    // pid 1 always exists on POSIX. As an unprivileged user the null signal is refused
    // with EPERM (the pid exists, this token can't signal it); as root (the docker
    // suite) it is simply delivered. Alive either way, never dead.
    expect(pidLiveness(1)).toBe("alive");
    expect(pidAlive(1)).toBe(true);
  },
);

test(
  "pidLiveness: a probe the permission set cannot run is 'unproven', never dead (real NotCapable)",
  () => {
    dir = tempDir("copilot-env-pid-");
    const script = join(dir, "probe.ts");
    writeFileSync(
      script,
      `import { pidAlive, pidLiveness } from ${
        importSpecifier(join(ROOT, "src", "utils", "pid.ts"))
      };\n` +
        "console.log(JSON.stringify([\n" +
        `  pidLiveness(${process.pid}), pidLiveness(${DEAD_PID}),\n` +
        `  pidAlive(${process.pid}), pidAlive(${DEAD_PID}),\n` +
        "]));\n",
    );
    // The daemon's own grants (PROXY_PERMISSIONS minus net): everything BUT --allow-run,
    // the capability the null signal needs -- the set every in-daemon consumer runs under.
    const restricted = runSync(Deno.execPath(), [
      "run",
      "--quiet",
      "--no-prompt",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-sys",
      script,
    ]);
    expect(restricted.exitCode).toBe(0);
    // A live pid and a never-assigned pid read the SAME: the probe could not look, so neither is a
    // verdict, and the wrapper flattens both to true so no boolean consumer acts on an unproven death.
    expect(JSON.parse(restricted.stdout)).toEqual(["unproven", "unproven", true, true]);
    // Control: the identical script under the run-granted test permission set proves the
    // reading above is the permission set's doing, not the harness's.
    const control = runSync(Deno.execPath(), [...denoRunArgs(), script]);
    expect(control.exitCode).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual(["alive", "dead", true, false]);
  },
  30_000,
);
