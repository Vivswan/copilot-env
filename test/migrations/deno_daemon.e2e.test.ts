// The 5.0.1 step over the deno release's daemon, alone in its file: every case here spawns this
// run's bun under the name `deno` (test/helpers/daemon.ts) and proves, stops, or spares it the way
// `agent update` meets it.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { daemonLockPath } from "../../src/copilot_api/daemon_lock.ts";
import { proxyPortFree } from "../../src/copilot_api/port.ts";
import {
  listenerLookCommand,
  type ProcessLook,
  type ProcessRow,
  processIsZombie,
  processLookCommand,
  processStartMs,
  stopPidCommand,
} from "../../src/copilot_api/process.ts";
import { retireDenoDaemon, stopPreviousDaemons } from "../../src/migrations/5.0.1.ts";
import { runMigrations } from "../../src/migrations/index.ts";
import {
  type DenoStopOutcome,
  denoLockSidecarPath,
  isDenoDaemonRow,
  type LockVerdict,
  prove,
  REAL_HOLDER_READS,
  stopLockedDaemon,
} from "../../src/migrations/legacy_daemon.ts";
import { commandExists } from "../../src/utils/command.ts";
import { renderDryRun } from "../../src/utils/dry_run_report.ts";
import { pidAlive } from "../../src/utils/pid.ts";
import {
  denoEraDaemon,
  killAndAwaitExit,
  spawnDaemonShapedChild,
  until,
} from "../helpers/daemon.ts";
import { dryRunChanges, fingerprintTree } from "../helpers/dry_run.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { captureChannels } from "../helpers/output.ts";
import { bunRunArgs, spawnChild } from "../helpers/run.ts";
import { afterEach, expect, step, tempDir, test } from "../helpers/testing.ts";

const restoreEnv = envSnapshot();

afterEach(() => {
  restoreEnv();
});

test("5.0.1 deno leftovers: the sidecar dir, the float's deno files, and OUR .npmrc go; the user's .npmrc and the record stay", async () => {
  // The marker is what tells the float's .npmrc from one the user wrote at the same path: an
  // unmarked file is never ours to delete, however the home came to hold it.
  const home = tempDir("copilot-migrate-deno-");
  const debris = [
    join(home, "deno", "2.9.7", "deno"),
    join(home, "deno", "cache", "npm", "registry.npmjs.org", "x"),
    join(home, "proxy", "deno.json"),
    join(home, "proxy", "deno.lock"),
  ];
  const kept = [
    join(home, "proxy", "resolved-version.json"),
    join(home, "proxy", "package.json"),
    join(home, "state.json"),
  ];
  for (const path of [...debris, ...kept]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
  }
  const npmrc = join(home, ".npmrc");
  writeFileSync(npmrc, "registry=https://example.test\n");
  const retire = async (): Promise<string> =>
    (await captureChannels(() => retireDenoDaemon(home, []))).all;
  expect(await retire()).not.toContain(npmrc);
  expect(readFileSync(npmrc, "utf8")).toBe("registry=https://example.test\n");
  expect(debris.map((path) => existsSync(path))).toEqual([false, false, false, false]);
  expect(existsSync(join(home, "deno"))).toBe(false);
  expect(kept.map((path) => existsSync(path))).toEqual([true, true, true]);

  writeFileSync(
    npmrc,
    "# managed by copilot-env (proxy float); do not edit\ntrust-policy=no-downgrade\n",
  );
  expect(await retire()).toContain(npmrc);
  expect(existsSync(npmrc)).toBe(false);
  // A second run has nothing to do and says nothing: the step is idempotent.
  expect(await retire()).toBe("");
});

// The deno release's daemon identifies itself by its argv, an external fact of a release no
// longer in this repository: the real shape (as that release's spawn wrote it, and as Windows
// quotes it) reads as the daemon with its port, and this release's daemon, a bare bun, a portless
// invocation, and an impostor that mentions copilot-api and start as text do not.
test("5.0.1: the deno-era daemon is told by its runtime and argv shape, port included", () => {
  const denoArgv =
    "run --config /home/user/.local/share/copilot-env/proxy/deno.json --cached-only " +
    "--node-modules-dir=none --allow-env --allow-read --allow-write --allow-net --allow-sys " +
    "--preload /home/user/.copilot-env/current/src/scripts/node_compat_preload.ts " +
    "npm:@jeffreycao/copilot-api@2.6.19 start --verbose --port 4141";
  const rows: Array<{ ucomm: string; command: string; deno: boolean }> = [
    {
      ucomm: "deno",
      command: `/home/user/.local/share/copilot-env/deno/bin/deno ${denoArgv}`,
      deno: true,
    },
    { ucomm: "deno.exe", command: `"C:\\Users\\user\\deno\\deno.exe" ${denoArgv}`, deno: true },
    {
      ucomm: "deno",
      command: `deno run /home/user/x/copilot-api/dist/main.js start --port 4141`,
      deno: true,
    },
    { ucomm: "deno", command: "deno run /home/user/x/copilot-api/dist/main.js start", deno: false },
    { ucomm: "bun", command: `/home/user/.bun/bin/bun ${denoArgv}`, deno: false },
    { ucomm: "deno", command: 'deno run /home/user/agent.ts "copilot-api start"', deno: false },
    { ucomm: "deno", command: "deno repl", deno: false },
  ];
  expect(rows.map((row) => isDenoDaemonRow({ pid: 1, ...row }))).toEqual(
    rows.map((row) => row.deno),
  );
});

// The incident: the step once stopped whatever live pid a home's lock named, so after a reboot
// the deno daemon's marker, naming a pid the OS had given to some other process, got that
// process killed; a same-shaped deno of another install would pass a shape check alone, hence
// the author proof. Each home below is one holder kind; the expectation table says what each keeps.
test("5.0.1: the deno-era daemon is stopped and its port freed; a recycled pid is never signalled; ours stays", async () => {
  const root = isolateProxyHome("copilot-migrate-daemon-");
  const [deno, late, portless, bare, recycled, bystander, dead, ours] = [
    "deno",
    "late",
    "portless",
    "bare",
    "recycled",
    "bystander",
    "dead",
    "ours",
  ].map((name) => join(root, "profiles", name)) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const homes = [deno, late, portless, bare, recycled, bystander, dead, ours];
  for (const home of homes) mkdirSync(home, { recursive: true });
  const idle = join(root, "copilot-api", "idle.ts");
  mkdirSync(join(idle, ".."), { recursive: true });
  writeFileSync(idle, "setInterval(() => {}, 60_000);\n");
  // Two plain bun children, alive and nothing like either release's daemon on their argv.
  const plain = () =>
    spawnChild(process.execPath, {
      args: [...bunRunArgs(), join(root, "plain.ts")],
      stdout: "ignore",
      stderr: "ignore",
    });
  writeFileSync(join(root, "plain.ts"), "setInterval(() => {}, 60_000);\n");
  const recycledPid = plain();
  const bystanderPid = plain();
  // This release's daemon: the shape the owner-filtered scan classifies as ours.
  const own = spawnDaemonShapedChild(idle);
  const daemon = await denoEraDaemon(root, deno);
  // Another install's deno copilot-api, the same shape, that the OS gave a dead daemon's pid: its
  // marker was written a minute before this process started, so it cannot be the author.
  const lateDaemon = await denoEraDaemon(root, late, { markerMs: () => Date.now() - 60_000 });
  const portlessDaemon = await denoEraDaemon(root, portless, { portless: true });
  const bareDaemon = await denoEraDaemon(root, bare, { sidecar: false });
  const marker = (home: string, pid: number): void =>
    writeFileSync(daemonLockPath(home), `${pid}\n${Date.now()}\n`);
  try {
    marker(recycled, recycledPid.pid);
    writeFileSync(denoLockSidecarPath(recycled), "");
    marker(bystander, bystanderPid.pid);
    marker(dead, 2_147_483_646);
    marker(ours, own.pid);

    step("the step over every home");
    let clear: boolean | null = null;
    const said = (
      await captureChannels(async () => {
        clear = (await stopPreviousDaemons(homes)).clear;
      })
    ).all;
    expect(said).toContain(`stopped the deno-era proxy daemon (pid ${daemon.pid}) in ${deno}:`);
    expect(said).toContain(`removed ${daemonLockPath(late)} and its .oslock sidecar`);
    expect(said).toContain(
      `  left a daemon running: pid ${portlessDaemon.pid} is a deno, but its argv names no --port\n`,
    );
    expect(said).toContain(
      `  left a daemon running: pid ${bareDaemon.pid} is a deno, but its lock has no .oslock sidecar, so it is not the deno release's\n`,
    );
    expect(said).toContain(`removed ${daemonLockPath(recycled)} and its .oslock sidecar`);
    expect(said).toContain(
      `left ${daemonLockPath(bystander)} alone: pid ${bystanderPid.pid} is not the deno-era daemon`,
    );
    step("the stopped daemon's exit");
    await until(() => !pidAlive(daemon.pid));
    expect({
      clear,
      portFree: await proxyPortFree(daemon.port as number),
      alive: [lateDaemon, portlessDaemon, bareDaemon, recycledPid, bystanderPid, own].map((c) =>
        pidAlive(c.pid),
      ),
      locks: homes.map((home) => existsSync(daemonLockPath(home))),
      sidecars: [deno, late, portless, recycled].map((home) =>
        existsSync(denoLockSidecarPath(home)),
      ),
    }).toEqual({
      // The portless and the bare daemon may still run, so the files must stay.
      clear: false,
      portFree: true,
      alive: [true, true, true, true, true, true],
      locks: [false, false, true, true, false, true, false, true],
      sidecars: [false, false, true, false],
    });

    // Idempotent: a second pass finds nothing to stop and leaves what it left.
    const again = (await captureChannels(async () => void (await stopPreviousDaemons(homes)))).all;
    expect(again).not.toContain("stopped the deno-era proxy daemon");
    expect([bystander, ours].map((home) => existsSync(daemonLockPath(home)))).toEqual([true, true]);
  } finally {
    await daemon.teardown();
    await lateDaemon.teardown();
    await portlessDaemon.teardown();
    await bareDaemon.teardown();
    await killAndAwaitExit(recycledPid.pid);
    await killAndAwaitExit(bystanderPid.pid);
    await killAndAwaitExit(own.pid);
  }
}, 60_000);

// A daemon that drops its lock while shutting down and then hangs once read as stopped, and its
// files went under a live process. Without the lock the pid cannot be re-proved at the SIGKILL
// boundary: nothing more is sent, it reads still-running, the files stay.
//
// A re-run finds no lock, yet the daemon's argv names this root home's deno.json, so the table
// scan keeps the files until it is gone. POSIX only (no SIGTERM on Windows).
test.skipIf(process.platform === "win32")(
  "5.0.1: a deno daemon that drops its lock on SIGTERM and hangs is still-running, and the files stay across a re-run",
  async () => {
    const root = isolateProxyHome("copilot-migrate-deno-hang-");
    const home = join(root, "profiles", "default");
    mkdirSync(home, { recursive: true });
    const denoFile = join(root, "deno", "entry");
    mkdirSync(join(denoFile, ".."), { recursive: true });
    writeFileSync(denoFile, "{}\n");
    const daemon = await denoEraDaemon(root, home, { dropsLockOnTerm: true, provenance: true });
    try {
      step("the step over the hanging daemon");
      const said = (await captureChannels(() => retireDenoDaemon(root, [home]))).all;
      step("the re-run after the lock drop");
      const again = (await captureChannels(() => retireDenoDaemon(root, [home]))).all;
      expect({
        alive: pidAlive(daemon.pid),
        denoFile: existsSync(denoFile),
        lock: existsSync(daemonLockPath(home)),
        said: said.includes(
          `  the deno-era proxy daemon (pid ${daemon.pid}) did not stop: spared\n    pid ${daemon.pid} is still that daemon after the SIGKILL grace; ${daemonLockPath(home)} may be gone\n    stop it by hand:  ${stopPidCommand(daemon.pid, true)}\n`,
        ),
        filesStay: said.includes("the deno-era files stay"),
        stray: again.includes(
          `  a deno of this root home still runs: pid ${daemon.pid} on port ${daemon.port}\n`,
        ),
        filesStayAgain: again.includes("the deno-era files stay"),
      }).toEqual({
        alive: true,
        denoFile: true,
        lock: false,
        said: true,
        filesStay: true,
        stray: true,
        filesStayAgain: true,
      });
    } finally {
      await daemon.teardown();
    }
  },
  40_000,
);

// The daemon exits on SIGTERM and, inside the grace, the OS hands its pid to a stranger, who once
// read as still-running and was offered to `kill -9`. The identity re-read (shape, start time)
// tells the stranger apart: no KILL, the stop verified by the free port, the lock pair removed.
//
// The fixture stands in for both: it closes its listener on SIGTERM and stays, and every start read
// after the proof's own is a minute later than the real one. POSIX only (no SIGTERM on Windows).
test.skipIf(process.platform === "win32")(
  "5.0.1: a pid recycled inside the grace is spared, the stop verified by the port, the lock pair removed",
  async () => {
    const root = isolateProxyHome("copilot-migrate-deno-recycle-");
    const home = join(root, "profiles", "default");
    mkdirSync(home, { recursive: true });
    const daemon = await denoEraDaemon(root, home, { closesOnTerm: true });
    // The proof's own start read is the real one; every read after it (the SIGKILL re-proof, the
    // identity after the grace) sees a process started a minute later.
    let reads = 0;
    const laterStart = async (pid: number): Promise<number | null> => {
      const real = await processStartMs(pid);
      return real === null || reads++ === 0 ? real : real + 60_000;
    };
    const proveLater = (at: string): Promise<LockVerdict> =>
      prove(at, { ...REAL_HOLDER_READS, start: laterStart });
    try {
      step("the step over the recycled pid");
      const said = (
        await captureChannels(
          async () => void (await stopPreviousDaemons([home], { prove: proveLater })),
        )
      ).all;
      expect({
        alive: pidAlive(daemon.pid),
        lock: existsSync(daemonLockPath(home)),
        sidecar: existsSync(denoLockSidecarPath(home)),
        portFree: await proxyPortFree(daemon.port as number),
        said: said.includes(
          `  stopped the deno-era proxy daemon (pid ${daemon.pid}) in ${home}: spared; removed ${daemonLockPath(home)} and its .oslock sidecar`,
        ),
        killAdvised: said.includes(stopPidCommand(daemon.pid, true)),
      }).toEqual({
        alive: true,
        lock: false,
        sidecar: false,
        portFree: true,
        said: true,
        killAdvised: false,
      });
    } finally {
      await daemon.teardown();
    }
  },
  30_000,
);

// The 4.0.9 steps stop through stopLockedDaemon, and an update from 4.0.8 never reaches the 5.0.1
// cleanup in the same run: its dry run once showed the root files moved and the lock pair kept,
// where the real stop removes both.
test("4.0.9 dry run: stopLockedDaemon's plan lists the daemon's lock pair as removed, and nothing lands", async () => {
  const root = isolateProxyHome("copilot-migrate-root-plan-");
  const daemon = await denoEraDaemon(root, root);
  try {
    const before = fingerprintTree(root);
    const { changes, result } = await dryRunChanges(() => stopLockedDaemon(root));
    expect({
      tree: fingerprintTree(root),
      alive: pidAlive(daemon.pid),
      result,
      plan: renderDryRun(changes)
        .filter((line) => line.startsWith("delete "))
        .sort(),
    }).toEqual({
      tree: before,
      alive: true,
      result: { kind: "would-stop", pid: daemon.pid },
      plan: [`delete ${daemonLockPath(root)}`, `delete ${denoLockSidecarPath(root)}`].sort(),
    });
  } finally {
    await daemon.teardown();
  }
}, 30_000);

// Evidence that is malformed or impossible fails closed. A truncated marker beside the deno
// release's sidecar once read as a removable leftover, and the 4.0.9 move went under a running
// daemon; a junk-suffixed one parsed as the live pid and could be signalled; a marker stamped
// after the clock (moved backward) let a same-shaped stranger started before it pass as the
// author. All keep the lock pair and the files.
test("5.0.1: a truncated or junk-suffixed marker beside a live deno, and a marker stamped in the future, are unjudged: lock pair and files kept", async () => {
  const root = isolateProxyHome("copilot-migrate-deno-malformed-");
  const denoFile = join(root, "deno", "entry");
  mkdirSync(join(denoFile, ".."), { recursive: true });
  writeFileSync(denoFile, "{}\n");
  const truncated = join(root, "profiles", "truncated");
  const junk = join(root, "profiles", "junk");
  const future = join(root, "profiles", "future");
  const liveDeno = await denoEraDaemon(root, truncated);
  writeFileSync(daemonLockPath(truncated), "");
  // parseInt would read `<pid>junk` as the pid and the marker as the live daemon's.
  const junkDaemon = await denoEraDaemon(root, junk);
  writeFileSync(daemonLockPath(junk), `${junkDaemon.pid}junk\n${Date.now()}junk\n`);
  const futureDaemon = await denoEraDaemon(root, future, {
    markerMs: () => Date.now() + 60 * 60 * 1000,
  });
  try {
    step("the step over the three homes");
    const said = (await captureChannels(() => retireDenoDaemon(root, [truncated, junk, future])))
      .all;
    const moved = (await captureChannels(async () => void (await stopLockedDaemon(truncated)))).all;
    expect({
      alive: [liveDeno, junkDaemon, futureDaemon].map((d) => pidAlive(d.pid)),
      locks: [truncated, junk, future].map((home) => existsSync(daemonLockPath(home))),
      sidecars: [truncated, junk, future].map((home) => existsSync(denoLockSidecarPath(home))),
      denoFile: existsSync(denoFile),
      truncatedSaid: said.includes(
        `  left a home as it is: its lock marker names no pid while a deno runs\n    ${daemonLockPath(truncated)}\n`,
      ),
      junkSaid: said.includes(
        `  left a home as it is: its lock marker names no pid while a deno runs\n    ${daemonLockPath(junk)}\n`,
      ),
      junkSignalled: said.includes(`pid ${junkDaemon.pid}`),
      futureSaid: said.includes(
        `  left a daemon running: pid ${futureDaemon.pid} is a deno, but its lock marker is stamped in the future\n`,
      ),
      filesStay: said.includes("the deno-era files stay"),
      movedNothing: moved === "",
    }).toEqual({
      alive: [true, true, true],
      locks: [true, true, true],
      sidecars: [true, true, true],
      denoFile: true,
      truncatedSaid: true,
      junkSaid: true,
      junkSignalled: false,
      futureSaid: true,
      filesStay: true,
      movedNothing: true,
    });
  } finally {
    await liveDeno.teardown();
    await junkDaemon.teardown();
    await futureDaemon.teardown();
  }
}, 40_000);

// The sidecar sweep that follows the daemon step once read an empty marker as free and took the
// sidecar, so the retry proved a malformed leftover, removed the marker, and the 4.0.9 move went
// under a live deno. The sweep takes a daemon.lock's sidecar only on the daemon step's own
// verdict (leftover or no marker): two full 5.0.1 runs over the truncated marker keep everything.
test("5.0.1 twice over a truncated marker beside a live deno: the sweep keeps the sidecar, the files stay, nothing is signalled", async () => {
  const root = isolateProxyHome("copilot-migrate-deno-sweep-");
  const installRoot = join(root, "install");
  mkdirSync(installRoot, { recursive: true });
  const home = join(root, "profiles", "default");
  const denoFile = join(root, "deno", "entry");
  mkdirSync(join(denoFile, ".."), { recursive: true });
  writeFileSync(denoFile, "{}\n");
  const daemon = await denoEraDaemon(root, home);
  writeFileSync(daemonLockPath(home), "");
  try {
    const runs: string[] = [];
    for (const pass of [1, 2]) {
      step(`5.0.1 run ${pass}`);
      runs.push(
        (await captureChannels(() => runMigrations("5.0.1", "5.0.2", undefined, installRoot))).all,
      );
    }
    expect({
      alive: pidAlive(daemon.pid),
      lock: existsSync(daemonLockPath(home)),
      sidecar: existsSync(denoLockSidecarPath(home)),
      denoFile: existsSync(denoFile),
      unjudgedBoth: runs.every((said) =>
        said.includes("left a home as it is: its lock marker names no pid while a deno runs"),
      ),
      sidecarKeptBoth: runs.every((said) => said.includes(`kept ${denoLockSidecarPath(home)}`)),
      signalled: runs.some((said) => said.includes("stopped the deno-era proxy daemon")),
    }).toEqual({
      alive: true,
      lock: true,
      sidecar: true,
      denoFile: true,
      unjudgedBoth: true,
      sidecarKeptBoth: true,
      signalled: false,
    });
  } finally {
    await daemon.teardown();
  }
}, 40_000);

// --dry-run is the same code path on the overlay: the plan must list the removals the real run
// makes (a stopped daemon's marker and sidecar, a dead holder's marker, the deno files once the
// daemon the plan stops no longer counts as a stray), with nothing landed and the daemon running.
test("5.0.1 dry run: the plan lists the daemon's lock pair, a dead marker, and the deno files as removed, and nothing lands", async () => {
  const root = isolateProxyHome("copilot-migrate-deno-plan-");
  const home = join(root, "profiles", "default");
  const deadHome = join(root, "profiles", "dead");
  for (const at of [home, deadHome]) mkdirSync(at, { recursive: true });
  writeFileSync(daemonLockPath(deadHome), `2147483646\n${Date.now()}\n`);
  const denoDir = join(root, "deno");
  mkdirSync(denoDir, { recursive: true });
  writeFileSync(join(denoDir, "entry"), "{}\n");
  const daemon = await denoEraDaemon(root, home, { provenance: true });
  try {
    const before = fingerprintTree(root);
    let narrated = "";
    const { changes } = await dryRunChanges(async () => {
      narrated = (await captureChannels(() => retireDenoDaemon(root, [home, deadHome]))).all;
    });
    expect({
      tree: fingerprintTree(root),
      alive: pidAlive(daemon.pid),
      plan: renderDryRun(changes)
        .filter((line) => line.startsWith("delete "))
        .sort(),
    }).toEqual({
      tree: before,
      alive: true,
      plan: [
        `delete ${daemonLockPath(deadHome)}`,
        `delete ${daemonLockPath(home)}`,
        `delete ${denoLockSidecarPath(home)}`,
        `delete ${denoDir}${sep}`,
        `delete ${join(root, "proxy", "deno.json")}`,
      ].sort(),
    });
    expect(narrated).toContain(
      `  would stop the deno-era proxy daemon (pid ${daemon.pid}) in ${home} and remove ${daemonLockPath(home)} and its .oslock sidecar`,
    );
  } finally {
    await daemon.teardown();
  }
}, 30_000);

// The deno-era files are what a still-running previous daemon runs from, so they go only once
// every daemon is confirmed stopped or absent. The look and the stop are the seams: a holder that
// survives SIGKILL and a table that will not read are not stageable. Each warning is three lines.
test("5.0.1: the deno files stay while any daemon may still run from them, and go once every stop is confirmed", async () => {
  const root = isolateProxyHome("copilot-migrate-deno-gate-");
  const homes = ["a", "b"].map((name) => join(root, "profiles", name)) as [string, string];
  for (const home of homes) mkdirSync(home, { recursive: true });
  const denoFiles = [join(root, "deno", "entry"), join(root, "proxy", "deno.json")];
  const plant = (): void => {
    for (const file of denoFiles) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}\n");
    }
  };
  // Two real deno-era daemons, so the stop seam receives real proofs (a ProvenLock has one
  // builder); the stop itself is staged, and the lock pair is re-planted for each row.
  const a = await denoEraDaemon(root, homes[0]);
  const b = await denoEraDaemon(root, homes[1]);
  const replant = (): void => {
    for (const [home, daemon] of [
      [homes[0], a],
      [homes[1], b],
    ] as const) {
      writeFileSync(daemonLockPath(home), `${daemon.pid}\n${Date.now()}\n`);
      writeFileSync(denoLockSidecarPath(home), "");
    }
  };
  const stopped: DenoStopOutcome = { kind: "stopped", verdict: "kill" };
  const lockA = daemonLockPath(homes[0]);
  try {
    const rows: {
      prove?: () => Promise<{ kind: "unreadable" }>;
      scan?: () => Promise<ProcessRow[]>;
      relook?: (pid: number) => Promise<ProcessLook>;
      stops: Record<string, DenoStopOutcome>;
      left: boolean;
      warned: string[];
    }[] = [
      {
        stops: {
          [homes[0]]: { kind: "still-running", verdict: "kill", identity: "same" },
          [homes[1]]: stopped,
        },
        left: true,
        warned: [
          `  the deno-era proxy daemon (pid ${a.pid}) did not stop: kill`,
          `    pid ${a.pid} is still that daemon after the SIGKILL grace; ${lockA} may be gone`,
          `    stop it by hand:  ${stopPidCommand(a.pid, true)}`,
        ],
      },
      {
        stops: {
          [homes[0]]: { kind: "still-running", verdict: "kill", identity: "unread" },
          [homes[1]]: stopped,
        },
        left: true,
        warned: [
          `  the deno-era proxy daemon (pid ${a.pid}) may not have stopped: kill`,
          `    pid ${a.pid} is alive after the SIGKILL grace, and this host can no longer read what it is`,
          `    look first:  ${processLookCommand(a.pid)}`,
        ],
      },
      {
        stops: { [homes[0]]: { kind: "port-still-busy", port: 4141 }, [homes[1]]: stopped },
        left: true,
        warned: [
          `  the deno-era proxy daemon (pid ${a.pid}) stopped, but port 4141 is still busy`,
          `    127.0.0.1:4141 still answers; whatever listens there is not the daemon of ${homes[0]}`,
          `    find it:  ${listenerLookCommand(4141)}`,
        ],
      },
      {
        prove: () => Promise.resolve({ kind: "unreadable" as const }),
        stops: { [homes[1]]: stopped },
        left: true,
        warned: ["  left a home as it is: its daemon.lock cannot be read", `    ${lockA}`],
      },
      {
        // A deno row the table cannot read, still there on every re-read: it may be the daemon.
        scan: () => Promise.resolve([{ pid: 4242, ucomm: "deno.exe", command: "" }]),
        relook: () => Promise.resolve({ kind: "unreadable" as const }),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: true,
        warned: [
          "  a deno runs whose command line this host cannot read: pid 4242",
          "    it may be the deno-era proxy daemon of this root home",
          `    look first:  ${processLookCommand(4242)}`,
        ],
      },
      {
        // The same row, gone on the first re-read: a process on its way out, no stray (the
        // windows-latest red of a sibling fixture mid-exit).
        scan: () => Promise.resolve([{ pid: 4242, ucomm: "deno.exe", command: "" }]),
        relook: () => Promise.resolve({ kind: "gone" as const }),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: false,
        warned: [],
      },
      {
        // Unreadable on the first re-read, gone on the second: the re-read keeps asking.
        scan: () => Promise.resolve([{ pid: 4242, ucomm: "deno.exe", command: "" }]),
        relook: (() => {
          let asked = 0;
          return () =>
            Promise.resolve(
              asked++ === 0 ? { kind: "unreadable" as const } : { kind: "gone" as const },
            );
        })(),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: false,
        warned: [],
      },
      {
        // Still there on the re-read with a command line the owner-blind look can read: the
        // listing's unreadable owner is the judgment, not the re-read's text; files kept.
        scan: () => Promise.resolve([{ pid: 4242, ucomm: "deno.exe", command: "" }]),
        relook: () =>
          Promise.resolve({
            kind: "row" as const,
            row: {
              pid: 4242,
              ucomm: "deno.exe",
              command: "deno run /x/copilot-api/main.js start --port 1",
            },
          }),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: true,
        warned: ["  a deno runs whose command line this host cannot read: pid 4242"],
      },
      {
        // An older daemon of this root home, from before the port rode on argv: the signal path
        // would not stop it (no --port), the clearance must still see it.
        scan: () =>
          Promise.resolve([
            {
              pid: 4343,
              ucomm: "deno",
              command: `deno run --config ${join(root, "proxy", "deno.json")} npm:@jeffreycao/copilot-api@2.6.19 start --verbose`,
            },
          ]),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: true,
        warned: [
          "  a deno of this root home still runs: pid 4343",
          `    deno run --config ${join(root, "proxy", "deno.json")} npm:@jeffreycao/copilot-api@2.6.19 start --verbose`,
          `    if it is that daemon:  ${stopPidCommand(4343)}`,
        ],
      },
      {
        scan: () =>
          Promise.resolve([
            {
              pid: 4343,
              ucomm: "deno",
              command: `deno run --config ${join(root, "proxy", "deno.json")} npm:@jeffreycao/copilot-api@2.6.19 start --verbose --port 4141`,
            },
          ]),
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: true,
        warned: ["  a deno of this root home still runs: pid 4343 on port 4141"],
      },
      {
        stops: { [homes[0]]: stopped, [homes[1]]: stopped },
        left: false,
        warned: [],
      },
    ];
    for (const row of rows) {
      plant();
      replant();
      const staged = row.prove;
      const said = (
        await captureChannels(() =>
          retireDenoDaemon(root, homes, {
            stop: (daemon) => Promise.resolve(row.stops[daemon.home] as DenoStopOutcome),
            ...(row.scan === undefined ? {} : { scan: row.scan }),
            ...(row.relook === undefined ? {} : { relook: row.relook }),
            ...(staged === undefined
              ? {}
              : { prove: (home: string) => (home === homes[0] ? staged() : prove(home)) }),
          }),
        )
      ).all;
      expect({ row: row.stops, left: denoFiles.map((f) => existsSync(f)) }).toEqual({
        row: row.stops,
        left: [row.left, row.left],
      });
      expect(said.includes("the deno-era files stay")).toBe(row.left);
      expect(
        said.includes(`    ${join(root, "deno")} and the float's deno files go on the next run`),
      ).toBe(row.left);
      for (const line of row.warned) expect(said).toContain(`${line}\n`);
      if (row.left) expect(said).toContain("    after it is stopped:  agent migrate <from> <to>");
    }
  } finally {
    await a.teardown();
    await b.teardown();
  }
}, 60_000);

// A pid killed before its parent reaped it answers the signal probe as alive yet holds no socket
// and writes nothing: dead for the lock's purposes. The lock pair goes, the warning names the
// zombie without a kill. The parent is a perl that never waits (bun and node reap on SIGCHLD).
test.skipIf(process.platform === "win32" || !commandExists("perl"))(
  "5.0.1: a zombie holding the lock is a leftover: the lock pair goes, nothing is signalled, the files go",
  async () => {
    const root = isolateProxyHome("copilot-migrate-deno-zombie-");
    const home = join(root, "profiles", "default");
    mkdirSync(home, { recursive: true });
    const denoFile = join(root, "deno", "entry");
    mkdirSync(join(denoFile, ".."), { recursive: true });
    writeFileSync(denoFile, "{}\n");
    const runtime = join(root, "runtime", "deno");
    mkdirSync(join(runtime, ".."), { recursive: true });
    if (process.platform === "linux") symlinkSync(process.execPath, runtime);
    else copyFileSync(process.execPath, runtime);
    const pidFile = join(root, "child.pid");
    const parent = spawnChild("perl", {
      args: [
        "-e",
        'my $pid = fork; if (!$pid) { exec @ARGV } open(my $f, ">", $ENV{PID_FILE}); print $f $pid; close $f; sleep 600',
        runtime,
        "-e",
        "setInterval(() => {}, 60_000)",
      ],
      env: { PID_FILE: pidFile },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      step("the child's pid");
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      writeFileSync(daemonLockPath(home), `${pid}\n${Date.now()}\n`);
      writeFileSync(denoLockSidecarPath(home), "");
      process.kill(pid, "SIGKILL");
      step("the zombie");
      await until(async () => (await processIsZombie(pid)) === true);
      const alivePerProbe = pidAlive(pid);
      const said = (await captureChannels(() => retireDenoDaemon(root, [home]))).all;
      expect({
        alivePerProbe,
        lock: existsSync(daemonLockPath(home)),
        sidecar: existsSync(denoLockSidecarPath(home)),
        denoFile: existsSync(denoFile),
        said: said.includes(
          `  removed ${daemonLockPath(home)} and its .oslock sidecar (pid ${pid} is a zombie awaiting its parent: it holds no port and nothing stops it)`,
        ),
        killAdvised: said.includes(stopPidCommand(pid)),
      }).toEqual({
        alivePerProbe: true,
        lock: false,
        sidecar: false,
        denoFile: false,
        said: true,
        killAdvised: false,
      });
    } finally {
      await killAndAwaitExit(parent.pid);
    }
  },
  30_000,
);

// The re-prove at the SIGKILL boundary reads an unreadable table: "unknown" never authorizes a
// signal, so only the SIGTERM goes out, the daemon (ignoring it) reads still-running with its
// identity unread, the warning offers a look, and the files stay. POSIX only (no SIGTERM on Windows).
test.skipIf(process.platform === "win32")(
  "5.0.1: an unreadable re-prove at the SIGKILL boundary sends SIGTERM only, reads still-running unread, and keeps the files",
  async () => {
    const root = isolateProxyHome("copilot-migrate-deno-unread-");
    const home = join(root, "profiles", "default");
    const denoFile = join(root, "deno", "entry");
    mkdirSync(join(denoFile, ".."), { recursive: true });
    writeFileSync(denoFile, "{}\n");
    const daemon = await denoEraDaemon(root, home, { ignoresTerm: true });
    // The proof's own lookup reads the table; every lookup after it (the re-prove, the identity)
    // finds it unreadable.
    let lookups = 0;
    const reads = {
      ...REAL_HOLDER_READS,
      lookup: (pid: number) =>
        lookups++ === 0
          ? REAL_HOLDER_READS.lookup(pid)
          : Promise.resolve({ kind: "unreadable" as const }),
    };
    try {
      step("the step over the daemon whose re-prove cannot read");
      const said = (
        await captureChannels(() =>
          retireDenoDaemon(root, [home], { prove: (at) => prove(at, reads) }),
        )
      ).all;
      expect({
        alive: pidAlive(daemon.pid),
        lock: existsSync(daemonLockPath(home)),
        denoFile: existsSync(denoFile),
        said: said.includes(
          `  the deno-era proxy daemon (pid ${daemon.pid}) may not have stopped: spared\n    pid ${daemon.pid} is alive after the SIGKILL grace, and this host can no longer read what it is\n    look first:  ${processLookCommand(daemon.pid)}\n`,
        ),
        killAdvised: said.includes(stopPidCommand(daemon.pid, true)),
        filesStay: said.includes("the deno-era files stay"),
      }).toEqual({
        alive: true,
        lock: true,
        denoFile: true,
        said: true,
        killAdvised: false,
        filesStay: true,
      });
    } finally {
      await daemon.teardown();
    }
  },
  30_000,
);

// Windows keeps a listening socket answering for a moment after its owner exits, which once read
// as "port still busy" right after a clean stop. The port look is re-read in steps: busy once,
// then free, reads as stopped.
test("5.0.1: a port that lingers after the daemon's death reads as stopped once it comes free", async () => {
  const root = isolateProxyHome("copilot-migrate-deno-linger-");
  const home = join(root, "profiles", "default");
  const daemon = await denoEraDaemon(root, home);
  let portLooks = 0;
  const reads = {
    ...REAL_HOLDER_READS,
    portFree: (port: number) => (portLooks++ === 0 ? Promise.resolve(false) : proxyPortFree(port)),
  };
  try {
    step("the step with a lingering port");
    const said = (
      await captureChannels(
        async () => void (await stopPreviousDaemons([home], { prove: (at) => prove(at, reads) })),
      )
    ).all;
    expect({
      portLooks: portLooks >= 2,
      alive: pidAlive(daemon.pid),
      portFree: await proxyPortFree(daemon.port as number),
      lock: existsSync(daemonLockPath(home)),
      said: said.includes(
        `  stopped the deno-era proxy daemon (pid ${daemon.pid}) in ${home}: term;`,
      ),
      busyWarned: said.includes("is still busy"),
    }).toEqual({
      portLooks: true,
      alive: false,
      portFree: true,
      lock: false,
      said: true,
      busyWarned: false,
    });
  } finally {
    await daemon.teardown();
  }
}, 30_000);
