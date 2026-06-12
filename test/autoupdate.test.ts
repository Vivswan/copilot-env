import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDue, shouldRunPreflight } from "../src/autoupdate/due.ts";
import { acquireLock, releaseLock } from "../src/autoupdate/lock.ts";
import { AutoupdateState } from "../src/autoupdate/state.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
function tmp(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-env-autoupdate-"));
  return join(dir, name);
}

// --- AutoupdateState --------------------------------------------------------

test("AutoupdateState defaults to disabled with a 7-day cooldown when absent", () => {
  const s = new AutoupdateState(tmp("state.json")).read();
  expect(s).toEqual({ enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" });
});

test("AutoupdateState round-trips enable/cooldown/result and preserves unknown keys", () => {
  const path = tmp("state.json");
  writeFileSync(path, JSON.stringify({ keep: "me" }));
  const state = new AutoupdateState(path);
  state.set({ enabled: true, cooldownDays: 14, lastCheckMs: 1234, lastResult: "updated v1.2.3" });
  expect(new AutoupdateState(path).read()).toEqual({
    enabled: true,
    cooldownDays: 14,
    lastCheckMs: 1234,
    lastResult: "updated v1.2.3",
  });
  // Unknown keys survive the read-modify-write.
  expect(JSON.parse(readFileSync(path, "utf-8")).keep).toBe("me");
});

test("AutoupdateState disable flips enabled without clobbering cooldown", () => {
  const path = tmp("state.json");
  const state = new AutoupdateState(path);
  state.set({ enabled: true, cooldownDays: 3 });
  state.set({ enabled: false });
  expect(new AutoupdateState(path).read()).toMatchObject({ enabled: false, cooldownDays: 3 });
});

test("AutoupdateState coerces ill-typed fields back to safe defaults", () => {
  const path = tmp("state.json");
  writeFileSync(
    path,
    JSON.stringify({ enabled: "yes", cooldownDays: -5, lastCheckMs: "soon", lastResult: 42 }),
  );
  expect(new AutoupdateState(path).read()).toEqual({
    enabled: false, // only `true` enables
    cooldownDays: 7, // negative -> default
    lastCheckMs: 0, // non-number -> 0
    lastResult: "", // non-string -> ""
  });
});

test("AutoupdateState writes a 0600 file (POSIX)", () => {
  const path = tmp("state.json");
  new AutoupdateState(path).set({ enabled: true });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
});

// --- isDue / shouldRunPreflight (pure, nowMs injected) ----------------------

test("isDue is false under a day, true at/after a day", () => {
  const now = Date.parse("2026-06-10T00:00:00.000Z");
  expect(isDue(now - (MILLISECONDS_PER_DAY - 1), now)).toBe(false);
  expect(isDue(now - MILLISECONDS_PER_DAY, now)).toBe(true); // exactly a day
  expect(isDue(now - 2 * MILLISECONDS_PER_DAY, now)).toBe(true);
  expect(isDue(0, now)).toBe(true); // never checked
  expect(isDue(now + MILLISECONDS_PER_DAY, now)).toBe(true); // future timestamp can't wedge it
});

test("shouldRunPreflight runs only for `start`", () => {
  expect(shouldRunPreflight("start")).toBe(true);
  for (const a of ["env", "update", "stop", "health", "cost", "shell", "-h", "", undefined]) {
    expect(shouldRunPreflight(a)).toBe(false);
  }
});

// --- lock -------------------------------------------------------------------

const DEAD_PID = 2_147_483_646; // never alive -> pidAlive() returns false

test("acquireLock creates the lock, blocks a fresh second acquire, releases", () => {
  const path = tmp("update.lock");
  const now = 1_000_000;
  expect(acquireLock(now, path)).toBe(true);
  expect(existsSync(path)).toBe(true);
  // A fresh lock held by this (alive) pid blocks a second acquire.
  expect(acquireLock(now, path)).toBe(false);
  releaseLock(path);
  expect(existsSync(path)).toBe(false);
  // After release it can be acquired again.
  expect(acquireLock(now, path)).toBe(true);
});

test("acquireLock steals a lock older than 30 minutes", () => {
  const path = tmp("update.lock");
  const now = 100_000_000;
  writeFileSync(path, JSON.stringify({ pid: process.pid, ts: now - 31 * 60 * 1000 }));
  expect(acquireLock(now, path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
});

test("acquireLock steals a lock owned by a dead pid even if recent", () => {
  const path = tmp("update.lock");
  const now = 100_000_000;
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, ts: now }));
  expect(acquireLock(now, path)).toBe(true);
});

test("acquireLock steals a malformed lock file", () => {
  const path = tmp("update.lock");
  writeFileSync(path, "not json");
  expect(acquireLock(1_000, path)).toBe(true);
});

test("releaseLock leaves a lock owned by another (live) pid in place", () => {
  const path = tmp("update.lock");
  // A successor stole our slot and now owns the lock under its own (alive) pid.
  writeFileSync(path, JSON.stringify({ pid: process.pid + 1, ts: 1_000 }));
  releaseLock(path);
  expect(existsSync(path)).toBe(true); // not ours -> not deleted
});
