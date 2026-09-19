import {
  appendFileSync,
  mkdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  discoverClaudeSessionRoots,
  parseClaudeTail,
  parseClaudeWhole,
  readClaudeSessions,
  walkClaudeSessions,
} from "../src/usage/claude_sessions.ts";
import { parseEveryCandidate, type WalkedFile } from "../src/usage/contribution.ts";
import { errMessage } from "../src/utils/error.ts";
import { captureAllWrites } from "./helpers/output.ts";
import {
  assistantLine,
  claudeUsage as usage,
  writeTranscript,
} from "./helpers/session_fixtures.ts";
import { CLAUDE_SCENARIOS, scenarioNamed } from "./helpers/session_scenarios.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

test("readClaudeSessions counts an unterminated final line once its LF lands", async () => {
  const scenario = scenarioNamed(CLAUDE_SCENARIOS, "does not count an unterminated final line");
  const { roots, files } = scenario.build(tempDir("claude-sessions-"));
  scenario.check(await readClaudeSessions(roots, undefined, undefined, parseEveryCandidate));
  appendFileSync(files![0]!, "\n");
  expect(
    (await readClaudeSessions(roots, undefined, undefined, parseEveryCandidate)).byModel.get(
      "claude-opus-4.8",
    ),
  ).toEqual({
    input: 11,
    output: 22,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readClaudeSessions books a message's GitHub bill once, however many files repeat its line", async () => {
  const root = join(tempDir("claude-sessions-"), "projects");
  const proj = join(root, "-Users-x-proj");
  // The shape a billed response carries: GitHub's per-bucket detail and its total in nano credits.
  const billed = assistantLine(
    "2026-06-01T10:00:00.000Z",
    "claude-fable-5-1",
    "msg_billed",
    usage(4, 262, 912_223, 6_399),
    {
      "copilot_usage": {
        "token_details": [{ "token_type": "output", "token_count": 262 }],
        "total_nano_aiu": 32_118_325_000,
      },
    },
  );
  writeTranscript(proj, "aaa.jsonl", [
    billed,
    assistantLine("2026-06-01T10:01:00.000Z", "claude-fable-5-1", "msg_plain", usage(10, 20)),
  ]);
  // A resumed session copies finished lines into its own file, bill included.
  writeTranscript(proj, "bbb.jsonl", [billed]);

  const report = await readClaudeSessions([root], undefined, "UTC", parseEveryCandidate);
  expect(report.byModel.get("claude-fable-5.1")?.events).toBe(2);
  expect([...report.billed]).toEqual([
    ["claude-fable-5.1", {
      input: 4,
      output: 262,
      cacheRead: 912_223,
      cacheCreation: 6_399,
      events: 1,
      nanoAiu: 32_118_325_000,
    }],
  ]);
});

test("walkClaudeSessions under a NaN cutoff keeps every file a candidate", () => {
  // A NaN cutoff fails every comparison, so no file is skipped by its mtime.
  const { roots } = scenarioNamed(CLAUDE_SCENARIOS, "under a NaN cutoff counts nothing, as before")
    .build(tempDir("claude-sessions-"));
  expect(walkClaudeSessions(roots, Number.NaN).map((f) => f.candidate)).toEqual([true]);
});

test("discoverClaudeSessionRoots returns existing projects dirs only, deduped", async () => {
  const dir = tempDir("claude-sessions-");
  const home = join(dir, "dot-claude");
  mkdirSync(join(home, "projects"), { recursive: true });
  const missingHome = join(dir, "nope");

  const roots = discoverClaudeSessionRoots([home, home, missingHome]);
  expect(roots).toEqual([join(home, "projects")]);
});

function walkedFile(path: string): WalkedFile {
  const { size, mtimeMs } = statSync(path);
  return { path, size, mtimeMs, candidate: true, resumable: true };
}

test("parseClaudeTail resumed from a prefix parse equals one whole parse", () => {
  const dir = tempDir("claude-sessions-");
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

test("walkClaudeSessions reports every transcript with its candidacy verdict, ascending by path", () => {
  const dir = tempDir("claude-sessions-");
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
    const dir = tempDir("claude-sessions-");
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
