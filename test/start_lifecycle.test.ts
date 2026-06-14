import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portListening, runStart } from "../src/commands/start.ts";
import { classifyDaemonPid } from "../src/copilot_api/process.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";

// The lifecycle primitives the proxy-token resolver orchestrates: `start --record-event`
// (heartbeat) and `start --check` (is-it-up probe). Each is isolated in a temp
// COPILOT_API_HOME and resets the shared process.exitCode.
const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  // Reset to 0 (NOT undefined -- bun's process.exitCode setter ignores undefined and keeps
  // the last value, which would leak a test's exit 1 to the whole `bun test` run).
  process.exitCode = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-lifecycle-"));
  process.env.COPILOT_API_HOME = dir;
}

// Open a loopback TCP server on an ephemeral port and resolve once it is accepting
// connections. Mirrors the daemon's listening socket so portListening can probe a real port.
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

test("start --record-event writes the lastEnsureAt heartbeat and never launches", async () => {
  tmpHome();
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();

  await runStart({ recordEvent: true });

  expect(typeof new CopilotEnvRunState().read().lastEnsureAt).toBe("number");
  expect(new CopilotEnvRunState().read().pid).toBeUndefined(); // no daemon was started
});

test("start --check exits non-zero when no proxy is tracked/running", async () => {
  tmpHome();
  await runStart({ check: true });
  expect(process.exitCode).toBe(1);
});

// portListening is the liveness half of proxyStatus's UP-path composition. proxyStatus's
// OTHER half (classifyDaemonPid) checks the recorded pid's identity against a `copilot-api
// ... start` command line, which the bun test runner's own pid cannot satisfy -- so the full
// UP-path through runStart({check:true}) is not reproducible in-test without a real daemon (see
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
    new CopilotEnvRunState().set({ pid: process.pid, port });
    expect(new CopilotEnvRunState().read().pid).toBe(process.pid);
    expect(new CopilotEnvRunState().read().port).toBe(port);

    await runStart({ check: true });
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
