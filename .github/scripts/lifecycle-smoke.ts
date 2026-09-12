// End-to-end daemon lifecycle against the fake proxy (COPILOT_API_ENTRY -> test/copilot-api-fake.mjs),
// so no Copilot auth is needed. It rewires agent configs in whatever HOME it sees, so it refuses
// to run outside a container or a CI runner. On a developer machine:
//   deno task test:docker --lifecycle
//
//   start -> health --scope runtime must pass -> stop -> health --scope runtime must FAIL
// start/stop and the probe verify each other, so neither can pass alone.
//
// `--allow-run` is unscoped: the pid probe signals the daemon's pid, which `--allow-run=deno`
// cannot express.
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../../src/copilot_api/state.ts";
import { pidLiveness } from "../../src/utils/pid.ts";
import { cli, cliOrExit, fail, requireDisposableHome, runnerOs } from "./smoke-support.ts";

requireDisposableHome("lifecycle-smoke.ts", "mutates", "--lifecycle");

const os = runnerOs();
const PROFILE = parseProfileName("work");

function failOn(message: string): never {
  return fail(`${message} on ${os}`);
}

function readPid(): number | undefined {
  return new CopilotEnvRunState().read().pid;
}

function readProfilePid(): number | undefined {
  return CopilotEnvRunState.forProfile(PROFILE).read().pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the daemon at `pid` is still there. A probe that could not judge (no run
 *  permission) fails the smoke by name instead of reading as a survivor. */
function daemonAlive(pid: number): boolean {
  const liveness = pidLiveness(pid);
  if (liveness === "unproven") failOn(`could not probe pid ${pid}; the smoke needs --allow-run`);
  return liveness === "alive";
}

cliOrExit(["start"]);
cliOrExit(["health", "--scope", "runtime"]);

// Managed mode (auto-start on): a redundant `start` must keep the SAME pid, so it never
// disrupts a connected agent; `--force` relaunches. The gate is the "[start:noop]" machine
// marker, an external contract of src/commands/start.ts, so the human wording is free to change.
cliOrExit(["config", "--set", "auto-start", "true"]);
const pidBefore = readPid();
const redundantStart = cliOrExit(["start"], { stdout: "piped" });
Deno.stdout.writeSync(new TextEncoder().encode(redundantStart));
if (!redundantStart.includes("[start:noop]")) failOn("managed redundant start did not no-op");
const pidAfter = readPid();
if (pidBefore !== pidAfter) {
  failOn(`managed redundant start changed the pid (${pidBefore} -> ${pidAfter})`);
}
cliOrExit(["health", "--scope", "runtime"]);
cliOrExit(["start", "--force"]);
const pidForced = readPid();
if (pidAfter === pidForced) failOn("start --force did not relaunch a fresh daemon");
cliOrExit(["health", "--scope", "runtime"]);
cliOrExit(["config", "--del", "auto-start"]);

cliOrExit(["codex", "--proxy"]);
cliOrExit(["claude", "--proxy"]);
cliOrExit(["health", "--scope", "setup"]);
console.log(`health OK while running on ${os}`);

// Named-profile daemon BESIDE the default: one `agent profile --add` wires its own
// credential + mode + BOTH agents; its daemon gets an isolated home and reserved
// port; stopping/deleting it must leave the default daemon untouched.
cliOrExit([
  "profile",
  "--add",
  PROFILE,
  "--proxy",
  "--provider",
  "gh-token",
  "--set",
  "fake-profile-token",
]);
if (!cliOrExit(["profile", "--list"], { stdout: "piped" }).includes(PROFILE)) {
  failOn("profile --list did not report the work profile");
}
if (!cliOrExit(["auth", "--list"], { stdout: "piped" }).includes(PROFILE)) {
  failOn("auth --list did not report the work profile");
}
const checkCode = cli(["profile", "--check", PROFILE]).code;
if (checkCode !== 2) failOn(`profile --check work should exit 2 (proxy), got ${checkCode}`);
cliOrExit(["start", "--profile", PROFILE]);
cliOrExit(["start", "--check", "--profile", PROFILE]);
cliOrExit(["start", "--check"]);
if (readPid() === readProfilePid()) failOn("profile daemon shares the default pid");
const workPid = readProfilePid() ?? failOn("profile daemon recorded no pid");
cliOrExit(["stop", "--profile", PROFILE]);
// `stop` clears the tracked pid, so `start --check` alone can't prove the PROCESS
// died -- assert on the saved pid directly (SIGTERM is async; allow a short grace).
for (let attempt = 0; attempt < 5 && daemonAlive(workPid); attempt++) {
  await sleep(1000);
}
if (daemonAlive(workPid)) failOn(`profile daemon (pid ${workPid}) survived stop --profile`);
if (cli(["start", "--check", "--profile", PROFILE]).code === 0) {
  failOn("profile daemon still up after stop --profile");
}
if (cli(["start", "--check"]).code !== 0) failOn("default daemon died with the profile daemon");
cliOrExit(["profile", "--del", PROFILE]);
if (cli(["profile", "--check", PROFILE], { stdout: "null", stderr: "null" }).code === 0) {
  failOn("profile still exists after profile --del");
}
console.log(`profile daemon lifecycle OK on ${os}`);

cliOrExit(["stop"]);
if (cli(["health", "--scope", "runtime"]).code === 0) failOn("health reported healthy after stop");
console.log(`start/stop + health OK on ${os}`);
