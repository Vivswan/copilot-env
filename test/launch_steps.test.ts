import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import {
  applyDefaultConfig,
  awaitReadiness,
  listUntrackedOrphans,
  resolveLaunchCredential,
  resolveStartPort,
  trackedDaemonPids,
  withStartLock,
} from "../src/copilot_api/launch.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { ProxyProjectionState } from "../src/copilot_api/projection_state.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, writeRunState } from "./helpers.ts";

// Pure-unit coverage for the launch-pipeline steps extracted out of `agent start`:
// the credential decision table (provider x PAT shape x passthrough override), the
// orphan-sweep exclusion set, the port-resolution branches, and the readiness wait's
// EADDRINUSE bind-race handling. Each test isolates a temp COPILOT_API_HOME.
const WORK = parseProfileName("work");

// A pid no real process holds (far above any OS pid ceiling we run on).
const DEAD_PID = 2_147_483_646;

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  resetIntegrationIdentityCache();
  setIntegrationProbeFetch(null);
  dir = removeDir(dir);
});

function tmpHome(): string {
  dir = isolateProxyHome("copilot-launch-");
  return dir;
}

/** A login stub for paths that must NEVER prompt: fails the test if invoked. */
async function loginMustNotRun(): Promise<void> {
  throw new Error("interactive login must not run for this case");
}

/** An identity-probe spy: records each (token, pinned) call, returns `id`. */
function probeSpy(id: string): {
  calls: Array<{ token: string; pinned: string | null }>;
  resolve: (token: string, opts?: { pinned?: string | null }) => Promise<string>;
} {
  const calls: Array<{ token: string; pinned: string | null }> = [];
  return {
    calls,
    resolve: (token, opts = {}) => {
      calls.push({ token, pinned: opts.pinned ?? null });
      return Promise.resolve(id);
    },
  };
}

// Open a loopback TCP listener so a port is genuinely busy; caller closes it.
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

/** A busy port (held for the callback) and a free port (grabbed, then released). */
async function withBusyPort<T>(run: (port: number) => Promise<T>): Promise<T> {
  const { server, port } = await listenEphemeral();
  try {
    return await run(port);
  } finally {
    await closeServer(server);
  }
}

async function freePort(): Promise<number> {
  const { server, port } = await listenEphemeral();
  await closeServer(server);
  return port;
}

// --- resolveLaunchCredential: the decision table -------------------------------------

test("resolveLaunchCredential: a stored PAT auto-enables passthrough and probes the identity", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghp_stored_pat");
  const probe = probeSpy(COPILOT_CLI_INTEGRATION_ID);

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: true, // a resolved token never prompts, even on a TTY
    resolveIntegrationId: probe.resolve,
  });

  expect(result).toEqual({
    kind: "pat",
    token: "ghp_stored_pat",
    integrationId: COPILOT_CLI_INTEGRATION_ID,
  });
  // Probed once, per credential, with no config pin.
  expect(probe.calls).toEqual([{ token: "ghp_stored_pat", pinned: null }]);
});

test("resolveLaunchCredential: the copilot device-flow token skips passthrough AND the probe", async () => {
  tmpHome();
  new Credential().store("copilot", "gho_device_flow");
  const probe = probeSpy(COPILOT_CLI_INTEGRATION_ID);

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: false,
    resolveIntegrationId: probe.resolve,
  });

  expect(result).toEqual({ kind: "token", token: "gho_device_flow" });
  expect(probe.calls).toEqual([]); // non-passthrough launches never probe
});

test("resolveLaunchCredential: `passthrough off` overrides even a PAT (and skips the probe)", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghp_forced_off");
  new CopilotEnvConfig().set({ passthrough: "off" });
  const probe = probeSpy(COPILOT_CLI_INTEGRATION_ID);

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: false,
    resolveIntegrationId: probe.resolve,
  });

  expect(result).toEqual({ kind: "token", token: "ghp_forced_off" });
  expect(probe.calls).toEqual([]);
});

test("resolveLaunchCredential: `passthrough on` forces the shim for a non-PAT token; the probe skips non-PATs without network", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghu_user_to_server");
  new CopilotEnvConfig().set({ passthrough: "on" });

  // The REAL resolver: a non-PAT-shaped token needs no probe, so no fetch happens
  // and the daemon default (vscode-chat) comes back.
  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: false,
  });

  expect(result).toEqual({
    kind: "pat",
    token: "ghu_user_to_server",
    integrationId: VSCODE_CHAT_INTEGRATION_ID,
  });
});

test("resolveLaunchCredential: a pinned integration-id reaches the probe as the pin", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghp_pinned");
  new CopilotEnvConfig().set({ integrationId: "copilot-developer-sandbox" });
  const probe = probeSpy("copilot-developer-sandbox");

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: false,
    resolveIntegrationId: probe.resolve,
  });

  expect(result).toEqual({
    kind: "pat",
    token: "ghp_pinned",
    integrationId: "copilot-developer-sandbox",
  });
  expect(probe.calls).toEqual([{ token: "ghp_pinned", pinned: "copilot-developer-sandbox" }]);
});

test("resolveLaunchCredential: PAT + real probe -- the injected fetch's accepted identity wins", async () => {
  tmpHome();
  new Credential().store("gh-token", "github_pat_finegrained");
  // The endpoint rejects vscode-chat (the verified PAT rejection) and accepts the CLI id.
  const stub: ProbeFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    return Promise.resolve(
      id === COPILOT_CLI_INTEGRATION_ID
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("Personal Access Tokens are not supported", { status: 400 }),
    );
  };
  setIntegrationProbeFetch(stub);

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: loginMustNotRun,
    isTTY: false,
  });

  expect(result).toEqual({
    kind: "pat",
    token: "github_pat_finegrained",
    integrationId: COPILOT_CLI_INTEGRATION_ID,
  });
});

test("resolveLaunchCredential: nothing resolved + no TTY -> no login, no token, no shim", async () => {
  tmpHome();
  let loginCalls = 0;

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: async () => {
      loginCalls++;
    },
    isTTY: false,
  });

  expect(loginCalls).toBe(0);
  expect(result).toEqual({ kind: "none" });
});

test("resolveLaunchCredential: nothing resolved + TTY -> logs in, then resolves the fresh credential", async () => {
  tmpHome();
  const loggedInto: Profile[] = [];

  const result = await resolveLaunchCredential(null, new CopilotEnvConfig(), {
    interactiveLogin: async (profile) => {
      loggedInto.push(profile);
      new Credential().store("copilot", "gho_after_login");
    },
    isTTY: true,
  });

  expect(loggedInto).toEqual([null]);
  // copilot provider: exchange-capable, so a plain token and no passthrough shim.
  expect(result).toEqual({ kind: "token", token: "gho_after_login" });
});

test("resolveLaunchCredential: a named profile NEVER falls back to the default credential", async () => {
  tmpHome();
  // The default slot has a perfectly good credential; the profile's own slot is empty.
  new Credential().store("gh-token", "ghp_default_only");
  let loginCalls = 0;

  const result = await resolveLaunchCredential(WORK, new CopilotEnvConfig(), {
    interactiveLogin: async () => {
      loginCalls++;
    },
    isTTY: false,
  });

  expect(result).toEqual({ kind: "none" }); // hard-empty, not the default token
  expect(loginCalls).toBe(0);
});

// --- the orphan-sweep exclusion set --------------------------------------------------

test("listUntrackedOrphans: pids in the keep set are never listed", async () => {
  const listPids = () => Promise.resolve([100, 200, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set([200]), listPids)).toEqual([100, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([100, 200, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set([100, 200, 300]), listPids)).toEqual([]);
});

test("trackedDaemonPids collects the default AND every profile's tracked pid", () => {
  tmpHome();
  writeRunState({ pid: 111 });
  writeRunState({ pid: 222, port: 4242 }, WORK);
  writeRunState({ port: 4343 }, parseProfileName("portonly")); // tracked port, no pid

  expect(trackedDaemonPids()).toEqual(new Set([111, 222]));
});

test("the exclusion set end-to-end: another profile's tracked daemon is not an orphan", async () => {
  tmpHome();
  writeRunState({ pid: 222, port: 4242 }, WORK);
  // The machine-wide scan sees the profile's daemon (222) and a genuine orphan (333).
  const listPids = () => Promise.resolve([222, 333]);
  const orphans = await listUntrackedOrphans(
    process.pid,
    process.ppid,
    trackedDaemonPids(),
    listPids,
  );
  expect(orphans).toEqual([333]);
});

// --- resolveStartPort: the branch table -----------------------------------------------

test("resolveStartPort: an inverted range (min > max) is a clear error", async () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 5000, maxPort: 4000 });
  await expect(
    resolveStartPort(undefined, false, null, false, new CopilotEnvConfig()),
  ).rejects.toThrow(
    "invalid port range: min-port (5000) is greater than max-port (4000); fix it with `agent config --set min-port <n>` / `--set max-port <n>`.",
  );
});

test("resolveStartPort: a pinned out-of-range port fails with the range message", async () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 4000, maxPort: 5000 });
  await expect(resolveStartPort(3999, false, null, false, new CopilotEnvConfig())).rejects.toThrow(
    "requested port 3999 is out of range; the proxy port must be between 4000 and 5000 (`agent config --set min-port/max-port` to change the range).",
  );
});

test("resolveStartPort: a pinned busy port fails -- never silently moves off the pin", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    await expect(
      resolveStartPort(busy, false, null, false, new CopilotEnvConfig()),
    ).rejects.toThrow(
      `requested port ${busy} is busy (held by another process). Free it or pick another --port.`,
    );
  });
});

test("resolveStartPort: a pinned free port is used as-is", async () => {
  tmpHome();
  const port = await freePort();
  expect(await resolveStartPort(port, false, null, false, new CopilotEnvConfig())).toBe(port);
});

test("resolveStartPort: strict-port makes a busy DEFAULT port fatal instead of auto-incrementing", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    new CopilotEnvConfig().set({ port: busy, strictPort: true });
    await expect(
      resolveStartPort(undefined, false, null, false, new CopilotEnvConfig()),
    ).rejects.toThrow(
      `port ${busy} is busy and auto-increment is disabled (\`strict-port\`); free it, pick another \`--port\`, or set \`agent config --set strict-port false\`.`,
    );
  });
});

test("resolveStartPort: a busy default WITHOUT strict-port auto-increments to a free port", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    new CopilotEnvConfig().set({ port: busy });
    const resolved = await resolveStartPort(undefined, false, null, false, new CopilotEnvConfig());
    expect(resolved).not.toBe(busy);
    expect(resolved).toBeGreaterThan(busy);
  });
});

test("resolveStartPort: a configured default port outside the range is a clear error", async () => {
  tmpHome();
  new CopilotEnvConfig().set({ port: 1500, minPort: 2000, maxPort: 3000 });
  await expect(
    resolveStartPort(undefined, false, null, false, new CopilotEnvConfig()),
  ).rejects.toThrow(
    "configured port 1500 is outside the allowed range 2000-3000; run `agent config --set port <n>` within the range, or adjust min-port/max-port.",
  );
});

test("resolveStartPort: a named profile's reservation is honored, even after the range narrowed past it", async () => {
  tmpHome();
  const reserved = await freePort();
  expect(reserved).toBeGreaterThan(2048); // OS ephemeral ports sit far above the narrowed range
  writeRunState({ port: reserved }, WORK);
  // Honored while in range...
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
  // ...and still honored when min/max no longer cover it (liveness-only probe).
  new CopilotEnvConfig().set({ minPort: 1024, maxPort: 2048 });
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
});

test("resolveStartPort: strict-port is DEFAULT-daemon-only -- a profile's busy reservation still moves", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    new CopilotEnvConfig().set({ strictPort: true });
    writeRunState({ port: busy }, WORK);
    const resolved = await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig());
    expect(resolved).not.toBe(busy); // auto-incremented despite strict-port
  });
});

test("resolveStartPort: reserve=false peeks at a profile's candidate without recording it", async () => {
  tmpHome();
  const peeked = await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig());
  expect(peeked).toBeGreaterThan(0);
  expect(CopilotEnvRunState.forProfile(WORK).read().port).toBeUndefined();
});

test("resolveStartPort: reserve=true persists a profile's reservation", async () => {
  tmpHome();
  await resolveStartPort(undefined, false, WORK, true, new CopilotEnvConfig());
  expect(CopilotEnvRunState.forProfile(WORK).read().port).toBeDefined();
});

// --- awaitReadiness: the EADDRINUSE bind race ------------------------------------------

function seedLog(home: string, content: string): string {
  const logFile = join(home, "start.log");
  writeFileSync(logFile, content);
  return logFile;
}

test("awaitReadiness: a pinned port that loses the bind race fails, never relaunches", async () => {
  const home = tmpHome();
  const logFile = seedLog(home, "error: EADDRINUSE address already in use\n");
  let relaunches = 0;
  await expect(
    awaitReadiness({
      pid: DEAD_PID,
      port: 4545,
      logFile,
      profile: null,
      pinnedPort: 4545,
      state: new CopilotEnvRunState(),
      relaunch: () => {
        relaunches++;
        return DEAD_PID;
      },
      config: new CopilotEnvConfig(),
    }),
  ).rejects.toThrow(`port 4545 was taken by another process just before launch. See ${logFile}`);
  expect(relaunches).toBe(0);
});

test("awaitReadiness: strict-port turns the default daemon's bind race fatal, with the strict wording", async () => {
  const home = tmpHome();
  new CopilotEnvConfig().set({ strictPort: true });
  const logFile = seedLog(home, "EADDRINUSE\n");
  await expect(
    awaitReadiness({
      pid: DEAD_PID,
      port: 4646,
      logFile,
      profile: null,
      pinnedPort: undefined,
      state: new CopilotEnvRunState(),
      relaunch: () => DEAD_PID,
      config: new CopilotEnvConfig(),
    }),
  ).rejects.toThrow(
    `port 4646 was taken by another process just before launch (strict-port is on, so no auto-increment). See ${logFile}`,
  );
});

test("awaitReadiness: an unpinned bind race retries on a different port and tails to readiness", async () => {
  const home = tmpHome();
  const base = await freePort();
  const logFile = seedLog(home, "EADDRINUSE\n");
  const state = new CopilotEnvRunState();
  const relaunchPorts: number[] = [];

  const live = await awaitReadiness({
    pid: DEAD_PID,
    port: base,
    logFile,
    profile: null,
    pinnedPort: undefined,
    state,
    relaunch: (port) => {
      relaunchPorts.push(port);
      writeFileSync(logFile, "Listening on: http://127.0.0.1\n");
      return process.pid; // alive, and the log already reads ready
    },
    config: new CopilotEnvConfig(),
    // Injected: a real scan from an ephemeral base can hit the top of the range
    // on Windows runners (reserved blocks near 65535) and find nothing.
    findPort: (start) => Promise.resolve(start),
  });

  expect(relaunchPorts.length).toBe(1);
  expect(relaunchPorts[0]).toBeGreaterThan(base); // moved OFF the raced port
  expect(live.port).toBe(relaunchPorts[0] as number);
  expect(live.pid).toBe(process.pid);
  // The winning pid/port pair was recorded in run state.
  expect(state.read().pid).toBe(process.pid);
  expect(state.read().port).toBe(live.port);
  expect(readFileSync(logFile, "utf-8")).toContain("Listening on:");
});

test("awaitReadiness: a dead daemon without a bind race fails with the plain start error", async () => {
  const home = tmpHome();
  const logFile = seedLog(home, "Failed to get Copilot token: 403\n");
  await expect(
    awaitReadiness({
      pid: DEAD_PID,
      port: 4747,
      logFile,
      profile: null,
      pinnedPort: undefined,
      state: new CopilotEnvRunState(),
      relaunch: () => DEAD_PID,
      config: new CopilotEnvConfig(),
    }),
  ).rejects.toThrow(`the proxy failed to start. See ${logFile}`);
});

// --- applyDefaultConfig: the pre-launch config.json projection --------------------------

/** The temp home's paths plus its config.json store (what applyDefaultConfig writes). */
function projectionFixture(): { paths: CopilotApiPaths; config: CopilotApiConfig } {
  tmpHome();
  const paths = new CopilotApiPaths();
  return { paths, config: new CopilotApiConfig(paths.configFile) };
}

test("applyDefaultConfig: a nested projection merges into contextManagement and drops the stale flat key", () => {
  const { paths, config } = projectionFixture();
  new CopilotEnvConfig().set({ useResponsesApiContextManagement: true });
  // Seed what an existing daemon home holds: its own contextManagement.messages plus the
  // flat key an older copilot-env projected (dead since the proxy's 1.14 rename).
  config.save({
    contextManagement: { messages: true },
    useResponsesApiContextManagement: false,
  });

  applyDefaultConfig(paths);

  const doc = config.load();
  expect(doc.contextManagement).toEqual({ messages: true, responses: true });
  expect("useResponsesApiContextManagement" in doc).toBe(false);
  // The force-projected keys still land at the top level alongside.
  expect(doc.smallModel).toBe("gpt-5-mini");
  // The opt-in write (and ONLY it) is recorded as ours, so a later unset can clear it.
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([
    ["contextManagement", "responses"],
  ]);
});

test("applyDefaultConfig: --del of an opt-in key clears OUR recorded write on the next apply", () => {
  const { paths, config } = projectionFixture();
  const envConfig = new CopilotEnvConfig();
  envConfig.set({ useResponsesApiContextManagement: true });
  config.save({ contextManagement: { messages: true } });
  applyDefaultConfig(paths);
  expect(config.load().contextManagement).toEqual({ messages: true, responses: true });

  envConfig.del("useResponsesApiContextManagement");
  applyDefaultConfig(paths);

  const doc = config.load();
  // Our projected value is gone, the daemon-owned sibling stands, and the force-projected
  // keys are untouched by the clearing pass.
  expect(doc.contextManagement).toEqual({ messages: true });
  expect(doc.smallModel).toBe("gpt-5-mini");
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

test("applyDefaultConfig: with the opt-in key unset, a hand-edited value we never projected survives", () => {
  const { paths, config } = projectionFixture();
  config.save({
    contextManagement: { messages: false, responses: true },
    useResponsesApiContextManagement: true,
  });

  applyDefaultConfig(paths);

  const doc = config.load();
  // No ownership record exists for contextManagement.responses, so the hand edit stands;
  // only the stale flat key is dropped.
  expect(doc.contextManagement).toEqual({ messages: false, responses: true });
  expect("useResponsesApiContextManagement" in doc).toBe(false);
});

test("applyDefaultConfig: a recorded path outside the registry's opt-in set is never deleted", () => {
  const { paths, config } = projectionFixture();
  config.save({ auth: { apiKeys: ["seeded-key"] } });
  // A well-formed record entry claiming a path no registry entry projects opt-in (a foreign
  // write, or an older registry's key).
  new ProxyProjectionState(paths).setOwnedPaths([["auth"]]);

  applyDefaultConfig(paths);

  // The foreign claim deleted nothing, and it fell out of the record instead of persisting.
  expect(config.load().auth).toMatchObject({ apiKeys: ["seeded-key"] });
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

test("applyDefaultConfig: a lost record write self-heals on the next apply", () => {
  const { paths, config } = projectionFixture();
  const envConfig = new CopilotEnvConfig();
  envConfig.set({ useResponsesApiContextManagement: true });
  applyDefaultConfig(paths);
  // Simulate the crash window: config.json already carries our value, but the record write
  // (which lands after the config write) never did.
  rmSync(paths.projectionsFile);

  applyDefaultConfig(paths);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([
    ["contextManagement", "responses"],
  ]);

  // With ownership re-established, --del clears the value as usual.
  envConfig.del("useResponsesApiContextManagement");
  applyDefaultConfig(paths);
  expect(config.load().contextManagement).toEqual({});
});

test("applyDefaultConfig: a non-record in a nested path's way is replaced, not crashed on", () => {
  const { paths, config } = projectionFixture();
  new CopilotEnvConfig().set({ useResponsesApiContextManagement: false });
  config.save({ contextManagement: "corrupt" });

  applyDefaultConfig(paths);

  expect(config.load().contextManagement).toEqual({ responses: false });
});

test("applyDefaultConfig: ownership clearing covers every opt-in key (claude-token-multiplier)", () => {
  const { paths, config } = projectionFixture();
  const envConfig = new CopilotEnvConfig();
  envConfig.set({ claudeTokenMultiplier: 1.3 });
  applyDefaultConfig(paths);
  expect(config.load().claudeTokenMultiplier).toBe(1.3);

  envConfig.del("claudeTokenMultiplier");
  applyDefaultConfig(paths);

  expect("claudeTokenMultiplier" in config.load()).toBe(false);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

// --- withStartLock: the ONE owning scope of the global start lock ------------------------

test("withStartLock releases the start lock on return and on throw alike", async () => {
  tmpHome();
  expect(await withStartLock(() => Promise.resolve(41))).toBe(41);
  await expect(withStartLock(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  // If either scope above had leaked the lock, this take would wait forever
  // (the start lock's wait is unbounded) and time the suite out.
  expect(await withStartLock(() => Promise.resolve(true))).toBe(true);
});
