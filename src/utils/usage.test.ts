import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverUsageDbs, readUsage } from "./usage.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
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
