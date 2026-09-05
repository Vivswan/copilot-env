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
import { join } from "node:path";
import {
  discoverClaudeSessionRoots,
  parseClaudeTail,
  parseClaudeWhole,
  readClaudeSessions,
  walkClaudeSessions,
} from "../src/usage/claude_sessions.ts";
import { emptyIndexStats, type Reconcile, type WalkedFile } from "../src/usage/contribution.ts";
import { errMessage } from "../src/utils/error.ts";
import { localDayKey } from "../src/utils/time.ts";
import { captureAllWrites } from "./helpers/output.ts";
import {
  assistantLine,
  claudeUsage as usage,
  writeTranscript,
} from "./helpers/session_fixtures.ts";
import { expect, test } from "./helpers/testing.ts";

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

test("readClaudeSessions buckets by the user's local day, not the UTC day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
    assistantLine("2026-06-02T01:00:00.000Z", "claude-opus-4-8", "msg_1", usage(1, 2)),
  ]);

  // The zone is NAMED rather than pinned through process.env.TZ, so this runs on Windows
  // too (deno honors the TZ env var on unix only). Asserting the SAME event in two zones
  // is what keeps the teeth on every runner: a reader that ignored the zone -- or sliced
  // by UTC -- would have to return one key for both, and these two differ.
  const newYork = await readClaudeSessions([root], undefined, "America/New_York");
  expect([...newYork.perDay.keys()]).toEqual(["2026-06-01"]);
  const utc = await readClaudeSessions([root], undefined, "UTC");
  expect([...utc.perDay.keys()]).toEqual(["2026-06-02"]);
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

/** The walk record for one file on disk, as a candidate. */
function walkedFile(path: string): WalkedFile {
  const { size, mtimeMs } = statSync(path);
  return { path, size, mtimeMs, candidate: true, resumable: true };
}

test("parseClaudeTail resumed from a prefix parse equals one whole parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const lines = [
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 3, 300, 40)),
    assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", usage(10, 20, 300, 40)),
    assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", usage(10, 20, 300, 40)),
    assistantLine("2026-06-02T10:00:01.000Z", "claude-fable-5", undefined, usage(5, 6)),
  ];
  const wholePath = writeTranscript(join(dir, "whole"), "aaa.jsonl", lines);
  const whole = parseClaudeWhole(walkedFile(wholePath));
  // Every occurrence, exact repeats included, with the RAW model id (the fold
  // canonicalizes); the message id is hashed, never stored.
  expect(whole.contribution.occurrences.length).toBe(4);
  expect(whole.contribution.occurrences.map((o) => o[2])).toEqual([
    "claude-opus-4-8",
    "claude-opus-4-8",
    "claude-opus-4-8",
    "claude-fable-5",
  ]);
  expect(JSON.stringify(whole.contribution)).not.toContain("msg_1");

  const grownPath = writeTranscript(join(dir, "grown"), "aaa.jsonl", lines.slice(0, 2));
  const prefix = parseClaudeWhole(walkedFile(grownPath));
  const priorSnapshot = JSON.stringify(prefix.contribution);
  appendFileSync(grownPath, `${lines.slice(2).join("\n")}\n`);
  const tail = parseClaudeTail(walkedFile(grownPath), prefix.parsedThrough, prefix.contribution);
  expect(tail.contribution).toEqual(whole.contribution);
  expect(tail.parsedThrough).toBe(whole.parsedThrough);
  expect(tail.tailProbeHex).toBe(whole.tailProbeHex);
  expect(JSON.stringify(prefix.contribution)).toBe(priorSnapshot);
});

test("readClaudeSessions counts an unterminated final line only once its LF lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const file = writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
  ]);
  appendFileSync(
    file,
    assistantLine("2026-06-01T10:00:05.000Z", "claude-opus-4-8", "msg_2", usage(1, 2)),
  );
  const partial = await readClaudeSessions([root]);
  expect(partial.byModel.get("claude-opus-4.8")?.events).toBe(1);

  appendFileSync(file, "\n");
  const complete = await readClaudeSessions([root]);
  expect(complete.byModel.get("claude-opus-4.8")).toEqual({
    input: 11,
    output: 22,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readClaudeSessions ignores a needle that sits inside another line's content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
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
          message: { id: "msg_x", model: "claude-opus-4-8", usage: usage(999, 999) },
        }],
      },
    }),
    assistantLine("2026-06-01T10:00:01.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
  ]);

  const report = await readClaudeSessions([root]);
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("readClaudeSessions applies the window BEFORE the running-max dedup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    // An out-of-window HIGHER snapshot of the same id must not pre-book the
    // in-window lower one down to a zero delta.
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
    assistantLine("2026-06-03T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 5)),
  ]);

  const sinceMs = Date.parse("2026-06-02T00:00:00Z");
  const report = await readClaudeSessions([root], sinceMs);
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("walkClaudeSessions reports every transcript with its candidacy verdict, ascending by path", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const proj = join(root, "-Users-x-proj");
  const stale = writeTranscript(proj, "zzz-old.jsonl", ["x"]);
  const oldSec = Date.parse("2026-01-01T00:00:00Z") / 1000;
  utimesSync(stale, oldSec, oldSec);
  const fresh = writeTranscript(proj, "bbb.jsonl", ["x"]);
  const nested = writeTranscript(join(proj, "s", "subagents"), "agent-a.jsonl", ["x"]);
  writeFileSync(join(proj, "notes.txt"), "not a transcript");

  const walked = walkClaudeSessions([root], Date.parse("2026-06-01T00:00:00Z"));
  expect(walked.map((f) => f.path)).toEqual([fresh, nested, stale]);
  expect(walked.map((f) => f.candidate)).toEqual([true, true, false]);
  expect(walked.every((f) => f.resumable)).toBe(true);
  expect(walked[0]!.size).toBe(statSync(fresh).size);
});

// File symlinks need a privilege on Windows that CI runners do not always hold.
test.skipIf(Deno.build.os === "windows")(
  "walkClaudeSessions warns about a transcript it cannot stat and leaves it out",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
    const root = join(dir, "projects");
    const proj = join(root, "-Users-x-proj");
    const kept = writeTranscript(proj, "aaa.jsonl", ["x"]);
    const dangling = join(proj, "bbb.jsonl");
    symlinkSync(join(dir, "gone.jsonl"), dangling, "file");

    let statError = "";
    try {
      statSync(dangling);
    } catch (e) {
      statError = errMessage(e);
    }

    let walked: WalkedFile[] = [];
    const output = await captureAllWrites(async () => {
      walked = walkClaudeSessions([root], undefined);
    });
    expect(walked.map((f) => f.path)).toEqual([kept]);
    expect(output).toContain(`could not read ${dangling} (${statError}).`);
  },
);

test("readClaudeSessions records nothing for an exact repeat, even under another model or day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
    // The same id and snapshot again, relabelled: a zero delta must not seed a
    // row for the other model or a bucket for the other day.
    assistantLine("2026-06-02T10:00:00.000Z", "claude-fable-5", "msg_1", usage(10, 20)),
  ]);

  const report = await readClaudeSessions([root]);
  expect([...report.byModel.keys()]).toEqual(["claude-opus-4.8"]);
  expect(report.perDay.size).toBe(1);
});

test("readClaudeSessions under a NaN cutoff walks every file and counts nothing, as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const old = writeTranscript(join(root, "-Users-x-proj"), "old.jsonl", [
    assistantLine("2026-01-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
  ]);
  const oldSec = Date.parse("2026-01-01T00:00:00Z") / 1000;
  utimesSync(old, oldSec, oldSec);

  // A NaN cutoff fails every comparison: no file is skipped, no event passes.
  expect(walkClaudeSessions([root], Number.NaN).map((f) => f.candidate)).toEqual([true]);
  const report = await readClaudeSessions([root], Number.NaN);
  expect(report.byModel.size).toBe(0);
});

/** A reconcile that parses every candidate whole and hands the records back REVERSED. */
const reversingReconcile: Reconcile = (_source, walked, parseWhole) => {
  const records = walked
    .filter((f) => f.candidate)
    .map((f) => ({ path: f.path, contribution: parseWhole(f).contribution }));
  return { records: records.reverse(), stats: emptyIndexStats() };
};

test("readClaudeSessions folds ascending by path whatever order the reconcile returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  const proj = join(root, "-Users-x-proj");
  // The same id on two days: the first-folded occurrence books its snapshot on
  // ITS day, so order decides attribution. This pins the NEW deterministic
  // order (ascending path); the old reader folded in filesystem readdir order.
  writeTranscript(proj, "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
  ]);
  writeTranscript(proj, "bbb.jsonl", [
    assistantLine("2026-06-02T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 5)),
  ]);

  const direct = await readClaudeSessions([root]);
  const viaReconcile = await readClaudeSessions([root], undefined, undefined, reversingReconcile);
  expect([...viaReconcile.perDay.keys()]).toEqual([
    localDayKey(Date.parse("2026-06-01T10:00:00.000Z")),
  ]);
  expect(viaReconcile).toEqual(direct);
});

test("readClaudeSessions counts a root named twice once, with and without a reconcile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const root = join(dir, "projects");
  writeTranscript(join(root, "-Users-x-proj"), "aaa.jsonl", [
    assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", usage(10, 20)),
  ]);

  expect(walkClaudeSessions([root, root], undefined).length).toBe(1);
  const once = await readClaudeSessions([root]);
  expect(once.byModel.get("claude-opus-4.8")?.events).toBe(1);
  expect(await readClaudeSessions([root, root])).toEqual(once);
  expect(await readClaudeSessions([root, root], undefined, undefined, reversingReconcile)).toEqual(
    once,
  );
});
