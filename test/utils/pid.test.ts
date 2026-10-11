// The daemon runs on the Deno sidecar under a permission set without --allow-run, where the null
// signal throws Deno's NotCapable with code undefined; an EPERM-only catch read that as DEAD, and
// pidAlive=false gates tracking clears, sweeps, and now the file lock's takeover. The restricted
// run below produces the real NotCapable, so the "unproven" mapping and withUnprovablePidProbe
// (test/helpers/daemon.ts) are anchored to the genuine shape.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDenoBin } from "../../src/copilot_api/sidecar.ts";
import { pidAlive, pidLiveness } from "../../src/utils/pid.ts";
import { bunRunArgs, importSpecifier, ROOT, runSync } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

let dir = "";
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
    // the capability the null signal needs -- the set every in-daemon consumer runs under. The
    // deno is the sidecar's (PATH or the override), the one the daemon itself runs on.
    const restricted = runSync(resolveDenoBin(), [
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
    // Control: the identical script under the CLI's own runtime proves the reading above is the
    // permission set's doing, not the harness's: our own pid reads alive and a never-assigned pid
    // reads dead.
    const control = runSync(process.execPath, [...bunRunArgs(), script]);
    expect(control.exitCode).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual(["alive", "dead", true, false]);
  },
  30_000,
);
