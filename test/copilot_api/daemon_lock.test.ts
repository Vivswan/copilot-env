import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  anyTrackedDaemonAlive,
  proxyStatus,
  stopTrackedProxy,
} from "../../src/copilot_api/daemon.ts";
import { CopilotApiPaths } from "../../src/copilot_api/paths.ts";
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { launchDaemon } from "../../src/copilot_api/process.ts";
import { pidAlive } from "../../src/utils/pid.ts";
import { resolveDenoBin } from "../../src/copilot_api/sidecar.ts";
import { daemonConfigFile, writeDaemonConfig } from "../../src/proxy_float.ts";
import { resolveRootHome } from "../../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../../src/copilot_api/run_state.ts";
import {
  acquireDaemonLockForLife,
  daemonLockHolderPid,
  daemonLockPath,
  daemonLockVerdict,
} from "../../src/copilot_api/daemon_lock.ts";
import { releaseFileLock } from "../../src/utils/file_lock.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  spawnChild,
} from "../helpers/run.ts";
import { afterEach, expect, tempDir, test } from "../helpers/testing.ts";
import { defaultHomeDir, envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { writeRunState } from "../helpers/fixtures.ts";
import {
  FAKE_DAEMON_CREDENTIAL,
  FAKE_DAEMON_HOST,
  until,
  withUnprovablePidProbe,
} from "../helpers/daemon.ts";
import { captureAllWrites } from "../helpers/output.ts";
import { closeServer, freePort, listenEphemeral } from "../helpers/net.ts";

// The daemon holds `<home>/daemon.lock` for life (acquired by daemon_lock_preload), and the
// liveness consults judge it BEFORE the pid table. The lock is the marker file naming the
// holder's pid (src/utils/file_lock.ts): SIGKILL leaves the file behind with a dead pid in it,
// which reads as dead with no unlock code running; that is the whole point.

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

const restoreEnv = envSnapshot();
let dir = "";
afterEach(() => {
  restoreEnv();
});

const plantMarker = (home: string, pid: number): void => {
  mkdirSync(home, { recursive: true });
  writeFileSync(daemonLockPath(home), `${pid}\n${Date.now()}\n`);
};

// --- the decision table, in-process ------------------------------------------------------

test("anyTrackedDaemonAlive: a named profile's live daemon counts, not only the default's", () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  expect(anyTrackedDaemonAlive()).toBe(false);
  // The preferences are account-wide, so a `--profile work` daemon holding its lock is a
  // daemon the restart hint must speak of even with no default daemon tracked.
  const work = parseProfileName("work");
  const home = new CopilotApiPaths(work).home;
  writeRunState({ pid: process.pid }, work);
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    expect(anyTrackedDaemonAlive()).toBe(true);
  } finally {
    releaseFileLock(daemonLockPath(home));
  }
});

test("daemonLockVerdict: absent, dead-marker, held, and foreign-pid judgments", () => {
  dir = tempDir("copilot-daemon-lock-");

  // No lock file at all: a pre-lock daemon holds none, so nothing is proven either way.
  expect(daemonLockVerdict(dir, 123)).toBe("unproven");
  expect(daemonLockHolderPid(dir)).toBe(null);

  // A marker naming a dead pid is a dead daemon's; any OTHER pid stays unproven (the marker
  // proves nothing about it).
  plantMarker(dir, DEAD_PID);
  expect(daemonLockVerdict(dir, DEAD_PID)).toBe("dead");
  expect(daemonLockVerdict(dir, process.pid)).toBe("unproven");
  expect(daemonLockHolderPid(dir)).toBe(null); // free = nobody HOLDS it

  // Acquired over the dead holder's leftover: held = alive for the holder pid only.
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

// --- the cross-process hold: contention and the SIGKILL release ---------------------------

test("a live holder blocks acquisition; SIGKILL releases the lock promptly", async () => {
  dir = tempDir("copilot-daemon-lock-");
  const home = join(dir, "home");
  const ready = join(dir, "ready");
  const holder = join(dir, "holder.ts");
  writeFileSync(
    holder,
    `import { writeFileSync } from "node:fs";\n` +
      `import { acquireDaemonLockForLife } from ${
        importSpecifier(join(ROOT, "src", "copilot_api", "daemon_lock.ts"))
      };\n` +
      `if (!acquireDaemonLockForLife(${CHILD_VALUES}.home)) process.exit(1);\n` +
      `writeFileSync(${CHILD_VALUES}.ready, "locked");\n` +
      "setInterval(() => {}, 60_000);\n",
  );
  const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), holder],
    env: childValuesEnv({ home, ready }),
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    await until(() => existsSync(ready));

    // Holder alive: the probe sees it held by the child's pid, and a contender's
    // bounded-retry acquisition fails -- the holder's pid lives, so the marker is no leftover.
    expect(daemonLockHolderPid(home)).toBe(child.pid);
    expect(daemonLockVerdict(home, child.pid)).toBe("alive");
    expect(acquireDaemonLockForLife(home, { waitMs: 300, retryMs: 30 })).toBe(false);

    // SIGKILL: no unlock code runs, the marker stays, and its pid is now provably gone --
    // the verdict flips to dead (same pid) promptly.
    child.kill("SIGKILL");
    await child.exited;
    const flippedAt = Date.now();
    await until(() => daemonLockVerdict(home, child.pid) === "dead");
    expect(Date.now() - flippedAt).toBeLessThan(5_000);

    // And the lock is genuinely re-acquirable (the dead holder's marker is taken over).
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

// The daemon side of the protocol for real: the sidecar deno (PATH or the override) runs the fake
// proxy with the preload shims under the generated daemon config, and daemon_lock_preload creates
// the same marker file this process judges.
test("a launched daemon holds its home's lock for life, released by SIGKILL", async () => {
  dir = isolateProxyHome("copilot-daemon-lock-");
  const port = await freePort();
  const logFile = join(dir, "daemon.log");
  writeFileSync(logFile, "");
  writeDaemonConfig(resolveRootHome());
  // A predecessor's leftover: the launch clears it, or the daemon's own acquire (which cannot
  // judge the pid) would refuse for its whole budget and the proxy would never serve.
  plantMarker(dir, DEAD_PID);
  const pid = launchDaemon({
    port,
    logFile,
    home: dir,
    env: {},
    credential: FAKE_DAEMON_CREDENTIAL,
    idleWatchdog: false,
    muteProxyLogs: false,
    copilotHost: FAKE_DAEMON_HOST,
    entry: {
      kind: "file",
      path: join(ROOT, "test", "copilot-api-fake.mjs"),
      configFile: daemonConfigFile(resolveRootHome()),
    },
    denoBin: resolveDenoBin(),
  });
  try {
    // The preload acquires before the proxy serves, so a held lock is observable no
    // later than readiness.
    await until(() => daemonLockVerdict(dir, pid) === "alive");
    expect(daemonLockHolderPid(dir)).toBe(pid);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await until(() => !pidAlive(pid));
  // The postcondition of the whole design: the killed daemon's lock reads dead, by pid.
  await until(() => daemonLockVerdict(dir, pid) === "dead");
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
    // The pid is alive and the port genuinely listens, but the lock's marker names a pid
    // nothing holds the lock under (our own, outside this process's record): the daemon that
    // wrote it is gone, so the answer is DOWN without consulting the pid table.
    plantMarker(defaultHomeDir(), process.pid);
    writeRunState({ pid: process.pid, port });
    expect(await proxyStatus()).toEqual({ up: false });
  } finally {
    await closeServer(server);
  }
});

// --- stopTrackedProxy consults the lock first ---------------------------------------------

/** A process the owner-filtered scan classifies as our daemon: the sidecar deno running an entry
 *  whose basename starts with `copilot-api`, with `start` next. Nothing else in the process table
 *  qualifies, the CLI's own Bun processes included. */
function spawnDaemonShapedDecoy(
  dir: string,
  ready: string,
): Bun.Subprocess<"ignore", "ignore", "inherit"> {
  const decoy = join(dir, "copilot-api-decoy.mjs");
  writeFileSync(
    decoy,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${CHILD_VALUES}.ready, "up");\n` +
      "setInterval(() => {}, 60_000);\n",
  );
  return spawnChild(resolveDenoBin(), {
      args: ["run", "--allow-write", "--allow-env", decoy, "start"],
    env: childValuesEnv({ ready }),
    stdout: "ignore",
    stderr: "inherit",
  });
}

test(
  "stopTrackedProxy: a lock-held corroborated daemon is signalled, lock-first",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const home = defaultHomeDir();
    const ready = join(dir, "ready");
    // A lock-alive pid is signalled only under the owner-filtered scan's corroboration; the
    // shared-home refusal is the test below. This process takes the effective home's lock (the
    // one stopTrackedProxy consults for the default profile) and the marker then names the
    // daemon-shaped decoy, as the decoy's own acquire would have left it.
    const child = spawnDaemonShapedDecoy(dir, ready);
    try {
      await until(() => existsSync(ready));
      expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      writeRunState({ pid: child.pid });
      expect(daemonLockVerdict(home, child.pid)).toBe("alive");

      const result = await stopTrackedProxy();
      expect(result.trackedPid).toBe(child.pid);
      expect(result.signalled).toBe(true); // lock-alive AND corroborated as our daemon
      await child.exited; // the SIGTERM (TerminateProcess on Windows) ends it
    } finally {
      // The marker names the decoy, so this drops the record alone and leaves the file.
      releaseFileLock(daemonLockPath(home));
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  },
  30_000,
);

// Shared-home coincidence on the STOP path: our crashed daemon's state pid, the remote
// daemon's marker, and an innocent local process all carry the same number. The stop must
// refuse AND keep the tracking: the user asked to stop something provably still up, and
// unbinding it would lie.
test(
  "stopTrackedProxy: stale tracking + a held lock naming a local NON-daemon pid is refused, tracking kept",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const home = defaultHomeDir();
    const bystander = join(dir, "bystander.ts");
    writeFileSync(bystander, "setInterval(() => {}, 60_000);\n");
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), bystander],
      stdout: "ignore",
      stderr: "ignore",
    });
    // Stand-in for the remote host's daemon: THIS test process took the lock, then the marker
    // (and the stale run state) name the local bystander, a live pid: the lock reads held by it.
    expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
    try {
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      writeRunState({ pid: child.pid, port: 4141 });
      expect(daemonLockVerdict(home, child.pid)).toBe("alive"); // must not authorize alone

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
      // Our own lock first: the wait below can end with the deadline's error.
      releaseFileLock(daemonLockPath(home));
      await until(() => !pidAlive(child.pid));
    }
  },
  30_000,
);

// KILL-boundary pid reuse on the STOP path: the TERM'd daemon dies inside the grace and the
// OS recycles its pid onto a foreign process, so terminatePid's boundary re-proof refuses
// the SIGKILL. Our daemon is provably gone, so the stop counts as STOPPED, clears the
// tracking and says so; keeping it would point follow-up stops at the bystander.
//   classify at the TERM gate      -> "yes" (the proof that authorized the signal)
//   classify at the KILL boundary  -> "no"
// POSIX-only: the TERM-surviving bystander needs a trappable SIGTERM.
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
      `import { writeFileSync } from "node:fs";\n` +
        'process.on("SIGTERM", () => {});\n' +
        `writeFileSync(${CHILD_VALUES}.ready, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), bystander],
      env: childValuesEnv({ ready }),
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
      // No daemon.lock at all ("unproven"), so the TERM gate falls back to classification.
      writeRunState({ pid: child.pid, port: 4141 });
      const answers: ("yes" | "no")[] = ["yes", "no"];
      const classify = (_pid: number): Promise<"yes" | "no" | "unknown"> =>
        Promise.resolve(answers.shift() ?? "no");

      let result: Awaited<ReturnType<typeof stopTrackedProxy>> | undefined;
      const output = await captureAllWrites(async () => {
        result = await stopTrackedProxy(300, null, classify);
      });

      // Signalled on the TERM-gate "yes", stopped on the boundary's proof of death.
      expect(result).toEqual({ trackedPid: child.pid, signalled: true, stopped: true });
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
      await until(() => !pidAlive(child.pid));
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

// --- the unprovable-liveness posture (probe cannot run: every pid reads "unproven") ------

// With no lock to consult and an unprovable pid-table read, the identity scan and the port
// probe own the verdict: a live daemon-shaped tracked pid whose recorded port answers reads
// UP (the real NotCapable probe shape is pinned in test/utils/pid.test.ts).
test(
  "proxyStatus: an unprovable liveness read defers to identity + port probe, not DOWN",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    // The real classification must answer "yes" for the status to survive the pid-reuse guard.
    const ready = join(dir, "ready");
    const child = spawnDaemonShapedDecoy(dir, ready);
    const { server, port } = await listenEphemeral();
    try {
      await until(() => existsSync(ready));
      writeRunState({ pid: child.pid, port });
      await withUnprovablePidProbe(async () => {
        expect(await proxyStatus()).toEqual({ up: true, port });
      });
    } finally {
      await closeServer(server);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.exited;
    }
  },
  30_000,
);

// graceMs > 0 is the caller that must be SURE (de-auth): with no signal deliverable and no
// death provable, the stop must not claim stopped and must keep the tracking, so a follow-up
// `agent stop` from a capable shell can still target the daemon.
test(
  "stopTrackedProxy: an unprovable stop keeps the tracking and never claims stopped",
  async () => {
    dir = isolateProxyHome("copilot-daemon-lock-");
    const ready = join(dir, "ready");
    const bystander = join(dir, "bystander.ts");
    writeFileSync(
      bystander,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${CHILD_VALUES}.ready, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), bystander],
      env: childValuesEnv({ ready }),
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
      writeRunState({ pid: child.pid, port: 4141 });
      // No lock file: the verdict is "unproven" and the injected TERM-gate classify
      // answers "yes" (a confirmed daemon this token still cannot signal or re-probe).
      const classify = (): Promise<"yes" | "no" | "unknown"> => Promise.resolve("yes");
      let result: Awaited<ReturnType<typeof stopTrackedProxy>> | undefined;
      await withUnprovablePidProbe(async () => {
        result = await stopTrackedProxy(300, null, classify);
      });
      // Signalled (attempted, honestly reported) but NOT stopped: no death was proven.
      expect(result).toEqual({ trackedPid: child.pid, signalled: true, stopped: false });
      // Alive and still tracked: never cleared on a failed look.
      expect(pidAlive(child.pid)).toBe(true);
      expect(new CopilotEnvRunState().read().pid).toBe(child.pid);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.exited;
    }
  },
  30_000,
);
