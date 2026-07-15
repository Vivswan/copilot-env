import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverUsageDbs, readUsage } from "../src/usage/usage.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    // bun:sqlite can briefly hold the DB file on Windows after close() (EBUSY),
    // so retry the cleanup; never let a temp-dir cleanup fail a passing test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // leaked temp dir is harmless on CI runners
    }
    dir = "";
  }
});

function seedUsageDb(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("claude-opus-4.8", 100, 50, 0, 0, 1, "2026-06-01T00:00:00Z");
  insert.run("claude-opus-4.8", 100, 50, 10, 0, 2, "2026-06-01T01:00:00Z");
  insert.run("gpt-5.5", 200, 0, 0, 0, 3, "2026-06-02T00:00:00Z");
  db.close();
}

test("readUsage sums tokens per model and counts distinct active days", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  const report = readUsage([path]);

  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 200,
    output: 100,
    cacheRead: 10,
    cacheCreation: 0,
    events: 2,
  });
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.activeDays).toBe(2);
});

test("readUsage exposes a per-day, per-model breakdown that reconciles with byModel", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  const report = readUsage([path]);

  // perDay keys are the distinct UTC days; size matches activeDays.
  expect([...report.perDay.keys()].sort()).toEqual(["2026-06-01", "2026-06-02"]);
  expect(report.perDay.size).toBe(report.activeDays);

  // 2026-06-01 carried both claude rows (100+100 input, 50+50 output, 0+10 cache read).
  expect(report.perDay.get("2026-06-01")?.get("claude-opus-4.8")).toEqual({
    input: 200,
    output: 100,
    cacheRead: 10,
    cacheCreation: 0,
    events: 2,
  });
  // 2026-06-02 carried only the gpt row.
  expect(report.perDay.get("2026-06-02")?.get("gpt-5.5")?.input).toBe(200);
  expect(report.perDay.get("2026-06-02")?.has("claude-opus-4.8")).toBe(false);
});

test("readUsage folds divergent spellings of one model into the canonical row", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  const db = new Database(path);
  db.run(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  // Anthropic dashed, Copilot dotted, and dated-snapshot ids of one model.
  insert.run("claude-opus-4-8", 1, 2, 0, 0, 1, "2026-06-01T00:00:00Z");
  insert.run("claude-opus-4.8", 10, 20, 0, 0, 2, "2026-06-01T01:00:00Z");
  insert.run("claude-opus-4-8-20260101", 100, 200, 0, 0, 3, "2026-06-01T02:00:00Z");
  db.close();

  const report = readUsage([path]);

  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 111,
    output: 222,
    cacheRead: 0,
    cacheCreation: 0,
    events: 3,
  });
  expect(report.byModel.size).toBe(1);
  expect(report.perDay.get("2026-06-01")?.get("claude-opus-4.8")?.events).toBe(3);
});

test("readUsage sums tokens by model and unions active days across two DBs", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const pathA = join(dir, "a.sqlite");
  const pathB = join(dir, "b.sqlite");
  seedUsageDb(pathA);

  // DB B shares the "claude-opus-4.8" model and the 2026-06-01 day with A, plus
  // a fresh model and a fresh day, so we can prove SUM (not overwrite) and a
  // UNION of distinct days (not a per-DB reset).
  const db = new Database(pathB);
  db.run(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("claude-opus-4.8", 5, 7, 1, 2, 10, "2026-06-01T12:00:00Z");
  insert.run("gemini-3.0", 9, 0, 0, 0, 11, "2026-06-03T00:00:00Z");
  db.close();

  const report = readUsage([pathA, pathB]);

  // claude-opus-4.8: A (200/100/10/0/2 events) summed with B (5/7/1/2/1 event).
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 205,
    output: 107,
    cacheRead: 11,
    cacheCreation: 2,
    events: 3,
  });
  // Models only in one DB carry through untouched.
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.byModel.get("gemini-3.0")?.input).toBe(9);
  // Distinct days: 2026-06-01 (both DBs), 2026-06-02 (A), 2026-06-03 (B) = 3.
  expect(report.activeDays).toBe(3);
});

test("readUsage sinceMs filters older rows from token totals and active days", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  // Seed rows live at created_at_ms 1, 2 (claude, 2026-06-01) and 3 (gpt,
  // 2026-06-02). sinceMs=3 keeps only the gpt row.
  const report = readUsage([path], 3);

  expect(report.byModel.has("claude-opus-4.8")).toBe(false);
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.byModel.get("gpt-5.5")?.events).toBe(1);
  // Only 2026-06-02 survives the cutoff.
  expect(report.activeDays).toBe(1);
});

test("readUsage skips a missing DB and still reports the readable ones", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const good = join(dir, "good.sqlite");
  const missing = join(dir, "does-not-exist.sqlite");
  seedUsageDb(good);

  const report = readUsage([missing, good]);

  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.activeDays).toBe(2);
});

test("readUsage skips a corrupt DB file without throwing", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const good = join(dir, "good.sqlite");
  const corrupt = join(dir, "corrupt.sqlite");
  seedUsageDb(good);
  // Not a valid SQLite file; opening/querying it must be caught and skipped.
  writeFileSync(corrupt, "this is not a sqlite database");

  const report = readUsage([corrupt, good]);

  // The good DB still contributes its full totals; the corrupt one is dropped.
  expect(report.byModel.get("claude-opus-4.8")?.input).toBe(200);
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.activeDays).toBe(2);
});

test("readUsage on an all-corrupt set returns an empty report, no throw", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const corrupt = join(dir, "corrupt.sqlite");
  writeFileSync(corrupt, "garbage");

  const report = readUsage([corrupt]);

  expect(report.byModel.size).toBe(0);
  expect(report.activeDays).toBe(0);
});

test("discoverUsageDbs finds the legacy file plus per-host DBs", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const legacy = join(dir, "copilot-api.sqlite");
  writeFileSync(legacy, "");

  const hostDir = join(dir, ".run", "host-a");
  mkdirSync(hostDir, { recursive: true });
  const hostDb = join(hostDir, "copilot-api.sqlite");
  writeFileSync(hostDb, "");

  const found = discoverUsageDbs(dir);

  expect(found).toContain(legacy);
  expect(found).toContain(hostDb);
  expect(found).toHaveLength(2);
});

test("discoverUsageDbs excludes a stray .run file and a host dir missing the sqlite", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));

  // A stray plain file sitting directly under .run/ (not a host directory).
  const runDir = join(dir, ".run");
  mkdirSync(runDir, { recursive: true });
  const strayFile = join(runDir, "stray.txt");
  writeFileSync(strayFile, "not a host dir");

  // A host directory that exists but has no copilot-api.sqlite inside it.
  const emptyHost = join(runDir, "host-empty");
  mkdirSync(emptyHost, { recursive: true });
  writeFileSync(join(emptyHost, "other.txt"), "no db here");

  // A real host directory that does carry the sqlite.
  const goodHost = join(runDir, "host-good");
  mkdirSync(goodHost, { recursive: true });
  const goodDb = join(goodHost, "copilot-api.sqlite");
  writeFileSync(goodDb, "");

  const found = discoverUsageDbs(dir);

  expect(found).toEqual([goodDb]);
  expect(found).not.toContain(strayFile);
});
