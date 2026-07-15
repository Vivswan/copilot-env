import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverCodexSessionRoots, readCodexSessions } from "../src/usage/codex_sessions.ts";

/** A Codex TokenUsage object: input INCLUDES cached; output includes reasoning. */
function usage(input: number, cached: number, output: number): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function rolloutLine(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMeta(
  timestamp: string,
  id: string,
  opts: { provider?: string; forkedFrom?: string } = {},
): string {
  return rolloutLine(timestamp, "session_meta", {
    id,
    session_id: id,
    timestamp,
    cwd: "/tmp",
    ...(opts.provider !== undefined ? { model_provider: opts.provider } : {}),
    ...(opts.forkedFrom !== undefined ? { forked_from_id: opts.forkedFrom } : {}),
  });
}

function turnContext(timestamp: string, model: string): string {
  return rolloutLine(timestamp, "turn_context", { turn_id: "t", model, cwd: "/tmp" });
}

function tokenCount(
  timestamp: string,
  total: Record<string, number>,
  last: Record<string, number>,
): string {
  return rolloutLine(timestamp, "event_msg", {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 1000 },
    rate_limits: null,
  });
}

/** Write one rollout file into `dir` with the canonical filename for `localDate`. */
function writeRollout(dir: string, localDate: string, id: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${localDate}T01-00-00-${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("readCodexSessions attributes turns to the model in effect and splits cached input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    // input 100 includes 40 cached -> input 60 / cacheRead 40.
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 40, 20), usage(100, 40, 20)),
    // Model switch mid-session; the day also rolls over in UTC.
    turnContext("2026-06-02T00:00:01.000Z", "gpt-5.6-mini"),
    tokenCount("2026-06-02T00:00:05.000Z", usage(300, 40, 50), usage(200, 0, 30)),
  ]);

  const byProvider = await readCodexSessions([root]);
  const report = byProvider.get("copilot-env");
  expect([...byProvider.keys()]).toEqual(["copilot-env"]);
  expect(report?.byModel.get("gpt-5.6")).toEqual({
    input: 60,
    output: 20,
    cacheRead: 40,
    cacheCreation: 0,
    events: 1,
  });
  expect(report?.byModel.get("gpt-5.6-mini")).toEqual({
    input: 200,
    output: 30,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  // Days come from the per-line UTC timestamps, not the file's date path.
  expect([...(report?.perDay.keys() ?? [])].sort()).toEqual(["2026-06-01", "2026-06-02"]);
  expect(report?.activeDays).toBe(2);
});

test("readCodexSessions groups sessions by model_provider (absent = default)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
  ]);
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T11:00:00.000Z", "bbb"),
    turnContext("2026-06-01T11:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T11:00:05.000Z", usage(20, 0, 2), usage(20, 0, 2)),
  ]);

  const byProvider = await readCodexSessions([root]);
  expect([...byProvider.keys()].sort()).toEqual(["copilot-env", "default"]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")?.input).toBe(10);
  expect(byProvider.get("default")?.byModel.get("gpt-5.6")?.input).toBe(20);
});

test("readCodexSessions does not double count a fork's copied prefix (parent scanned)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  const parentCounts = [
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-01T10:00:15.000Z", usage(250, 90, 25), usage(150, 90, 15)),
  ];
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    ...parentCounts,
  ]);
  // The fork batch-writes copies of the parent's items (fresh line timestamps,
  // identical payloads), then continues cumulatively with its own turn.
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
      provider: "copilot-env",
      forkedFrom: "aaa",
    }),
    turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T12:00:00.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-01T12:00:00.000Z", usage(250, 90, 25), usage(150, 90, 15)),
    turnContext("2026-06-01T12:00:00.100Z", "gpt-5.6"),
    tokenCount("2026-06-01T12:00:09.000Z", usage(450, 290, 45), usage(200, 200, 20)),
  ]);

  const byProvider = await readCodexSessions([root]);
  const m = byProvider.get("copilot-env")?.byModel.get("gpt-5.6");
  // Parent's two turns once each, plus the fork's own turn: never the copies.
  expect(m).toEqual({
    input: 100 + 60 + 0,
    output: 10 + 15 + 20,
    cacheRead: 0 + 90 + 200,
    cacheCreation: 0,
    events: 3,
  });
});

test("readCodexSessions falls back to the batch-write window when the parent is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
      provider: "copilot-env",
      forkedFrom: "gone",
    }),
    turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
    // Copied prefix: written within the batch window right after session_meta.
    tokenCount("2026-06-01T12:00:00.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-01T12:00:00.050Z", usage(250, 90, 25), usage(150, 90, 15)),
    // The fork's own turn lands well outside the window.
    tokenCount("2026-06-01T12:00:09.000Z", usage(450, 290, 45), usage(200, 200, 20)),
  ]);

  const byProvider = await readCodexSessions([root]);
  const m = byProvider.get("copilot-env")?.byModel.get("gpt-5.6");
  expect(m).toEqual({ input: 0, output: 20, cacheRead: 200, cacheCreation: 0, events: 1 });
});

test("readCodexSessions applies the sinceMs cutoff per event and skips old files by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  // Old file: skipped by its filename date + old mtime (never read).
  const oldFile = writeRollout(root, "2026-01-01", "old", [
    "this would fail to parse if it were read",
  ]);
  const oldMs = Date.parse("2026-01-01T02:00:00Z") / 1000;
  utimesSync(oldFile, oldMs, oldMs);
  // Resumed session: the filename carries the ORIGINAL start date, but recent
  // events were appended (fresh mtime), so it must still be read.
  writeRollout(root, "2026-01-02", "res", [
    sessionMeta("2026-01-02T10:00:00.000Z", "res", { provider: "copilot-env" }),
    turnContext("2026-01-02T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-01-02T10:00:05.000Z", usage(999, 0, 99), usage(999, 0, 99)),
    tokenCount("2026-06-03T09:00:05.000Z", usage(1049, 0, 104), usage(50, 0, 5)),
  ]);
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-03T10:00:05.000Z", usage(300, 0, 30), usage(200, 0, 20)),
  ]);

  const sinceMs = Date.parse("2026-06-02T00:00:00Z");
  const byProvider = await readCodexSessions([root], sinceMs);
  const m = byProvider.get("copilot-env")?.byModel.get("gpt-5.6");
  // aaa's second event plus the resumed session's recent event; nothing older.
  expect(m).toEqual({ input: 250, output: 25, cacheRead: 0, cacheCreation: 0, events: 2 });
});

test("readCodexSessions skips null-info counts, torn lines, and unnamed models default to unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    // No turn_context yet: the first count lands on the unknown bucket.
    tokenCount("2026-06-01T10:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
    // Rate-limit-only event: no info, never counted.
    rolloutLine("2026-06-01T10:00:06.000Z", "event_msg", { type: "token_count", info: null }),
    '{"timestamp":"2026-06-01T10:00:07.000Z","type":"event_msg","payload":{"type":"token_count"',
  ]);

  const byProvider = await readCodexSessions([root]);
  const report = byProvider.get("copilot-env");
  expect(report?.byModel.get("unknown")?.events).toBe(1);
  expect([...(report?.byModel.keys() ?? [])]).toEqual(["unknown"]);
});

test("readCodexSessions counts a session once when it exists both live and archived", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const live = join(dir, "sessions");
  const archived = join(dir, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  const lines = [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ];
  writeRollout(live, "2026-06-01", "aaa", lines);
  // The archived twin (same basename, compressed) must not double count.
  writeFileSync(
    join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
    Bun.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
  );

  const byProvider = await readCodexSessions([live, archived]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("readCodexSessions reads zstd-compressed archived rollouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "archived_sessions");
  mkdirSync(root, { recursive: true });
  const lines = [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ];
  writeFileSync(
    join(root, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
    Bun.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
  );

  const byProvider = await readCodexSessions([root]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")?.input).toBe(100);
});

test("discoverCodexSessionRoots dedupes farm symlinks by realpath", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const shared = join(dir, "dot-codex");
  mkdirSync(join(shared, "sessions"), { recursive: true });
  mkdirSync(join(shared, "archived_sessions"), { recursive: true });
  const farmHome = join(shared, "hosts", "some-host");
  mkdirSync(farmHome, { recursive: true });
  // Farm homes link their session dirs back into the shared home ("junction"
  // keeps this working on Windows; POSIX ignores the type argument).
  symlinkSync(join(shared, "sessions"), join(farmHome, "sessions"), "junction");

  const roots = discoverCodexSessionRoots([shared, farmHome]);
  expect(roots.sort()).toEqual([join(shared, "archived_sessions"), join(shared, "sessions")]);
});
