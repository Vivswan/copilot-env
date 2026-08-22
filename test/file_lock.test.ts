import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reclaimStaleLock, releaseFileLock, tryAcquireFileLock } from "../src/utils/file_lock.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { removeDir, tmpDir } from "./helpers.ts";

// Direct tests of the shared lock's parameterization (staleMs, injected nowMs, marker
// format) and of the steal path's restore contract. The multi-process mutual-exclusion
// proof lives in config_lock.test.ts; here each judgment is exercised deterministically
// (probes use an injected clock or staleMs=Infinity, so a suspended test process can
// never age a lock mid-test).

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});
function tmp(name: string): string {
  dir = tmpDir("copilot-env-file-lock-");
  return join(dir, name);
}

const DEAD_PID = 2_147_483_646; // never alive -> pidAlive() returns false
const marker = (pid: number, ts: number): string => `${pid}\n${ts}\n`;

test("acquire, contend against a fresh live holder, release, re-acquire", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false); // fresh + live
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 3_000 })).toBe(true);
});

test("a HELD lock's marker stays readable and deletable by path (the sidecar invariant)", () => {
  // The marker is the cross-version contract: other processes read it to judge the holder.
  // Holding the OS lock on the marker itself would break exactly that on Windows, where an
  // exclusive LockFileEx fails reads from every other handle -- so the lock lives on a
  // sidecar and this by-path read must work on every platform.
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe(marker(process.pid, 1_000));
  releaseFileLock(path);
});

test("staleMs is the age horizon, judged at the injected nowMs (strictly older steals)", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid, 1_000));
  // Exactly staleMs old is NOT stale (the judgment is a strict >).
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_000 })).toBe(false);
  // One millisecond past the horizon it is stolen.
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
});

test("staleMs=Infinity never age-steals a live holder, however old", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid, 1_000)); // ancient, but the holder is alive
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(false);
});

test("a dead holder is stolen even when recent, even under staleMs=Infinity", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(DEAD_PID, Date.now()));
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(true);
});

test("jsonMarker writes the JSON {pid,ts} contract, and both formats are read", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000, jsonMarker: true })).toBe(true);
  // The on-disk form is the pre-unification autoupdate contract (old readers parse it).
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: process.pid, ts: 1_000 });
  // A live fresh JSON lock blocks a native-format contender ...
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false);
  // ... the same age horizon applies to it ...
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
  releaseFileLock(path);
  // ... and a native lock blocks a JSON-format contender.
  writeFileSync(path, marker(process.pid, 1_000));
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000, jsonMarker: true })).toBe(false);
});

test("a JSON marker with a non-finite ts is malformed, not immortal", () => {
  const path = tmp("x.lock");
  // JSON.parse turns 1e999 into Infinity; it must read as stale, not as a lock that can
  // never age out.
  writeFileSync(path, `{"pid":${process.pid},"ts":1e999}`);
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
});

test("reclaimStaleLock restores a FRESH holder's lock instead of stealing it", () => {
  const path = tmp("x.lock");
  // The interleaving under test: we observed a stale marker, but before our rename a
  // fresh holder replaced the lock. The yanked marker no longer matches, so the
  // reclaim must put the fresh lock back untouched.
  const fresh = marker(process.pid, Date.now());
  writeFileSync(path, fresh);
  reclaimStaleLock(path, marker(DEAD_PID, 1_000));
  expect(readFileSync(path, "utf-8")).toBe(fresh); // restored byte-for-byte
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(false); // still held
  // No .steal.* remnant is left behind.
  expect(readdirSync(dir).filter((f) => f.includes(".steal."))).toEqual([]);
});

test("reclaimStaleLock removes the lock when it IS the stale marker we judged", () => {
  const path = tmp("x.lock");
  const stale = marker(DEAD_PID, 1_000);
  writeFileSync(path, stale);
  reclaimStaleLock(path, stale);
  expect(existsSync(path)).toBe(false);
});

test("release by a non-holder is refused (a successor's lock survives)", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid + 1, Date.now()));
  releaseFileLock(path);
  expect(existsSync(path)).toBe(true);
});

test("release by the holder works even when the marker's ts half is corrupted", () => {
  const path = tmp("x.lock");
  writeFileSync(path, `${process.pid}\ngarbage`);
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
});
