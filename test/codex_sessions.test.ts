import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { consola } from "consola";
import {
  discoverCodexSessionRoots,
  parseCodexTail,
  parseCodexWhole,
  readCodexSessions,
  walkCodexSessions,
} from "../src/usage/codex_sessions.ts";
import {
  dedupKey,
  emptyIndexStats,
  parseEveryCandidate,
  type Reconcile,
  type WalkedFile,
} from "../src/usage/contribution.ts";
import { errMessage } from "../src/utils/error.ts";
import { localDayKey } from "../src/utils/time.ts";
import { expect, test } from "./helpers/testing.ts";

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
    // Model switch mid-session, a full day later: distinct local days in any
    // runner timezone (a fall-back transition could stretch a day to 25h, but
    // these June dates avoid one).
    turnContext("2026-06-02T10:00:01.000Z", "gpt-5.6-mini"),
    tokenCount("2026-06-02T10:00:05.000Z", usage(300, 40, 50), usage(200, 0, 30)),
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
  // Days come from the per-line timestamps (local calendar days), not the
  // file's date path.
  expect([...(report?.perDay.keys() ?? [])].sort()).toEqual([
    localDayKey(Date.parse("2026-06-01T10:00:05.000Z")),
    localDayKey(Date.parse("2026-06-02T10:00:05.000Z")),
  ]);
  expect(report?.perDay.size).toBe(2);
});

test("readCodexSessions buckets by the user's local day, not the UTC day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-02", "aaa", [
    sessionMeta("2026-06-02T01:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-02T01:00:01.000Z", "gpt-5.6"),
    // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
    tokenCount("2026-06-02T01:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
  ]);

  // The zone is NAMED rather than pinned through process.env.TZ, so this runs on Windows
  // too (deno honors the TZ env var on unix only). Asserting the SAME event in two zones
  // is what keeps the teeth on every runner: a reader that ignored the zone -- or sliced
  // by UTC -- would have to return one key for both, and these two differ.
  const newYork = await readCodexSessions([root], undefined, "America/New_York");
  expect([...(newYork.get("copilot-env")?.perDay.keys() ?? [])]).toEqual(["2026-06-01"]);
  const utc = await readCodexSessions([root], undefined, "UTC");
  expect([...(utc.get("copilot-env")?.perDay.keys() ?? [])]).toEqual(["2026-06-02"]);
});

test("readCodexSessions keys rows by the canonical model spelling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    // Dashed claude id via turn_context folds into the dotted canonical row.
    turnContext("2026-06-01T10:00:01.000Z", "claude-opus-4-8"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(10, 0, 2), usage(10, 0, 2)),
    // A thread_settings_applied model switch canonicalizes the same way.
    rolloutLine("2026-06-01T10:01:00.000Z", "event_msg", {
      type: "thread_settings_applied",
      thread_settings: { model: "claude-haiku-4-5-20251001" },
    }),
    tokenCount("2026-06-01T10:01:05.000Z", usage(30, 0, 7), usage(20, 0, 5)),
  ]);

  const byProvider = await readCodexSessions([root]);
  const report = byProvider.get("copilot-env");
  expect(report?.byModel.get("claude-opus-4.8")?.events).toBe(1);
  expect(report?.byModel.get("claude-haiku-4.5")?.events).toBe(1);
  expect(report?.byModel.size).toBe(2);
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
    zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
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
    zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
  );

  const byProvider = await readCodexSessions([root]);
  // The whole row: decompression that mangled counts (not just the input column)
  // must fail here, and events pins that the archive was read exactly once.
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
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

/** The walk record for one file on disk, as a candidate. */
function walkedFile(path: string): WalkedFile {
  const { size, mtimeMs } = statSync(path);
  return { path, size, mtimeMs, candidate: true, resumable: !path.endsWith(".zst") };
}

test("parseCodexTail resumed from a prefix parse equals one whole parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const lines = [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env", forkedFrom: "p" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 40, 20), usage(100, 40, 20)),
    turnContext("2026-06-01T10:00:06.000Z", "claude-haiku-4-5-20251001"),
    tokenCount("2026-06-01T10:00:09.000Z", usage(300, 40, 50), usage(200, 0, 30)),
    tokenCount("2026-06-01T10:00:19.000Z", usage(500, 40, 70), usage(200, 0, 20)),
  ];
  const wholePath = writeRollout(join(dir, "whole"), "2026-06-01", "aaa", lines);
  const whole = parseCodexWhole(walkedFile(wholePath));
  expect(whole.contribution.events.length).toBe(3);
  // The contribution keeps the RAW ids (state and per event); the fold canonicalizes.
  expect(whole.contribution.state.model).toBe("claude-haiku-4-5-20251001");
  expect(whole.contribution.events.map((e) => e[2])).toEqual([
    "gpt-5.6",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-20251001",
  ]);

  // The same file written in two steps: parse the prefix, append, resume.
  const grownPath = writeRollout(join(dir, "grown"), "2026-06-01", "aaa", lines.slice(0, 3));
  const prefix = parseCodexWhole(walkedFile(grownPath));
  const priorSnapshot = JSON.stringify(prefix.contribution);
  appendFileSync(grownPath, `${lines.slice(3).join("\n")}\n`);
  const tail = parseCodexTail(walkedFile(grownPath), prefix.parsedThrough, prefix.contribution);
  expect(tail.contribution).toEqual(whole.contribution);
  expect(tail.parsedThrough).toBe(whole.parsedThrough);
  expect(tail.tailProbeHex).toBe(whole.tailProbeHex);
  // The prior the index handed over is untouched.
  expect(JSON.stringify(prefix.contribution)).toBe(priorSnapshot);
});

test("readCodexSessions counts an unterminated final line only once its LF lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  const file = writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
  ]);
  // A writer mid-line: the fragment is complete JSON but has no terminator yet.
  appendFileSync(file, tokenCount("2026-06-01T10:00:09.000Z", usage(30, 0, 3), usage(20, 0, 2)));
  const partial = await readCodexSessions([root]);
  expect(partial.get("copilot-env")?.byModel.get("gpt-5.6")?.events).toBe(1);

  appendFileSync(file, "\n");
  const complete = await readCodexSessions([root]);
  expect(complete.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 30,
    output: 3,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readCodexSessions ignores a needle that sits inside another line's content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    // A response item whose payload carries every needle as nested values,
    // token counts included: not an event_msg, so nothing may count.
    rolloutLine("2026-06-01T10:00:02.000Z", "response_item", {
      type: "custom_tool_call",
      name: "token_count",
      input: { type: "session_meta", "turn_context": "turn_context" },
      "thread_settings_applied": { info: { "last_token_usage": usage(999, 0, 999) } },
    }),
    tokenCount("2026-06-01T10:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
  ]);

  const byProvider = await readCodexSessions([root]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("readCodexSessions dedups a fork against its parent BEFORE the window filter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  const parentTurn = tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10));
  // Parent: its only turn is OUTSIDE the window (the file itself is fresh, so it is read).
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    parentTurn,
  ]);
  // Fork: the copied parent turn carries a fresh, IN-window line timestamp
  // and lands well after the batch-write window, so only the parent's hash
  // set can identify it as a copy.
  writeRollout(root, "2026-06-03", "bbb", [
    sessionMeta("2026-06-03T12:00:00.000Z", "bbb", { provider: "copilot-env", forkedFrom: "aaa" }),
    turnContext("2026-06-03T12:00:00.000Z", "gpt-5.6"),
    tokenCount("2026-06-03T12:00:09.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-03T12:00:19.000Z", usage(300, 0, 30), usage(200, 0, 20)),
  ]);

  const sinceMs = Date.parse("2026-06-02T00:00:00Z");
  const byProvider = await readCodexSessions([root], sinceMs);
  // Only the fork's own turn: the copied one was suppressed by a parent event
  // that itself never counted.
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 200,
    output: 20,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("walkCodexSessions reports every rollout with its candidacy verdict, in fold order", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const live = join(dir, "sessions");
  const archived = join(dir, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  const stale = writeRollout(live, "2026-01-01", "old", ["x"]);
  const oldMs = Date.parse("2026-01-01T02:00:00Z") / 1000;
  utimesSync(stale, oldMs, oldMs);
  const kept = writeRollout(live, "2026-06-01", "aaa", ["x"]);
  const twin = join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst");
  writeFileSync(twin, zstdCompressSync(Buffer.from("x\n")));
  const archivedOnly = join(archived, "rollout-2026-06-01T02-00-00-bbb.jsonl.zst");
  writeFileSync(archivedOnly, zstdCompressSync(Buffer.from("x\n")));
  writeFileSync(join(live, "notes.txt"), "not a rollout");

  const walked = walkCodexSessions([live, archived], Date.parse("2026-06-01T00:00:00Z"));
  expect(walked.map((f) => basename(f.path))).toEqual(
    [stale, kept, twin, archivedOnly].map((p) => basename(p)),
  );
  expect(walked.map((f) => [f.candidate, f.resumable])).toEqual([
    [false, true], // stale by name and mtime
    [true, true], // the live copy wins
    [false, false], // its compressed twin is demoted
    [true, false], // an archive without a live twin is parsed
  ]);
  const kept0 = walked[1]!;
  expect(kept0.size).toBe(statSync(kept).size);
  expect(kept0.mtimeMs).toBe(statSync(kept).mtimeMs);
});

/** Run `body` with stdout/stderr captured (consola routes through one of them); the
 *  consola level is raised so warnings are not self-silenced under the test runner. */
async function captureAllWrites(body: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    consola.level = 3;
    await body();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return written.join("");
}

// File symlinks need a privilege on Windows that CI runners do not always hold.
test.skipIf(Deno.build.os === "windows")(
  "walkCodexSessions warns about a rollout it cannot stat and leaves it out",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const root = join(dir, "sessions");
    const kept = writeRollout(root, "2026-06-01", "aaa", ["x"]);
    const dangling = join(root, "rollout-2026-06-01T02-00-00-bbb.jsonl");
    symlinkSync(join(dir, "gone.jsonl"), dangling, "file");

    let statError = "";
    try {
      statSync(dangling);
    } catch (e) {
      statError = errMessage(e);
    }

    let walked: WalkedFile[] = [];
    const output = await captureAllWrites(async () => {
      walked = walkCodexSessions([root], undefined);
    });
    expect(walked.map((f) => f.path)).toEqual([kept]);
    expect(output).toContain(`could not read ${dangling} (${statError}).`);
  },
);

test("readCodexSessions counts a token_count re-emitted within one file once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  const turn = tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10));
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    turn,
    // A resume re-emits the last count with a fresh line timestamp: same info.
    turn.replace("2026-06-01T10:00:05.000Z", "2026-06-01T11:00:05.000Z"),
    tokenCount("2026-06-01T11:00:09.000Z", usage(300, 0, 30), usage(200, 0, 20)),
  ]);

  const byProvider = await readCodexSessions([root]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 300,
    output: 30,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readCodexSessions keeps a fork's own early turn when its parent WAS scanned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ]);
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T12:00:00.000Z", "bbb", { provider: "copilot-env", forkedFrom: "aaa" }),
    turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
    // The copied prefix: identical info, dropped through the parent's hashes.
    tokenCount("2026-06-01T12:00:00.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    // A NEW turn inside the batch window: with the parent scanned, the
    // timestamp fallback must stay off and this counts.
    tokenCount("2026-06-01T12:00:01.000Z", usage(150, 0, 15), usage(50, 0, 5)),
  ]);

  const byProvider = await readCodexSessions([root]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 150,
    output: 15,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readCodexSessions treats a parent without any counts as unscanned for the fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
  ]);
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T12:00:00.000Z", "bbb", { provider: "copilot-env", forkedFrom: "aaa" }),
    turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
    // No parent hash set was registered (nothing to register), so the
    // batch-window fallback applies: inside the window drops, outside counts.
    tokenCount("2026-06-01T12:00:01.000Z", usage(100, 0, 10), usage(100, 0, 10)),
    tokenCount("2026-06-01T12:00:05.000Z", usage(300, 0, 30), usage(200, 0, 20)),
  ]);

  const byProvider = await readCodexSessions([root]);
  expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 200,
    output: 20,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("readCodexSessions under a NaN cutoff walks every file and counts nothing, as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  const old = writeRollout(root, "2026-01-01", "old", [
    sessionMeta("2026-01-01T10:00:00.000Z", "old", { provider: "copilot-env" }),
    turnContext("2026-01-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-01-01T10:00:05.000Z", usage(10, 0, 1), usage(10, 0, 1)),
  ]);
  const oldMs = Date.parse("2026-01-01T02:00:00Z") / 1000;
  utimesSync(old, oldMs, oldMs);

  // A NaN cutoff fails every comparison: no file is skipped, no event passes.
  expect(walkCodexSessions([root], Number.NaN).map((f) => f.candidate)).toEqual([true]);
  const byProvider = await readCodexSessions([root], Number.NaN);
  expect(byProvider.size).toBe(0);
});

/** A reconcile that parses every candidate whole and hands the records back REVERSED. */
const reversingReconcile: Reconcile = (_source, walked, parseWhole) => {
  const records = walked
    .filter((f) => f.candidate)
    .map((f) => ({ path: f.path, contribution: parseWhole(f).contribution }));
  return { records: records.reverse(), stats: emptyIndexStats() };
};

test("readCodexSessions folds in walk order whatever order the reconcile returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ]);
  // The copy lands outside the batch window, so only the parent's hashes (which
  // exist only if the parent was folded FIRST) can identify it.
  writeRollout(root, "2026-06-01", "bbb", [
    sessionMeta("2026-06-01T12:00:00.000Z", "bbb", { provider: "copilot-env", forkedFrom: "aaa" }),
    turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T12:00:09.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ]);

  const direct = await readCodexSessions([root]);
  const viaReconcile = await readCodexSessions([root], undefined, undefined, reversingReconcile);
  expect(viaReconcile.get("copilot-env")?.byModel.get("gpt-5.6")?.events).toBe(1);
  expect(viaReconcile).toEqual(direct);
});

test("readCodexSessions counts a root named twice once, with and without a reconcile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "sessions");
  writeRollout(root, "2026-06-01", "aaa", [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ]);

  expect(walkCodexSessions([root, root], undefined).length).toBe(1);
  const once = await readCodexSessions([root]);
  expect(once.get("copilot-env")?.byModel.get("gpt-5.6")?.events).toBe(1);
  expect(await readCodexSessions([root, root])).toEqual(once);
  expect(await readCodexSessions([root, root], undefined, undefined, reversingReconcile)).toEqual(
    once,
  );
});

test("parseEveryCandidate parses candidates only, and a failing one is warned about and counted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "archived_sessions");
  mkdirSync(root, { recursive: true });
  const good = join(root, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst");
  writeFileSync(good, zstdCompressSync(Buffer.from("x\n")));
  const corrupt = join(root, "rollout-2026-06-01T02-00-00-bbb.jsonl.zst");
  writeFileSync(corrupt, "not zstd at all");
  const walked = walkCodexSessions([root], undefined);
  walked.push({ ...walked[0]!, path: join(root, "never-parsed.jsonl"), candidate: false });

  let result: ReturnType<Reconcile> | undefined;
  const output = await captureAllWrites(async () => {
    result = parseEveryCandidate("codex", walked, parseCodexWhole, parseCodexTail);
  });
  expect(result?.records.map((r) => r.path)).toEqual([good]);
  expect(result?.stats).toEqual({
    ...emptyIndexStats(),
    filesSeen: 3,
    filesParsedWhole: 1,
    filesFailed: 1,
    bytesRead: statSync(good).size,
  });
  expect(output).toContain(`could not read ${corrupt} (`);
});

test("readCodexSessions reads a zstd archive that starts with a byte order mark, as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const root = join(dir, "archived_sessions");
  mkdirSync(root, { recursive: true });
  const lines = [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", usage(100, 0, 10), usage(100, 0, 10)),
  ];
  const text = Buffer.from(`\ufeff${lines.join("\n")}\n`);
  writeFileSync(join(root, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"), zstdCompressSync(text));
  // The uncompressed reader never stripped it: its first line stays unparseable
  // and the session lands on the default provider. Both behaviours are the old ones.
  const live = join(dir, "sessions");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "rollout-2026-06-01T01-00-00-bbb.jsonl"), text);

  const archived = await readCodexSessions([root]);
  expect([...archived.keys()]).toEqual(["copilot-env"]);
  expect(archived.get("copilot-env")?.byModel.get("gpt-5.6")?.events).toBe(1);
  const plain = await readCodexSessions([live]);
  expect([...plain.keys()]).toEqual(["default"]);
  expect(plain.get("default")?.byModel.get("gpt-5.6")?.events).toBe(1);
});

test("parseCodexWhole honours session_meta until an id is known, then ignores later ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const path = writeRollout(join(dir, "s"), "2026-06-01", "aaa", [
    // No id: the gate stays open, so the NEXT meta line still applies.
    rolloutLine("2026-06-01T10:00:00.000Z", "session_meta", { "model_provider": "first" }),
    tokenCount("2026-06-01T10:00:01.000Z", usage(1, 0, 1), usage(1, 0, 1)),
    sessionMeta("2026-06-01T10:00:02.000Z", "aaa", { provider: "second", forkedFrom: "p" }),
    tokenCount("2026-06-01T10:00:03.000Z", usage(2, 0, 2), usage(1, 0, 1)),
    // Id known: a third meta changes nothing.
    sessionMeta("2026-06-01T10:00:04.000Z", "zzz", { provider: "third" }),
    tokenCount("2026-06-01T10:00:05.000Z", usage(3, 0, 3), usage(1, 0, 1)),
  ]);
  const { contribution: { state, events } } = parseCodexWhole(walkedFile(path));
  expect(events.map((e) => e[1])).toEqual(["first", "second", "second"]);
  expect(state.provider).toBe("second");
  expect(state.sessionIdHash).toBe(dedupKey("aaa"));
  expect(state.forkedFromIdHash).toBe(dedupKey("p"));
  expect(state.metaTsMs).toBe(Date.parse("2026-06-01T10:00:02.000Z"));
});
