// The index may change how long `agent cost` takes, never its answer: every
// reader fixture is read three ways (no index, a cold index, a warm index) and
// the three reports must be identical. The IndexStats of each run are the
// oracle for what the index did (parsed whole, reused, tail-parsed, deleted).
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { CLAUDE_SCENARIOS, CODEX_SCENARIOS } from "./helpers/session_scenarios.ts";
import {
  assistantLine,
  claudeUsage,
  codexUsage,
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

// Every catalog fixture, three ways; the catalog's own check on the no-index
// report is the positive control that the fixture exercised what it claims.
for (const scenario of CODEX_SCENARIOS) {
  test(`codex fixture reads the same three ways: ${scenario.name}`, async () => {
    const dir = tempDir();
    const { roots, sinceMs, timeZone } = scenario.build(dir);
    scenario.check(
      await assertThreeWaysAgree(
        dir,
        (reconcile) => readCodexSessions(roots, sinceMs, timeZone, reconcile),
      ),
    );
  });
}

for (const scenario of CLAUDE_SCENARIOS) {
  test(`claude fixture reads the same three ways: ${scenario.name}`, async () => {
    const dir = tempDir();
    const { roots, sinceMs, timeZone } = scenario.build(dir);
    scenario.check(
      await assertThreeWaysAgree(
        dir,
        (reconcile) => readClaudeSessions(roots, sinceMs, timeZone, reconcile),
      ),
    );
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
    // The three reports came from three different paths, not one: the warm run
    // reused every row where the others parsed.
    const runtimeOf = (payload: Record<string, unknown>) =>
      payload.runtime as { indexed: boolean; index: IndexStats };
    expect(runtimeOf(plain).indexed).toBe(false);
    expect(runtimeOf(warm).index.filesReused).toBe(2);
    expect(runtimeOf(warm).index.bytesRead).toBe(0);
  } finally {
    process.env.COPILOT_API_HOME = savedHome;
  }
});
