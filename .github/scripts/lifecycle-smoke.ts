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

// `agent start` and every wiring command need a credential first; the fake proxy never reads the
// token, so any string satisfies the gate headless. A daemon launch with a credential selects its
// client identity and host by probing Copilot, which refuses a fake token; the pin and the literal
// are the two knobs that skip both probes (the token-label lookup at api.github.com still runs,
// best-effort).
cliOrExit(["config", "--set", "identity", "copilot-developer-cli"]);
cliOrExit(["config", "--set", "host", "https://copilot.invalid"]);
cliOrExit(["auth", "--set", "fake-default-token"]);

cliOrExit(["start"]);
cliOrExit(["health", "--scope", "runtime"]);

// Managed mode (auto-start on): a redundant `start` must keep the SAME pid, so it never
// disrupts a connected agent; `--force` relaunches. The gate is the "[start:noop]" machine
// marker, an external contract of src/commands/start.ts, so the human wording is free to change.
cliOrExit(["config", "--set", "daemon.auto-start", "true"]);
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
cliOrExit(["config", "--del", "daemon.auto-start"]);

cliOrExit(["init", "--proxy"]);
cliOrExit(["health", "--scope", "setup"]);
console.log(`health OK while running on ${os}`);

// Named-profile daemon BESIDE the default: `add` records the mode, `auth` lands the credential
// and wires BOTH agents; its daemon gets an isolated home and reserved port; stopping/deleting it
// must leave the default daemon untouched.
cliOrExit(["profile", PROFILE, "add", "--proxy", "--no-auth"]);
cliOrExit(["profile", PROFILE, "auth", "--set", "fake-profile-token"]);
if (!cliOrExit(["list"], { stdout: "piped" }).includes(PROFILE)) {
  failOn("agent list did not report the work profile");
}
const checkCode = cli(["profile", PROFILE, "check"]).code;
if (checkCode !== 2) failOn(`profile work check should exit 2 (proxy), got ${checkCode}`);
// The identity and host keys are per profile: the work daemon's launch needs its own pin and
// literal, or its fake token is probed like the default's would have been.
cliOrExit(["config", "--set", "identity", "copilot-developer-cli", "--profile", PROFILE]);
cliOrExit(["config", "--set", "host", "https://copilot.invalid", "--profile", PROFILE]);
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
cliOrExit(["profile", PROFILE, "del", "--yes"]);
if (cli(["profile", PROFILE, "check"], { stdout: "null", stderr: "null" }).code === 0) {
  failOn("profile still exists after profile work del");
}
console.log(`profile daemon lifecycle OK on ${os}`);

cliOrExit(["stop"]);
if (cli(["health", "--scope", "runtime"]).code === 0) failOn("health reported healthy after stop");
console.log(`start/stop + health OK on ${os}`);
