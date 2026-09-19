import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_LOCK_POLICY } from "../src/autoupdate/lock.ts";
import { runPreflight } from "../src/autoupdate/preflight.ts";
import {
  autoupdateDir,
  AutoupdateState,
  autoupdateStateFile,
  DEFAULT_AUTOUPDATE_COOLDOWN_DAYS,
  effectiveUpdateCooldownDays,
} from "../src/autoupdate/state.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { type LockOutcome, withFileLock } from "../src/utils/file_lock.ts";
import { isDue, MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { packageVersion } from "../src/utils/version.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot } from "./helpers/env.ts";

const restoreEnv = envSnapshot();
let dir = "";
afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});
function tmp(name: string): string {
  dir = tempDir("copilot-env-autoupdate-");
  return join(dir, name);
}

// --- autoupdate paths -------------------------------------------------------

test("autoupdate state lives at the TOP of a versioned root, never through the link", () => {
  // Machine state: written through `<top>/current` it would land inside a version dir, and the
  // next update's GC (or the flip) would silently drop the check record.
  const top = tempDir("copilot-env-autoupdate-paths-");
  try {
    expect(autoupdateDir(top)).toBe(join(top, ".autoupdate")); // flat: in place
    mkdirSync(join(top, "versions", "v1.0.0"), { recursive: true });
    symlinkSync(join(top, "versions", "v1.0.0"), join(top, "current"), "junction");
    expect(autoupdateDir(join(top, "current"))).toBe(join(top, ".autoupdate"));
    expect(autoupdateStateFile(join(top, "current"))).toBe(
      join(top, ".autoupdate", "autoupdate.json"),
    );
    expect(autoupdateDir(top)).toBe(join(top, ".autoupdate")); // top spelling agrees
  } finally {
    removeDir(top);
  }
});

// --- AutoupdateState --------------------------------------------------------

test("AutoupdateState reads a lenient 0600 record: absent and ill-typed fields default, unknown keys survive", () => {
  const rows: {
    name: string;
    seed?: Record<string, unknown>;
    set?: Parameters<AutoupdateState["set"]>[0];
    read: ReturnType<AutoupdateState["read"]>;
    raw?: Record<string, unknown>;
  }[] = [
    { name: "absent file", read: { lastCheckMs: 0, lastResult: "" } },
    {
      // `cooldownDays` and `enabled` are retired keys older state files still carry; the
      // lenient schema ignores them.
      name: "ill-typed fields",
      seed: { enabled: "yes", cooldownDays: 14, lastCheckMs: "soon", lastResult: 42 },
      read: { lastCheckMs: 0, lastResult: "" },
    },
    {
      name: "round-trip preserving unknown keys",
      seed: { keep: "me" },
      set: { lastCheckMs: 1234, lastResult: "updated v1.2.3" },
      read: { lastCheckMs: 1234, lastResult: "updated v1.2.3" },
      raw: { keep: "me", lastCheckMs: 1234, lastResult: "updated v1.2.3" },
    },
  ];
  for (const { name, seed, set, read, raw } of rows) {
    const path = tmp("autoupdate.json");
    if (seed) writeFileSync(path, JSON.stringify(seed));
    if (set) {
      new AutoupdateState(path).set(set);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777, name).toBe(0o600);
    }
    expect(new AutoupdateState(path).read(), name).toEqual(read);
    if (raw) expect(JSON.parse(readFileSync(path, "utf-8")), name).toEqual(raw);
    dir = removeDir(dir);
  }
});

function isolatedConfig(): CopilotEnvConfig {
  process.env.COPILOT_API_HOME = dir;
  return new CopilotEnvConfig();
}

// The preflight's gate is the key ALONE: off -> nothing, even when a check is due and the file
// still carries the pre-key `enabled: true`; on but not due -> nothing.
test("runPreflight honors the auto-update key and ignores a legacy enabled field", async () => {
  const path = tmp("autoupdate.json");
  const config = isolatedConfig();
  const now = Date.parse("2026-06-10T00:00:00.000Z");
  // Off (default), a check long due, the old flag still set: untouched, nothing run.
  writeFileSync(path, JSON.stringify({ enabled: true, lastCheckMs: 1, lastResult: "up to date" }));
  await runPreflight({ nowMs: now, state: new AutoupdateState(path) });
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
    enabled: true,
    lastCheckMs: 1,
    lastResult: "up to date",
  });
  expect(config.read().global["update.auto"]).toBeUndefined();
  // On, checked a minute ago: not due, untouched.
  config.set({ "update.auto": true });
  writeFileSync(path, JSON.stringify({ lastCheckMs: now - 60_000, lastResult: "up to date" }));
  await runPreflight({ nowMs: now, state: new AutoupdateState(path) });
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
    lastCheckMs: now - 60_000,
    lastResult: "up to date",
  });
  // On and DUE (the positive control): the release check runs against a stubbed GitHub
  // API whose newest release is the running version, so the due path records its result
  // without applying anything. Cooldown 0 so the stub's date needs no aging.
  config.set({ "update.cooldown": 0 });
  writeFileSync(path, JSON.stringify({ lastCheckMs: 1, lastResult: "old" }));
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
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
    // The lock seam keeps the run off the install root's real update lock.
    await runPreflight({
      nowMs: now,
      state: new AutoupdateState(path),
      lock: (nowMs, fn) =>
        withFileLock(join(dir, "update.lock"), { ...UPDATE_LOCK_POLICY, nowMs }, fn),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(urls.length).toBe(1);
  expect(urls[0]).toContain("/repos/Vivswan/copilot-env/releases");
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
    lastCheckMs: now,
    lastResult: "up to date",
  });
  // Due at the unlocked read, but a concurrent run completes its check between that read
  // and the lock acquire (staged by the lock seam): the under-lock recheck sees the fresh
  // record and neither fetches nor overwrites it.
  writeFileSync(path, JSON.stringify({ lastCheckMs: 1, lastResult: "old" }));
  const concurrent = { lastCheckMs: now - 1, lastResult: "updated v9.9.9" };
  globalThis.fetch = (() => {
    throw new Error("the under-lock recheck must not reach the network");
  }) as typeof fetch;
  try {
    await runPreflight({
      nowMs: now,
      state: new AutoupdateState(path),
      lock: (nowMs, fn) =>
        withFileLock(join(dir, "update.lock"), { ...UPDATE_LOCK_POLICY, nowMs }, (outcome) => {
          writeFileSync(path, JSON.stringify(concurrent));
          return fn(outcome);
        }),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(concurrent);
});

test("effectiveUpdateCooldownDays: the live update-cooldown config, else the 7-day default", () => {
  tmp("unused"); // creates an isolated dir; point the shared prefs store at it
  process.env.COPILOT_API_HOME = dir;
  expect(effectiveUpdateCooldownDays()).toBe(DEFAULT_AUTOUPDATE_COOLDOWN_DAYS); // unset -> default
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ global: { "update.cooldown": 3 } }),
  );
  expect(effectiveUpdateCooldownDays()).toBe(3); // read live, never snapshotted
});

// --- isDue (pure, nowMs injected) --------------------------------------------

test("isDue is false under a day, true at/after a day", () => {
  const now = Date.parse("2026-06-10T00:00:00.000Z");
  expect(isDue(now - (MILLISECONDS_PER_DAY - 1), now)).toBe(false);
  expect(isDue(now - MILLISECONDS_PER_DAY, now)).toBe(true); // exactly a day
  expect(isDue(now - 2 * MILLISECONDS_PER_DAY, now)).toBe(true);
  expect(isDue(0, now)).toBe(true); // never checked
  expect(isDue(now + MILLISECONDS_PER_DAY, now)).toBe(true); // future timestamp can't wedge it
});

// --- lock -------------------------------------------------------------------
// The update lock is the shared file lock under UPDATE_LOCK_POLICY at autoupdateLockFile(); these
// pin, at a hermetic path, the behaviours the preflight and `agent update` rely on.

const DEAD_PID = 2_147_483_646; // never alive -> pidAlive() returns false
const marker = (pid: number, ts: number): string => `${pid}\n${ts}\n`;
const lockAt = <T>(path: string, nowMs: number, fn: (outcome: LockOutcome) => T | Promise<T>) =>
  withFileLock(path, { ...UPDATE_LOCK_POLICY, nowMs }, fn);

test("the update lock holds across fn, reports a nested acquire not-held, releases on exit", async () => {
  const path = tmp("update.lock");
  const now = 1_000_000;
  await lockAt(path, now, async (outer) => {
    expect(outer.held).toBe(true);
    expect(existsSync(path)).toBe(true);
    // A fresh lock held by this (alive) pid blocks a second acquire ...
    await lockAt(path, now, (inner) => {
      expect(inner.held).toBe(false);
    });
    // ... and the not-held scope must not have released the holder's lock.
    expect(existsSync(path)).toBe(true);
  });
  expect(existsSync(path)).toBe(false);
  // After release it can be acquired again.
  await lockAt(path, now, (again) => {
    expect(again.held).toBe(true);
  });
});

test("the update lock takes over an aged, dead-owner, or malformed leftover; release spares a marker another pid wrote", async () => {
  const now = 100_000_000;
  const rows: {
    name: string;
    seed: string;
    // Runs inside the held scope; the successor row overwrites the marker there.
    inside?: (path: string) => void;
    leftBehind: boolean;
  }[] = [
    {
      name: "older than 30 minutes, holder alive",
      seed: marker(process.pid, now - 31 * 60 * 1000),
      leftBehind: false,
    },
    {
      name: "recent, holder dead",
      seed: marker(DEAD_PID, now),
      leftBehind: false,
    },
    { name: "malformed", seed: "garbage", leftBehind: false },
    {
      // Another pid's marker sits at the path at release time: not ours, so release must not
      // delete it.
      name: "another pid's marker at release",
      seed: marker(DEAD_PID, now),
      inside: (path) => writeFileSync(path, marker(process.pid + 1, now)),
      leftBehind: true,
    },
  ];
  for (const { name, seed, inside, leftBehind } of rows) {
    const path = tmp("update.lock");
    writeFileSync(path, seed);
    await lockAt(path, now, (outcome) => {
      expect(outcome.held, name).toBe(true);
      expect(readFileSync(path, "utf-8"), name).toBe(marker(process.pid, now));
      inside?.(path);
    });
    expect(existsSync(path), name).toBe(leftBehind);
    dir = removeDir(dir);
  }
});
