import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { consola } from "consola";
import { proxyStatus, stopTrackedProxy } from "../src/copilot_api/daemon.ts";
import { launchDaemon, pidAlive } from "../src/copilot_api/process.ts";
import { parseAbsolutePath } from "../src/copilot_api/sidecar.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import {
  acquireDaemonLockForLife,
  daemonLockHolderPid,
  daemonLockPath,
  daemonLockVerdict,
} from "../src/scripts/daemon_lock.ts";
import { releaseFileLock } from "../src/utils/file_lock.ts";
import { denoRunArgs, importSpecifier, ROOT, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  defaultHomeDir,
  envSnapshot,
  isolateProxyHome,
  removeDir,
  tmpDir,
  writeRunState,
} from "./helpers.ts";

// The daemon liveness lock: the daemon holds `<home>/daemon.lock` for its whole life
// (acquired by the daemon_lock_preload shim), and the liveness consults judge it BEFORE
// the pid table. These tests pin the decision table, the OS-enforced release semantics
// (SIGKILL frees the lock with no unlock code running -- the whole point), and the two
// consult sites' lock-first behavior against controls that the pre-lock pid
// classification would have decided the other way.

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

const restoreEnv = envSnapshot();
let dir = "";
afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const plantMarker = (home: string, pid: number): void => {
  mkdirSync(home, { recursive: true });
  writeFileSync(daemonLockPath(home), `${pid}\n${Date.now()}\n`);
};

// Open a loopback TCP listener standing in for a listening daemon; caller closes it.
function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from a TCP server"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const { server, port } = await listenEphemeral();
  await closeServer(server);
  return port;
}

async function until(deadlineMs: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe();
}

/** Run `body` with stdout/stderr captured (consola routes through one of them); the
 *  consola level is raised so info/warn are not self-silenced under the test runner. */
async function captureAllWrites(body: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    consola.level = 3;
    await body();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return written.join("");
}

// --- the decision table, in-process ------------------------------------------------------

test("daemonLockVerdict: absent, dead-marker, held, and foreign-pid judgments", () => {
  dir = tmpDir("copilot-daemon-lock-");

  // No lock file at all: a pre-lock daemon holds none, so nothing is proven either way.
  expect(daemonLockVerdict(dir, 123)).toBe("unproven");
  expect(daemonLockHolderPid(dir)).toBe(null);

  // A marker under a FREE lock names its dead writer: that pid is dead whatever the pid
  // table says; any OTHER pid stays unproven (the marker proves nothing about it).
  plantMarker(dir, DEAD_PID);
  expect(daemonLockVerdict(dir, DEAD_PID)).toBe("dead");
  expect(daemonLockVerdict(dir, process.pid)).toBe("unproven");
  expect(daemonLockHolderPid(dir)).toBe(null); // free = nobody HOLDS it

  // Acquired (stealing the dead holder's leftover): held = alive for the holder pid only.
  expect(acquireDaemonLockForLife(dir, { waitMs: 0 })).toBe(true);
  try {
    expect(daemonLockVerdict(dir, process.pid)).toBe("alive");
    expect(daemonLockVerdict(dir, DEAD_PID)).toBe("unproven");
    expect(daemonLockHolderPid(dir)).toBe(process.pid);
  } finally {
    releaseFileLock(daemonLockPath(dir));
  }
  expect(daemonLockVerdict(dir, process.pid)).toBe("unproven"); // released + marker gone
});

// --- the OS-enforced hold: cross-process contention and the SIGKILL release --------------

test("a live holder blocks acquisition; SIGKILL releases the lock promptly", async () => {
  dir = tmpDir("copilot-daemon-lock-");
  const home = join(dir, "home");
  const ready = join(dir, "ready");
  const holder = join(dir, "holder.ts");
  writeFileSync(
    holder,
    `import { acquireDaemonLockForLife } from ${
      importSpecifier(join(ROOT, "src", "scripts", "daemon_lock.ts"))
    };\n` +
      `if (!acquireDaemonLockForLife(${JSON.stringify(home)})) Deno.exit(1);\n` +
      `Deno.writeTextFileSync(${JSON.stringify(ready)}, "locked");\n` +
      "setInterval(() => {}, 60_000);\n", // hold for life (until killed)
  );
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), holder],
    stdout: "null",
    stderr: "inherit",
  });
  try {
    expect(await until(10_000, () => existsSync(ready))).toBe(true);

    // Holder alive: the probe sees it held by the child's pid, and a contender's
    // bounded-retry acquisition fails -- the OS lock, not the pid table, refuses it.
    expect(daemonLockHolderPid(home)).toBe(child.pid);
    expect(daemonLockVerdict(home, child.pid)).toBe("alive");
    expect(acquireDaemonLockForLife(home, { waitMs: 300, retryMs: 30 })).toBe(false);

    // SIGKILL: no unlock code runs, yet the OS releases the lock at process death --
    // the verdict flips to dead (same pid, now provably gone) promptly.
    child.kill("SIGKILL");
    await child.status;
    const flippedAt = Date.now();
    expect(await until(5_000, () => daemonLockVerdict(home, child.pid) === "dead")).toBe(true);
    expect(Date.now() - flippedAt).toBeLessThan(5_000);

    // And the lock is genuinely re-acquirable (the dead holder's marker is stolen).
    expect(acquireDaemonLockForLife(home, { waitMs: 1_000, retryMs: 50 })).toBe(true);
    releaseFileLock(daemonLockPath(home));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}, 30_000);

// --- the real daemon spawn: the preload takes the lock, SIGKILL frees it -----------------

test("a launched daemon holds its home's lock for life, released by SIGKILL", async () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  const port = await freePort();
  const logFile = join(dir, "daemon.log");
  writeFileSync(logFile, "");
  const pid = launchDaemon({
    port,
    logFile,
    home: dir,
    env: {},
    credential: { kind: "none" },
    idleWatchdog: false,
    muteProxyLogs: false,
    entry: {
      kind: "file",
      path: join(ROOT, "test", "copilot-api-fake.mjs"),
      configFile: join(ROOT, "deno.json"),
    },
    denoBin: parseAbsolutePath(Deno.execPath()),
  });
  try {
    // The preload acquires before the proxy serves, so a held lock is observable no
    // later than readiness.
    expect(
      await until(20_000, () => daemonLockVerdict(dir, pid) === "alive"),
    ).toBe(true);
    expect(daemonLockHolderPid(dir)).toBe(pid);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  expect(await until(5_000, () => !pidAlive(pid))).toBe(true);
  // The postcondition of the whole design: the killed daemon's lock reads dead, by pid.
  expect(await until(5_000, () => daemonLockVerdict(dir, pid) === "dead")).toBe(true);
}, 30_000);

// --- proxyStatus consults the lock first --------------------------------------------------

test("proxyStatus: a held lock proves the tracked daemon alive where classification says no", async () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  const home = defaultHomeDir();
  const { server, port } = await listenEphemeral();
  // This test process holds the default home's daemon lock and is the tracked pid: the
  // pre-lock classification would judge our argv "no" and report DOWN -- the lock-first
  // consult is exactly what makes this read UP.
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    writeRunState({ pid: process.pid, port });
    expect(await proxyStatus()).toEqual({ up: true, port });
  } finally {
    releaseFileLock(daemonLockPath(home));
    await closeServer(server);
  }
});

test("proxyStatus: an acquirable lock naming the tracked pid reads DOWN, pid table or not", async () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  const { server, port } = await listenEphemeral();
  try {
    // The pid is alive and the port genuinely listens, but the lock's marker names the
    // tracked pid under a FREE lock: the daemon that wrote it died, so the answer is
    // DOWN without consulting the pid table (pid-reuse immunity).
    plantMarker(defaultHomeDir(), process.pid);
    writeRunState({ pid: process.pid, port });
    expect(await proxyStatus()).toEqual({ up: false });
  } finally {
    await closeServer(server);
  }
});

// --- stopTrackedProxy consults the lock first ---------------------------------------------

test(
  "stopTrackedProxy: a lock-held corroborated daemon is signalled, lock-first",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const home = defaultHomeDir();
    const ready = join(dir, "ready");
    // A DAEMON-SHAPED holder (copilot-api entry basename + `start`): a lock-"alive" pid is
    // signalled only under the owner-filtered scan's corroboration -- on a shared home the
    // lock can be another host's daemon whose marker pid names an innocent local process
    // (the refusal is pinned by the coincidence test below). It locks the EFFECTIVE home,
    // which is what stopTrackedProxy consults for the default profile.
    const holder = join(dir, "copilot-api-holder.ts");
    writeFileSync(
      holder,
      `import { acquireDaemonLockForLife } from ${
        importSpecifier(join(ROOT, "src", "scripts", "daemon_lock.ts"))
      };\n` +
        `if (!acquireDaemonLockForLife(${JSON.stringify(home)})) Deno.exit(1);\n` +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holder, "start"],
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      writeRunState({ pid: child.pid });

      const result = await stopTrackedProxy();
      expect(result.trackedPid).toBe(child.pid);
      expect(result.signalled).toBe(true); // lock-alive AND corroborated as our daemon
      await child.status; // the SIGTERM (TerminateProcess on Windows) ends it
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  },
  30_000,
);

// The shared-home coincidence, on the STOP path: our daemon crashed leaving its state pid
// uncleared, the remote host's live daemon over the same home wrote the SAME number into
// the marker, and the local number was recycled onto an innocent process. The verdict
// reads "alive" -- the arm that used to signal uncorroborated -- but the stop must refuse
// and KEEP the tracking: the user asked to stop something provably still up, and silently
// unbinding it would lie.
test(
  "stopTrackedProxy: stale tracking + a held lock naming a local NON-daemon pid is refused, tracking kept",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const home = defaultHomeDir();
    const bystander = join(dir, "bystander.ts");
    writeFileSync(bystander, "setInterval(() => {}, 60_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), bystander],
      stdout: "null",
      stderr: "null",
    });
    // Stand-in for the remote host's daemon: THIS test process holds the lock, while the
    // marker and the stale run state both name the local bystander.
    expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
    try {
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      writeRunState({ pid: child.pid, port: 4141 });
      expect(daemonLockVerdict(home, child.pid)).toBe("alive"); // the old signal-alone arm

      const result = await stopTrackedProxy();

      expect(result).toEqual({ trackedPid: child.pid, signalled: false, stopped: false });
      expect(pidAlive(child.pid)).toBe(true); // never signalled
      // Tracking intact: the daemon (somewhere) is still up, so nothing was unbound.
      expect(new CopilotEnvRunState().read().pid).toBe(child.pid);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await until(5_000, () => !pidAlive(child.pid));
      releaseFileLock(daemonLockPath(home));
    }
  },
  30_000,
);

// The KILL-boundary reuse, on the STOP path: the TERM'd daemon dies inside the grace and
// the OS recycles its pid onto a foreign process, so terminatePid's boundary re-proof
// refuses the SIGKILL ("refused-reused-pid"). OUR daemon is provably gone -- the stop
// must count as STOPPED, CLEAR the tracking, and say so honestly, never keep pointing
// follow-up stops (or de-auth's "still running" warning) at an innocent bystander. Under
// the historical void-returning terminatePid this control goes red: the caller could only
// guess from the live foreign pid, computed stopped=false, and KEPT the tracking. The
// classify seam answers "yes" at the TERM gate (the seconds-old proof that authorized the
// signal) and "no" at the KILL boundary; the TERM-surviving bystander needs a trappable
// SIGTERM, so POSIX-only (same gating as the terminate_pid controls).
test.skipIf(process.platform === "win32")(
  "stopTrackedProxy: a KILL-boundary pid-reuse refusal counts as stopped, clears tracking, reports",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const ready = join(dir, "ready");
    const bystander = join(dir, "bystander.ts");
    // Stands in for the foreign process wearing the recycled pid: ignores SIGTERM so it
    // is provably alive at the KILL boundary, and its survival proves the refusal.
    writeFileSync(
      bystander,
      'Deno.addSignalListener("SIGTERM", () => {});\n' +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), bystander],
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      // No daemon.lock at all ("unproven"), so the TERM gate falls back to classification.
      writeRunState({ pid: child.pid, port: 4141 });
      const answers: ("yes" | "no")[] = ["yes", "no"];
      const calls: number[] = [];
      const classify = (pid: number): Promise<"yes" | "no" | "unknown"> => {
        calls.push(pid);
        return Promise.resolve(answers.shift() ?? "no");
      };

      let result: Awaited<ReturnType<typeof stopTrackedProxy>> | undefined;
      const output = await captureAllWrites(async () => {
        result = await stopTrackedProxy(300, null, classify);
      });

      // Signalled on the TERM-gate "yes", stopped on the boundary's proof of death --
      // and both identity reads happened, against the tracked pid.
      expect(result).toEqual({ trackedPid: child.pid, signalled: true, stopped: true });
      expect(calls).toEqual([child.pid, child.pid]);
      expect(pidAlive(child.pid)).toBe(true); // the foreign process was spared
      // Tracking cleared: our daemon is gone, so nothing may still point at the bystander.
      expect(new CopilotEnvRunState().read().pid).toBe(undefined);
      // Honest report: terminatePid's refusal warning plus the stop's own clearing line.
      expect(output).toContain(`Not escalating pid ${child.pid} to SIGKILL`);
      expect(output).toContain(
        `The tracked proxy (pid ${child.pid}) already exited and its pid now belongs to a different process; cleared the stale tracking.`,
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await until(5_000, () => !pidAlive(child.pid));
    }
  },
  30_000,
);

test("stopTrackedProxy: a lock-dead tracked pid is never signalled, and tracking clears", async () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  // The tracked pid is OUR OWN live pid with a free lock naming it: the dead verdict must
  // win over the live pid table, or this very test process would be signalled here.
  plantMarker(defaultHomeDir(), process.pid);
  writeRunState({ pid: process.pid, port: 4141 });

  const result = await stopTrackedProxy();
  expect(result).toEqual({ trackedPid: process.pid, signalled: false, stopped: true });
});
