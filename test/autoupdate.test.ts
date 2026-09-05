import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDue } from "../src/autoupdate/due.ts";
import { withUpdateLockForTests } from "../src/autoupdate/lock.ts";
import { autoupdateDir, autoupdateStateFile } from "../src/autoupdate/paths.ts";
import { runPreflight } from "../src/autoupdate/preflight.ts";
import {
  AutoupdateState,
  DEFAULT_AUTOUPDATE_COOLDOWN_DAYS,
  effectiveUpdateCooldownDays,
} from "../src/autoupdate/state.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { commandExists } from "../src/utils/command.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { packageVersion } from "../src/utils/version.ts";
import { runSync } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, removeDir, tmpDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";
afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});
function tmp(name: string): string {
  dir = tmpDir("copilot-env-autoupdate-");
  return join(dir, name);
}

// --- autoupdate paths -------------------------------------------------------

test("autoupdate state lives at the TOP of a versioned root, never through the link", () => {
  // The state is machine state: written through `<top>/current` it would land
  // inside a version dir, and the next update's GC (or just the flip) would
  // silently drop the check record (and re-check the next day).
  const top = tmpDir("copilot-env-autoupdate-paths-");
  try {
    expect(autoupdateDir(top)).toBe(join(top, ".autoupdate")); // flat: in place
    mkdirSync(join(top, "versions", "v1.0.0"), { recursive: true });
    symlinkSync(join(top, "versions", "v1.0.0"), join(top, "current"), "junction");
    expect(autoupdateDir(join(top, "current"))).toBe(join(top, ".autoupdate"));
    expect(autoupdateStateFile(join(top, "current"))).toBe(
      join(top, ".autoupdate", "state.json"),
    );
    expect(autoupdateDir(top)).toBe(join(top, ".autoupdate")); // top spelling agrees
  } finally {
    removeDir(top);
  }
});

// --- AutoupdateState --------------------------------------------------------

test("AutoupdateState defaults to never-checked when absent", () => {
  const s = new AutoupdateState(tmp("state.json")).read();
  expect(s).toEqual({ lastCheckMs: 0, lastResult: "" });
});

test("AutoupdateState round-trips the check record and preserves unknown keys", () => {
  const path = tmp("state.json");
  writeFileSync(path, JSON.stringify({ keep: "me" }));
  const state = new AutoupdateState(path);
  state.set({ lastCheckMs: 1234, lastResult: "updated v1.2.3" });
  expect(new AutoupdateState(path).read()).toEqual({
    lastCheckMs: 1234,
    lastResult: "updated v1.2.3",
  });
  // Unknown keys survive the read-modify-write.
  expect(JSON.parse(readFileSync(path, "utf-8")).keep).toBe("me");
});

test("AutoupdateState coerces ill-typed fields back to safe defaults", () => {
  const path = tmp("state.json");
  // `cooldownDays` and `enabled` are legacy keys (pre-live-cooldown releases
  // snapshotted the first; the second became the auto-update config key); the
  // lenient schema simply ignores them.
  writeFileSync(
    path,
    JSON.stringify({ enabled: "yes", cooldownDays: 14, lastCheckMs: "soon", lastResult: 42 }),
  );
  expect(new AutoupdateState(path).read()).toEqual({
    lastCheckMs: 0, // non-number -> 0
    lastResult: "", // non-string -> ""
  });
});

function isolatedConfig(): CopilotEnvConfig {
  process.env.COPILOT_API_HOME = dir;
  return new CopilotEnvConfig();
}

// The preflight's gate is the key ALONE: off -> nothing, even when a check is due and
// the file still carries the pre-key `enabled: true`; on but not due -> nothing. (An
// on-and-due run would resolve releases over the network, so it is not driven here.)
test("runPreflight honors the auto-update key and ignores a legacy enabled field", async () => {
  const path = tmp("state.json");
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
  expect(config.read().autoUpdate).toBeUndefined();
  // On, checked a minute ago: not due, untouched.
  config.set({ autoUpdate: true });
  writeFileSync(path, JSON.stringify({ lastCheckMs: now - 60_000, lastResult: "up to date" }));
  await runPreflight({ nowMs: now, state: new AutoupdateState(path) });
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
    lastCheckMs: now - 60_000,
    lastResult: "up to date",
  });
  // On and DUE (the positive control): the release check runs against a stubbed GitHub
  // API whose newest release is the running version, so the due path records its result
  // without applying anything. Cooldown 0 so the stub's date needs no aging.
  config.set({ updateCooldown: 0 });
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
      lock: (nowMs, fn) => withUpdateLockForTests(join(dir, "update.lock"), nowMs, fn),
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
});

test("effectiveUpdateCooldownDays: the live update-cooldown config, else the 7-day default", () => {
  tmp("unused"); // creates an isolated dir; point the shared prefs store at it
  process.env.COPILOT_API_HOME = dir;
  expect(effectiveUpdateCooldownDays()).toBe(DEFAULT_AUTOUPDATE_COOLDOWN_DAYS); // unset -> default
  writeFileSync(join(dir, ".copilot-env-config.json"), JSON.stringify({ updateCooldown: 3 }));
  expect(effectiveUpdateCooldownDays()).toBe(3); // read live, never snapshotted
});

test("the next write drops a legacy enabled field and says so; the throttle state survives", () => {
  const path = tmp("state.json");
  writeFileSync(path, JSON.stringify({ enabled: true, lastCheckMs: 5, lastResult: "old" }));
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    new AutoupdateState(path).set({ lastResult: "up to date" });
    // A file without the field says nothing.
    new AutoupdateState(path).set({ lastCheckMs: 6 });
  } finally {
    process.stderr.write = original;
  }
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
    lastCheckMs: 6,
    lastResult: "up to date",
  });
  const joined = lines.join("");
  expect(joined).toContain(
    `Dropped the legacy autoupdate flag (the preference is the auto-update config key) -> ${path}`,
  );
  expect(joined.split("Dropped the legacy autoupdate flag").length - 1).toBe(1);
});

test("AutoupdateState writes a 0600 file (POSIX)", () => {
  const path = tmp("state.json");
  new AutoupdateState(path).set({ lastResult: "up to date" });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
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

// --- the launchers' preflight gate --------------------------------------------
// The gate ("only on `agent start`") is shell in bin/agent(.ps1), so each launcher is
// EXECUTED from a staged copy of the checkout against a fake `deno` that records every
// spawn: `env` (whose stdout the wrapper evals) must never reach the preflight.

/** Run the launcher for `sub` from a fresh fake checkout (its own temp dir, removed
 *  after); returns the fake deno's invocation log, one line per spawn. */
function launcherCalls(sub: string): string[] {
  const root = tmpDir("copilot-env-launcher-");
  try {
    // The staged checkout: the launcher, its bootstrap, the pin, the lockfile, and a
    // node_modules NEWER than the lockfile so the launcher installs nothing.
    // A space in the path: the launcher must quote it, and the log must still parse.
    const checkout = join(root, "check out");
    mkdirSync(join(checkout, "bin"), { recursive: true });
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    for (
      const rel of [
        "bin/agent",
        "bin/agent.ps1",
        "scripts/ensure-deno.sh",
        "scripts/ensure-deno.ps1",
        ".dvmrc",
        "deno.lock",
      ]
    ) {
      copyFileSync(join(PROJECT_ROOT, rel), join(checkout, rel));
    }
    chmodSync(join(checkout, "bin", "agent"), 0o755);
    mkdirSync(join(checkout, "node_modules"));
    const pin = readFileSync(join(checkout, ".dvmrc"), "utf8").trim();
    const home = join(root, "home");
    const bin = join(root, "fake-bin");
    const log = join(root, "deno-calls.log");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(
        join(bin, "deno.cmd"),
        `@echo off\r\nif "%1"=="--version" (echo deno ${pin}& exit /b 0)\r\necho %*>> "${log}"\r\nexit /b 0\r\n`,
      );
    } else {
      writeFileSync(
        join(bin, "deno"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "deno ${pin} (stable, release, x86_64-unknown-linux-gnu)"; exit 0; fi\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    // HOME is scratch so the bootstrap finds no pinned deno under ~/.deno to prefer;
    // PATH puts the fake first (the system dirs stay for sh/awk/find).
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DENO_INSTALL: undefined,
      PATH: process.platform === "win32"
        ? `${bin};${process.env.PATH ?? ""}`
        : `${bin}:/usr/bin:/bin`,
    };
    const result = process.platform === "win32"
      ? runSync("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(checkout, "bin", "agent.ps1"),
        sub,
      ], { env })
      : runSync("sh", [join(checkout, "bin", "agent"), sub], { env });
    if (result.exitCode !== 0) throw new Error(`launcher failed: ${result.stderr}`);
    // cmd's %* keeps the quotes a spaced path needs; strip them so both sides compare alike.
    return existsSync(log)
      ? readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.length > 0).map((l) =>
        l.replaceAll('"', "")
      )
      : [];
  } finally {
    removeDir(root);
  }
}

test.skipIf(process.platform === "win32" && !commandExists("powershell"))(
  "the launcher runs the autoupdate preflight before `agent start` only",
  () => {
    // Deps are staged fresh, so the launcher spawns nothing but the preflight and the CLI.
    const start = launcherCalls("start");
    expect(start).toHaveLength(2);
    expect(start[0]).toMatch(/autoupdate[\\/]preflight\.ts$/);
    expect(start[1]).toMatch(/src[\\/]cli\.ts start$/);
    const env = launcherCalls("env");
    expect(env).toHaveLength(1);
    expect(env[0]).toMatch(/src[\\/]cli\.ts env$/);
  },
);

// --- lock -------------------------------------------------------------------
// All through the TEST-ONLY path seam (withUpdateLockForTests): production
// withUpdateLock always locks autoupdateLockFile() under the install root, so
// pointing these at a temp dir any other way would mint HeldUpdateLock evidence
// against a lock that is not THE update lock.

const DEAD_PID = 2_147_483_646; // never alive -> pidAlive() returns false

test("withUpdateLock holds across fn, reports a nested acquire not-held, releases on exit", async () => {
  const path = tmp("update.lock");
  const now = 1_000_000;
  await withUpdateLockForTests(path, now, async (outer) => {
    expect(outer.held).toBe(true);
    expect(Object.isFrozen(outer)).toBe(true); // the evidence singleton is immutable
    expect(existsSync(path)).toBe(true);
    // A fresh lock held by this (alive) pid blocks a second acquire ...
    await withUpdateLockForTests(path, now, (inner) => {
      expect(inner.held).toBe(false);
      expect(Object.isFrozen(inner)).toBe(true);
    });
    // ... and the not-held scope must not have released the holder's lock.
    expect(existsSync(path)).toBe(true);
  });
  expect(existsSync(path)).toBe(false);
  // After release it can be acquired again.
  await withUpdateLockForTests(path, now, (again) => {
    expect(again.held).toBe(true);
  });
});

test("withUpdateLock steals a lock older than 30 minutes", async () => {
  const path = tmp("update.lock");
  const now = 100_000_000;
  writeFileSync(path, JSON.stringify({ pid: process.pid, ts: now - 31 * 60 * 1000 }));
  await withUpdateLockForTests(path, now, (outcome) => {
    expect(outcome.held).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
  });
});

test("withUpdateLock steals a lock owned by a dead pid even if recent", async () => {
  const path = tmp("update.lock");
  const now = 100_000_000;
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, ts: now }));
  await withUpdateLockForTests(path, now, (outcome) => expect(outcome.held).toBe(true));
});

test("withUpdateLock steals a malformed lock file", async () => {
  const path = tmp("update.lock");
  writeFileSync(path, "not json");
  await withUpdateLockForTests(path, 1_000, (outcome) => expect(outcome.held).toBe(true));
});

test("release leaves a lock a successor stole (marker no longer ours) in place", async () => {
  const path = tmp("update.lock");
  await withUpdateLockForTests(path, 1_000, (outcome) => {
    expect(outcome.held).toBe(true);
    // A successor stole our slot and now owns the lock under its own (alive) pid.
    writeFileSync(path, JSON.stringify({ pid: process.pid + 1, ts: 1_000 }));
  });
  expect(existsSync(path)).toBe(true); // not ours -> not deleted
});
