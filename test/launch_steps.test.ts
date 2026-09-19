import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errMessage } from "../src/utils/error.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import type { GlobalMapKey } from "../src/copilot_api/config_registry.ts";
import { CopilotEnvConfig, type GlobalPatch } from "../src/copilot_api/env_config.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  daemonClientHeaders,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  resetIntegrationIdentityCache,
  selectDirectIdentityAndHost,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import {
  applyDefaultConfig,
  awaitReadiness,
  daemonLifecycleEnv,
  resolveStartPort,
  withStartLock,
} from "../src/copilot_api/launch.ts";
import {
  type CleanupAction,
  cleanupExistingProxies,
  listUntrackedOrphans,
  lockProtectedDaemonPids,
  planCleanup,
  trackedDaemonPids,
} from "../src/copilot_api/launch_cleanup.ts";
import { classifyOwnedDaemonPid, isCopilotApiPid, pidAlive } from "../src/copilot_api/process.ts";
import { CopilotApiPaths, profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import {
  acquireDaemonLockForLife,
  daemonLockHolderPid,
  daemonLockPath,
  daemonLockVerdict,
} from "../src/copilot_api/daemon_lock.ts";
import { releaseFileLock } from "../src/utils/file_lock.ts";
import {
  CHILD_VALUES,
  childValuesEnv,
  denoRunArgs,
  importSpecifier,
  ROOT,
  spawnChild,
} from "./helpers/run.ts";
import { afterEach, describe, expect, removeDir, test } from "./helpers/testing.ts";
import { defaultHomeDir, envSnapshot, isolateProxyHome } from "./helpers/env.ts";
import { writeRunState } from "./helpers/fixtures.ts";
import {
  killAndAwaitExit,
  launchAuth,
  launchFakeDaemon,
  until,
  withUnprovablePidProbe,
} from "./helpers/daemon.ts";
import { captureAllWrites } from "./helpers/output.ts";
import { closeServer, freePort, listenEphemeral } from "./helpers/net.ts";

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

/** Returns the DEFAULT daemon's home, not the isolated root; `dir` (the root) owns cleanup. */
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

const UA = "codex_exec/1";

function probeSpy(id: string | null, apiBase = DEFAULT_COPILOT_API_BASE): {
  calls: Array<{ token: string | null; userAgent: string; pinned: string | null }>;
  resolve: typeof selectDirectIdentityAndHost;
} {
  const calls: Array<{ token: string | null; userAgent: string; pinned: string | null }> = [];
  return {
    calls,
    resolve: (token, userAgent, opts = {}) => {
      calls.push({ token, userAgent, pinned: opts.pinned ?? null });
      return Promise.resolve({ integrationId: id, apiBase });
    },
  };
}

async function withBusyPort<T>(run: (port: number) => Promise<T>): Promise<T> {
  const { server, port } = await listenEphemeral();
  try {
    return await run(port);
  } finally {
    await closeServer(server);
  }
}

// --- resolveLaunchCredential: the decision table -------------------------------------

test("resolveLaunchCredential: a stored PAT auto-enables passthrough and probes the identity under the daemon's User-Agent", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghp_stored_pat");
  const probe = probeSpy(COPILOT_CLI_INTEGRATION_ID);

  const result = (await launchAuth(null, {
    userAgent: UA,
    selectIdentity: probe.resolve,
  })).credential;

  expect(result).toEqual({
    kind: "pat",
    token: "ghp_stored_pat",
    clientHeaders: daemonClientHeaders(UA, COPILOT_CLI_INTEGRATION_ID),
  });
  expect(probe.calls).toEqual([{ token: "ghp_stored_pat", userAgent: UA, pinned: null }]);
  // The probe was the credential's landing: its pair is the slot's now, and the next launch reads
  // it back without a request.
  expect(new CopilotEnvState().readProfileDirectPair(null)).toEqual({
    integrationId: COPILOT_CLI_INTEGRATION_ID,
    host: DEFAULT_COPILOT_API_BASE,
  });
  const never = probeSpy("copilot-developer-sandbox");
  const replayed = await launchAuth(null, {
    userAgent: UA,
    selectIdentity: never.resolve,
  });
  expect(never.calls).toEqual([]);
  expect(replayed).toEqual({
    credential: {
      kind: "pat",
      token: "ghp_stored_pat",
      clientHeaders: daemonClientHeaders(UA, COPILOT_CLI_INTEGRATION_ID),
    },
    copilotHost: DEFAULT_COPILOT_API_BASE,
  });
  // A credential write takes the pair with it: the next launch probes again, and the daemon's host
  // is the selection's own, the host its identity was accepted on, forwarded, not assumed (the spy
  // names a host the launch would never pick on its own).
  new Credential().store("gh-token", "ghp_rotated_pat");
  const moved = probeSpy(COPILOT_CLI_INTEGRATION_ID, "https://api.enterprise.githubcopilot.com");
  const { copilotHost } = await launchAuth(null, {
    userAgent: UA,
    selectIdentity: moved.resolve,
  });
  expect(copilotHost).toBe("https://api.enterprise.githubcopilot.com");
  expect(new CopilotEnvState().readProfileDirectPair(null)?.host).toBe(
    "https://api.enterprise.githubcopilot.com",
  );
});

// One decision table over the single-step launches: (profile, stored credential, passthrough
// config, identity selector) -> the credential handed to the daemon, or the refusal, and the tokens
// probed. A wrong row is a PAT sent raw, a daemon under the wrong identity, or a probe (or a daemon)
// where no credential, or a profile that was never created, forbids one.
test("a daemon launch: the credential, refusal, and probe decision per stored credential and config", async () => {
  type Launched = Awaited<ReturnType<typeof launchAuth>>["credential"];
  const acceptingProbe = (): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const rows: Array<{
    name: string;
    profile: Profile;
    /** The DEFAULT slot's stored credential. */
    stored: { provider: "gh-token" | "copilot"; token: string } | null;
    passthrough?: "on" | "off";
    /** A spy answering this id, or the real selector over a probe fetch that accepts. */
    identity: { spy: string | null } | "real";
    /** The credential handed to the daemon, or the refusal (no daemon is spawned). */
    credential: Launched | { refused: string };
    probedTokens: string[];
  }> = [
    {
      // The daemon exchanges the token itself, and the codex identity (no id header) is what the
      // client-headers shim applies upstream: one identity per credential, passthrough or not.
      name: "copilot device-flow token: no passthrough, probed identity",
      profile: null,
      stored: { provider: "copilot", token: "gho_device_flow" },
      identity: { spy: null },
      credential: {
        kind: "token",
        token: "gho_device_flow",
        clientHeaders: daemonClientHeaders(UA, null),
      },
      probedTokens: ["gho_device_flow"],
    },
    {
      name: "passthrough off overrides even a PAT; the identity is selected all the same",
      profile: null,
      stored: { provider: "gh-token", token: "ghp_forced_off" },
      passthrough: "off",
      identity: { spy: COPILOT_CLI_INTEGRATION_ID },
      credential: {
        kind: "token",
        token: "ghp_forced_off",
        clientHeaders: daemonClientHeaders(UA, COPILOT_CLI_INTEGRATION_ID),
      },
      probedTokens: ["ghp_forced_off"],
    },
    {
      // The real selector: every credential is probed, and the codex identity is accepted first.
      name: "passthrough on forces the shim for a non-PAT token, probed like any credential",
      profile: null,
      stored: { provider: "gh-token", token: "ghu_user_to_server" },
      passthrough: "on",
      identity: "real",
      credential: {
        kind: "pat",
        token: "ghu_user_to_server",
        clientHeaders: daemonClientHeaders(UA, null),
      },
      probedTokens: [],
    },
    {
      // The daemon never logs in on its own: no credential is a refusal naming the login, on a
      // TTY or headless alike, before anything is probed or spawned.
      name: "nothing resolved: refused with the `agent auth` hint, nothing probed",
      profile: null,
      stored: null,
      identity: { spy: null },
      credential: {
        refused:
          "cannot start the proxy without a credential: no GitHub credential configured - run `agent auth` to log in",
      },
      probedTokens: [],
    },
    {
      // Hard-empty, not the default token: a named profile NEVER falls back to the default
      // credential, and one that was never created is named as such (not sent to `agent auth`).
      name: "a named profile never falls back to the default credential",
      profile: WORK,
      stored: { provider: "gh-token", token: "ghp_default_only" },
      identity: { spy: COPILOT_CLI_INTEGRATION_ID },
      credential: {
        refused: "no such profile 'work' (no profiles exist - create one with " +
          "`agent profile <name> add --direct|--proxy`)",
      },
      probedTokens: [],
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    resetIntegrationIdentityCache();
    setIntegrationProbeFetch(null);
    tmpHome();
    if (row.stored) new Credential().store(row.stored.provider, row.stored.token);
    if (row.passthrough) new CopilotEnvConfig().setProfile(null, { passthrough: row.passthrough });
    const probe = probeSpy(row.identity === "real" ? null : row.identity.spy);
    if (row.identity === "real") setIntegrationProbeFetch(acceptingProbe);

    const credential: Launched | { refused: string } = await launchAuth(row.profile, {
      userAgent: UA,
      ...(row.identity === "real" ? {} : { selectIdentity: probe.resolve }),
    }).then((auth) => auth.credential, (e: unknown) => ({ refused: errMessage(e) }));

    expect({ name: row.name, credential, probedTokens: probe.calls.map((c) => c.token) })
      .toEqual({
        name: row.name,
        credential: row.credential,
        probedTokens: row.probedTokens,
      });
    // Every probe runs under the daemon's User-Agent, unpinned.
    for (const call of probe.calls) {
      expect(call).toMatchObject({ userAgent: UA, pinned: null });
    }
  }
});

test("resolveLaunchCredential: a pinned integration-id reaches the probe as the pin", async () => {
  tmpHome();
  new Credential().store("gh-token", "ghp_pinned");
  new CopilotEnvConfig().setProfile(null, { identity: "copilot-developer-sandbox" });
  const probe = probeSpy("copilot-developer-sandbox");

  const result = (await launchAuth(null, {
    userAgent: UA,
    selectIdentity: probe.resolve,
  })).credential;

  expect(result).toEqual({
    kind: "pat",
    token: "ghp_pinned",
    clientHeaders: daemonClientHeaders(UA, "copilot-developer-sandbox"),
  });
  expect(probe.calls).toEqual([
    { token: "ghp_pinned", userAgent: UA, pinned: "copilot-developer-sandbox" },
  ]);
  // The probe ran under the pin, so only the host half is the probe's own answer and only it is
  // stored (landDirectPair's rule): the identity half stays unprobed for the day the pin clears.
  expect(new CopilotEnvState().readProfileDirectPair(null)).toEqual({
    host: DEFAULT_COPILOT_API_BASE,
  });
  // With both halves known (the pin, the stored host) nothing probes; the daemon sends the pin.
  const never = probeSpy(COPILOT_CLI_INTEGRATION_ID);
  const overlaid = (await launchAuth(null, {
    userAgent: UA,
    selectIdentity: never.resolve,
  })).credential;
  expect(never.calls).toEqual([]);
  expect(overlaid).toEqual({
    kind: "pat",
    token: "ghp_pinned",
    clientHeaders: daemonClientHeaders(UA, "copilot-developer-sandbox"),
  });
  // Clearing the pin leaves the identity half unprobed: the next launch selects again (under
  // `auto` the host is the selection's too) and stores what it probed.
  new CopilotEnvConfig().setProfile(null, { identity: "auto" });
  const probe2 = probeSpy(COPILOT_CLI_INTEGRATION_ID);
  const cleared = (await launchAuth(null, {
    userAgent: UA,
    selectIdentity: probe2.resolve,
  })).credential;
  expect(probe2.calls).toEqual([{ token: "ghp_pinned", userAgent: UA, pinned: null }]);
  expect(cleared).toEqual({
    kind: "pat",
    token: "ghp_pinned",
    clientHeaders: daemonClientHeaders(UA, COPILOT_CLI_INTEGRATION_ID),
  });
  expect(new CopilotEnvState().readProfileDirectPair(null)).toEqual({
    integrationId: COPILOT_CLI_INTEGRATION_ID,
    host: DEFAULT_COPILOT_API_BASE,
  });
});

test("resolveLaunchCredential: PAT + real probe -- the injected fetch's accepted identity wins", async () => {
  tmpHome();
  new Credential().store("gh-token", "github_pat_finegrained");
  // Mirrors the live endpoint: a PAT under the codex identity draws the 400 below, the CLI id is accepted.
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

  const result = (await launchAuth(null, {
    userAgent: UA,
  })).credential;

  expect(result).toEqual({
    kind: "pat",
    token: "github_pat_finegrained",
    clientHeaders: daemonClientHeaders(UA, COPILOT_CLI_INTEGRATION_ID),
  });
});

// --- the orphan-sweep exclusion set --------------------------------------------------

test("an UNPROVEN process scan skips the sweep and SAYS so; a proven-empty scan is silent", async () => {
  tmpHome();
  // A silent [] off a failed scan would read as a clean machine, so the skip must be said.
  const unproven = await captureAllWrites(async () => {
    expect(
      await listUntrackedOrphans(1, 2, new Set(), () => Promise.resolve("unproven" as const)),
    ).toEqual([]);
  });
  expect(unproven).toContain("Skipping the orphan sweep");
  expect(unproven).toContain("the process scan failed");
  // Control: a completed empty scan is silent.
  const provenEmpty = await captureAllWrites(async () => {
    expect(await listUntrackedOrphans(1, 2, new Set(), () => Promise.resolve([]))).toEqual([]);
  });
  expect(provenEmpty).not.toContain("Skipping the orphan sweep");
});

// The lock keep-signal reads every daemon home, default and profile alike: a daemon whose run-state
// tracking was lost is protected by its lock alone, so a home the scan skipped would let the sweep
// list it. This test process holds the lock, standing in for that daemon under an empty keep set.
test("a live daemon.lock holder in any daemon home is never listed for the sweep, whatever its argv", async () => {
  const home = tmpHome();
  const listPids = () => Promise.resolve([process.pid, 333]);
  // Acquiring creates the profile home dir, which is what profileHomeNames enumerates.
  for (const lockedHome of [home, profileHome(WORK)]) {
    expect(acquireDaemonLockForLife(lockedHome, { waitMs: 0 })).toBe(true);
    try {
      expect({ lockedHome, spares: lockProtectedDaemonPids() }).toEqual({
        lockedHome,
        spares: { kind: "pids", pids: new Set([process.pid]) },
      });
      expect(await listUntrackedOrphans(1, 2, new Set(), listPids), lockedHome).toEqual([333]);
    } finally {
      releaseFileLock(daemonLockPath(lockedHome));
    }
    // Control: with the lock released, the same pid IS sweepable again.
    expect(lockProtectedDaemonPids(), lockedHome).toEqual({ kind: "pids", pids: new Set() });
    expect(await listUntrackedOrphans(1, 2, new Set(), listPids), lockedHome).toEqual([
      process.pid,
      333,
    ]);
  }
});

// Two ways the lock probe fails to name a holder, one verdict: indeterminate, so the sweep lists
// nothing and the holder stop skips. Reading either as "nobody there" would sweep a protected daemon.
test("a lock probe that cannot name a holder reads indeterminate: the sweep lists nothing, the holder stop skips", async () => {
  const home = tmpHome();
  const listPids = () => Promise.resolve([333]);
  // Control: with no lock at all, 333 is sweepable.
  expect(await listUntrackedOrphans(1, 2, new Set(), listPids)).toEqual([333]);

  const rows: Array<{ name: string; arrange: () => void; restore: () => void }> = [
    {
      // A directory at the marker path: the probe's marker read fails with a non-ENOENT error,
      // so the home's lock state is "failed to look", not "nobody there".
      name: "unreadable marker",
      arrange: () => mkdirSync(daemonLockPath(home), { recursive: true }),
      restore: () => rmSync(daemonLockPath(home), { recursive: true, force: true }),
    },
    {
      // Hold the lock, then corrupt the marker: the OS lock proves SOMEONE lives, but no pid can
      // be named.
      name: "held lock whose marker names nobody",
      arrange: () => {
        expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
        writeFileSync(daemonLockPath(home), "not a marker\n");
        expect(daemonLockHolderPid(home)).toBe(null); // nobody NAMEABLE to signal
      },
      restore: () => releaseFileLock(daemonLockPath(home)),
    },
  ];
  for (const row of rows) {
    row.arrange();
    try {
      expect({ name: row.name, spares: lockProtectedDaemonPids() }).toEqual({
        name: row.name,
        spares: { kind: "indeterminate", home },
      });
      expect(await listUntrackedOrphans(1, 2, new Set(), listPids), row.name).toEqual([]);
      // The full cleanup neither signals anyone (the anonymous holder is us) nor throws.
      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);
    } finally {
      row.restore();
    }
  }
});

// The keep set spans the default daemon AND every profile's; a port-only reservation tracks no pid.
test("the exclusion set end-to-end: the default's and another profile's tracked daemons are not orphans", async () => {
  tmpHome();
  writeRunState({ pid: 111 });
  writeRunState({ pid: 222, port: 4242 }, WORK);
  writeRunState({ port: 4343 }, parseProfileName("portonly"));
  const listPids = () => Promise.resolve([111, 222, 333]);
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
// A live daemon.lock holder whose run state was lost is spared by the sweep and out of the
// tracked stop's reach, so the start cleanup stops THIS home's holder, tracked or not, but
// only when the owner-filtered process scan corroborates it as our daemon. On a shared
// (NFS/SMB) home the lock can be another host's daemon and its marker pid names an innocent
// local process; run state only proves a pid was ours once.
//   another home's holder   -> spared
//   uncorroborated holder   -> left; the preload's lock acquisition fails legibly

/** An inert machine-wide scan: no orphans, so only the tracked/holder stops can act. */
const NO_ORPHANS = (): Promise<number[]> => Promise.resolve([]);

function cleanupUnderLock(
  profile: Profile,
  state: CopilotEnvRunState,
  listPids?: (myPid: number, myPpid: number) => Promise<number[]>,
): Promise<void> {
  return withStartLock(() => cleanupExistingProxies(profile, state, listPids));
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
      await until(() => daemonLockVerdict(home, pid) === "alive");
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

// The corroboration exempts the RECORD this plan clears, never the pid: a second slot tracking
// the same pid still refuses the holder stop. A pid-equality exemption would pass here.
test(
  "planCleanup: a holder another slot ALSO tracks is refused, even with this slot's clear planned",
  async () => {
    const home = tmpHome();
    const pid = launchFakeDaemon(home, await freePort());
    try {
      await until(() => daemonLockVerdict(home, pid) === "alive");
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

// A lock-dead tracked pid (never signalled by the tracked stop) recycled onto a live lockless
// daemon must still reach the orphan sweep: the sweep's keep set is taken after this slot's
// clear, so the stale record cannot spare it.
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
      await until(() => isCopilotApiPid(child.pid));
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
      await until(() => daemonLockVerdict(home, oldPid) === "alive");
      // The lost-run-state premise: nothing tracked, so the tracked stop cannot reach the
      // holder and the sweep (inert here regardless) would only spare it.
      expect(new CopilotEnvRunState().read().pid).toBeUndefined();

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // The holder was stopped and its lock reads dead by pid -- genuinely released, not
      // merely unobserved.
      await until(() => !pidAlive(oldPid));
      await until(() => daemonLockVerdict(home, oldPid) === "dead");

      // And the recovery is real: a NEW daemon launches and re-acquires this home's lock
      // (what the preload's bounded acquisition does at every `agent start`).
      newPid = launchFakeDaemon(home, await freePort());
      const started = newPid;
      await until(() => daemonLockVerdict(home, started) === "alive");
      expect(daemonLockHolderPid(home)).toBe(started);
    } finally {
      // Nested: the first wait can end with the deadline's error, and neither daemon is the
      // harness's to kill.
      try {
        await killAndAwaitExit(oldPid);
      } finally {
        if (newPid !== null) await killAndAwaitExit(newPid);
      }
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
      await until(() => daemonLockVerdict(profileHome(WORK), workPid) === "alive");
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
      // Controls: alive, no lock, nothing tracked, so only the argv-signature sweep can reach it.
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

// A pid the plan listed but a fresh scan no longer returns (exited and recycled during the
// tracked/holder grace) is never signalled. The bystander is not daemon-shaped and pidAlive
// alone would pass it, so only the fresh-scan intersect protects it.
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
      await until(() => daemonLockVerdict(home, pid) === "alive");
      writeRunState({ pid, port });

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      await until(() => !pidAlive(pid));
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

// Windows has no trappable SIGTERM (process.kill maps to TerminateProcess), so the escalation
// tests below are POSIX-only. Their holder scripts are named copilot-api-* and given `start`:
// the argv signature classifyDaemonPid needs before an untracked holder is signalled.
const DAEMON_LOCK_SPECIFIER = importSpecifier(join(ROOT, "src", "copilot_api", "daemon_lock.ts"));

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
      `import { acquireDaemonLockForLife } from ${DAEMON_LOCK_SPECIFIER};\n` +
        `if (!acquireDaemonLockForLife(${CHILD_VALUES}.home)) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => {});\n` +
        `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      env: childValuesEnv({ home, ready }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
      expect(daemonLockHolderPid(home)).toBe(child.pid);

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // SIGTERM was ignored, so only the SIGKILL escalation explains the death -- and the
      // lock reads dead by pid afterwards (released by the OS at process death).
      await until(() => !pidAlive(child.pid));
      await until(() => daemonLockVerdict(home, child.pid) === "dead");
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// Negative control: the SIGKILL is bound to still holding the lock, not to pid liveness,
// which a recycled pid would satisfy.
test.skipIf(process.platform === "win32")(
  "cleanupExistingProxies: a holder that releases the lock on SIGTERM but stays alive is NOT force-killed",
  async () => {
    const home = tmpHome();
    const ready = join(home, "ready");
    const holderScript = join(home, "copilot-api-holder.ts");
    writeFileSync(
      holderScript,
      `import { acquireDaemonLockForLife, daemonLockPath } from ${DAEMON_LOCK_SPECIFIER};\n` +
        `import { releaseFileLock } from ${
          importSpecifier(join(ROOT, "src", "utils", "file_lock.ts"))
        };\n` +
        `if (!acquireDaemonLockForLife(${CHILD_VALUES}.home)) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => releaseFileLock(daemonLockPath(${CHILD_VALUES}.home)));\n` +
        `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      env: childValuesEnv({ home, ready }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
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

// Shared-home hazard (a daemon home can sit on NFS/SMB; run state is per-host, the lock is
// one file): another host's daemon holds the lock and its marker pid names an innocent local
// process. The remote holder keeps the lock through the whole grace, so a lock-bound
// escalation without host-local corroboration would kill the bystander every time.
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
    // This test process stands in for the remote daemon: it holds the lock through the whole
    // cleanup while the marker names the bystander's pid.
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
      // Our own lock first: the wait can end with the deadline's error.
      releaseFileLock(daemonLockPath(home));
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// The tracked variant: our daemon crashed with its state pid uncleared, the remote daemon's
// marker wrote the same number, and the local number was recycled onto an innocent process.
// Run state only proves the pid was ours once, so the lock's "alive" verdict alone must not
// authorize a signal.
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
      // Control: held lock + marker naming the tracked pid reads "alive", the verdict that must
      // not authorize a signal on its own.
      expect(daemonLockVerdict(home, child.pid)).toBe("alive");

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      // Never signalled, tracking cleared, lock still held: the start would then fail
      // legibly in the preload rather than kill the innocent local process.
      expect(pidAlive(child.pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(child.pid);
      expect(new CopilotEnvRunState().read().pid).toBeUndefined();
    } finally {
      // Our own lock first: the wait can end with the deadline's error.
      releaseFileLock(daemonLockPath(home));
      await killAndAwaitExit(child.pid);
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
      await until(() => daemonLockVerdict(home, pid) === "alive");
      // Another profile home whose lock state cannot be read: corroboration can no longer
      // prove the holder is not THAT home's daemon, so nothing may be signalled.
      mkdirSync(daemonLockPath(profileHome(WORK)), { recursive: true });

      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);

      expect(pidAlive(pid)).toBe(true);
      expect(daemonLockHolderPid(home)).toBe(pid);

      // Control: with the other home readable again, the same start recovers as usual.
      rmSync(daemonLockPath(profileHome(WORK)), { recursive: true, force: true });
      await cleanupUnderLock(null, new CopilotEnvRunState(), NO_ORPHANS);
      await until(() => !pidAlive(pid));
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
      `import { acquireDaemonLockForLife } from ${DAEMON_LOCK_SPECIFIER};\n` +
        `if (!acquireDaemonLockForLife(${CHILD_VALUES}.home)) Deno.exit(1);\n` +
        `Deno.addSignalListener("SIGTERM", () => {\n` +
        `  if (!acquireDaemonLockForLife(${CHILD_VALUES}.workHome, { waitMs: 0 })) Deno.exit(1);\n` +
        `});\n` +
        `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "locked");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), holderScript, "start"],
      env: childValuesEnv({ home, ready, workHome }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
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

// (config, requested port) -> the range error naming the fix. A wrong row is a start that silently
// picks a port outside the operator's range.
test("resolveStartPort: a port outside the configured range is a clear error, whichever side asks", async () => {
  const rows: Array<{ config: GlobalPatch; requested: number | undefined; error: string }> = [
    {
      config: { "daemon.min-port": 5000, "daemon.max-port": 4000 },
      requested: undefined,
      error:
        "invalid port range: daemon.min-port (5000) is greater than daemon.max-port (4000); fix it with " +
        "`agent config set daemon.min-port <n>` / `agent config set daemon.max-port <n>`.",
    },
    {
      config: { "daemon.min-port": 4000, "daemon.max-port": 5000 },
      requested: 3999,
      error: "requested port 3999 is out of range; the proxy port must be between 4000 and 5000 " +
        "(`agent config set daemon.min-port <n>` / `agent config set daemon.max-port <n>` change the range).",
    },
    {
      config: { "daemon.port": 1500, "daemon.min-port": 2000, "daemon.max-port": 3000 },
      requested: undefined,
      error: "configured port 1500 is outside the allowed range 2000-3000; run " +
        "`agent config set daemon.port <n>` within the range, or adjust daemon.min-port/daemon.max-port.",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    tmpHome();
    new CopilotEnvConfig().set(row.config);
    await expect(
      resolveStartPort(row.requested, false, null, false, new CopilotEnvConfig()),
    ).rejects.toThrow(row.error);
  }
});

// (pinned or configured default, busy or free, strict-port) -> the port used or the refusal. A wrong
// row moves a start off its pinned port, or auto-increments where the operator forbade it.
test("resolveStartPort: a pin is used or refused as-is; a busy default moves unless strict-port forbids it", async () => {
  const rows: Array<{
    name: string;
    pinned: boolean;
    busy: boolean;
    strict: boolean;
    outcome: "same" | "moved" | ((port: number) => string);
  }> = [
    { name: "pinned free port", pinned: true, busy: false, strict: false, outcome: "same" },
    {
      name: "pinned busy port",
      pinned: true,
      busy: true,
      strict: false,
      outcome: (busy) =>
        `requested port ${busy} is busy (held by another process). Free it or pick another --port.`,
    },
    {
      name: "busy default under strict-port",
      pinned: false,
      busy: true,
      strict: true,
      outcome: (busy) =>
        `port ${busy} is busy and auto-increment is disabled (\`daemon.strict-port\`); free it, pick another \`--port\`, or set \`agent config set daemon.strict-port false\`.`,
    },
    {
      name: "busy default without strict-port",
      pinned: false,
      busy: true,
      strict: false,
      outcome: "moved",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    tmpHome();
    const run = async (port: number): Promise<void> => {
      if (!row.pinned) {
        new CopilotEnvConfig().set({
          "daemon.port": port,
          ...(row.strict ? { "daemon.strict-port": true } : {}),
        });
      }
      const resolved = resolveStartPort(
        row.pinned ? port : undefined,
        false,
        null,
        false,
        new CopilotEnvConfig(),
      );
      if (typeof row.outcome === "function") {
        await expect(resolved).rejects.toThrow(row.outcome(port));
        return;
      }
      const chosen = await resolved;
      if (row.outcome === "same") {
        expect({ name: row.name, chosen }).toEqual({ name: row.name, chosen: port });
      } else {
        expect(chosen).not.toBe(port);
        expect(chosen).toBeGreaterThan(port);
      }
    };
    if (row.busy) await withBusyPort(run);
    else await run(await freePort());
  }
});

test("resolveStartPort: a named profile's reservation is honored, even after the range narrowed past it", async () => {
  tmpHome();
  const reserved = await freePort();
  expect(reserved).toBeGreaterThan(2048); // OS ephemeral ports sit far above the narrowed range
  writeRunState({ port: reserved }, WORK);
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
  // Out of range now: the reservation gets a liveness-only probe, no range check.
  new CopilotEnvConfig().set({ "daemon.min-port": 1024, "daemon.max-port": 2048 });
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
});

test("resolveStartPort: strict-port is DEFAULT-daemon-only -- a profile's busy reservation still moves", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    new CopilotEnvConfig().set({ "daemon.strict-port": true });
    writeRunState({ port: busy }, WORK);
    const resolved = await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig());
    expect(resolved).not.toBe(busy);
  });
});

// The reserve flag decides whether a profile's candidate is recorded: a peek that recorded would pin
// a port the start never used; a reservation that did not would lose the profile's stable port.
test("resolveStartPort: reserve=false peeks at a profile's candidate, reserve=true records it", async () => {
  tmpHome();
  // A one-port range keeps the candidate equal to the recorded reservation. The port must be free:
  // the scan clamps to the range, so a busy sole port throws (after reserve=true has already
  // persisted the candidate, so the throw leaves that record behind).
  const free = await freePort();
  // 4141 always seeds the scan's used set, so a pick colliding with it would exhaust the range.
  expect(free).not.toBe(4141);
  new CopilotEnvConfig().set({ "daemon.min-port": free, "daemon.max-port": free });
  for (const reserve of [false, true]) {
    const resolved = await resolveStartPort(
      undefined,
      false,
      WORK,
      reserve,
      new CopilotEnvConfig(),
    );
    expect({ reserve, resolved, recorded: CopilotEnvRunState.forProfile(WORK).read().port })
      .toEqual({
        reserve,
        resolved: free,
        recorded: reserve ? free : undefined,
      });
  }
});

// --- awaitReadiness: the EADDRINUSE bind race ------------------------------------------

function seedLog(home: string, content: string): string {
  const logFile = join(home, "start.log");
  writeFileSync(logFile, content);
  return logFile;
}

// (log content, pin, strict-port) -> the failure's own wording, and never a relaunch. A wrong row
// relaunches off a pinned port, or reports a lost bind race as a plain start failure.
test("awaitReadiness: a lost bind race under a pin or strict-port, or a dead daemon, fails in its own words and never relaunches", async () => {
  const rows: Array<{
    log: string;
    port: number;
    pinnedPort: number | undefined;
    strict: boolean;
    error: (logFile: string) => string;
  }> = [
    {
      log: "error: EADDRINUSE address already in use\n",
      port: 4545,
      pinnedPort: 4545,
      strict: false,
      error: (logFile) =>
        `port 4545 was taken by another process just before launch. See ${logFile}`,
    },
    {
      log: "EADDRINUSE\n",
      port: 4646,
      pinnedPort: undefined,
      strict: true,
      error: (logFile) =>
        `port 4646 was taken by another process just before launch (daemon.strict-port is on, so no auto-increment). See ${logFile}`,
    },
    {
      log: "Failed to get Copilot token: 403\n",
      port: 4747,
      pinnedPort: undefined,
      strict: false,
      error: (logFile) => `the proxy failed to start. See ${logFile}`,
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    const home = tmpHome();
    if (row.strict) new CopilotEnvConfig().set({ "daemon.strict-port": true });
    const logFile = seedLog(home, row.log);
    let relaunches = 0;
    await expect(
      awaitReadiness({
        pid: DEAD_PID,
        port: row.port,
        logFile,
        profile: null,
        pinnedPort: row.pinnedPort,
        state: new CopilotEnvRunState(),
        relaunch: () => {
          relaunches++;
          return DEAD_PID;
        },
        config: new CopilotEnvConfig(),
      }),
    ).rejects.toThrow(row.error(logFile));
    expect({ port: row.port, relaunches }).toEqual({ port: row.port, relaunches: 0 });
  }
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
  expect(state.read().pid).toBe(process.pid);
  expect(state.read().port).toBe(live.port);
  expect(readFileSync(logFile, "utf-8")).toContain("Listening on:");
});

// --- the unprovable-liveness posture (probe cannot run: every pid reads "unproven") ------

// Only a PROVEN death may enter the failed-to-start or bind-race branch (the real NotCapable
// probe shape is pinned in test/pid.test.ts). An unprovable read defers to the log's
// "Listening on:" verdict; reading it as dead threw "the proxy failed to start" over a live
// daemon and left it running untracked.
test(
  "awaitReadiness: an unprovable liveness read defers to the log's readiness verdict",
  async () => {
    const home = tmpHome();
    const logFile = seedLog(home, "Listening on: http://127.0.0.1\n");
    const state = new CopilotEnvRunState();
    await withUnprovablePidProbe(async () => {
      const live = await awaitReadiness({
        pid: process.pid,
        port: 4848,
        logFile,
        profile: null,
        pinnedPort: undefined,
        state,
        relaunch: () => {
          throw new Error("an unprovable read must never trigger the bind-race relaunch");
        },
        config: new CopilotEnvConfig(),
      });
      expect(live).toEqual({ pid: process.pid, port: 4848 });
    });
    // Recorded, so the daemon stays tracked and stoppable.
    expect(state.read().pid).toBe(process.pid);
    expect(state.read().port).toBe(4848);
  },
  30_000,
);

// The scan already corroborated the pid as a live daemon-shaped process, so only a PROVEN
// death drops it from the plan; a failed look keeps the scan's verdict.
test("planCleanup: an unprovable liveness read keeps a scanned orphan planned", async () => {
  const home = tmpHome();
  const listPids = (): Promise<number[] | "unproven"> => Promise.resolve([DEAD_PID]);
  // Control first: a runnable probe proves the scanned pid died since the scan -> dropped.
  expect(await planCleanup(home, null, new CopilotEnvRunState(), listPids)).toEqual([]);
  // Unprovable probe: the scan's verdict stands and the stop is planned (the execute
  // path re-proves against a fresh scan before any signal).
  await withUnprovablePidProbe(async () => {
    expect(await planCleanup(home, null, new CopilotEnvRunState(), listPids)).toEqual([
      { kind: "stop-orphan", pid: DEAD_PID },
    ]);
  });
});

// --- applyDefaultConfig: the pre-launch config.json projection --------------------------

function projectionFixture(): { paths: CopilotApiPaths; config: CopilotApiConfig } {
  tmpHome();
  const paths = new CopilotApiPaths();
  return { paths, config: new CopilotApiConfig(paths.configFile) };
}

test("applyDefaultConfig: a nested projection merges into contextManagement", () => {
  const { paths, config } = projectionFixture();
  new CopilotEnvConfig().set({ "proxy.responses.context-management": true });
  // A daemon-owned sibling and a top-level key copilot-env never projects: both must survive.
  config.save({
    contextManagement: { messages: true },
    useResponsesApiContextManagement: false,
  });

  applyDefaultConfig(null, paths);

  const doc = config.load();
  expect(doc.contextManagement).toEqual({ messages: true, responses: true });
  expect(doc.useResponsesApiContextManagement).toBe(false); // not ours: untouched
  expect(doc.smallModel).toBe("gpt-5-mini");
});

// Every opt-in key, nested or top-level: after --del the next apply clears its path and nothing
// else. A key the clearing missed would outlive the operator's unset.
test("applyDefaultConfig: --del of any opt-in key clears its path on the next apply", () => {
  const rows: Array<{
    key: GlobalMapKey;
    set: GlobalPatch;
    seed: Record<string, unknown>;
    projected: (doc: Record<string, unknown>) => unknown;
    afterSet: unknown;
    afterDel: unknown;
    /** A top-level key the clear must remove outright, not leave as undefined. */
    absentKey?: string;
  }> = [
    {
      key: "proxy.responses.context-management",
      set: { "proxy.responses.context-management": true },
      seed: { contextManagement: { messages: true } },
      projected: (doc) => doc.contextManagement,
      afterSet: { messages: true, responses: true },
      afterDel: { messages: true },
    },
    {
      key: "proxy.claude-token-multiplier",
      set: { "proxy.claude-token-multiplier": 1.3 },
      seed: {},
      projected: (doc) => doc.claudeTokenMultiplier,
      afterSet: 1.3,
      afterDel: undefined,
      absentKey: "claudeTokenMultiplier",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    const { paths, config } = projectionFixture();
    const envConfig = new CopilotEnvConfig();
    envConfig.set(row.set);
    config.save(row.seed);
    applyDefaultConfig(null, paths);
    expect({ key: row.key, value: row.projected(config.load()) }).toEqual({
      key: row.key,
      value: row.afterSet,
    });

    envConfig.del(row.key);
    applyDefaultConfig(null, paths);

    const doc = config.load();
    expect({ key: row.key, value: row.projected(doc) }).toEqual({
      key: row.key,
      value: row.afterDel,
    });
    if (row.absentKey !== undefined) expect(row.absentKey in doc).toBe(false);
    expect(doc.smallModel).toBe("gpt-5-mini");
  }
});

// The daemon's config.json is an output: a value at one of our opt-in paths is re-rendered from
// the store on every start, whoever wrote it, while the daemon's own sibling keys are left alone.
test("applyDefaultConfig: with the opt-in key unset, a value at its path is cleared and its siblings kept", () => {
  const { paths, config } = projectionFixture();
  config.save({
    contextManagement: { messages: false, responses: true },
    auth: { apiKeys: ["k"] },
  });

  applyDefaultConfig(null, paths);

  const doc = config.load();
  expect(doc.contextManagement).toEqual({ messages: false });
  expect(doc.auth).toMatchObject({ apiKeys: ["k"] });
});

test("applyDefaultConfig: a non-record in a nested path's way is replaced, not crashed on", () => {
  const { paths, config } = projectionFixture();
  new CopilotEnvConfig().set({ "proxy.responses.context-management": false });
  config.save({ contextManagement: "corrupt" });

  applyDefaultConfig(null, paths);

  expect(config.load().contextManagement).toEqual({ responses: false });
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

// --- unproven tracked-pid identity scans (the plan gate + the signal boundary) ----------
//
// A FAILED identity scan ("unknown") and a confirmed "no" both skip the courtesy SIGTERM, but
// the failed look is SAID (a warn naming the pid), never flattened into "proven not ours".
// Pinned at both sites: the plan gate and the signal-boundary re-check.

/** Not daemon-shaped: with the classifier injected it only needs to be alive, so a skipped
 *  SIGTERM shows as survival. */
function spawnInertChild(): Deno.ChildProcess {
  return spawnChild(Deno.execPath(), {
    args: ["eval", "setTimeout(() => {}, 60000)"],
    stdout: "null",
    stderr: "null",
  });
}

describe("unproven tracked-pid identity scans", () => {
  test(
    "classifyOwnedDaemonPid: confirms our daemon-shaped child, denies self and a dead pid",
    async () => {
      tmpHome();
      // The lockless daemon-shaped fake (argv signature, no daemon.lock) -- the shape
      // the courtesy stop's default classifier must confirm as OURS.
      const child = spawnChild(Deno.execPath(), {
        args: [...denoRunArgs(), join(ROOT, "test", "copilot-api-fake.mjs"), "start"],
        stdout: "null",
        stderr: "null",
      });
      try {
        await until(async () => (await classifyOwnedDaemonPid(child.pid)) === "yes");
        // Controls: a live NON-daemon (this test process) and a dead pid read "no".
        expect(await classifyOwnedDaemonPid(process.pid)).toBe("no");
        expect(await classifyOwnedDaemonPid(DEAD_PID)).toBe("no");
      } finally {
        await killAndAwaitExit(child.pid);
      }
    },
    30_000,
  );

  test("planCleanup: a FAILED scan skips the courtesy stop but SAYS so; the clear still lands", async () => {
    const home = tmpHome();
    writeRunState({ pid: DEAD_PID, port: 4141 });
    let plan: CleanupAction[] = [];
    const out = await captureAllWrites(async () => {
      plan = await planCleanup(
        home,
        null,
        new CopilotEnvRunState(),
        NO_ORPHANS,
        () => Promise.resolve("unknown" as const),
      );
    });
    // Fail-closed holds: no stop is planned. But the skip is said, naming the pid.
    expect(plan).toEqual([{ kind: "clear-tracking", pid: DEAD_PID }] satisfies CleanupAction[]);
    expect(out).toContain(`Skipping the tracked-pid stop (pid=${DEAD_PID})`);
    expect(out).toContain("could not prove its identity");
  });

  test("planCleanup controls: 'yes' plans the stop and 'no' skips -- both silently", async () => {
    const home = tmpHome();
    writeRunState({ pid: DEAD_PID, port: 4141 });
    let plan: CleanupAction[] = [];
    const confirmed = await captureAllWrites(async () => {
      plan = await planCleanup(
        home,
        null,
        new CopilotEnvRunState(),
        NO_ORPHANS,
        () => Promise.resolve("yes" as const),
      );
    });
    expect(plan).toEqual(
      [
        { kind: "stop-tracked", pid: DEAD_PID },
        { kind: "clear-tracking", pid: DEAD_PID },
      ] satisfies CleanupAction[],
    );
    expect(confirmed).not.toContain("Skipping the tracked-pid stop");

    const denied = await captureAllWrites(async () => {
      plan = await planCleanup(
        home,
        null,
        new CopilotEnvRunState(),
        NO_ORPHANS,
        () => Promise.resolve("no" as const),
      );
    });
    expect(plan).toEqual([{ kind: "clear-tracking", pid: DEAD_PID }] satisfies CleanupAction[]);
    expect(denied).not.toContain("Skipping the tracked-pid stop");
  });

  test(
    "cleanupExistingProxies: a scan that FAILS at the signal boundary skips the SIGTERM and says so",
    async () => {
      tmpHome();
      const child = spawnInertChild();
      try {
        writeRunState({ pid: child.pid, port: 4141 });
        // Plan-time the identity CONFIRMS (authorizing stop-tracked); the boundary
        // re-scan FAILS -- the fail-closed skip must hold there too, and be said.
        let calls = 0;
        const out = await captureAllWrites(() =>
          withStartLock(() =>
            cleanupExistingProxies(
              null,
              new CopilotEnvRunState(),
              NO_ORPHANS,
              () => Promise.resolve(++calls === 1 ? "yes" as const : "unknown" as const),
            )
          )
        );
        expect(calls).toBeGreaterThanOrEqual(2); // the boundary re-check really ran
        expect(out).toContain(`Skipping the tracked-pid stop (pid=${child.pid})`);
        expect(out).not.toContain("Stopping tracked proxy");
        expect(pidAlive(child.pid)).toBe(true); // never signalled
        expect(new CopilotEnvRunState().read().pid).toBeUndefined(); // the clear still landed
      } finally {
        await killAndAwaitExit(child.pid);
      }
    },
    30_000,
  );

  test(
    "cleanupExistingProxies control: a boundary scan that CONFIRMS still stops the daemon",
    async () => {
      tmpHome();
      const child = spawnInertChild();
      try {
        writeRunState({ pid: child.pid, port: 4141 });
        const out = await captureAllWrites(() =>
          withStartLock(() =>
            cleanupExistingProxies(
              null,
              new CopilotEnvRunState(),
              NO_ORPHANS,
              () => Promise.resolve("yes" as const),
            )
          )
        );
        expect(out).toContain(`Stopping tracked proxy (pid=${child.pid})`);
        expect(out).not.toContain("Skipping the tracked-pid stop");
        await until(() => !pidAlive(child.pid));
        expect(new CopilotEnvRunState().read().pid).toBeUndefined();
      } finally {
        await killAndAwaitExit(child.pid);
      }
    },
    30_000,
  );

  // Windows has no trappable SIGTERM (process.kill maps to TerminateProcess), so the
  // escalation branch this pins is only reachable on POSIX.
  test.skipIf(process.platform === "win32")(
    "cleanupExistingProxies hands ITS classifier to the SIGKILL escalation (one identity standard)",
    async () => {
      tmpHome();
      const ready = join(dir, "term-trap-ready");
      // A TERM-trapping child: only the escalation's SIGKILL can end it, and that kill
      // must re-prove identity through the SAME injected seam as the plan and the TERM.
      const child = spawnChild(Deno.execPath(), {
        args: [
          "eval",
          `Deno.addSignalListener("SIGTERM", () => {}); Deno.writeTextFileSync(${CHILD_VALUES}.ready, "r"); setTimeout(() => {}, 60000);`,
        ],
        env: childValuesEnv({ ready }),
        stdout: "null",
        stderr: "null",
      });
      try {
        await until(() => existsSync(ready));
        writeRunState({ pid: child.pid, port: 4141 });
        let calls = 0;
        await captureAllWrites(() =>
          withStartLock(() =>
            cleanupExistingProxies(null, new CopilotEnvRunState(), NO_ORPHANS, () => {
              calls += 1;
              return Promise.resolve("yes" as const);
            })
          )
        );
        // The seam saw the plan, the signal boundary, AND the escalation's re-proof --
        // an escalation judging through the owner-blind default would leave calls at 2.
        expect(calls).toBeGreaterThanOrEqual(3);
        await until(() => !pidAlive(child.pid)); // SIGKILLed
      } finally {
        await killAndAwaitExit(child.pid);
      }
    },
    30_000,
  );
});
