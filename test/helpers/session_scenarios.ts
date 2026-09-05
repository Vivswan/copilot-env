// The session-log reader fixtures, ONE catalog per source, so the reader tests and
// the index equivalence tests (three ways, same check) can never drift apart.
// Plain data and functions only (this is not a test file).
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { UsageReport } from "../../src/usage/usage.ts";
import { localDayKey } from "../../src/utils/time.ts";
import {
  assistantLine,
  claudeUsage,
  codexUsage,
  rolloutLine,
  sessionMeta,
  tokenCount,
  turnContext,
  writeRollout,
  writeTranscript,
} from "./session_fixtures.ts";
import { expect } from "./testing.ts";

/** What a reader is handed for one scenario. `files` lists the session files
 *  written, for tests that change one between two reads. */
export interface ReaderInput {
  roots: string[];
  sinceMs?: number;
  timeZone?: string;
  files?: string[];
}

export interface ReaderScenario<T> {
  name: string;
  build(dir: string): ReaderInput;
  check(report: T): void;
}

export type CodexReport = Map<string, UsageReport>;

export function scenarioNamed<T>(
  catalog: readonly ReaderScenario<T>[],
  name: string,
): ReaderScenario<T> {
  const found = catalog.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no scenario named ${JSON.stringify(name)}`);
  return found;
}

function ageFile(path: string, iso: string): void {
  const sec = Date.parse(iso) / 1000;
  utimesSync(path, sec, sec);
}

const JUNE_2 = Date.parse("2026-06-02T00:00:00Z");

const NO_CACHE_CREATION = { cacheCreation: 0 };

// ---------- Codex ----------

function gptRow(report: CodexReport) {
  return report.get("copilot-env")?.byModel.get("gpt-5.6");
}

export const CODEX_SCENARIOS: readonly ReaderScenario<CodexReport>[] = [
  {
    name: "attributes turns to the model in effect and splits cached input",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        // input 100 includes 40 cached -> input 60 / cacheRead 40.
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 40, 20), codexUsage(100, 40, 20)),
        // Model switch mid-session, a full day later: distinct local days in any
        // runner timezone (a fall-back transition could stretch a day to 25h, but
        // these June dates avoid one).
        turnContext("2026-06-02T10:00:01.000Z", "gpt-5.6-mini"),
        tokenCount("2026-06-02T10:00:05.000Z", codexUsage(300, 40, 50), codexUsage(200, 0, 30)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      const report = byProvider.get("copilot-env");
      expect([...byProvider.keys()]).toEqual(["copilot-env"]);
      expect(report?.byModel.get("gpt-5.6")).toEqual({
        input: 60,
        output: 20,
        cacheRead: 40,
        ...NO_CACHE_CREATION,
        events: 1,
      });
      expect(report?.byModel.get("gpt-5.6-mini")).toEqual({
        input: 200,
        output: 30,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
      // Days come from the per-line timestamps (local calendar days), not the
      // file's date path.
      expect([...(report?.perDay.keys() ?? [])].sort()).toEqual([
        localDayKey(Date.parse("2026-06-01T10:00:05.000Z")),
        localDayKey(Date.parse("2026-06-02T10:00:05.000Z")),
      ]);
      expect(report?.perDay.size).toBe(2);
    },
  },
  // The zone is NAMED rather than pinned through process.env.TZ, so this runs on
  // Windows too (deno honors the TZ env var on unix only). Asserting the SAME
  // event in two zones keeps the teeth on every runner: a reader that ignored the
  // zone, or sliced by UTC, would have to return one key for both, and these differ.
  ...[
    { zone: "America/New_York", day: "2026-06-01" },
    { zone: "UTC", day: "2026-06-02" },
  ].map(({ zone, day }): ReaderScenario<CodexReport> => ({
    name: `buckets by the user's local day in ${zone}, not the UTC day`,
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-02", "aaa", [
        sessionMeta("2026-06-02T01:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-02T01:00:01.000Z", "gpt-5.6"),
        // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
        tokenCount("2026-06-02T01:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      return { roots: [root], timeZone: zone };
    },
    check(byProvider) {
      expect([...(byProvider.get("copilot-env")?.perDay.keys() ?? [])]).toEqual([day]);
    },
  })),
  {
    name: "keys rows by the canonical model spelling",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        // Dashed claude id via turn_context folds into the dotted canonical row.
        turnContext("2026-06-01T10:00:01.000Z", "claude-opus-4-8"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 2), codexUsage(10, 0, 2)),
        // A thread_settings_applied model switch canonicalizes the same way.
        rolloutLine("2026-06-01T10:01:00.000Z", "event_msg", {
          type: "thread_settings_applied",
          "thread_settings": { model: "claude-haiku-4-5-20251001" },
        }),
        tokenCount("2026-06-01T10:01:05.000Z", codexUsage(30, 0, 7), codexUsage(20, 0, 5)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      const report = byProvider.get("copilot-env");
      expect(report?.byModel.get("claude-opus-4.8")?.events).toBe(1);
      expect(report?.byModel.get("claude-haiku-4.5")?.events).toBe(1);
      expect(report?.byModel.size).toBe(2);
    },
  },
  {
    name: "groups sessions by model_provider (absent = default)",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T11:00:00.000Z", "bbb"),
        turnContext("2026-06-01T11:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T11:00:05.000Z", codexUsage(20, 0, 2), codexUsage(20, 0, 2)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect([...byProvider.keys()].sort()).toEqual(["copilot-env", "default"]);
      expect(byProvider.get("copilot-env")?.byModel.get("gpt-5.6")?.input).toBe(10);
      expect(byProvider.get("default")?.byModel.get("gpt-5.6")?.input).toBe(20);
    },
  },
  {
    name: "does not double count a fork's copied prefix (parent scanned)",
    build(dir) {
      const root = join(dir, "sessions");
      const parentCounts = [
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T10:00:15.000Z", codexUsage(250, 90, 25), codexUsage(150, 90, 15)),
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
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(250, 90, 25), codexUsage(150, 90, 15)),
        turnContext("2026-06-01T12:00:00.100Z", "gpt-5.6"),
        tokenCount("2026-06-01T12:00:09.000Z", codexUsage(450, 290, 45), codexUsage(200, 200, 20)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      // Parent's two turns once each, plus the fork's own turn: never the copies.
      expect(gptRow(byProvider)).toEqual({
        input: 100 + 60 + 0,
        output: 10 + 15 + 20,
        cacheRead: 0 + 90 + 200,
        ...NO_CACHE_CREATION,
        events: 3,
      });
    },
  },
  {
    name: "falls back to the batch-write window when the parent is missing",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "gone",
        }),
        turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
        // Copied prefix: written within the batch window right after session_meta.
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T12:00:00.050Z", codexUsage(250, 90, 25), codexUsage(150, 90, 15)),
        // The fork's own turn lands well outside the window.
        tokenCount("2026-06-01T12:00:09.000Z", codexUsage(450, 290, 45), codexUsage(200, 200, 20)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 0,
        output: 20,
        cacheRead: 200,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "applies the sinceMs cutoff per event and skips old files by name",
    build(dir) {
      const root = join(dir, "sessions");
      // Old file: skipped by its filename date + old mtime (never read).
      const oldFile = writeRollout(root, "2026-01-01", "old", [
        "this would fail to parse if it were read",
      ]);
      ageFile(oldFile, "2026-01-01T02:00:00Z");
      // Resumed session: the filename carries the ORIGINAL start date, but recent
      // events were appended (fresh mtime), so it must still be read.
      writeRollout(root, "2026-01-02", "res", [
        sessionMeta("2026-01-02T10:00:00.000Z", "res", { provider: "copilot-env" }),
        turnContext("2026-01-02T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-01-02T10:00:05.000Z", codexUsage(999, 0, 99), codexUsage(999, 0, 99)),
        tokenCount("2026-06-03T09:00:05.000Z", codexUsage(1049, 0, 104), codexUsage(50, 0, 5)),
      ]);
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-03T10:00:05.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root], sinceMs: JUNE_2 };
    },
    check(byProvider) {
      // aaa's second event plus the resumed session's recent event; nothing older.
      expect(gptRow(byProvider)).toEqual({
        input: 250,
        output: 25,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
    },
  },
  {
    name: "skips null-info counts and torn lines; an unnamed model defaults to unknown",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        // No turn_context yet: the first count lands on the unknown bucket.
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
        // Rate-limit-only event: no info, never counted.
        rolloutLine("2026-06-01T10:00:06.000Z", "event_msg", { type: "token_count", info: null }),
        '{"timestamp":"2026-06-01T10:00:07.000Z","type":"event_msg","payload":{"type":"token_count"',
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      const report = byProvider.get("copilot-env");
      expect(report?.byModel.get("unknown")?.events).toBe(1);
      expect([...(report?.byModel.keys() ?? [])]).toEqual(["unknown"]);
    },
  },
  {
    name: "counts a session once when it exists both live and archived",
    build(dir) {
      const live = join(dir, "sessions");
      const archived = join(dir, "archived_sessions");
      mkdirSync(archived, { recursive: true });
      const lines = [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ];
      writeRollout(live, "2026-06-01", "aaa", lines);
      // The archived twin (same basename, compressed) must not double count.
      writeFileSync(
        join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
        zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
      );
      return { roots: [live, archived] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 100,
        output: 10,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "reads zstd-compressed archived rollouts",
    build(dir) {
      const root = join(dir, "archived_sessions");
      mkdirSync(root, { recursive: true });
      const lines = [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ];
      writeFileSync(
        join(root, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
        zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
      );
      return { roots: [root] };
    },
    check(byProvider) {
      // The whole row: decompression that mangled counts (not just the input column)
      // must fail here, and events pins that the archive was read exactly once.
      expect(gptRow(byProvider)).toEqual({
        input: 100,
        output: 10,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "does not count an unterminated final line",
    build(dir) {
      const root = join(dir, "sessions");
      const file = writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      // A writer mid-line: the fragment is complete JSON but has no terminator yet.
      appendFileSync(
        file,
        tokenCount("2026-06-01T10:00:09.000Z", codexUsage(30, 0, 3), codexUsage(20, 0, 2)),
      );
      return { roots: [root], files: [file] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)?.events).toBe(1);
    },
  },
  {
    name: "ignores a needle that sits inside another line's content",
    build(dir) {
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
          "thread_settings_applied": { info: { "last_token_usage": codexUsage(999, 0, 999) } },
        }),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 10,
        output: 1,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "dedups a fork against its parent BEFORE the window filter",
    build(dir) {
      const root = join(dir, "sessions");
      // Parent: its only turn is OUTSIDE the window (the file itself is fresh, so it is read).
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
      // Fork: the copied parent turn carries a fresh, IN-window line timestamp
      // and lands well after the batch-write window, so only the parent's hash
      // set can identify it as a copy.
      writeRollout(root, "2026-06-03", "bbb", [
        sessionMeta("2026-06-03T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "aaa",
        }),
        turnContext("2026-06-03T12:00:00.000Z", "gpt-5.6"),
        tokenCount("2026-06-03T12:00:09.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-03T12:00:19.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root], sinceMs: JUNE_2 };
    },
    check(byProvider) {
      // Only the fork's own turn: the copied one was suppressed by a parent event
      // that itself never counted.
      expect(gptRow(byProvider)).toEqual({
        input: 200,
        output: 20,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "counts a token_count re-emitted within one file once",
    build(dir) {
      const root = join(dir, "sessions");
      const turn = tokenCount(
        "2026-06-01T10:00:05.000Z",
        codexUsage(100, 0, 10),
        codexUsage(100, 0, 10),
      );
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        turn,
        // A resume re-emits the last count with a fresh line timestamp: same info.
        turn.replace("2026-06-01T10:00:05.000Z", "2026-06-01T11:00:05.000Z"),
        tokenCount("2026-06-01T11:00:09.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 300,
        output: 30,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
    },
  },
  {
    name: "keeps a fork's own early turn when its parent WAS scanned",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "aaa",
        }),
        turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
        // The copied prefix: identical info, dropped through the parent's hashes.
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        // A NEW turn inside the batch window: with the parent scanned, the
        // timestamp fallback must stay off and this counts.
        tokenCount("2026-06-01T12:00:01.000Z", codexUsage(150, 0, 15), codexUsage(50, 0, 5)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 150,
        output: 15,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
    },
  },
  {
    name: "treats a parent without any counts as unscanned for the fallback",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
      ]);
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "aaa",
        }),
        turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
        // No parent hash set was registered (nothing to register), so the
        // batch-window fallback applies: inside the window drops, outside counts.
        tokenCount("2026-06-01T12:00:01.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T12:00:05.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)).toEqual({
        input: 200,
        output: 20,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "identifies a fork's copy outside the batch window only through the parent's hashes",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
      // The copy lands outside the batch window, so only the parent's hashes (which
      // exist only if the parent was folded FIRST) can identify it.
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "aaa",
        }),
        turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T12:00:09.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
      return { roots: [root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)?.events).toBe(1);
    },
  },
  {
    name: "under a NaN cutoff counts nothing, as before",
    build(dir) {
      const root = join(dir, "sessions");
      const old = writeRollout(root, "2026-01-01", "old", [
        sessionMeta("2026-01-01T10:00:00.000Z", "old", { provider: "copilot-env" }),
        turnContext("2026-01-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-01-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      ageFile(old, "2026-01-01T02:00:00Z");
      // A NaN cutoff fails every comparison: no event passes.
      return { roots: [root], sinceMs: Number.NaN };
    },
    check(byProvider) {
      expect(byProvider.size).toBe(0);
    },
  },
  {
    name: "counts a root named twice once",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
      return { roots: [root, root] };
    },
    check(byProvider) {
      expect(gptRow(byProvider)?.events).toBe(1);
    },
  },
  // The archive path has always dropped a leading byte order mark, the plain
  // path never did: its first line stays unparseable and the session lands on the
  // default provider. Both behaviours are the old ones.
  {
    name: "reads a zstd archive that starts with a byte order mark, as before",
    build(dir) {
      const root = join(dir, "archived_sessions");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
        zstdCompressSync(bomRollout()),
      );
      return { roots: [root] };
    },
    check(byProvider) {
      expect([...byProvider.keys()]).toEqual(["copilot-env"]);
      expect(gptRow(byProvider)?.events).toBe(1);
    },
  },
  {
    name: "keeps a plain rollout's byte order mark, so its meta line fails as before",
    build(dir) {
      const live = join(dir, "sessions");
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "rollout-2026-06-01T01-00-00-bbb.jsonl"), bomRollout());
      return { roots: [live] };
    },
    check(byProvider) {
      expect([...byProvider.keys()]).toEqual(["default"]);
      expect(byProvider.get("default")?.byModel.get("gpt-5.6")?.events).toBe(1);
    },
  },
];

function bomRollout(): Buffer {
  const lines = [
    sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
    turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
    tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
  ];
  return Buffer.from(`\ufeff${lines.join("\n")}\n`);
}

// ---------- Claude ----------

function opusRow(report: UsageReport) {
  return report.byModel.get("claude-opus-4.8");
}

export const CLAUDE_SCENARIOS: readonly ReaderScenario<UsageReport>[] = [
  {
    name: "maps the four usage buckets and buckets by local day",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        '{"type":"user","message":{"role":"user","content":"hi"}}',
        assistantLine(
          "2026-06-01T10:00:00.000Z",
          "claude-opus-4-8",
          "msg_1",
          claudeUsage(10, 20, 300, 40),
        ),
        // A full day later: distinct local days in any runner timezone (a fall-back
        // transition could stretch a day to 25h, but these June dates avoid one).
        assistantLine(
          "2026-06-02T10:00:01.000Z",
          "claude-fable-5",
          "msg_2",
          claudeUsage(5, 6, 0, 0),
        ),
        // Dated Anthropic snapshot ids fold into the canonical (dotted) row.
        assistantLine(
          "2026-06-02T10:00:02.000Z",
          "claude-haiku-4-5-20251001",
          "msg_3",
          claudeUsage(1, 2),
        ),
      ]);
      return { roots: [root] };
    },
    check(report) {
      // Rows are keyed canonically (dashed transcript ids become dotted).
      expect(opusRow(report)).toEqual({
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
    },
  },
  // Same two-zone proof as the Codex catalog: one event, two named zones, two keys.
  ...[
    { zone: "America/New_York", day: "2026-06-01" },
    { zone: "UTC", day: "2026-06-02" },
  ].map(({ zone, day }): ReaderScenario<UsageReport> => ({
    name: `buckets by the user's local day in ${zone}, not the UTC day`,
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
        assistantLine("2026-06-02T01:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(1, 2)),
      ]);
      return { roots: [root], timeZone: zone };
    },
    check(report) {
      expect([...report.perDay.keys()]).toEqual([day]);
    },
  })),
  {
    name: "books a streamed message at its final (max) usage snapshot",
    build(dir) {
      const root = join(dir, "projects");
      const at = (ts: string, output: number) =>
        assistantLine(ts, "claude-opus-4-8", "msg_1", claudeUsage(10, output, 300, 40));
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        // Streaming writes one line per content block; the usage snapshot GROWS
        // (output_tokens rises toward the true final count, input side constant).
        at("2026-06-01T10:00:00.000Z", 3),
        // Snapshots can dip mid-stream (observed in real data); the booked value
        // must still end at the per-bucket max, never above it.
        at("2026-06-01T10:00:00.400Z", 9),
        at("2026-06-01T10:00:00.500Z", 5),
        at("2026-06-01T10:00:01.000Z", 20),
        // An exact repeat (resume copy) of the final snapshot adds nothing.
        at("2026-06-01T10:00:01.000Z", 20),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 10,
        output: 20,
        cacheRead: 300,
        cacheCreation: 40,
        events: 1,
      });
    },
  },
  {
    name: "counts a resume-copied message once across files",
    build(dir) {
      const root = join(dir, "projects");
      const proj = join(root, "-Users-x-proj");
      const copied = assistantLine(
        "2026-06-01T10:00:00.000Z",
        "claude-opus-4-8",
        "msg_1",
        claudeUsage(10, 20),
      );
      writeTranscript(proj, "aaa.jsonl", [copied]);
      // A resumed/forked session carries the old line into the new file.
      writeTranscript(proj, "bbb.jsonl", [
        copied,
        assistantLine("2026-06-01T11:00:00.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 11,
        output: 22,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
    },
  },
  {
    name: "finds nested subagent transcripts",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(
        join(root, "-Users-x-proj", "session-1", "subagents", "workflows", "wf_1"),
        "agent-abc.jsonl",
        [assistantLine(
          "2026-06-01T10:00:00.000Z",
          "claude-opus-4-8",
          "msg_1",
          claudeUsage(10, 20),
        )],
      );
      return { roots: [root] };
    },
    check(report) {
      expect(opusRow(report)?.events).toBe(1);
    },
  },
  {
    name: "skips synthetic models, usage-less and torn lines; id-less lines count",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "<synthetic>", "msg_1", claudeUsage(999, 999)),
        '{"type":"assistant","timestamp":"2026-06-01T10:00:01.000Z","message":{"model":"claude-opus-4-8","role":"assistant"}}',
        '{"type":"assistant","timestamp":"2026-06-01T10:00:02.000Z","message":{"model":"claude-opus-4-8"',
        assistantLine(
          "2026-06-01T10:00:03.000Z",
          "claude-opus-4-8",
          undefined,
          claudeUsage(10, 20),
        ),
        assistantLine(
          "2026-06-01T10:00:04.000Z",
          "claude-opus-4-8",
          undefined,
          claudeUsage(10, 20),
        ),
      ]);
      return { roots: [root] };
    },
    check(report) {
      // Only the two id-less lines count (each unconditionally); nothing synthetic.
      expect(opusRow(report)).toEqual({
        input: 20,
        output: 40,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
      expect(report.byModel.has("<synthetic>")).toBe(false);
    },
  },
  {
    name: "applies the sinceMs cutoff per event and skips stale files by mtime",
    build(dir) {
      const root = join(dir, "projects");
      const proj = join(root, "-Users-x-proj");
      // Stale file (old mtime): never read -- its valid in-window line must not count.
      const stale = writeTranscript(proj, "old.jsonl", [
        assistantLine(
          "2026-06-03T09:00:00.000Z",
          "claude-opus-4-8",
          "msg_stale",
          claudeUsage(500, 500),
        ),
      ]);
      ageFile(stale, "2026-01-01T00:00:00Z");
      // Fresh-mtime file mixing old and new events: only the new one counts.
      writeTranscript(proj, "aaa.jsonl", [
        assistantLine(
          "2026-06-01T10:00:00.000Z",
          "claude-opus-4-8",
          "msg_1",
          claudeUsage(100, 100),
        ),
        assistantLine("2026-06-03T10:00:00.000Z", "claude-opus-4-8", "msg_2", claudeUsage(10, 20)),
      ]);
      return { roots: [root], sinceMs: JUNE_2 };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 10,
        output: 20,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "does not count an unterminated final line",
    build(dir) {
      const root = join(dir, "projects");
      const file = writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      appendFileSync(
        file,
        assistantLine("2026-06-01T10:00:05.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      );
      return { roots: [root], files: [file] };
    },
    check(report) {
      expect(opusRow(report)?.events).toBe(1);
    },
  },
  {
    name: "ignores a needle that sits inside another line's content",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        // A user line quoting a whole assistant record as a nested object.
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{
              type: "assistant",
              message: { id: "msg_x", model: "claude-opus-4-8", usage: claudeUsage(999, 999) },
            }],
          },
        }),
        assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 10,
        output: 20,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "applies the window BEFORE the running-max dedup",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        // An out-of-window HIGHER snapshot of the same id must not pre-book the
        // in-window lower one down to a zero delta.
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
        assistantLine("2026-06-03T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 5)),
      ]);
      return { roots: [root], sinceMs: JUNE_2 };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 10,
        output: 5,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 1,
      });
    },
  },
  {
    name: "records nothing for an exact repeat, even under another model or day",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
        // The same id and snapshot again, relabelled: a zero delta must not seed a
        // row for the other model or a bucket for the other day.
        assistantLine("2026-06-02T10:00:00.000Z", "claude-fable-5", "msg_1", claudeUsage(10, 20)),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect([...report.byModel.keys()]).toEqual(["claude-opus-4.8"]);
      expect(report.perDay.size).toBe(1);
    },
  },
  {
    name: "under a NaN cutoff counts nothing, as before",
    build(dir) {
      const root = join(dir, "projects");
      const old = writeTranscript(join(root, "-Users-x-proj"), "old.jsonl", [
        assistantLine("2026-01-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      ageFile(old, "2026-01-01T00:00:00Z");
      return { roots: [root], sinceMs: Number.NaN };
    },
    check(report) {
      expect(report.byModel.size).toBe(0);
    },
  },
  {
    name: "books the same id on two days across two files on the first path's day",
    build(dir) {
      const root = join(dir, "projects");
      const proj = join(root, "-Users-x-proj");
      // The first-folded occurrence books its snapshot on ITS day, so order decides
      // attribution. This pins the deterministic order (ascending path); the old
      // reader folded in filesystem readdir order.
      writeTranscript(proj, "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      writeTranscript(proj, "bbb.jsonl", [
        assistantLine("2026-06-02T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 5)),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect([...report.perDay.keys()]).toEqual([
        localDayKey(Date.parse("2026-06-01T10:00:00.000Z")),
      ]);
    },
  },
  {
    name: "counts a root named twice once",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      return { roots: [root, root] };
    },
    check(report) {
      expect(opusRow(report)?.events).toBe(1);
    },
  },
  {
    name: "counts lines carrying U+2028, U+2029, and NEL inside their content",
    build(dir) {
      const root = join(dir, "projects");
      // The pre-index readline reader split on U+2028 and U+2029 and dropped the
      // line (NEL rides along as a third non-LF separator); the scanner cuts on LF alone.
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:00:00.000Z",
          message: {
            id: "msg_1",
            model: "claude-opus-4-8",
            role: "assistant",
            content: [{ type: "text", text: "odd \u2028 \u2029 \u0085 separators" }],
            usage: claudeUsage(10, 20),
          },
        }),
        assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      ]);
      return { roots: [root] };
    },
    check(report) {
      expect(opusRow(report)).toEqual({
        input: 11,
        output: 22,
        cacheRead: 0,
        ...NO_CACHE_CREATION,
        events: 2,
      });
    },
  },
];
