// A live daemon and its neighbours as fixtures: the credential resolution `agent start` runs, a
// real detached fake daemon over a home, the waits that bound themselves by the test deadline,
// and the shared-home stop refusal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import {
  daemonClientHeaders,
  DEFAULT_COPILOT_API_BASE,
} from "../../src/copilot_api/integration_identity.ts";
import {
  type DaemonLaunchAuth,
  type LaunchCredentialDeps,
  readLaunchToken,
  resolveLaunchCredential,
} from "../../src/copilot_api/launch.ts";
import type { DaemonCredential } from "../../src/copilot_api/process.ts";
import { launchDaemon } from "../../src/copilot_api/process.ts";
import type { Profile, ProfileName } from "../../src/copilot_api/profile.ts";
import { parseAbsolutePath } from "../../src/copilot_api/sidecar.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../../src/copilot_api/daemon_lock.ts";
import { releaseFileLock } from "../../src/utils/file_lock.ts";
import { pidAlive } from "../../src/utils/pid.ts";
import { writeRunState } from "./fixtures.ts";
import { denoRunArgs, ROOT, spawnChild } from "./run.ts";
import { testAbortSignal } from "./testing.ts";

/** `agent start`'s two credential steps as one call, the refusal gate and the resolution it feeds,
 *  so a decision table holds refusals and resolved credentials side by side (a refusal rejects). */
export async function launchAuth(
  profile: Profile,
  deps: LaunchCredentialDeps,
): Promise<DaemonLaunchAuth> {
  return await resolveLaunchCredential(
    profile,
    readLaunchToken(profile),
    new CopilotEnvConfig(),
    deps,
  );
}

/** Every daemon carries a credential and a host (a launch without one is refused); the fake proxy
 *  reads neither, so the spawn fixtures share one placeholder pair. */
export const FAKE_DAEMON_CREDENTIAL: DaemonCredential = {
  kind: "token",
  token: "gho_fake_daemon",
  clientHeaders: daemonClientHeaders("copilot-env-test/0", null),
};
export const FAKE_DAEMON_HOST = DEFAULT_COPILOT_API_BASE;

/** A real detached daemon over `home`, preloads included, so it takes the daemon.lock at boot like
 *  production. */
export function launchFakeDaemon(home: string, port: number): number {
  mkdirSync(home, { recursive: true });
  const logFile = join(home, "daemon.log");
  writeFileSync(logFile, "");
  return launchDaemon({
    port,
    logFile,
    home,
    env: {},
    credential: FAKE_DAEMON_CREDENTIAL,
    idleWatchdog: false,
    muteProxyLogs: false,
    copilotHost: FAKE_DAEMON_HOST,
    entry: {
      kind: "file",
      path: join(ROOT, "test", "copilot-api-fake.mjs"),
      configFile: join(ROOT, "deno.json"),
    },
    denoBin: parseAbsolutePath(Deno.execPath()),
  });
}

/**
 * Resolves once `probe` answers true. No clock of its own: the test deadline is the one budget.
 * A pending probe or sleep rejects the moment it fires, so a `finally` behind the wait runs before
 * the runner can exit; a sync probe already true is still answered after it, so an abandoned
 * body's `finally` finishes the cleanup it can.
 */
export async function until(probe: () => boolean | Promise<boolean>): Promise<void> {
  const signal = testAbortSignal();
  if (signal === undefined) throw new Error("until: no test deadline to bound the wait");
  for (;;) {
    const answer = probe();
    if (typeof answer === "boolean" ? answer : await unlessAborted(answer, signal)) return;
    await unlessAborted(new Promise((resolve) => setTimeout(resolve, 50)), signal);
  }
}

/** Settles as `pending` does, or rejects with the signal's reason the moment it aborts, probe and
 *  sleep alike: the runner exits once the last test settles, and a wait still pending then would
 *  miss its cleanup. */
function unlessAborted<T>(pending: T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(pending)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Returns once the pid is gone: a daemon outliving its test would hold the temp home open into
 *  removeDir. */
export async function killAndAwaitExit(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await until(() => !pidAlive(pid));
}

/**
 * The thrower mimics Deno's NotCapable (name "NotCapable", `code` undefined), what a permission set
 * without --allow-run really throws; test/pid.test.ts pins that shape. Inside `body` every
 * pidLiveness read is "unproven" and every signal fails as it does in the daemon.
 */
export async function withUnprovablePidProbe(body: () => Promise<void>): Promise<void> {
  const realKill = process.kill;
  process.kill = ((_pid: number, _signal?: string | number): true => {
    throw Object.assign(new Error("Requires run access to signal processes"), {
      name: "NotCapable",
    });
  }) as typeof process.kill;
  try {
    await body();
  } finally {
    process.kill = realKill;
  }
}

// --- the refused-stop fixture -------------------------------------------------------

interface RefusedStopFixture {
  /** The live local pid the marker and run state both name (never a daemon). */
  bystanderPid: number;
  teardown: () => Promise<void>;
}

/**
 * The shared-home stop refusal; `home` must be `profile`'s effective home under the current env.
 *   this process holds home's daemon.lock (the remote host's daemon) -> the lock reads alive
 *   marker and slot run state name a live local bystander            -> the pid is uncorroborated
 *   stopTrackedProxy refuses with tracking kept  -> { signalled: false, stopped: false }
 */
export function stageRefusedStop(home: string, profile?: ProfileName): RefusedStopFixture {
  mkdirSync(home, { recursive: true });
  const script = join(home, "bystander.ts");
  writeFileSync(script, "setInterval(() => {}, 60_000);\n");
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), script],
    stdout: "null",
    stderr: "null",
  });
  if (!acquireDaemonLockForLife(home, { waitMs: 0 })) {
    throw new Error(`could not hold ${home}'s daemon.lock for the refused-stop fixture`);
  }
  writeFileSync(daemonLockPath(home), `${child.pid}\n${Date.now()}\n`);
  writeRunState({ pid: child.pid, port: 4141 }, profile);
  return {
    bystanderPid: child.pid,
    teardown: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      // Our own lock first: the wait below can end with the deadline's error.
      releaseFileLock(daemonLockPath(home));
      await until(() => !pidAlive(child.pid));
    },
  };
}
