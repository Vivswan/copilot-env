import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverClaudeSessionRoots, readClaudeSessions } from "../src/usage/claude_sessions.ts";
import { localDayKey } from "../src/utils/time.ts";

/** One assistant transcript line; Claude's input_tokens EXCLUDES the cache buckets. */
function assistantLine(
  timestamp: string,
  model: string,
  id: string | undefined,
  usage: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    uuid: "u",
    sessionId: "s",
    message: { ...(id === undefined ? {} : { id }), model, role: "assistant", usage },
  });
}

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function writeTranscript(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("readClaudeSessions maps the four usage buckets and buckets by local day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20, 300, 40)),
    // A full day later: distinct local days in any runner timezone (a fall-back
    // transition could stretch a day to 25h, but these June dates avoid one).
    assistantLine("2026-06-02T10:00:01.000Z", "claude-fable-5", "msg_2", usage(5, 6, 0, 0)),
    // Dated Anthropic snapshot ids fold into the canonical (dotted) row.
    assistantLine("2026-06-02T10:00:02.000Z", "claude-haiku-4-5-20251001", "msg_3", usage(1, 2)),
  ]);

  const report = await readClaudeSessions([root]);
  // Rows are keyed canonically (dashed transcript ids become dotted).
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheCreation: 40,
    events: 1,
  });
  expect(report.byModel.get("claude-fable-5")?.events).toBe(1);
  expect(report.byModel.get("claude-haiku-4.5")?.events).toBe(1);
  expect([...report.perDay.keys()].sort()).toEqual([
    localDayKey(Date.parse("2026-06-01T10:00:00.000Z")),
    localDayKey(Date.parse("2026-06-02T10:00:01.000Z")),
  ]);
  expect(report.perDay.size).toBe(2);
});

test("readClaudeSessions buckets by the user's local day, not the UTC day (TZ-pinned)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
    assistantLine("2026-06-02T01:00:00.000Z", "claude-opus-4-8", "msg_1", usage(1, 2)),
  ]);

  // Bun ignores TZ assignments after a `delete process.env.TZ` (verified), so
  // save/restore by explicit zone name and never delete.
  const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = "America/New_York";
    const report = await readClaudeSessions([root]);
    // A literal expectation on purpose: a regression back to UTC slicing would
    // key this "2026-06-02" and fail here even on a UTC CI runner.
    expect([...report.perDay.keys()]).toEqual(["2026-06-01"]);
  } finally {
    process.env.TZ = savedTz;
  }
});

test("readClaudeSessions books a streamed message at its final (max) usage snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    // Streaming writes one line per content block; the usage snapshot GROWS
    // (output_tokens rises toward the true final count, input side constant).
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 3, 300, 40)),
    // Snapshots can dip mid-stream (observed in real data); the booked value
    // must still end at the per-bucket max, never above it.
    assistantLine("2026-06-01T10:00:00.400Z", "claude-opus-4-8", "msg_1", usage(10, 9, 300, 40)),
    assistantLine("2026-06-01T10:00:00.500Z", "claude-opus-4-8", "msg_1", usage(10, 5, 300, 40)),
    assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", usage(10, 20, 300, 40)),
    // An exact repeat (resume copy) of the final snapshot adds nothing.
    assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", usage(10, 20, 300, 40)),
  ]);

  const report = await readClaudeSessions([root]);
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheCreation: 40,
    events: 1,
  });
});

test("readClaudeSessions counts a resume-copied message once across files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const proj = join(root, "-Users-x-proj");
  const copied = assistantLine(
    "2026-06-01T10:00:00.000Z",
    "claude-opus-4-8",
    "msg_1",
    usage(10, 20),
  );
  writeTranscript(proj, "aaa.jsonl", [copied]);
  // A resumed/forked session carries the old line into the new file.
  writeTranscript(proj, "bbb.jsonl", [
    copied,
    assistantLine("2026-06-01T11:00:00.000Z", "claude-opus-4-8", "msg_2", usage(1, 2)),
  ]);

  const report = await readClaudeSessions([root]);
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 11,
    output: 22,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readClaudeSessions finds nested subagent transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(
    join(root, "-Users-x-proj", "session-1", "subagents", "workflows", "wf_1"),
    "agent-abc.jsonl",
    [assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20))],
  );

  const report = await readClaudeSessions([root]);
  expect(report.byModel.get("claude-opus-4.8")?.events).toBe(1);
});

test("readClaudeSessions skips synthetic models, usage-less and torn lines; id-less lines count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "<synthetic>", "msg_1", usage(999, 999)),
    '{"type":"assistant","timestamp":"2026-06-01T10:00:01.000Z","message":{"model":"claude-opus-4-8","role":"assistant"}}',
    '{"type":"assistant","timestamp":"2026-06-01T10:00:02.000Z","message":{"model":"claude-opus-4-8"',
    assistantLine("2026-06-01T10:00:03.000Z", "claude-opus-4-8", undefined, usage(10, 20)),
    assistantLine("2026-06-01T10:00:04.000Z", "claude-opus-4-8", undefined, usage(10, 20)),
  ]);

  const report = await readClaudeSessions([root]);
  // Only the two id-less lines count (each unconditionally); nothing synthetic.
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 20,
    output: 40,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
  expect(report.byModel.has("<synthetic>")).toBe(false);
});

test("readClaudeSessions applies the sinceMs cutoff per event and skips stale files by mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const proj = join(root, "-Users-x-proj");
  // Stale file (old mtime): never read -- its valid in-window line must not count.
  const stale = writeTranscript(proj, "old.jsonl", [
    assistantLine("2026-06-03T09:00:00.000Z", "claude-opus-4-8", "msg_stale", usage(500, 500)),
  ]);
  const oldSec = Date.parse("2026-01-01T00:00:00Z") / 1000;
  utimesSync(stale, oldSec, oldSec);
  // Fresh-mtime file mixing old and new events: only the new one counts.
  writeTranscript(proj, "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(100, 100)),
    assistantLine("2026-06-03T10:00:00.000Z", "claude-opus-4-8", "msg_2", usage(10, 20)),
  ]);

  const sinceMs = Date.parse("2026-06-02T00:00:00Z");
  const report = await readClaudeSessions([root], sinceMs);
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("discoverClaudeSessionRoots returns existing projects dirs only, deduped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const home = join(dir, "dot-claude");
  mkdirSync(join(home, "projects"), { recursive: true });
  const missingHome = join(dir, "nope");

  const roots = discoverClaudeSessionRoots([home, home, missingHome]);
  expect(roots).toEqual([join(home, "projects")]);
});
