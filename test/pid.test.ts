// The three-state pid-liveness primitive (src/utils/pid.ts): alive / dead / unproven,
// and the pidAlive wrapper -- the house accepted-flatten with the safe direction built
// in (true = NOT PROVABLY DEAD). The unproven arm is the measured bug's home: under the
// daemon's own permission set (PROXY_PERMISSIONS -- everything but --allow-run) the
// null signal throws Deno's NotCapable (code: undefined), which the historical
// EPERM-only catch read as DEAD -- and pidAlive=false gates lock steals, tracking
// clears, and sweep decisions across the tree. The restricted run below produces the
// REAL NotCapable, so the "unproven" mapping (and the monkeypatched thrower the
// consumer tests use, see withUnprovablePidProbe in test/helpers.ts) is anchored to the
// genuine error shape rather than a guessed one.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, pidLiveness } from "../src/utils/pid.ts";
import { denoRunArgs, importSpecifier, ROOT, runSync } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { removeDir, tmpDir } from "./helpers.ts";

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

test("pidLiveness: alive for our own pid, dead for a never-assigned pid", () => {
  expect(pidLiveness(process.pid)).toBe("alive");
  expect(pidLiveness(DEAD_PID)).toBe("dead");
  // The flatten under a runnable probe: alive stays true, a proven death reads false.
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
    dir = tmpDir("copilot-env-pid-");
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
    // A live parent and a never-assigned pid read the SAME: the probe failed to look, so
    // neither is a verdict -- mapping either to "dead" is exactly the measured bug. The
    // wrapper flattens both to true (NOT PROVABLY DEAD): under this permission set no
    // boolean consumer -- lock steal, tracking clear, sweep, died-in-grace,
    // failed-to-start -- can ever act on a death the probe never proved.
    expect(JSON.parse(restricted.stdout)).toEqual(["unproven", "unproven", true, true]);
    // Control: the identical script under the run-granted test permission set proves the
    // reading above is the permission set's doing, not the harness's.
    const control = runSync(Deno.execPath(), [...denoRunArgs(), script]);
    expect(control.exitCode).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual(["alive", "dead", true, false]);
  },
  30_000,
);
