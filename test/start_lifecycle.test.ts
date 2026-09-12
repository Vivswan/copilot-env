import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { consola } from "consola";
import { withUpdateLockForTests } from "../src/autoupdate/lock.ts";
import { type PreflightOptions, runPreflight } from "../src/autoupdate/preflight.ts";
import { AutoupdateState } from "../src/autoupdate/state.ts";
import { parseStartAction, runStart } from "../src/commands/start.ts";
import { portListening } from "../src/copilot_api/daemon.ts";
import { startLockPath } from "../src/copilot_api/launch.ts";
import { classifyDaemonPid, pidAlive } from "../src/copilot_api/process.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { daemonLockHolderPid } from "../src/scripts/daemon_lock.ts";
import { probeFileLock } from "../src/utils/file_lock.ts";
import { packageVersion } from "../src/utils/version.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  defaultHomeDir,
  envSnapshot,
  isolateProxyHome,
  killAndAwaitExit,
  launchFakeDaemon,
  resetExitCode,
  stageRefusedStop,
  until,
  writeRunState,
} from "./helpers.ts";
// `start --record-event` (the heartbeat) and `start --check` (the is-it-up probe) are the
// primitives the proxy-token resolver orchestrates.
// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

const restoreEnv = envSnapshot(["COPILOT_API_ENTRY"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

/** Isolate a root and return the DEFAULT daemon's home under it (profiles/default,
 *  created on disk) -- what the dry-run plan and the lock/holder staging both
 *  resolve. `dir` (the root) owns cleanup. */
function tmpHome(): string {
  dir = isolateProxyHome("copilot-lifecycle-");
  return defaultHomeDir();
}

/** Run `fn` and return what it wrote to each process stream; `onStdout` sees each stdout
 *  chunk as it lands, so a test can order output against its own events. */
async function streamsOf(
  fn: () => Promise<void>,
  onStdout: (chunk: string) => void = () => {},
): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s: string | Uint8Array) => {
    out.push(String(s));
    onStdout(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  };
  try {
    consola.level = 3; // ensure info is not self-silenced under the test runner
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

async function narrationOf(fn: () => Promise<void>): Promise<string> {
  const { stdout, stderr } = await streamsOf(fn);
  return stdout + stderr;
}

function dryRunNarration(): Promise<string> {
  return narrationOf(() =>
    runStart({ kind: "launch", dryRun: true, force: false, port: undefined, profile: null })
  );
}

// A real listening socket, so portListening can probe a real port.
function listenEphemeral(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
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

test("start --record-event writes the lastEnsureAt heartbeat and never launches", async () => {
  tmpHome();
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();

  const before = Date.now();
  await runStart({ kind: "record-event", profile: null });

  // A real clock reading, not just "some number" (NaN/0 would satisfy typeof).
  const at = new CopilotEnvRunState().read().lastEnsureAt;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  expect(new CopilotEnvRunState().read().pid).toBeUndefined(); // no daemon was started
});

test("start --record-event --profile heartbeats ONLY the profile's run state", async () => {
  tmpHome();
  // A real proxy profile always has run state before its resolver heartbeats (the
  // port reservation writes it); a profile WITHOUT state must not be fabricated.
  writeRunState({ port: 4242 }, WORK);
  const before = Date.now();
  await runStart({ kind: "record-event", profile: WORK });

  const at = CopilotEnvRunState.forProfile(WORK).read().lastEnsureAt;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();
});

// A conflicting flag combination is rejected at the boundary, never resolved by dispatch order:
// the old shape silently dropped `--record-event` when `--check` was present.
test("parseStartAction rejects conflicting mode flags at the boundary", () => {
  const CONFLICT =
    "--check and --record-event are mutually exclusive and cannot combine with --dry-run/--port/--force";
  expect(() => parseStartAction({ check: true, recordEvent: true })).toThrow(CONFLICT);
  expect(() => parseStartAction({ check: true, force: true })).toThrow(CONFLICT);
  expect(() => parseStartAction({ check: true, dryRun: true })).toThrow(CONFLICT);
  expect(() => parseStartAction({ recordEvent: true, port: 4141 })).toThrow(CONFLICT);
  expect(() => parseStartAction({ check: true, recordEvent: true, dryRun: true })).toThrow(
    CONFLICT,
  );
});

test("parseStartAction parses each valid flag shape into its single action", () => {
  expect(parseStartAction({ check: true, profile: "work" })).toEqual({
    kind: "check",
    profile: WORK,
  });
  expect(parseStartAction({ recordEvent: true })).toEqual({
    kind: "record-event",
    profile: null,
  });
  // A launch keeps its knobs; --dry-run with --force/--port stays a valid combination.
  expect(parseStartAction({ dryRun: true, force: true, port: 4141 })).toEqual({
    kind: "launch",
    dryRun: true,
    force: true,
    port: 4141,
    profile: null,
  });
  expect(parseStartAction({})).toEqual({
    kind: "launch",
    dryRun: false,
    force: false,
    port: undefined,
    profile: null,
  });
});

test("start --check --profile exits non-zero when that profile's daemon is not running", async () => {
  tmpHome();
  await runStart({ kind: "check", profile: WORK });
  expect(process.exitCode).toBe(1);
});

test("start --check exits non-zero when no proxy is tracked/running", async () => {
  tmpHome();
  await runStart({ kind: "check", profile: null });
  expect(process.exitCode).toBe(1);
});

// The dry run narrates planCleanup (the SHARED decision source) and never acts on it. In the
// refused-stop fixture the test process holds the lock through both dry runs, while the marker
// and run state name a live local bystander the plan cannot corroborate.
test(
  "start --dry-run narrates the refused holder and the tracking clear, and never acts",
  async () => {
    const home = tmpHome();
    const fixture = stageRefusedStop(home);
    try {
      const leaveLine = `Would leave the daemon.lock holder (pid=${fixture.bystanderPid}) alone`;

      // Tracked control: the lock's "alive" verdict plans no tracked signal -- only the
      // state clear -- and the uncorroborated holder plans a leave, never a stop.
      const tracked = await dryRunNarration();
      expect(tracked).toContain(`Would clear tracked run state (pid=${fixture.bystanderPid}).`);
      expect(tracked).toContain(leaveLine);
      expect(tracked).not.toContain("Would stop tracked proxy");
      expect(tracked).not.toContain("untracked daemon.lock holder");
      // The honest "never acts" detector: the live cleanup ALWAYS clears a tracked pid
      // (even when it defers or refuses the signal), so tracking surviving the dry run
      // proves the cleanup never ran.
      expect(new CopilotEnvRunState().read().pid).toBe(fixture.bystanderPid);

      // The untracked state: run state lost, only the lock names the (refused) holder.
      writeRunState({ pid: null, port: null });
      const untracked = await dryRunNarration();
      expect(untracked).toContain(leaveLine);
      expect(untracked).not.toContain("Would clear tracked run state");

      // Never signalled: the bystander lives and the lock is still held over it.
      expect(pidAlive(fixture.bystanderPid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(fixture.bystanderPid);
    } finally {
      await fixture.teardown();
    }
  },
  30_000,
);

// Stale tracking of a DEAD pid (live: a durable state-file clear) beside a corroborated
// daemon.lock holder (live: the holder stop): the dry run must narrate both and perform neither.
test(
  "start --dry-run reports the corroborated holder stop and the dead-pid tracking clear without acting",
  async () => {
    const home = tmpHome();
    const daemonPid = launchFakeDaemon(home, await freePort());
    try {
      expect(await until(20_000, () => daemonLockHolderPid(home) === daemonPid)).toBe(true);
      writeRunState({ pid: DEAD_PID, port: 4141 });

      const narration = await dryRunNarration();
      expect(narration).toContain(`Would clear tracked run state (pid=${DEAD_PID}).`);
      expect(narration).toContain(
        `Would stop this home's untracked daemon.lock holder (pid=${daemonPid}).`,
      );
      expect(narration).not.toContain("Would stop tracked proxy"); // dead: no signal to report

      // Never acts: the live cleanup would clear this tracking and stop this daemon.
      expect(new CopilotEnvRunState().read().pid).toBe(DEAD_PID);
      expect(pidAlive(daemonPid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(daemonPid);
    } finally {
      await killAndAwaitExit(daemonPid);
    }
  },
  60_000,
);

// A fake daemon holds the home's lock AND listens on the tracked port, so the launch resolves
// as the managed-lifecycle no-op and spawns nothing. Both are awaited: the lock is taken at
// boot before the server listens, and a lock without a listener reads as a stale holder to stop.
//
//   release listing            -> a stubbed fetch whose newest release is the running version
//   preflight's state and lock -> runStart's seam, so the checkout's own are untouched
test(
  "start runs the self-update preflight after a live launch's outcome, gated on the auto-update key",
  async () => {
    const home = tmpHome();
    const port = await freePort();
    const daemonPid = launchFakeDaemon(home, port);
    const stateFile = join(dir, "autoupdate-state.json");
    const lockHolders: (number | null)[] = [];
    // The order of the launch outcome ("[start:noop]" on stdout) and the preflight call.
    const events: string[] = [];
    const onStdout = (chunk: string) => {
      if (chunk.includes("[start:noop]")) events.push("noop");
    };
    const preflight = (opts: PreflightOptions) => {
      events.push("preflight");
      // Runs INSIDE the start lock: the marker names this process now, and is gone after.
      const lock = probeFileLock(startLockPath());
      lockHolders.push(lock.kind === "held" ? lock.markerPid : null);
      // One line through the SHARED consola, the way the installer's shim writer does from
      // inside an applied update: it must reach stderr, while start's own narration (which
      // precedes it) is on stdout.
      consola.info("shared-consola narration from inside the preflight");
      return runPreflight({
        ...opts,
        state: new AutoupdateState(stateFile),
        lock: (nowMs, fn) => withUpdateLockForTests(join(dir, "update.lock"), nowMs, fn),
      });
    };
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            "tag_name": `v${packageVersion()}`,
            "published_at": "2026-01-01T00:00:00Z",
            "draft": false,
            "prerelease": false,
          }]),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    try {
      expect(await until(20_000, () => daemonLockHolderPid(home) === daemonPid)).toBe(true);
      const listening = Date.now() + 20_000;
      while (!(await portListening(port)) && Date.now() < listening) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await portListening(port)).toBe(true);
      writeRunState({ pid: daemonPid, port });
      process.env.COPILOT_API_ENTRY = join(ROOT, "test", "copilot-api-fake.mjs");
      const config = new CopilotEnvConfig();
      config.set({ autoStart: true, updateCooldown: 0 });
      const launch = {
        kind: "launch",
        dryRun: false,
        force: false,
        port: undefined,
        profile: null,
      } as const;

      // Key off (the default), a check long due: the no-op outcome, then the preflight
      // call, which checks nothing.
      writeFileSync(stateFile, JSON.stringify({ lastCheckMs: 1, lastResult: "old" }));
      await streamsOf(() => runStart(launch, preflight), onStdout);
      expect(events).toEqual(["noop", "preflight"]);
      expect(urls).toEqual([]);
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
        lastCheckMs: 1,
        lastResult: "old",
      });

      // Key on, still due: the release check runs and its result is recorded.
      config.set({ autoUpdate: true });
      const { stdout, stderr } = await streamsOf(() => runStart(launch, preflight), onStdout);
      expect(events).toEqual(["noop", "preflight", "noop", "preflight"]);
      // Stream routing: the preflight's shared-consola line is the ONLY stderr output (its
      // prefix is consola's reporter glyph, which differs between a TTY and CI), and none
      // of it is on stdout.
      const stderrLines = stderr.split(/\r?\n/).filter((line) => line.length > 0);
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain("shared-consola narration from inside the preflight");
      expect(stdout).not.toContain("shared-consola narration");
      expect(lockHolders).toEqual([process.pid, process.pid]); // both starts, under the lock
      expect(existsSync(startLockPath())).toBe(false); // released after the preflight
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/repos/Vivswan/copilot-env/releases");
      expect(JSON.parse(readFileSync(stateFile, "utf8")).lastResult).toBe("up to date");
      // Left up, never relaunched: the tracked daemon is still the fake.
      expect(new CopilotEnvRunState().read().pid).toBe(daemonPid);
      expect(pidAlive(daemonPid)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      await killAndAwaitExit(daemonPid);
    }
  },
  60_000,
);

// The full UP path is not reproducible here: classifyDaemonPid needs a `copilot-api ... start`
// command line, which the test runner's own pid cannot satisfy (see the "stays DOWN" test
// below). These two pin the TCP liveness half alone.
test("portListening resolves true against a real listening loopback port", async () => {
  const { server, port } = await listenEphemeral();
  try {
    expect(await portListening(port, 2000)).toBe(true);
  } finally {
    await closeServer(server);
  }
});

test("portListening resolves false for a port with nothing listening", async () => {
  const { server, port } = await listenEphemeral();
  await closeServer(server);
  expect(await portListening(port, 1000)).toBe(false);
});

test("portListening detects an IPv6-loopback-only listener too", async () => {
  // The probe connects to 127.0.0.1 and ::1 concurrently and settles on the first success, so a
  // daemon bound only to IPv6 loopback is still found.
  let listener: { server: Server; port: number };
  try {
    listener = await listenEphemeral("::1");
  } catch {
    return; // no IPv6 loopback on this machine -- nothing to assert
  }
  try {
    expect(await portListening(listener.port)).toBe(true);
  } finally {
    await closeServer(listener.server);
  }
});

// The guard is load-bearing: a live, IDENTIFIABLE pid whose command line is not
// `copilot-api ... start`, plus a genuinely listening port, must still be DOWN, never a false UP.
//   identifiable non-daemon pid -> "no"      -> exit 1, whatever the port says
//   unreadable command line     -> "unknown" -> the port probe decides (classifyDaemonPid test below)
// The true exit-0 path runs in the start/stop lifecycle against the fake proxy, whose command
// line does match.
test("start --check stays DOWN for a live pid + listening port that is not a copilot-api daemon", async () => {
  tmpHome();
  const { server, port } = await listenEphemeral();
  try {
    // process.pid is alive and the port listens, but the runner is identifiable as not a daemon.
    writeRunState({ pid: process.pid, port });
    expect(new CopilotEnvRunState().read().pid).toBe(process.pid);
    expect(new CopilotEnvRunState().read().port).toBe(port);

    await runStart({ kind: "check", profile: null });
    expect(process.exitCode).toBe(1);
  } finally {
    await closeServer(server);
  }
});

// A definitive "no" is what keeps the DOWN test above honest; "unknown" (a restricted token that
// cannot read a command line) is reserved for sandboxed callers and is not reproducible here.
test("classifyDaemonPid returns 'no' for a dead pid and a live non-daemon pid", async () => {
  expect(await classifyDaemonPid(DEAD_PID)).toBe("no");
  expect(await classifyDaemonPid(process.pid)).toBe("no");
});
