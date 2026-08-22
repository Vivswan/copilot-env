import { createServer, type Server } from "node:net";
import { parseStartAction, runStart } from "../src/commands/start.ts";
import { portListening } from "../src/copilot_api/daemon.ts";
import { classifyDaemonPid } from "../src/copilot_api/process.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateProxyHome,
  removeDir,
  resetExitCode,
  writeRunState,
} from "./helpers.ts";

// The lifecycle primitives the proxy-token resolver orchestrates: `start --record-event`
// (heartbeat) and `start --check` (is-it-up probe). Each is isolated in a temp
// COPILOT_API_HOME and resets the shared process.exitCode.
// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-lifecycle-");
}

// Open a loopback TCP server on an ephemeral port and resolve once it is accepting
// connections. Mirrors the daemon's listening socket so portListening can probe a real port.
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

test("start --record-event writes the lastEnsureAt heartbeat and never launches", async () => {
  tmpHome();
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();

  await runStart({ kind: "record-event", profile: null });

  expect(typeof new CopilotEnvRunState().read().lastEnsureAt).toBe("number");
  expect(new CopilotEnvRunState().read().pid).toBeUndefined(); // no daemon was started
});

test("start --record-event --profile heartbeats ONLY the profile's run state", async () => {
  tmpHome();
  // A real proxy profile always has run state before its resolver heartbeats (the
  // port reservation writes it); a profile WITHOUT state must not be fabricated.
  writeRunState({ port: 4242 }, WORK);
  await runStart({ kind: "record-event", profile: WORK });

  expect(typeof CopilotEnvRunState.forProfile(WORK).read().lastEnsureAt).toBe("number");
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();
});

// parseStartAction is the CLI boundary: exactly one of check / record-event / launch.
// A conflicting flag combination is rejected there, never resolved by dispatch order
// (the old silent-if-order shape dropped `--record-event` when `--check` was present).
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
  // `profile` comes back PARSED: a branded ProfileName, or null when the flag is absent.
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

// portListening is the liveness half of proxyStatus's UP-path composition. proxyStatus's
// OTHER half (classifyDaemonPid) checks the recorded pid's identity against a `copilot-api
// ... start` command line, which the deno test runner's own pid cannot satisfy -- so the full
// UP-path through runStart({kind:"check"}) is not reproducible in-test without a real daemon (see
// the "stays DOWN" test below). These two tests pin the part that IS deterministic: the raw TCP
// liveness probe against a real listening port vs. a dead one.
test("portListening resolves true against a real listening loopback port", async () => {
  const { server, port } = await listenEphemeral();
  try {
    expect(await portListening(port, 2000)).toBe(true);
  } finally {
    await closeServer(server);
  }
});

test("portListening resolves false for a port with nothing listening", async () => {
  // Grab an ephemeral port, then close the server so the port is free again. Nothing is
  // listening, so the connect should error/refuse and the probe must report not-listening.
  const { server, port } = await listenEphemeral();
  await closeServer(server);
  expect(await portListening(port, 1000)).toBe(false);
});

test("portListening detects an IPv6-loopback-only listener too", async () => {
  // The probe connects to 127.0.0.1 and ::1 concurrently and settles on the first success, so a
  // daemon bound only to IPv6 loopback is still found. Skip if the host has no IPv6 loopback.
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

// The full UP-path (live pid + real listening port -> exit 0) requires proxyStatus's
// classifyDaemonPid guard to NOT return "no", which means the seeded pid must be a process whose
// command line matches `copilot-api ... start`. The test runner's pid is identifiable but does
// NOT match, so classifyDaemonPid returns "no" and even a genuinely listening port stays DOWN.
// This asserts the guard is load-bearing: a live-but-foreign, IDENTIFIABLE pid plus a real port
// still yields exit 1, never a false UP. (A restricted token that cannot read the pid's command
// line yields "unknown" -> the port probe decides; see the classifyDaemonPid unit test below. A
// true exit-0 path is covered end-to-end by the start/stop lifecycle against the fake proxy,
// where the daemon's command line does match.)
test("start --check stays DOWN for a live pid + listening port that is not a copilot-api daemon", async () => {
  tmpHome();
  const { server, port } = await listenEphemeral();
  try {
    // process.pid is alive (pidAlive true) and the port genuinely listens, but the test runner
    // is not a copilot-api daemon and IS identifiable, so classifyDaemonPid(process.pid) is "no".
    writeRunState({ pid: process.pid, port });
    expect(new CopilotEnvRunState().read().pid).toBe(process.pid);
    expect(new CopilotEnvRunState().read().port).toBe(port);

    await runStart({ kind: "check", profile: null });
    expect(process.exitCode).toBe(1);
  } finally {
    await closeServer(server);
  }
});

// classifyDaemonPid is the PID-identity half of proxyStatus. A definitive "no" (dead pid, or a
// live but identifiable non-daemon) is what keeps the DOWN test above honest; "unknown" (a
// restricted token that cannot read a command line) is reserved for sandboxed callers and is
// exercised by proxyStatus's fall-through, not reproducible here.
test("classifyDaemonPid returns 'no' for a dead pid and a live non-daemon pid", async () => {
  const DEAD_PID = 2_147_483_646; // far above any real pid -> not running anywhere
  expect(await classifyDaemonPid(DEAD_PID)).toBe("no");
  // The test runner is alive and identifiable, but its command line is not `copilot-api ... start`.
  expect(await classifyDaemonPid(process.pid)).toBe("no");
});
