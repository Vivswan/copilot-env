import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
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
// The subcommand gate ("only on `agent start`") is shell in the launchers, not TS:
// bin/agent and bin/agent.ps1 run preflight.ts before cli.ts loads. Pin the gating
// lines as text so the two sides can't drift apart -- day-to-day commands
// (env/health/cost/...) must never trigger a self-update, and `agent env` (whose
// stdout the shell wrapper evals) must never be in scope.

test("bin/agent and bin/agent.ps1 gate the autoupdate preflight on the same subcommand", () => {
  const posix = readFileSync(join(PROJECT_ROOT, "bin", "agent"), "utf8");
  const ps = readFileSync(join(PROJECT_ROOT, "bin", "agent.ps1"), "utf8");

  // Each launcher gates on a first-arg comparison, and the preflight invocation
  // must sit INSIDE that gated block (matched to its closing `fi` / `}`), so
  // moving the call out from under the gate fails here too. Both sides are pinned
  // to the same literal ("start"), so one side changing its command word alone --
  // the drift this test exists to catch -- fails one of the word assertions.
  // The subcommand is the WHOLE gate: the preference is the `auto-update` config key
  // the preflight reads itself, so no file-exists conjunct may stand in for it (one
  // would skip the very first check after the key is set).
  const posixGate = posix.match(/^if \[ "\$\{1:-\}" = "([a-z-]+)" \]; then$[\s\S]*?^fi$/m);
  expect(posixGate).not.toBeNull(); // gate block not found at all (deleted/reformatted)
  expect(posixGate?.[1]).toBe("start");
  expect(posixGate?.[0]).toContain("src/autoupdate/preflight.ts");

  // $Sub is an intermediate, so pin its assignment too: it must be $args[0].
  expect(ps).toMatch(/^\$Sub = if \(\$args\.Count -gt 0\) \{ \$args\[0\] \}/m);
  const psGate = ps.match(/^if \(\$Sub -eq '([a-z-]+)'\) \{$[\s\S]*?^\}$/m);
  expect(psGate).not.toBeNull(); // gate block not found at all (deleted/reformatted)
  expect(psGate?.[1]).toBe("start");
  expect(psGate?.[0]).toContain("src\\autoupdate\\preflight.ts");
  for (const text of [posix, ps]) expect(text).not.toContain(".autoupdate");
});

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
