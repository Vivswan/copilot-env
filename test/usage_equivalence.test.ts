// The index may change how long `agent cost` takes, never its answer: every
// reader fixture is read three ways (no index, a cold index, a warm index) and
// the three reports must be identical. The IndexStats of each run are the
// oracle for what the index did (parsed whole, reused, tail-parsed, deleted).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { readClaudeSessions } from "../src/usage/claude_sessions.ts";
import { readCodexSessions } from "../src/usage/codex_sessions.ts";
import {
  emptyIndexStats,
  type IndexStats,
  parseEveryCandidate,
  type Reconcile,
  TAIL_PROBE_BYTES,
} from "../src/usage/contribution.ts";
import { ReconcileMeter, runCost } from "../src/usage/cost.ts";
import { openUsageIndex, USAGE_INDEX_DB_NAME } from "../src/usage/index.ts";
import { captureAllWrites } from "./helpers/output.ts";
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
} from "./helpers/session_fixtures.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-equivalence-"));
  dirs.push(dir);
  return dir;
}

/** Set a file's mtime to an old instant so the walk's recency heuristic skips it. */
function ageFile(path: string, iso: string): void {
  const sec = Date.parse(iso) / 1000;
  utimesSync(path, sec, sec);
}

// ---------- the fixture catalog ----------
//
// One entry per reader test fixture (test/codex_sessions.test.ts and
// test/claude_sessions.test.ts), rebuilt here from the shared builders. `build`
// writes the tree under `dir` and returns the roots the reader is given.

interface Scenario {
  name: string;
  build(dir: string): { roots: string[]; sinceMs?: number; timeZone?: string };
  /** The fixture reads as an empty report by design (a cutoff nothing passes). */
  empty?: boolean;
}

const JUNE_2 = Date.parse("2026-06-02T00:00:00Z");

const CODEX_SCENARIOS: Scenario[] = [
  {
    name: "model switch with cached input across two days",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 40, 20), codexUsage(100, 40, 20)),
        turnContext("2026-06-02T10:00:01.000Z", "gpt-5.6-mini"),
        tokenCount("2026-06-02T10:00:05.000Z", codexUsage(300, 40, 50), codexUsage(200, 0, 30)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "canonical model spellings via turn_context and thread_settings_applied",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "claude-opus-4-8"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 2), codexUsage(10, 0, 2)),
        rolloutLine("2026-06-01T10:01:00.000Z", "event_msg", {
          type: "thread_settings_applied",
          "thread_settings": { model: "claude-haiku-4-5-20251001" },
        }),
        tokenCount("2026-06-01T10:01:05.000Z", codexUsage(30, 0, 7), codexUsage(20, 0, 5)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "sessions grouped by model_provider, absent meaning default",
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
  },
  {
    name: "a fork's copied prefix with the parent scanned",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T10:00:15.000Z", codexUsage(250, 90, 25), codexUsage(150, 90, 15)),
      ]);
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
  },
  {
    name: "a fork whose parent is missing (batch-write window fallback)",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "bbb", [
        sessionMeta("2026-06-01T12:00:00.000Z", "bbb", {
          provider: "copilot-env",
          forkedFrom: "gone",
        }),
        turnContext("2026-06-01T12:00:00.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T12:00:00.050Z", codexUsage(250, 90, 25), codexUsage(150, 90, 15)),
        tokenCount("2026-06-01T12:00:09.000Z", codexUsage(450, 290, 45), codexUsage(200, 200, 20)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a sinceMs cutoff with an old file skipped by name and a resumed session kept",
    build(dir) {
      const root = join(dir, "sessions");
      const oldFile = writeRollout(root, "2026-01-01", "old", [
        "this would fail to parse if it were read",
      ]);
      ageFile(oldFile, "2026-01-01T02:00:00Z");
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
  },
  {
    name: "null-info counts, a torn line, and an unnamed model",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
        rolloutLine("2026-06-01T10:00:06.000Z", "event_msg", { type: "token_count", info: null }),
        '{"timestamp":"2026-06-01T10:00:07.000Z","type":"event_msg","payload":{"type":"token_count"',
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a session present both live and as a zstd archive",
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
      writeFileSync(
        join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
        zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
      );
      return { roots: [live, archived] };
    },
  },
  {
    name: "a zstd archive alone, and one with a byte order mark beside a plain BOM file",
    build(dir) {
      const archived = join(dir, "archived_sessions");
      const live = join(dir, "sessions");
      mkdirSync(archived, { recursive: true });
      mkdirSync(live, { recursive: true });
      const lines = [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ];
      writeFileSync(
        join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
        zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)),
      );
      const bom = Buffer.from(`\ufeff${lines.join("\n")}\n`);
      writeFileSync(
        join(archived, "rollout-2026-06-01T01-00-00-bbb.jsonl.zst"),
        zstdCompressSync(bom),
      );
      writeFileSync(join(live, "rollout-2026-06-01T01-00-00-ccc.jsonl"), bom);
      return { roots: [live, archived] };
    },
  },
  {
    name: "an unterminated final line",
    build(dir) {
      const root = join(dir, "sessions");
      const file = writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      appendFileSync(
        file,
        tokenCount("2026-06-01T10:00:09.000Z", codexUsage(30, 0, 3), codexUsage(20, 0, 2)),
      );
      return { roots: [root] };
    },
  },
  {
    name: "needles inside another line's content",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
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
  },
  {
    name: "a fork deduped against an out-of-window parent",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
      ]);
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
  },
  {
    name: "a token_count re-emitted within one file",
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
        turn.replace("2026-06-01T10:00:05.000Z", "2026-06-01T11:00:05.000Z"),
        tokenCount("2026-06-01T11:00:09.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a fork's own early turn with the parent scanned, and a parent without counts",
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
        tokenCount("2026-06-01T12:00:00.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T12:00:01.000Z", codexUsage(150, 0, 15), codexUsage(50, 0, 5)),
      ]);
      writeRollout(root, "2026-06-01", "ccc", [
        sessionMeta("2026-06-01T13:00:00.000Z", "ccc", { provider: "copilot-env" }),
        turnContext("2026-06-01T13:00:01.000Z", "gpt-5.6"),
      ]);
      writeRollout(root, "2026-06-01", "ddd", [
        sessionMeta("2026-06-01T14:00:00.000Z", "ddd", {
          provider: "copilot-env",
          forkedFrom: "ccc",
        }),
        turnContext("2026-06-01T14:00:00.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T14:00:01.000Z", codexUsage(100, 0, 10), codexUsage(100, 0, 10)),
        tokenCount("2026-06-01T14:00:05.000Z", codexUsage(300, 0, 30), codexUsage(200, 0, 20)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "session_meta honoured until an id is known",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-01", "aaa", [
        rolloutLine("2026-06-01T10:00:00.000Z", "session_meta", { "model_provider": "first" }),
        tokenCount("2026-06-01T10:00:01.000Z", codexUsage(1, 0, 1), codexUsage(1, 0, 1)),
        sessionMeta("2026-06-01T10:00:02.000Z", "aaa", { provider: "second", forkedFrom: "p" }),
        tokenCount("2026-06-01T10:00:03.000Z", codexUsage(2, 0, 2), codexUsage(1, 0, 1)),
        sessionMeta("2026-06-01T10:00:04.000Z", "zzz", { provider: "third" }),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(3, 0, 3), codexUsage(1, 0, 1)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "days cut in a named zone, with the root named twice",
    build(dir) {
      const root = join(dir, "sessions");
      writeRollout(root, "2026-06-02", "aaa", [
        sessionMeta("2026-06-02T01:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-02T01:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-02T01:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      return { roots: [root, root], timeZone: "America/New_York" };
    },
  },
  {
    name: "a NaN cutoff walks every file and counts nothing",
    empty: true,
    build(dir) {
      const root = join(dir, "sessions");
      const old = writeRollout(root, "2026-01-01", "old", [
        sessionMeta("2026-01-01T10:00:00.000Z", "old", { provider: "copilot-env" }),
        turnContext("2026-01-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-01-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      ageFile(old, "2026-01-01T02:00:00Z");
      return { roots: [root], sinceMs: Number.NaN };
    },
  },
];

const CLAUDE_SCENARIOS: Scenario[] = [
  {
    name: "the four usage buckets across two days with canonical spellings",
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
        assistantLine(
          "2026-06-02T10:00:01.000Z",
          "claude-fable-5",
          "msg_2",
          claudeUsage(5, 6, 0, 0),
        ),
        assistantLine(
          "2026-06-02T10:00:02.000Z",
          "claude-haiku-4-5-20251001",
          "msg_3",
          claudeUsage(1, 2),
        ),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a streamed message booked at its running-max snapshot, with an exact repeat",
    build(dir) {
      const root = join(dir, "projects");
      const at = (ts: string, output: number) =>
        assistantLine(ts, "claude-opus-4-8", "msg_1", claudeUsage(10, output, 300, 40));
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        at("2026-06-01T10:00:00.000Z", 3),
        at("2026-06-01T10:00:00.400Z", 9),
        at("2026-06-01T10:00:00.500Z", 5),
        at("2026-06-01T10:00:01.000Z", 20),
        at("2026-06-01T10:00:01.000Z", 20),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a resume-copied message across files",
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
      writeTranscript(proj, "bbb.jsonl", [
        copied,
        assistantLine("2026-06-01T11:00:00.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "a nested subagent transcript",
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
  },
  {
    name: "synthetic, usage-less, torn, and id-less lines",
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
  },
  {
    name: "a sinceMs cutoff with a stale-mtime file skipped",
    build(dir) {
      const root = join(dir, "projects");
      const proj = join(root, "-Users-x-proj");
      const stale = writeTranscript(proj, "old.jsonl", [
        assistantLine(
          "2026-06-03T09:00:00.000Z",
          "claude-opus-4-8",
          "msg_stale",
          claudeUsage(500, 500),
        ),
      ]);
      ageFile(stale, "2026-01-01T00:00:00Z");
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
  },
  {
    name: "an unterminated final line",
    build(dir) {
      const root = join(dir, "projects");
      const file = writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      appendFileSync(
        file,
        assistantLine("2026-06-01T10:00:05.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      );
      return { roots: [root] };
    },
  },
  {
    name: "a needle inside another line's content",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
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
  },
  {
    name: "the window applied before the running-max dedup",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
        assistantLine("2026-06-03T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 5)),
      ]);
      return { roots: [root], sinceMs: JUNE_2 };
    },
  },
  {
    name: "an exact repeat under another model and day",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
        assistantLine("2026-06-02T10:00:00.000Z", "claude-fable-5", "msg_1", claudeUsage(10, 20)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "the same id on two days across two files (path order decides the day)",
    build(dir) {
      const root = join(dir, "projects");
      const proj = join(root, "-Users-x-proj");
      writeTranscript(proj, "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      writeTranscript(proj, "bbb.jsonl", [
        assistantLine("2026-06-02T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 5)),
      ]);
      return { roots: [root] };
    },
  },
  {
    name: "lines carrying U+2028, U+2029, and NEL inside their content",
    build(dir) {
      const root = join(dir, "projects");
      // The pre-index readline reader split on these and dropped the lines; the
      // byte scanner cuts on LF alone, so they count. Both readers here agree.
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
  },
  {
    name: "days cut in a named zone, with the root named twice",
    build(dir) {
      const root = join(dir, "projects");
      writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-02T01:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(1, 2)),
      ]);
      return { roots: [root, root], timeZone: "America/New_York" };
    },
  },
  {
    name: "a NaN cutoff walks every file and counts nothing",
    empty: true,
    build(dir) {
      const root = join(dir, "projects");
      const old = writeTranscript(join(root, "-Users-x-proj"), "old.jsonl", [
        assistantLine("2026-01-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      ageFile(old, "2026-01-01T00:00:00Z");
      return { roots: [root], sinceMs: Number.NaN };
    },
  },
];

// ---------- reading three ways ----------

interface MeteredRead<T> {
  report: T;
  stats: IndexStats;
}

/** Read through `reconcile`, returning the report and the reconcile's stats. */
async function readWith<T>(
  read: (reconcile: Reconcile) => Promise<T>,
  reconcile: Reconcile,
): Promise<MeteredRead<T>> {
  const meter = new ReconcileMeter(reconcile);
  const report = await read(meter.reconcile);
  return { report, stats: meter.stats };
}

/** Read through a fresh open of the index at `indexDir`, closed afterwards. */
async function readIndexed<T>(
  read: (reconcile: Reconcile) => Promise<T>,
  indexDir: string,
): Promise<MeteredRead<T>> {
  const index = openUsageIndex({ dir: indexDir });
  if (index === null) throw new Error("index did not open");
  try {
    return await readWith(read, index.reconcile);
  } finally {
    index.close();
  }
}

/** The three-way assertion: no index, a cold index, and a warm index agree, and
 *  the stats say the cold run parsed every candidate whole and the warm run
 *  reused every one without reading a byte. */
async function assertThreeWaysAgree<T>(
  dir: string,
  read: (reconcile: Reconcile) => Promise<T>,
): Promise<T> {
  const indexDir = join(dir, "index");
  const plain = await readWith(read, parseEveryCandidate);
  const cold = await readIndexed(read, indexDir);
  const warm = await readIndexed(read, indexDir);

  expect(cold.report).toEqual(plain.report);
  expect(warm.report).toEqual(plain.report);

  // The no-index run defines the candidates and the bytes; a cold index does the
  // same work and stores it, a warm one reuses every row and reads nothing.
  const { filesSeen, filesParsedWhole: candidates, bytesRead } = plain.stats;
  expect(plain.stats).toEqual({
    ...emptyIndexStats(),
    filesSeen,
    filesParsedWhole: candidates,
    bytesRead,
  });
  expect(cold.stats).toEqual(plain.stats);
  expect(warm.stats).toEqual({ ...emptyIndexStats(), filesSeen, filesReused: candidates });
  return plain.report;
}

for (const scenario of CODEX_SCENARIOS) {
  test(`codex fixture reads the same three ways: ${scenario.name}`, async () => {
    const dir = tempDir();
    const { roots, sinceMs, timeZone } = scenario.build(dir);
    const report = await assertThreeWaysAgree(
      dir,
      (reconcile) => readCodexSessions(roots, sinceMs, timeZone, reconcile),
    );
    // Every catalog entry must exercise the fold unless it is about an empty
    // result: a fixture that reads as empty three ways by accident proves nothing.
    expect(report.size > 0).toBe(scenario.empty !== true);
  });
}

for (const scenario of CLAUDE_SCENARIOS) {
  test(`claude fixture reads the same three ways: ${scenario.name}`, async () => {
    const dir = tempDir();
    const { roots, sinceMs, timeZone } = scenario.build(dir);
    const report = await assertThreeWaysAgree(
      dir,
      (reconcile) => readClaudeSessions(roots, sinceMs, timeZone, reconcile),
    );
    expect(report.byModel.size > 0).toBe(scenario.empty !== true);
  });
}

// ---------- change between runs ----------

/** The paths stored in the index database at `indexDir` (opened read-only). */
function storedPaths(indexDir: string): string[] {
  const db = new DatabaseSync(join(indexDir, USAGE_INDEX_DB_NAME), { readOnly: true });
  try {
    const rows = db.prepare(`SELECT "path" FROM "files" ORDER BY "path"`).all();
    return rows.map((row) => String((row as { path: unknown }).path));
  } finally {
    db.close();
  }
}

/** One source's append check, with the reader's result type tied to the event
 *  selector by the generic: a Codex selector cannot be paired with the Claude reader. */
function appendCase<T>(
  source: string,
  seed: (dir: string) => { file: string; read(reconcile: Reconcile): Promise<T>; appended: string },
  events: (report: T) => number | undefined,
): { source: string; check(dir: string): Promise<void> } {
  return {
    source,
    async check(dir) {
      const indexDir = join(dir, "index");
      const { file, read, appended } = seed(dir);
      await readIndexed(read, indexDir);

      appendFileSync(file, appended);

      const warm = await readIndexed(read, indexDir);
      expect(warm.stats.filesParsedTail).toBe(1);
      expect(warm.stats.filesParsedWhole).toBe(0);
      // The new bytes plus two probe reads: the index verifies the stored probe, then
      // the scanner seeds the next probe from the same bytes before resuming.
      expect(warm.stats.bytesRead).toBe(Buffer.byteLength(appended) + 2 * TAIL_PROBE_BYTES);
      expect(warm.report).toEqual((await readWith(read, parseEveryCandidate)).report);
      expect(events(warm.report)).toBe(2);
    },
  };
}

const APPEND_CASES = [
  appendCase(
    "claude",
    (dir) => {
      const root = join(dir, "projects");
      const file = writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
        assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
      ]);
      return {
        file,
        read: (reconcile) => readClaudeSessions([root], undefined, undefined, reconcile),
        appended: `${
          assistantLine("2026-06-01T10:00:05.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2))
        }\n`,
      };
    },
    (report) => report.byModel.get("claude-opus-4.8")?.events,
  ),
  appendCase(
    "codex",
    (dir) => {
      const root = join(dir, "sessions");
      const file = writeRollout(root, "2026-06-01", "aaa", [
        sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
        turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
        tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
      ]);
      return {
        file,
        read: (reconcile) => readCodexSessions([root], undefined, undefined, reconcile),
        appended: `${
          tokenCount("2026-06-01T10:00:09.000Z", codexUsage(30, 0, 3), codexUsage(20, 0, 2))
        }\n`,
      };
    },
    (report) => report.get("copilot-env")?.byModel.get("gpt-5.6")?.events,
  ),
];

for (const { source, check } of APPEND_CASES) {
  test(`an appended ${source} file is tail-parsed once, reading only the new bytes and the probe`, () =>
    check(tempDir()));
}

test("a deleted transcript leaves the next report and the database", async () => {
  const dir = tempDir();
  const indexDir = join(dir, "index");
  const root = join(dir, "projects");
  const proj = join(root, "-Users-x-proj");
  const kept = writeTranscript(proj, "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
  ]);
  const gone = writeTranscript(proj, "bbb.jsonl", [
    assistantLine("2026-06-01T11:00:00.000Z", "claude-fable-5", "msg_2", claudeUsage(1, 2)),
  ]);
  const read = (reconcile: Reconcile) =>
    readClaudeSessions([root], undefined, undefined, reconcile);
  const cold = await readIndexed(read, indexDir);
  expect(cold.report.byModel.has("claude-fable-5")).toBe(true);
  expect(storedPaths(indexDir)).toEqual([kept, gone]);

  rmSync(gone);

  const warm = await readIndexed(read, indexDir);
  expect(warm.stats.filesDeleted).toBe(1);
  expect(warm.stats.filesReused).toBe(1);
  expect(warm.report.byModel.has("claude-fable-5")).toBe(false);
  expect(warm.report).toEqual((await readWith(read, parseEveryCandidate)).report);
  expect(storedPaths(indexDir)).toEqual([kept]);
});

test("a removed session root takes every one of its rows with it", async () => {
  const dir = tempDir();
  const indexDir = join(dir, "index");
  const root = join(dir, "sessions");
  for (const id of ["aaa", "bbb", "ccc"]) {
    writeRollout(root, "2026-06-01", id, [
      sessionMeta("2026-06-01T10:00:00.000Z", id, { provider: "copilot-env" }),
      turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
      tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
    ]);
  }
  await readIndexed(
    (reconcile) => readCodexSessions([root], undefined, undefined, reconcile),
    indexDir,
  );
  expect(storedPaths(indexDir).length).toBe(3);

  // The root is gone, so discovery hands the reader no roots at all: the walk
  // sees nothing, and the reconcile of that empty walk is what deletes the rows.
  rmSync(root, { recursive: true });
  const after = await readIndexed(
    (reconcile) => readCodexSessions([], undefined, undefined, reconcile),
    indexDir,
  );
  expect(after.stats.filesDeleted).toBe(3);
  expect(after.report.size).toBe(0);
  expect(storedPaths(indexDir)).toEqual([]);
});

// ---------- the whole command ----------

const PRICE_URL = "https://pricing.example/models";

/** A fetch serving one priced model per source so the JSON carries dollar amounts too. */
const pricedFetch = ((): Promise<Response> =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        data: [
          {
            id: "anthropic/claude-opus-4.8",
            pricing: { prompt: "0.000015", completion: "0.000075" },
          },
          { id: "openai/gpt-5.6", pricing: { prompt: "0.00000125", completion: "0.00001" } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  )) as typeof fetch;

/** Run `agent cost --json --per-day` with the given flags and return the parsed payload. */
async function costJson(
  args: { noIndex?: boolean },
  roots: { codex: string[]; claude: string[] },
): Promise<Record<string, unknown>> {
  const out = await captureAllWrites(() =>
    runCost({ json: true, perDay: true, pricingUrl: PRICE_URL, ...args }, {
      fetchImpl: pricedFetch,
      sessionRoots: { codex: () => roots.codex, claude: () => roots.claude },
    })
  );
  const payload: unknown = JSON.parse(out.slice(out.indexOf("{")));
  if (typeof payload !== "object" || payload === null) throw new Error("no JSON payload");
  return payload as Record<string, unknown>;
}

test("agent cost --json is identical without the index, cold, and warm, except runtime", async () => {
  const dir = tempDir();
  const savedHome = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api");
  try {
    const codexRoot = join(dir, "sessions");
    writeRollout(codexRoot, "2026-06-01", "aaa", [
      sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" }),
      turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
      tokenCount("2026-06-01T10:00:05.000Z", codexUsage(100, 40, 20), codexUsage(100, 40, 20)),
    ]);
    const claudeRoot = join(dir, "projects");
    writeTranscript(join(claudeRoot, "-Users-x-proj"), "aaa.jsonl", [
      assistantLine(
        "2026-06-01T10:00:00.000Z",
        "claude-opus-4-8",
        "msg_1",
        claudeUsage(10, 20, 300, 40),
      ),
    ]);
    const roots = { codex: [codexRoot], claude: [claudeRoot] };

    const plain = await costJson({ noIndex: true }, roots);
    const cold = await costJson({}, roots);
    const warm = await costJson({}, roots);

    const withoutRuntime = (payload: Record<string, unknown>) => {
      const { runtime: _runtime, ...rest } = payload;
      return rest;
    };
    expect(withoutRuntime(cold)).toEqual(withoutRuntime(plain));
    expect(withoutRuntime(warm)).toEqual(withoutRuntime(plain));
    // Last key by contract: its `total` is stamped after everything else is built.
    for (const payload of [plain, cold, warm]) {
      expect(Object.keys(payload).at(-1)).toBe("runtime");
    }

    const runtimeOf = (payload: Record<string, unknown>) =>
      payload.runtime as { indexed: boolean; index: IndexStats };
    expect(runtimeOf(plain).indexed).toBe(false);
    expect(runtimeOf(plain).index.filesParsedWhole).toBe(2);
    expect(runtimeOf(cold).indexed).toBe(true);
    expect(runtimeOf(cold).index.filesParsedWhole).toBe(2);
    expect(runtimeOf(warm).indexed).toBe(true);
    expect(runtimeOf(warm).index.filesReused).toBe(2);
    expect(runtimeOf(warm).index.bytesRead).toBe(0);
  } finally {
    process.env.COPILOT_API_HOME = savedHome;
  }
});
