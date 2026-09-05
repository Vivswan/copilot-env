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
import { captureAllWrites } from "./helpers/output.ts";
import {
  assistantLine,
  claudeUsage as usage,
  writeTranscript,
} from "./helpers/session_fixtures.ts";
import { CLAUDE_SCENARIOS, scenarioNamed } from "./helpers/session_scenarios.ts";
import { expect, test } from "./helpers/testing.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "claude-sessions-"));
}

// The single-read fixtures live in the shared catalog, which the index equivalence
// tests read three ways with the same checks.
for (const scenario of CLAUDE_SCENARIOS) {
  test(`readClaudeSessions ${scenario.name}`, async () => {
    const { roots, sinceMs, timeZone } = scenario.build(tempDir());
    scenario.check(await readClaudeSessions(roots, sinceMs, timeZone));
  });
}

test("readClaudeSessions counts an unterminated final line once its LF lands", async () => {
  const scenario = scenarioNamed(CLAUDE_SCENARIOS, "does not count an unterminated final line");
  const { roots, files } = scenario.build(tempDir());
  scenario.check(await readClaudeSessions(roots));
  appendFileSync(files![0]!, "\n");
  expect((await readClaudeSessions(roots)).byModel.get("claude-opus-4.8")).toEqual({
    input: 11,
    output: 22,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("walkClaudeSessions under a NaN cutoff keeps every file a candidate", () => {
  // A NaN cutoff fails every comparison, so no file is skipped by its mtime.
  const { roots } = scenarioNamed(CLAUDE_SCENARIOS, "under a NaN cutoff counts nothing, as before")
    .build(tempDir());
  expect(walkClaudeSessions(roots, Number.NaN).map((f) => f.candidate)).toEqual([true]);
});

const reversingReconcile: Reconcile = (_source, walked, parseWhole) => {
  const records = walked
    .filter((f) => f.candidate)
    .map((f) => ({ path: f.path, contribution: parseWhole(f).contribution }));
  return { records: records.reverse(), stats: emptyIndexStats() };
};

test("readClaudeSessions folds ascending by path whatever order the reconcile returns", async () => {
  const scenario = scenarioNamed(
    CLAUDE_SCENARIOS,
    "books the same id on two days across two files on the first path's day",
  );
  const { roots } = scenario.build(tempDir());
  const viaReconcile = await readClaudeSessions(roots, undefined, undefined, reversingReconcile);
  scenario.check(viaReconcile);
  expect(viaReconcile).toEqual(await readClaudeSessions(roots));
});

test("readClaudeSessions walks a root named twice once, whatever the reconcile", async () => {
  const { roots } = scenarioNamed(CLAUDE_SCENARIOS, "counts a root named twice once").build(
    tempDir(),
  );
  expect(walkClaudeSessions(roots, undefined).length).toBe(1);
  // The baseline is the root named ONCE; both duplicated-root reads must equal it.
  const once = await readClaudeSessions([roots[0]!]);
  expect(await readClaudeSessions(roots)).toEqual(once);
  expect(await readClaudeSessions(roots, undefined, undefined, reversingReconcile)).toEqual(once);
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
