import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  type CleanupAction,
  cleanupExistingProxies,
  daemonLifecycleEnv,
  type FloorCheckedEntry,
  type HeldStartLock,
  listUntrackedOrphans,
  lockProtectedDaemonPids,
  planCleanup,
  resolveLaunchCredential,
  resolveStartPort,
  trackedDaemonPids,
  withStartLock,
} from "../src/copilot_api/launch.ts";
import { type CopilotApiEntry, isCopilotApiPid, pidAlive } from "../src/copilot_api/process.ts";
import { CopilotApiPaths, profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { ProxyProjectionState } from "../src/copilot_api/ownership.ts";
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
  killAndAwaitExit,
  launchFakeDaemon,
  removeDir,
  until,
  writeRunState,
} from "./helpers.ts";

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

/** Isolate a root and return the DEFAULT daemon's home under it
 *  (profiles/default, created on disk) -- what the lock/holder staging and the
 *  consult sites both resolve. `dir` (the root) owns cleanup. */
function tmpHome(): string {
  dir = isolateProxyHome("copilot-launch-");
  return defaultHomeDir();
}

// The env keys are pinned as LITERALS: they are the spawn-to-preload contract, so a
// rename on either side must fail here.
test("daemonLifecycleEnv transports home, root, and the keep-port policy per daemon", () => {
  tmpHome();
  const defaults = daemonLifecycleEnv(null, new CopilotApiPaths());
  expect(defaults["COPILOT_ENV_ROOT_HOME"]).toBe(dir);
  expect(defaults["COPILOT_API_SQLITE_DB_PATH"]).toBe(new CopilotApiPaths().sqliteDb);
  // The default daemon releases its port on auto-stop (DaemonPolicy.releasesPortOnStop).
  expect(defaults["COPILOT_ENV_DAEMON_KEEP_PORT"]).toBe("0");
  // A named profile's port is its stable reservation: the watchdog must keep it.
  const work = daemonLifecycleEnv(WORK, new CopilotApiPaths(WORK));
  expect(work["COPILOT_ENV_DAEMON_KEEP_PORT"]).toBe("1");
  expect(work["COPILOT_ENV_ROOT_HOME"]).toBe(dir);
});

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
  tmpHome(); // the lock keep-signal scans the effective home, so it must be isolated
  const listPids = () => Promise.resolve([100, 200, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set([200]), listPids)).toEqual([100, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([100, 200, 300]);
  expect(await listUntrackedOrphans(1, 2, new Set([100, 200, 300]), listPids)).toEqual([]);
});

test("a live daemon.lock holder is never listed for the sweep, whatever its argv", async () => {
  const home = tmpHome();
  // This test process holds the DEFAULT home's daemon lock, standing in for a daemon whose
  // run-state tracking was lost -- with an empty keep set, only the lock protects it.
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    const listPids = () => Promise.resolve([process.pid, 333]);
    expect(lockProtectedDaemonPids()).toEqual({ kind: "pids", pids: new Set([process.pid]) });
    expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([333]);
  } finally {
    releaseFileLock(daemonLockPath(home));
  }
  // Control: with the lock released, the same pid IS sweepable again.
  expect(lockProtectedDaemonPids()).toEqual({ kind: "pids", pids: new Set() });
  expect(
    await listUntrackedOrphans(1, 2, new Set(), () => Promise.resolve([process.pid, 333])),
  ).toEqual([process.pid, 333]);
});

test("the lock keep-signal covers profile homes too", async () => {
  tmpHome();
  // Acquiring creates the profile home dir, which is what profileHomeNames enumerates.
  const workHome = profileHome(WORK);
  expect(acquireDaemonLockForLife(workHome, { waitMs: 0 })).toBe(true);
  try {
    expect(lockProtectedDaemonPids()).toEqual({ kind: "pids", pids: new Set([process.pid]) });
    expect(
      await listUntrackedOrphans(1, 2, new Set(), () => Promise.resolve([process.pid, 444])),
    ).toEqual([444]);
  } finally {
    releaseFileLock(daemonLockPath(workHome));
  }
});

test("an unreadable lock probe makes the sweep fail closed instead of reading as unprotected", async () => {
  const home = tmpHome();
  const listPids = () => Promise.resolve([333]);
  // Control first: with the home's lock state readable (no lock at all), 333 IS sweepable.
  expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([333]);

  // A directory at the marker path: the probe's marker read fails with a non-ENOENT error,
  // so the home's lock state is "failed to look", not "nobody there".
  mkdirSync(daemonLockPath(home), { recursive: true });
  expect(lockProtectedDaemonPids()).toEqual({ kind: "indeterminate", home });
  expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([]);
});

test("a held lock whose marker names nobody also reads indeterminate, and the holder stop skips", async () => {
  const home = tmpHome();
  // Hold the lock, then corrupt the marker: the OS lock proves SOMEONE lives, but no pid
  // can be named -- neither the sweep nor the holder stop may act on that.
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    writeFileSync(daemonLockPath(home), "not a marker\n");
    expect(daemonLockHolderPid(home)).toBe(null); // nobody NAMEABLE to signal
    expect(lockProtectedDaemonPids()).toEqual({ kind: "indeterminate", home });
    expect(await listUntrackedOrphans(1, 2, new Set(), () => Promise.resolve([333]))).toEqual([]);

    // The full cleanup neither signals us (the anonymous holder) nor throws.
    await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);
  } finally {
    releaseFileLock(daemonLockPath(home));
  }
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

// --- cleanupExistingProxies: the this-home lock-holder recovery --------------------------
//
// The recovery hole these pin: the sweep spares every live daemon.lock holder, so a live
// holder whose run state was LOST (hostname change, deleted state file, an outlived
// SIGTERM after the optimistic pid clear) used to be unstoppable -- every `agent start`
// failed in the preload's lock acquisition and `agent stop` no-opped. The start cleanup
// now stops THIS home's lock holder itself -- tracked or not, but ONLY under host-local
// corroboration (the owner-filtered process scan confirms our daemon; never a pid some
// run state tracks or another home's lock can claim): on a SHARED home the lock belongs
// to another host's daemon and its marker pid means nothing in this host's pid table,
// and per-host run state only proves a pid was ours ONCE. Every other home's holder
// stays spared, and every uncorroborated case falls back to the preload's legible
// failure.

/** An inert machine-wide scan: no orphans, so only the tracked/holder stops can act. */
const NO_ORPHANS = (): Promise<number[]> => Promise.resolve([]);

/** Run the cleanup under the real start lock -- the held-lock evidence its signature
 *  demands (only withStartLock mints one), exactly as runStart threads it. */
function cleanupUnderLock(
  profile: Profile,
  state: CopilotEnvRunState,
  listPids?: (myPid: number, myPpid: number) => Promise<number[]>,
): Promise<void> {
  return withStartLock((lock) => cleanupExistingProxies(lock, profile, state, listPids));
}

// --- planCleanup: the enumerated decision source (executed live, narrated by --dry-run) --

test("planCleanup: a dead tracked pid plans only the tracking clear, orphans enumerated", async () => {
  const home = tmpHome();
  writeRunState({ pid: DEAD_PID, port: 4141 });
  // process.pid stands in as the injected "orphan": alive, untracked, holding no lock.
  const plan = await planCleanup(
    home,
    null,
    new CopilotEnvRunState(),
    () => Promise.resolve([process.pid]),
  );
  expect(plan).toEqual(
    [
      { kind: "clear-tracking", pid: DEAD_PID },
      { kind: "stop-orphan", pid: process.pid },
    ] satisfies CleanupAction[],
  );
  // Planning is read-only: the stale tracking survives until the EXECUTION clears it.
  expect(new CopilotEnvRunState().read().pid).toBe(DEAD_PID);
});

test(
  "planCleanup: a corroborated lock holder is planned for the stop even while tracked (the deferred tracked stop)",
  async () => {
    const home = tmpHome();
    const pid = launchFakeDaemon(home, await freePort());
    try {
      expect(await until(20_000, () => daemonLockVerdict(home, pid) === "alive")).toBe(true);
      writeRunState({ pid, port: 4141 });

      // The lock's "alive" verdict defers the tracked stop to the holder stop, and the
      // corroboration must not refuse the holder over the very tracking this plan clears.
      expect(await planCleanup(home, null, new CopilotEnvRunState(), NO_ORPHANS)).toEqual(
        [
          { kind: "clear-tracking", pid },
          { kind: "stop-holder", pid },
        ] satisfies CleanupAction[],
      );

      // Planning is read-only: nothing signalled, nothing cleared.
      expect(pidAlive(pid)).toBe(true);
      expect(new CopilotEnvRunState().read().pid).toBe(pid);
    } finally {
      await killAndAwaitExit(pid);
    }
  },
  60_000,
);

// The class pin for the deferral's SHAPE: the corroboration exempts the RECORD this plan
// clears, never the pid. A stale-state pid-reuse collision -- a SECOND slot's run state
// tracking the SAME pid -- must still refuse the holder stop even though this slot's clear
// is planned (a pid-equality exemption would corroborate here and regress the kill-safety
// refusal).
test(
  "planCleanup: a holder another slot ALSO tracks is refused, even with this slot's clear planned",
  async () => {
    const home = tmpHome();
    const pid = launchFakeDaemon(home, await freePort());
    try {
      expect(await until(20_000, () => daemonLockVerdict(home, pid) === "alive")).toBe(true);
      writeRunState({ pid, port: 4141 });
      writeRunState({ pid, port: 4242 }, WORK); // the surviving second claim

      expect(await planCleanup(home, null, new CopilotEnvRunState(), NO_ORPHANS)).toEqual(
        [
          { kind: "clear-tracking", pid },
          { kind: "leave-holder", pid },
        ] satisfies CleanupAction[],
      );
    } finally {
      await killAndAwaitExit(pid);
    }
  },
  60_000,
);

// The post-clear keep set covers the SWEEP too: a lock-dead tracked pid (verdict "dead",
// so the tracked stop never signals it) recycled onto a live lockless daemon must still be
// enumerated for the orphan sweep -- pre-split, the sweep's keep-set snapshot was taken
// AFTER the clear, so this slot's stale record never spared it.
test(
  "planCleanup: a lock-dead tracked pid recycled onto a lockless daemon is still swept",
  async () => {
    const home = tmpHome();
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), join(ROOT, "test", "copilot-api-fake.mjs"), "start"],
      stdout: "null",
      stderr: "null",
    });
    try {
      mkdirSync(home, { recursive: true });
      // A free lock whose marker names the child: the daemon that wrote it died and the
      // OS released the lock; the pid number was then recycled onto the lockless child.
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      writeRunState({ pid: child.pid, port: 4141 });
      expect(daemonLockVerdict(home, child.pid)).toBe("dead"); // control: no tracked signal

      const plan = await planCleanup(
        home,
        null,
        new CopilotEnvRunState(),
        () => Promise.resolve([child.pid]),
      );
      expect(plan).toEqual(
        [
          { kind: "clear-tracking", pid: child.pid },
          { kind: "stop-orphan", pid: child.pid },
        ] satisfies CleanupAction[],
      );
      expect(pidAlive(child.pid)).toBe(true); // planning is read-only
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

test(
  "planCleanup: a tracked pre-lock daemon (no lock) plans the argv-gated stop, then the clear",
  async () => {
    const home = tmpHome();
    // The fake proxy WITHOUT the daemon preloads: daemon-shaped argv, no daemon.lock --
    // exactly the "unproven" verdict the argv-gated tracked stop exists for.
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), join(ROOT, "test", "copilot-api-fake.mjs"), "start"],
      stdout: "null",
      stderr: "null",
    });
    try {
      // Wait until the argv scan can actually see the spawn (the plan's identity gate).
      const deadline = Date.now() + 10_000;
      while (!(await isCopilotApiPid(child.pid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      writeRunState({ pid: child.pid, port: 4141 });

      expect(await planCleanup(home, null, new CopilotEnvRunState(), NO_ORPHANS)).toEqual(
        [
          { kind: "stop-tracked", pid: child.pid },
          { kind: "clear-tracking", pid: child.pid },
        ] satisfies CleanupAction[],
      );

      // Planning is read-only: the daemon-shaped child was never signalled.
      expect(pidAlive(child.pid)).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

test(
  "cleanupExistingProxies: a live lock holder with NO run state is stopped, and a new daemon re-acquires",
  async () => {
    const home = tmpHome();
    const oldPid = launchFakeDaemon(home, await freePort());
    let newPid: number | null = null;
    try {
      expect(await until(20_000, () => daemonLockVerdict(home, oldPid) === "alive")).toBe(true);
      // The lost-run-state premise: nothing tracked, so the tracked stop cannot reach the
      // holder and the sweep (inert here regardless) would only spare it.
      expect(new CopilotEnvRunState().read().pid).toBeUndefined();

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // The holder was stopped and its lock reads dead by pid -- genuinely released, not
      // merely unobserved.
      expect(await until(5_000, () => !pidAlive(oldPid))).toBe(true);
      expect(await until(5_000, () => daemonLockVerdict(home, oldPid) === "dead")).toBe(true);

      // And the recovery is real: a NEW daemon launches and re-acquires this home's lock
      // (what the preload's bounded acquisition does at every `agent start`).
      newPid = launchFakeDaemon(home, await freePort());
      const started = newPid;
      expect(await until(20_000, () => daemonLockVerdict(home, started) === "alive")).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(started);
    } finally {
      await killAndAwaitExit(oldPid);
      if (newPid !== null) await killAndAwaitExit(newPid);
    }
  },
  60_000,
);

test(
  "cleanupExistingProxies: a DIFFERENT home's live lock holder is untouched by this start",
  async () => {
    const home = tmpHome();
    const workPid = launchFakeDaemon(profileHome(WORK), await freePort());
    try {
      expect(
        await until(20_000, () => daemonLockVerdict(profileHome(WORK), workPid) === "alive"),
      ).toBe(true);
      // Control: the DEFAULT home (the one this start cleans) holds no lock, and the
      // machine-wide scan DOES see the profile's daemon -- only the lock spares it.
      expect(daemonLockHolderPid(home)).toBe(null);

      await cleanupUnderLock(
        null,
        new CopilotEnvRunState(),
        () => Promise.resolve([workPid]),
      );

      expect(pidAlive(workPid)).toBe(true);
      expect(daemonLockHolderPid(profileHome(WORK))).toBe(workPid);
    } finally {
      await killAndAwaitExit(workPid);
    }
  },
  60_000,
);

test(
  "cleanupExistingProxies: a pre-lock daemon (no lock) with lost run state is still swept by argv signature",
  async () => {
    const home = tmpHome();
    const port = await freePort();
    // The fake proxy WITHOUT the daemon preloads -- exactly what a pre-lock release
    // launched: daemon-shaped argv, no daemon.lock.
    const child = spawnChild(Deno.execPath(), {
      args: [
        ...denoRunArgs(),
        join(ROOT, "test", "copilot-api-fake.mjs"),
        "start",
        "--port",
        String(port),
      ],
      stdout: "null",
      stderr: "null",
    });
    try {
      // Controls: alive, holding NO lock, nothing tracked -- only the argv-signature sweep
      // (its scan simulated by the injected list, as in the listUntrackedOrphans tests
      // above) can reach it, and the holder stop must not fire at all.
      expect(pidAlive(child.pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(null);
      expect(new CopilotEnvRunState().read().pid).toBeUndefined();

      let scans = 0;
      await cleanupUnderLock(null, new CopilotEnvRunState(), () => {
        scans++;
        return Promise.resolve([child.pid]);
      });

      await child.status; // the sweep's SIGTERM (TerminateProcess on Windows) ends it
      expect(pidAlive(child.pid)).toBe(false);
      // The injected seam served all THREE sweep passes: the plan's enumeration, the
      // signal-boundary confirmation before TERM, and the survivor re-list before KILL.
      expect(scans).toBe(3);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// The signal-boundary confirmation is LOAD-BEARING, not a count: a pid the plan listed
// but a fresh scan no longer returns (exited and recycled between planning and the sweep
// -- the tracked/holder stops in between can take a whole grace) is never signalled. The
// bystander is deliberately NOT daemon-shaped and pidAlive alone would still pass, so
// only the fresh-scan intersect protects it.
test(
  "cleanupExistingProxies: a planned orphan a fresh scan no longer lists is not signalled",
  async () => {
    const home = tmpHome();
    const script = join(home, "bystander.ts");
    writeFileSync(script, "setInterval(() => {}, 60_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      stdout: "null",
      stderr: "null",
    });
    try {
      let scans = 0;
      // Scan 1 (the plan) lists the child; the confirmation scan comes back empty.
      await cleanupUnderLock(null, new CopilotEnvRunState(), () => {
        scans++;
        return Promise.resolve(scans === 1 ? [child.pid] : []);
      });

      // Never TERM'd (a signal would have ended the plain script), and the empty
      // confirmation also ended the sweep: no grace wait, no survivor pass.
      expect(pidAlive(child.pid)).toBe(true);
      expect(scans).toBe(2);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

test(
  "cleanupExistingProxies: the tracked-pid path still stops a tracked daemon and clears state",
  async () => {
    const home = tmpHome();
    const port = await freePort();
    const pid = launchFakeDaemon(home, port);
    try {
      expect(await until(20_000, () => daemonLockVerdict(home, pid) === "alive")).toBe(true);
      writeRunState({ pid, port });

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      expect(await until(5_000, () => !pidAlive(pid))).toBe(true);
      const after = new CopilotEnvRunState().read();
      expect(after.pid).toBeUndefined();
      expect(after.port).toBeUndefined(); // the default daemon releases its port on stop
    } finally {
      await killAndAwaitExit(pid);
    }
  },
  60_000,
);

test("cleanupExistingProxies: a lock-dead tracked pid is never signalled, and tracking clears", async () => {
  const home = tmpHome();
  // The tracked pid is OUR OWN live pid under a FREE lock naming it (the daemon that
  // wrote the marker died): neither the tracked stop nor the holder stop may signal it,
  // or this very test process would be killed here.
  mkdirSync(home, { recursive: true });
  writeFileSync(daemonLockPath(home), `${process.pid}\n${Date.now()}\n`);
  writeRunState({ pid: process.pid, port: 4141 });

  await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

  expect(new CopilotEnvRunState().read().pid).toBeUndefined();
});

test("cleanupExistingProxies: a lock THIS process holds is never signalled (self-guard)", async () => {
  const home = tmpHome();
  // Not a production shape (the CLI never holds a daemon lock), but the safety bias is
  // pinned: when the holder is ourselves, fall through to the preload's legible
  // two-daemons failure rather than signalling the running process.
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);
    // Still alive (this line runs) and still the holder.
    expect(daemonLockHolderPid(home)).toBe(process.pid);
  } finally {
    releaseFileLock(daemonLockPath(home));
  }
});

// Windows has no trappable SIGTERM (process.kill maps to TerminateProcess), so the
// TERM-survivor escalation branch is only reachable on POSIX. The holder scripts are
// spawned DAEMON-SHAPED (a copilot-api entry basename followed by `start`, the argv
// signature classifyDaemonPid confirms): an untracked holder is only ever signalled
// under that host-local corroboration.
test.skipIf(process.platform === "win32")(
  "cleanupExistingProxies: a holder that ignores SIGTERM draws the SIGKILL escalation, bound to the lock",
  async () => {
    const home = tmpHome();
    const ready = join(home, "ready");
    const holderScript = join(home, "copilot-api-holder.ts");
    // A daemon-shaped holder that swallows SIGTERM while keeping the lock -- the
    // escalation must fire on "still the holder after the grace", not on a bare
    // pid-liveness read.
    writeFileSync(
      holderScript,
      `import { acquireDaemonLockForLife } from ${
        importSpecifier(join(ROOT, "src", "scripts", "daemon_lock.ts"))
      };\n` +
        `if (!acquireDaemonLockForLife(${JSON.stringify(home)})) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => {});\n` +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // SIGTERM was ignored, so only the SIGKILL escalation explains the death -- and the
      // lock reads dead by pid afterwards (released by the OS at process death).
      expect(await until(5_000, () => !pidAlive(child.pid))).toBe(true);
      expect(await until(5_000, () => daemonLockVerdict(home, child.pid) === "dead")).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// The negative control for the escalation above: the SIGKILL must be bound to STILL
// HOLDING the lock, not to a bare pid-liveness read (which a recycled pid could satisfy).
// A holder that releases the lock on SIGTERM but stays alive past the grace draws no kill.
test.skipIf(process.platform === "win32")(
  "cleanupExistingProxies: a holder that releases the lock on SIGTERM but stays alive is NOT force-killed",
  async () => {
    const home = tmpHome();
    const ready = join(home, "ready");
    const holderScript = join(home, "copilot-api-holder.ts");
    writeFileSync(
      holderScript,
      `import { acquireDaemonLockForLife, daemonLockPath } from ${
        importSpecifier(join(ROOT, "src", "scripts", "daemon_lock.ts"))
      };\n` +
        `import { releaseFileLock } from ${
          importSpecifier(join(ROOT, "src", "utils", "file_lock.ts"))
        };\n` +
        `if (!acquireDaemonLockForLife(${JSON.stringify(home)})) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => releaseFileLock(daemonLockPath(${
          JSON.stringify(home)
        })));\n` +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // The lock is gone (the SIGTERM handler released it) but the process was left
      // alive: the escalation re-derived its proof and found no holder to kill.
      expect(daemonLockHolderPid(home)).toBe(null);
      expect(pidAlive(child.pid)).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// The shared-home hazard (in-design: a daemon home can sit on NFS/SMB, where run state
// stays per-host but the lock is one file): the lock is held by ANOTHER HOST's daemon,
// and its marker pid names whatever innocent local process carries that number. Without
// host-local corroboration the lock-bound escalation would GUARANTEE the wrong kill --
// the remote daemon keeps the lock held through the whole grace.
test(
  "cleanupExistingProxies: a held lock naming a local NON-daemon pid is never signalled (shared home)",
  async () => {
    const home = tmpHome();
    // The bystander: a live local process whose argv is nothing like a daemon.
    const script = join(home, "bystander.ts");
    writeFileSync(script, "setInterval(() => {}, 60_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      stdout: "null",
      stderr: "null",
    });
    // Stand-in for the remote host's daemon: THIS test process holds the lock, so it
    // stays held through the whole cleanup exactly like a remote holder would, while the
    // marker names the bystander's pid (which is what a foreign marker looks like here).
    expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
    try {
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      // Controls: the consult DOES name the bystander, and it is alive.
      expect(daemonLockHolderPid(home)).toBe(child.pid);
      expect(pidAlive(child.pid)).toBe(true);

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // Never signalled (a TERM would have ended the plain script), and the lock is
      // still held: a real start now fails legibly in the preload's lock acquisition.
      expect(pidAlive(child.pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);
    } finally {
      await killAndAwaitExit(child.pid);
      releaseFileLock(daemonLockPath(home));
    }
  },
  30_000,
);

// The TRACKED variant of the shared-home hazard: our daemon crashed leaving its state pid
// uncleared, the remote host's live daemon over the same home wrote the SAME pid number
// into the marker, and the local number was recycled onto an innocent process. The old
// tracked path signalled on the lock's "alive" verdict alone (run state only proves the
// pid was ours ONCE), which was guaranteed-wrong here; now the tracked lock-held case
// defers to the same corroborated holder stop.
test(
  "cleanupExistingProxies: stale tracking + a held lock naming a local NON-daemon pid is never signalled",
  async () => {
    const home = tmpHome();
    const script = join(home, "bystander.ts");
    writeFileSync(script, "setInterval(() => {}, 60_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      stdout: "null",
      stderr: "null",
    });
    expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
    try {
      writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
      writeRunState({ pid: child.pid, port: 4141 }); // the stale record naming the bystander
      // Control: this is exactly the old path's "alive" verdict (held + marker names the
      // tracked pid) -- the case that used to signal uncorroborated.
      expect(daemonLockVerdict(home, child.pid)).toBe("alive");

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // Never signalled, tracking cleared, lock still held: the start would then fail
      // legibly in the preload rather than kill the innocent local process.
      expect(pidAlive(child.pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);
      expect(new CopilotEnvRunState().read().pid).toBeUndefined();
    } finally {
      await killAndAwaitExit(child.pid);
      releaseFileLock(daemonLockPath(home));
    }
  },
  30_000,
);

test(
  "cleanupExistingProxies: an unreadable lock in ANOTHER home defers the holder stop (fail closed)",
  async () => {
    const home = tmpHome();
    const pid = launchFakeDaemon(home, await freePort());
    try {
      expect(await until(20_000, () => daemonLockVerdict(home, pid) === "alive")).toBe(true);
      // Another profile home whose lock state cannot be read: corroboration can no longer
      // prove the holder is not THAT home's daemon, so nothing may be signalled.
      mkdirSync(daemonLockPath(profileHome(WORK)), { recursive: true });

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      expect(pidAlive(pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(pid);

      // Control: with the other home readable again, the same start recovers as usual.
      rmSync(daemonLockPath(profileHome(WORK)), { recursive: true, force: true });
      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);
      expect(await until(5_000, () => !pidAlive(pid))).toBe(true);
    } finally {
      await killAndAwaitExit(pid);
    }
  },
  60_000,
);

// The escalation re-runs FULL corroboration at the deadline: a TERM survivor that BECOMES
// another home's lock holder during the grace no longer corroborates, so it draws no
// SIGKILL even though it still holds this home's lock and still looks like a daemon.
test.skipIf(process.platform === "win32")(
  "cleanupExistingProxies: a TERM survivor that acquires another home's lock mid-grace is NOT force-killed",
  async () => {
    const home = tmpHome();
    const workHome = profileHome(WORK);
    const ready = join(home, "ready");
    const holderScript = join(home, "copilot-api-holder.ts");
    writeFileSync(
      holderScript,
      `import { acquireDaemonLockForLife } from ${
        importSpecifier(join(ROOT, "src", "scripts", "daemon_lock.ts"))
      };\n` +
        `if (!acquireDaemonLockForLife(${JSON.stringify(home)})) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => {\n` +
        `  if (!acquireDaemonLockForLife(${
          JSON.stringify(workHome)
        }, { waitMs: 0 })) Deno.exit(1);\n` +
        `});\n` +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // Alive and holding BOTH locks: the TERM was corroborated and sent, then the
      // SIGKILL was refused once the pid read as another home's holder.
      expect(pidAlive(child.pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);
      expect(daemonLockHolderPid(workHome)).toBe(child.pid);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

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

// --- the floor-checked entry: gate-then-spawn ordered by data ----------------------------

test("spawnConfiguredDaemon demands ensureProxyFloor's evidence (compile-enforced)", () => {
  // Only ensureProxyFloor mints a FloorCheckedEntry, so a spawn from an entry the
  // gate never judged does not compile -- the float/floor-before-spawn ordering is
  // carried by the data, not by statement order in runStart.
  const plain: CopilotApiEntry = {
    kind: "package",
    specifier: "@jeffreycao/copilot-api",
    configFile: "deno.json",
  };
  // @ts-expect-error a plain resolved entry is not floor-checked evidence
  const gated: FloorCheckedEntry = plain;
  expect(gated).toBe(plain); // the brand is type-level only; no runtime shape exists
});

test("cleanupExistingProxies demands withStartLock's evidence (compile-enforced)", () => {
  // Only withStartLock mints a HeldStartLock, so an un-locked cleanup does not compile --
  // the lock-before-sweep ordering is carried by the data. The first parameter must BE the
  // evidence type EXACTLY: a widening (HeldStartLock | null) or a dropped parameter turns
  // `paramIsEvidence` into never and fails the typecheck.
  type FirstParam = Parameters<typeof cleanupExistingProxies>[0];
  const paramIsEvidence: FirstParam extends HeldStartLock
    ? HeldStartLock extends FirstParam ? true : never
    : never = true;
  const bare = { held: true } as const;
  // @ts-expect-error a bare { held: true } literal is not held-start-lock evidence
  const held: HeldStartLock = bare;
  expect(held).toBe(bare); // the brand is type-level only; no runtime shape exists
  expect(paramIsEvidence).toBe(true);
});
