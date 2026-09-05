import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  discoverCodexSessionRoots,
  foldCodex,
  parseCodexTail,
  parseCodexWhole,
  readCodexSessions,
  walkCodexSessions,
} from "../src/usage/codex_sessions.ts";
import {
  dedupKey,
  emptyIndexStats,
  type Reconcile,
  type WalkedFile,
} from "../src/usage/contribution.ts";
import { errMessage } from "../src/utils/error.ts";
import { dayKeyIn } from "../src/utils/time.ts";
import { captureAllWrites } from "./helpers/output.ts";
import {
  codexUsage as usage,
  rolloutLine,
  sessionMeta,
  tokenCount,
  turnContext,
  writeRollout,
} from "./helpers/session_fixtures.ts";
import { CODEX_SCENARIOS, scenarioNamed } from "./helpers/session_scenarios.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  dirs.push(dir);
  return dir;
}

// The reader fixtures live in the shared catalog, which the index equivalence tests
// read three ways with the same checks; one default-reconcile read here covers the
// reader's own entry point.
test("readCodexSessions reads a catalog scenario without a reconcile", async () => {
  const scenario = scenarioNamed(
    CODEX_SCENARIOS,
    "attributes turns to the model in effect and splits cached input",
  );
  const { roots, sinceMs, timeZone } = scenario.build(tempDir());
  scenario.check(await readCodexSessions(roots, sinceMs, timeZone));
});

test("readCodexSessions counts an unterminated final line once its LF lands", async () => {
  const scenario = scenarioNamed(CODEX_SCENARIOS, "does not count an unterminated final line");
  const { roots, files } = scenario.build(tempDir());
  scenario.check(await readCodexSessions(roots));
  appendFileSync(files![0]!, "\n");
  expect((await readCodexSessions(roots)).get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 30,
    output: 3,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
});

test("readCodexSessions warns about a corrupt archive and still counts the valid ones", async () => {
  const root = join(tempDir(), "archived_sessions");
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
  const corrupt = join(root, "rollout-2026-06-01T02-00-00-bbb.jsonl.zst");
  writeFileSync(corrupt, "not zstd at all");

  let byProvider: Awaited<ReturnType<typeof readCodexSessions>> | undefined;
  const output = await captureAllWrites(async () => {
    byProvider = await readCodexSessions([root]);
  });
  expect(output).toContain(`could not read ${corrupt} (`);
  expect([...(byProvider?.keys() ?? [])]).toEqual(["copilot-env"]);
  expect(byProvider?.get("copilot-env")?.byModel.get("gpt-5.6")).toEqual({
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});

test("walkCodexSessions under a NaN cutoff keeps every file a candidate", () => {
  // A NaN cutoff fails every comparison, so no file is skipped by its date.
  const { roots } = scenarioNamed(CODEX_SCENARIOS, "under a NaN cutoff counts nothing, as before")
    .build(tempDir());
  expect(walkCodexSessions(roots, Number.NaN).map((f) => f.candidate)).toEqual([true]);
});

const reversingReconcile: Reconcile = (_source, walked, parseWhole) => {
  const records = walked
    .filter((f) => f.candidate)
    .map((f) => ({ path: f.path, contribution: parseWhole(f).contribution }));
  return { records: records.reverse(), stats: emptyIndexStats() };
};

test("readCodexSessions folds in walk order whatever order the reconcile returns", async () => {
  // The parent's hashes exist only if the parent was folded FIRST.
  const scenario = scenarioNamed(
    CODEX_SCENARIOS,
    "identifies a fork's copy outside the batch window only through the parent's hashes",
  );
  const { roots } = scenario.build(tempDir());
  const viaReconcile = await readCodexSessions(roots, undefined, undefined, reversingReconcile);
  scenario.check(viaReconcile);
  expect(viaReconcile).toEqual(await readCodexSessions(roots));
});

test("readCodexSessions walks a root named twice once, whatever the reconcile", async () => {
  const { roots } = scenarioNamed(CODEX_SCENARIOS, "counts a root named twice once").build(
    tempDir(),
  );
  expect(walkCodexSessions(roots, undefined).length).toBe(1);
  // The baseline is the root named ONCE; both duplicated-root reads must equal it.
  const once = await readCodexSessions([roots[0]!]);
  expect(await readCodexSessions(roots)).toEqual(once);
  expect(await readCodexSessions(roots, undefined, undefined, reversingReconcile)).toEqual(once);
});

test("discoverCodexSessionRoots dedupes farm symlinks by realpath", () => {
  const dir = tempDir();
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
  const dir = tempDir();
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

test("walkCodexSessions reports every rollout with its candidacy verdict, in fold order", () => {
  const dir = tempDir();
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

// File symlinks need a privilege on Windows that CI runners do not always hold.
test.skipIf(Deno.build.os === "windows")(
  "walkCodexSessions warns about a rollout it cannot stat and leaves it out",
  async () => {
    const dir = tempDir();
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

test("parseCodexWhole honours session_meta until an id is known, then ignores later ones", () => {
  const dir = tempDir();
  const path = writeRollout(join(dir, "s"), "2026-06-01", "aaa", [
    // No id: the gate stays open, so the NEXT meta line still applies.
    rolloutLine("2026-06-01T10:00:00.000Z", "session_meta", { "model_provider": "first" }),
    tokenCount("2026-06-01T10:00:01.000Z", usage(1, 0, 1), usage(1, 0, 1)),
    sessionMeta("2026-06-01T10:00:02.000Z", "aaa", { provider: "second", forkedFrom: "p" }),
    tokenCount("2026-06-01T10:00:03.000Z", usage(3, 0, 3), usage(2, 0, 2)),
    // Id known: a third meta changes nothing.
    sessionMeta("2026-06-01T10:00:04.000Z", "zzz", { provider: "third" }),
    tokenCount("2026-06-01T10:00:05.000Z", usage(6, 0, 6), usage(3, 0, 3)),
  ]);
  const { contribution } = parseCodexWhole(walkedFile(path));
  const { state, events } = contribution;
  expect(events.map((e) => e[1])).toEqual(["first", "second", "second"]);
  expect(state.provider).toBe("second");
  expect(state.sessionIdHash).toBe(dedupKey("aaa"));
  expect(state.forkedFromIdHash).toBe(dedupKey("p"));
  expect(state.forkKnownAfter).toBe(1);
  expect(state.metaTsMs).toBe(Date.parse("2026-06-01T10:00:02.000Z"));

  // The fold applies the fork rules from the event the fork was learned before: the
  // first count (before the meta) was an ordinary turn, the second (1 s after the
  // meta, parent unscanned) is the copied prefix, the third (3 s after) is a turn.
  const folded = foldCodex([{ path, contribution }], undefined, dayKeyIn("UTC"));
  expect([...folded.keys()]).toEqual(["first", "second"]);
  expect(folded.get("first")?.byModel.get("unknown")).toEqual({
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  expect(folded.get("second")?.byModel.get("unknown")).toEqual({
    input: 3,
    output: 3,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
});
