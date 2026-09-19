import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { delimiter, join, relative } from "node:path";
import { consola } from "consola";
import { withUpdateLockForTests } from "../src/autoupdate/lock.ts";
import { type PreflightOptions, runPreflight } from "../src/autoupdate/preflight.ts";
import { AutoupdateState } from "../src/autoupdate/state.ts";
import { CI_NO_LIVE_LOOKUPS_ENV, resetCodexVersionMemo } from "../src/codex/user_agent.ts";
import { parseStartAction, renderStartSummary, runStart } from "../src/commands/start.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import {
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { portListening } from "../src/copilot_api/daemon.ts";
import { startLockPath } from "../src/copilot_api/launch.ts";
import { classifyDaemonPid, pidAlive } from "../src/copilot_api/process.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { daemonLockHolderPid } from "../src/copilot_api/daemon_lock.ts";
import { probeFileLock } from "../src/utils/file_lock.ts";
import { packageVersion } from "../src/utils/version.ts";
import { captureChannels } from "./helpers/output.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  defaultHomeDir,
  envSnapshot,
  fingerprintTree,
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

/** The `work` slot in the store: a named profile hard-fails on every arm of `start` without one. */
function seedWork(): void {
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
}

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

const restoreEnv = envSnapshot(["COPILOT_API_ENTRY", "PATH", CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";

afterEach(() => {
  setIntegrationProbeFetch(null);
  resetIntegrationIdentityCache();
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

/** The start's credential resolution selects the daemon's identity over the network; the stub
 *  accepts the first candidate on the default host, offline. */
function stubIdentityProbe(): void {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
}

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

test("start --dry-run runs the launch's credential gate: no credential is the real refusal, a stored one is named in the plan", async () => {
  tmpHome();
  const refusal = /cannot start the proxy without a credential/;
  await expect(dryRunNarration()).rejects.toThrow(refusal);
  // The real launch refuses the same way, before any side effect.
  await expect(
    narrationOf(() =>
      runStart({ kind: "launch", dryRun: false, force: false, port: undefined, profile: null })
    ),
  ).rejects.toThrow(refusal);
  new Credential().store("gh-token", "ghp_fake_for_the_plan");
  stubIdentityProbe();
  // A bare `start --dry-run` collects its own plan: the port and the credential pair it would
  // record print as store rows, and nothing is written.
  const before = fingerprintTree(dir);
  // The narration is consola's (streamsOf reads it); the plan block is console output
  // (captureChannels reads it). A second preview costs nothing: neither writes.
  expect(await dryRunNarration()).toMatch(
    /Would launch the proxy on port \d+ with the gh-token credential\./,
  );
  const { stdout } = await captureChannels(() =>
    runStart({ kind: "launch", dryRun: true, force: false, port: undefined, profile: null })
  );
  expect(stdout).toContain("DRY RUN: nothing was written.");
  expect(stdout).toMatch(/\bport {2}\(absent\) -> \d+/);
  expect(fingerprintTree(dir)).toEqual(before);
  // The projected configuration lands in the preview as in the real start, so a config.json the
  // real start refuses to rewrite (not JSON) refuses the preview the same way.
  writeFileSync(new CopilotApiPaths().configFile, "{");
  const notJson = /is not valid JSON/;
  await expect(dryRunNarration()).rejects.toThrow(notJson);
  // The refusal comes where the real start's does, before the port and the credential pair land:
  // the plan printed up to it carries neither.
  const refused = await captureChannels(async () => {
    await runStart({ kind: "launch", dryRun: true, force: false, port: undefined, profile: null })
      .catch(() => {});
  });
  expect(refused.stdout).not.toContain(".state.json");
  expect(refused.stdout).not.toContain("integrationIdentity");
  await expect(
    narrationOf(() =>
      runStart({ kind: "launch", dryRun: false, force: false, port: undefined, profile: null })
    ),
  ).rejects.toThrow(notJson);
});

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

// The heartbeat lands in the NAMED daemon's run state alone. A real proxy profile always has run
// state before its resolver heartbeats (the port reservation writes it); a profile WITHOUT state
// must not be fabricated, and the other slot's state is left exactly as it was.
test("start --record-event writes the lastEnsureAt heartbeat to the named run state only, and never launches", async () => {
  tmpHome();
  seedWork();
  writeRunState({ port: 4242 }, WORK);
  const rows = [
    { profile: WORK, own: CopilotEnvRunState.forProfile(WORK), other: new CopilotEnvRunState() },
    { profile: null, own: new CopilotEnvRunState(), other: CopilotEnvRunState.forProfile(WORK) },
  ];
  for (const { profile, own, other } of rows) {
    const slot = profile ?? "(default)";
    expect(own.read().lastEnsureAt, slot).toBeUndefined();
    const otherBefore = other.read().lastEnsureAt;
    const before = Date.now();
    await runStart({ kind: "record-event", profile });

    // A real clock reading, not just "some number" (NaN/0 would satisfy typeof).
    const at = own.read().lastEnsureAt;
    expect(at, slot).toBeGreaterThanOrEqual(before);
    expect(at, slot).toBeLessThanOrEqual(Date.now());
    expect(other.read().lastEnsureAt, slot).toBe(otherBefore);
    expect(own.read().pid, slot).toBeUndefined(); // no daemon was started
  }
});

test("renderStartSummary keeps the label column and splits a long path inside the value column at width 80", () => {
  const logs = "/home/me/.local/share/copilot-env/logs/copilot-api-default-profile-very-long.log";
  const lines = renderStartSummary(
    [
      ["Logs", logs],
      ["PID", "48213"],
      ["Install root", "/home/me/Projects/copilot-env"],
    ],
    80,
    false,
  ).split("\n");
  expect(lines.length).toBeGreaterThan(3);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(80);
    // Every line starts in the label column or, for a continuation, in the value column.
    expect(line).toMatch(/^ {3}(Logs|PID|Install root):|^ {18}\S/);
  }
  // The split loses no character of the path, and no value moves to another row.
  expect(lines.join("").replace(/ +/g, "")).toBe(
    `Logs:${logs}PID:48213Installroot:/home/me/Projects/copilot-env`,
  );
});

// A conflicting flag combination is rejected at the boundary, never resolved by dispatch order:
// the old shape silently dropped `--record-event` when `--check` was present. A valid shape
// parses into its single action, knobs kept.
test("parseStartAction: each flag shape is one action, or a boundary rejection", () => {
  const CONFLICT =
    "--check and --record-event are mutually exclusive and cannot combine with --dry-run/--port/--force";
  const rows: Array<
    & { flags: Parameters<typeof parseStartAction>[0] }
    & (
      | { action: ReturnType<typeof parseStartAction> }
      | { throws: string }
    )
  > = [
    { flags: { check: true, recordEvent: true }, throws: CONFLICT },
    { flags: { check: true, force: true }, throws: CONFLICT },
    { flags: { check: true, dryRun: true }, throws: CONFLICT },
    { flags: { recordEvent: true, port: 4141 }, throws: CONFLICT },
    { flags: { check: true, recordEvent: true, dryRun: true }, throws: CONFLICT },
    { flags: { check: true, profile: "work" }, action: { kind: "check", profile: WORK } },
    { flags: { recordEvent: true }, action: { kind: "record-event", profile: null } },
    // A launch keeps its knobs; --dry-run with --force/--port stays a valid combination.
    {
      flags: { dryRun: true, force: true, port: 4141 },
      action: { kind: "launch", dryRun: true, force: true, port: 4141, profile: null },
    },
    {
      flags: {},
      action: { kind: "launch", dryRun: false, force: false, port: undefined, profile: null },
    },
  ];
  for (const row of rows) {
    if ("throws" in row) {
      expect(() => parseStartAction(row.flags), JSON.stringify(row.flags)).toThrow(row.throws);
    } else {
      expect(parseStartAction(row.flags), JSON.stringify(row.flags)).toEqual(row.action);
    }
  }
});

// The dry run narrates planCleanup (the SHARED decision source) and never acts on it. In the
// refused-stop fixture the test process holds the lock through both dry runs, while the marker
// and run state name a live local bystander the plan cannot corroborate.
test(
  "start --dry-run narrates the refused holder and the tracking clear, and never acts",
  async () => {
    const home = tmpHome();
    // The plan runs the launch's credential gate first, so the preview needs a credential.
    new Credential().store("gh-token", "ghp_fake_for_the_plan");
    stubIdentityProbe();
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
    // The plan runs the launch's credential gate first, so the preview needs a credential.
    new Credential().store("gh-token", "ghp_fake_for_the_plan");
    stubIdentityProbe();
    const daemonPid = launchFakeDaemon(home, await freePort());
    try {
      await until(() => daemonLockHolderPid(home) === daemonPid);
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
      await until(() => daemonLockHolderPid(home) === daemonPid);
      await until(() => portListening(port));
      writeRunState({ pid: daemonPid, port });
      process.env.COPILOT_API_ENTRY = join(ROOT, "test", "copilot-api-fake.mjs");
      const config = new CopilotEnvConfig();
      config.set({ "daemon.auto-start": true, "update.cooldown": 0 });
      // The refusal gate runs before the managed no-op (a refusal precedes every side effect, the
      // heartbeat included); on this path the token is read, never probed.
      new Credential().store("gh-token", "ghp_fake_for_the_noop");
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
      config.set({ "update.auto": true });
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
// below). This pins the TCP liveness half alone, one listener state per row. The probe connects
// to 127.0.0.1 and ::1 concurrently and settles on the first success, so a daemon bound only to
// IPv6 loopback is still found; that row skips itself where ::1 is unavailable.
test("portListening: a real v4 or v6-only loopback listener reads true, a closed port false", async () => {
  const rows: Array<{ host: string; close: boolean; listening: boolean }> = [
    { host: "127.0.0.1", close: false, listening: true },
    { host: "127.0.0.1", close: true, listening: false },
    { host: "::1", close: false, listening: true },
  ];
  for (const row of rows) {
    let listener: { server: Server; port: number };
    try {
      listener = await listenEphemeral(row.host);
    } catch {
      if (row.host === "::1") continue; // no IPv6 loopback on this machine
      throw new Error(`could not listen on ${row.host}`);
    }
    try {
      if (row.close) await closeServer(listener.server);
      expect({ ...row, got: await portListening(listener.port, 2000) }).toEqual({
        ...row,
        got: row.listening,
      });
    } finally {
      if (!row.close) await closeServer(listener.server);
    }
  }
});

// The guard is load-bearing: a live, IDENTIFIABLE pid whose command line is not
// `copilot-api ... start`, plus a genuinely listening port, must still be DOWN, never a false UP.
//   identifiable non-daemon pid -> "no"      -> exit 1, whatever the port says
//   unreadable command line     -> "unknown" -> the port probe decides
// The true exit-0 path runs in the start/stop lifecycle against the fake proxy, whose command
// line does match. The controls: with nothing tracked (default or a named profile) the check is
// DOWN too, and the classifier's definitive "no" for a dead pid and for this runner is what keeps
// the guard honest; "unknown" (a restricted token that cannot read a command line) is reserved for
// sandboxed callers and is not reproducible here.
test("start --check stays DOWN for a live pid + listening port that is not a copilot-api daemon", async () => {
  tmpHome();
  // A named profile the store does not hold is the refusal, never a "not running" verdict.
  await expect(runStart({ kind: "check", profile: WORK })).rejects.toThrow(
    "no such profile 'work'",
  );
  seedWork();
  for (const profile of [null, WORK]) {
    await runStart({ kind: "check", profile });
    expect(process.exitCode, profile ?? "(default)").toBe(1); // nothing tracked
    resetExitCode();
  }
  expect(await classifyDaemonPid(DEAD_PID)).toBe("no");
  expect(await classifyDaemonPid(process.pid)).toBe("no");

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

// No credential: the launch is refused naming the login, and the proxy is never spawned into a
// login of its own (a token it minted would live in its files, outside the store).
test(
  "start with no stored credential refuses with the `agent auth` hint and spawns no daemon",
  async () => {
    const home = tmpHome();
    process.env.COPILOT_API_ENTRY = join(ROOT, "test", "copilot-api-fake.mjs");
    const preflight = () => Promise.resolve();
    const launch = {
      kind: "launch",
      dryRun: false,
      force: false,
      port: undefined,
      profile: null,
    } as const;
    const before = fingerprint(dir);

    await expect(runStart(launch, preflight)).rejects.toThrow(
      "cannot start the proxy without a credential: no GitHub credential configured - run `agent auth` to log in",
    );
    // A profile that was never created is refused by name.
    await expect(runStart({ ...launch, profile: WORK }, preflight)).rejects.toThrow(
      "no such profile 'work'",
    );

    // Nothing was spawned and nothing written: no run directory, no tracked pid, no start lock
    // marker, no daemon home for the unknown profile, and no daemon.lock holder.
    expect(fingerprint(dir)).toEqual(before);
    expect(daemonLockHolderPid(home)).toBeNull();
  },
  30_000,
);

/** Every entry under `root`, relative path -> sha256 of a file's bytes, a directory recorded as
 *  itself (so an empty run or daemon directory counts): the "nothing written" detector for a
 *  refused start, lock markers, run files, and daemon homes included. An `.oslock` sidecar is
 *  recorded by name only: the running daemon holds it and Windows refuses to read a held lock. */
function fingerprint(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        hashes[`${relative(root, path)}/`] = "directory";
        walk(path);
      } else if (entry.name.endsWith(".oslock")) {
        hashes[relative(root, path)] = "lock";
      } else {
        hashes[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest(
          "hex",
        );
      }
    }
  };
  walk(root);
  return hashes;
}

/** A `codex` that shadows any real one on PATH and records each spawn: with the live-lookup seam
 *  OFF, the codex User-Agent's version road really spawns `codex --version`. */
function fakeCodexOnPath(): { spawns: () => string[] } {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const spawns = join(bin, "spawns");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho codex >> "${spawns}"\necho codex-cli 1.2.3\n`);
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(
    join(bin, "codex.cmd"),
    `@echo off\r\necho codex>>"${spawns}"\r\necho codex-cli 1.2.3\r\n`,
  );
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  delete process.env[CI_NO_LIVE_LOOKUPS_ENV];
  resetCodexVersionMemo();
  return {
    spawns: () => existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n") : [],
  };
}

// The refusal comes before ANY side effect: a `--force` with no credential must not stop the
// running daemon first and refuse second, which would leave the user worse off than before the
// command. The detectors: a hash of every file under the root (no lock marker, no daemon home, no
// cleared run state, the tracked pid included), the daemon alive and holding its lock, and a spawn
// ledger for the codex User-Agent's version lookup, the one spawn the refusal path used to reach.
test(
  "start --force with no stored credential refuses before any side effect: nothing written, nothing spawned, the running daemon untouched",
  async () => {
    const home = tmpHome();
    const port = await freePort();
    const daemonPid = launchFakeDaemon(home, port);
    try {
      await until(() => daemonLockHolderPid(home) === daemonPid);
      await until(() => portListening(port));
      // The daemon's one log line has landed, so the log cannot change under the fingerprint.
      await until(() => readFileSync(join(home, "daemon.log"), "utf8").includes("Listening on:"));
      writeRunState({ pid: daemonPid, port });
      process.env.COPILOT_API_ENTRY = join(ROOT, "test", "copilot-api-fake.mjs");
      const codex = fakeCodexOnPath();
      const before = fingerprint(dir);

      await expect(
        runStart(
          { kind: "launch", dryRun: false, force: true, port: undefined, profile: null },
          () => Promise.resolve(),
        ),
      ).rejects.toThrow(
        "cannot start the proxy without a credential: no GitHub credential configured - run `agent auth` to log in",
      );

      expect(fingerprint(dir)).toEqual(before);
      expect(pidAlive(daemonPid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(daemonPid);
      expect(codex.spawns()).toEqual([]);
    } finally {
      await killAndAwaitExit(daemonPid);
    }
  },
  60_000,
);
