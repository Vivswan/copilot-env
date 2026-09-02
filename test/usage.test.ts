import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  discoverUsageDbs,
  mergeUsageReports,
  type ModelUsage,
  parseUsageRow,
  type ReadonlyUsageReport,
  readUsage,
  record,
  sanitizeTokenCount,
  undatedUsage,
  usageReport,
} from "../src/usage/usage.ts";
import { localDayKey } from "../src/utils/time.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

// Day keys are LOCAL calendar days now, so expectations derive from the same
// helper the reader uses; timestamps meant to share a day are written at the
// SAME instant, and distinct days sit a full day apart (which lands on
// different local days in any runner timezone -- a fall-back transition could
// stretch a day to 25h, but these June dates avoid one).
const ms = (utc: string): number => Date.parse(utc);
const day = (utc: string): string => localDayKey(ms(utc));

let dir = "";

afterEach(() => {
  if (dir) {
    // sqlite can briefly hold the DB file on Windows after close() (EBUSY),
    // so retry the cleanup; never let a temp-dir cleanup fail a passing test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // leaked temp dir is harmless on CI runners
    }
    dir = "";
  }
});

// The ONE token-count sanitization rule both session readers apply: only a finite
// positive number passes, floored to an integer; hostile or torn values become 0.
test("sanitizeTokenCount clamps non-finite, negative, and non-number counts to 0", () => {
  expect(sanitizeTokenCount(42)).toBe(42);
  expect(sanitizeTokenCount(0)).toBe(0);
  expect(sanitizeTokenCount(-5)).toBe(0);
  expect(sanitizeTokenCount(Number.NaN)).toBe(0);
  expect(sanitizeTokenCount(Number.POSITIVE_INFINITY)).toBe(0);
  expect(sanitizeTokenCount("7")).toBe(0);
  expect(sanitizeTokenCount(undefined)).toBe(0);
  // Counts are integral by nature; a fraction is a torn value and floors, which
  // is also what keeps report arithmetic (the undated remainder) exact.
  expect(sanitizeTokenCount(1.9)).toBe(1);
  expect(sanitizeTokenCount(0.4)).toBe(0);
});

// parseUsageRow is THE boundary between untyped SQLite output and the report. It runs on
// values a live daemon DB should never hold, because the file is external state a torn
// write or a hand edit can corrupt -- so the shapes below are driven directly rather than
// through a DB that cannot produce all of them.
test("parseUsageRow normalizes every count and drops rows it cannot attribute", () => {
  const ok = parseUsageRow({
    bucket: 100,
    model: "gpt-5.5",
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheCreation: 40,
    events: 2,
  });
  expect(ok).toEqual({
    bucket: 100,
    model: "gpt-5.5",
    buckets: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
    events: 2,
  });

  // A bigint column (node:sqlite hands one back for an integer a double cannot hold, and
  // for every column under readBigInts) becomes a plain number, never leaks downstream.
  expect(parseUsageRow({ bucket: 5n, model: "m", input: 7n, events: 1n })?.buckets.input).toBe(7);
  expect(parseUsageRow({ bucket: 5n, model: "m", events: 1 })?.bucket).toBe(5);

  // Hostile or absent counts clamp to 0 rather than reaching a report.
  const clamped = parseUsageRow({
    bucket: null,
    model: "m",
    input: -5,
    output: null,
    cacheRead: "700",
    cacheCreation: Number.NaN,
    events: 1,
  });
  expect(clamped?.buckets).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  expect(clamped?.bucket).toBeNull(); // no timestamp -> omitted from the per-day split

  // Nothing usable to attribute the row to -> the whole row is dropped.
  expect(parseUsageRow({ model: null, input: 10, events: 1 })).toBeNull();
  expect(parseUsageRow({ model: "", input: 10, events: 1 })).toBeNull();
  expect(parseUsageRow({ model: 42, input: 10, events: 1 })).toBeNull();
  expect(parseUsageRow(null)).toBeNull();
  expect(parseUsageRow("not a row")).toBeNull();
});

// record is the ONE owner of the report's two maps: every producer folds through it,
// so its contract -- always byModel, perDay only when a day is given -- is what every
// source's totals-vs-split behavior reduces to.
test("record folds into byModel always and into perDay only when a day is given", () => {
  const report = usageReport();
  record(report, "2026-06-01", "m", {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheCreation: 1,
    events: 1,
  });
  record(report, "2026-06-01", "m", {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheCreation: 1,
    events: 1,
  });
  // The day-less occurrence (a timestamp-less row) reaches the totals only.
  record(report, null, "m", { input: 3, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 });

  expect(report.byModel.get("m")).toEqual({
    input: 23,
    output: 10,
    cacheRead: 4,
    cacheCreation: 2,
    events: 3,
  });
  expect(report.perDay.size).toBe(1);
  expect(report.perDay.get("2026-06-01")?.get("m")).toEqual({
    input: 20,
    output: 10,
    cacheRead: 4,
    cacheCreation: 2,
    events: 2,
  });
});

test("record snapshots the increment, so an aliasing accumulator cannot double-count", () => {
  const report = usageReport();
  record(report, "2026-06-01", "m", {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheCreation: 1,
    events: 1,
  });
  // Fold the report's OWN byModel entry back in. Without the snapshot, the
  // byModel fold doubles that entry in place and the perDay fold then reads the
  // doubled values: 10 + 20 = 30 instead of 20.
  record(report, "2026-06-01", "m", report.byModel.get("m")!);

  const doubled = { input: 20, output: 10, cacheRead: 4, cacheCreation: 2, events: 2 };
  expect(report.byModel.get("m")).toEqual(doubled);
  expect(report.perDay.get("2026-06-01")?.get("m")).toEqual(doubled);
});

test("undatedUsage returns exactly the share of byModel no day accounts for", () => {
  const report = usageReport();
  record(report, "2026-06-01", "m", {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheCreation: 4,
    events: 1,
  });
  record(report, null, "m", { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 });
  record(report, "2026-06-02", "n", {
    input: 7,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });

  const rest = undatedUsage(report);
  expect(rest.get("m")).toEqual({
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  // A model the days fully cover is absent, not zero-filled.
  expect(rest.has("n")).toBe(false);
  // The remainder is a copy: the report keeps its full roll-up.
  expect(report.byModel.get("m")?.input).toBe(11);

  const dated = usageReport();
  record(dated, "2026-06-01", "m", {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  expect(undatedUsage(dated).size).toBe(0);
});

test("usageReport validates a hand-built perDay split against the byModel roll-up", () => {
  // The default mint is the empty report every producer folds into via record().
  const empty = usageReport();
  expect(empty.byModel.size).toBe(0);
  expect(empty.perDay.size).toBe(0);

  // A consistent pair passes through: the days may cover the roll-up partially
  // (the difference is undated usage).
  const byModel = new Map<string, ModelUsage>([
    ["m", { input: 5, output: 0, cacheRead: 0, cacheCreation: 0, events: 2 }],
  ]);
  const perDay = new Map([
    [
      "2026-06-01",
      new Map<string, ModelUsage>([
        ["m", { input: 3, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 }],
      ]),
    ],
  ]);
  const report = usageReport(byModel, perDay);
  expect(undatedUsage(report).get("m")?.input).toBe(2);

  // The factory deep-copies both maps top to bottom: the report never aliases
  // caller maps or entries, so a caller edit cannot invalidate a report
  // already validated.
  expect(report.byModel).not.toBe(byModel);
  expect(report.byModel.get("m")).not.toBe(byModel.get("m"));
  expect(report.perDay).not.toBe(perDay);
  expect(report.perDay.get("2026-06-01")).not.toBe(perDay.get("2026-06-01"));
  expect(report.perDay.get("2026-06-01")?.get("m")).not.toBe(perDay.get("2026-06-01")?.get("m"));
  byModel.get("m")!.input = 0;
  expect(report.byModel.get("m")?.input).toBe(5);

  // One ModelUsage object shared between the two maps cannot double-mutate:
  // record() folds into the report's own copies, never the caller's object.
  const shared: ModelUsage = { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 };
  const aliased = usageReport(
    new Map([["m", shared]]),
    new Map([["2026-06-01", new Map([["m", shared]])]]),
  );
  record(aliased, "2026-06-01", "m", {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  expect(aliased.byModel.get("m")?.input).toBe(2);
  expect(aliased.perDay.get("2026-06-01")?.get("m")?.input).toBe(2);
  expect(shared.input).toBe(1);

  // Days exceeding the roll-up -- even only when SUMMED across days -- are a
  // construction error, never a report whose undated remainder dips negative.
  const twoDays = new Map([
    [
      "2026-06-01",
      new Map<string, ModelUsage>([
        ["m", { input: 3, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 }],
      ]),
    ],
    [
      "2026-06-02",
      new Map<string, ModelUsage>([
        ["m", { input: 3, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 }],
      ]),
    ],
  ]);
  expect(() => usageReport(byModel, twoDays)).toThrow("inconsistent usage report");

  // Any bucket can trip it, events included.
  expect(() =>
    usageReport(
      new Map([["m", { input: 9, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 }]]),
      new Map([
        [
          "2026-06-01",
          new Map([["m", { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, events: 2 }]]),
        ],
      ]),
    )
  ).toThrow("inconsistent usage report");

  // A perDay model byModel does not carry at all is inconsistent too.
  expect(() => usageReport(new Map(), perDay)).toThrow("inconsistent usage report");

  // Hostile counts are rejected, not compared -- NaN passes every ordering
  // check, so admitting one would let the split validation fail open. Every
  // bucket is checked, on both maps.
  const zero: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0 };
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
    expect(() => usageReport(new Map([["m", { ...zero, input: bad }]]))).toThrow(
      "invalid usage report",
    );
  }
  for (const field of ["input", "output", "cacheRead", "cacheCreation", "events"] as const) {
    expect(() => usageReport(new Map([["m", { ...zero, [field]: -1 }]]))).toThrow(
      "invalid usage report",
    );
    // The perDay side runs the same check: byModel here is valid and would
    // cover the split, so only the entry validation can be what throws.
    expect(() =>
      usageReport(
        new Map([["m", { ...zero, [field]: 1 }]]),
        new Map([["2026-06-01", new Map([["m", { ...zero, [field]: Number.NaN }]])]]),
      )
    ).toThrow("invalid usage report");
  }
});

test("undatedUsage fails fast on a perDay model that byModel does not carry", () => {
  // Impossible via record()/usageReport(); a structurally hand-built report
  // that reaches this state is corrupt and must surface, not print low totals.
  const corrupt: ReadonlyUsageReport = {
    byModel: new Map(),
    perDay: new Map([
      [
        "2026-06-01",
        new Map([["m", { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 }]]),
      ],
    ]),
  };
  expect(() => undatedUsage(corrupt)).toThrow("inconsistent usage report");
});

test("mergeUsageReports sums models, unions days, and keeps day-less usage in the totals", () => {
  const a = usageReport();
  record(a, "2026-06-01", "m", { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, events: 1 });
  // Day-less usage lives in byModel only; the merge must not lose it.
  record(a, null, "m", { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 });

  const b = usageReport();
  record(b, "2026-06-01", "m", {
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  record(b, "2026-06-02", "n", { input: 7, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 });
  // A day with an empty model map still counts as active in the union.
  b.perDay.set("2026-06-03", new Map());

  const merged = mergeUsageReports([a, b]);

  expect(merged.byModel.get("m")).toEqual({
    input: 111,
    output: 2,
    cacheRead: 3,
    cacheCreation: 4,
    events: 3,
  });
  expect(merged.byModel.get("n")?.input).toBe(7);
  expect([...merged.perDay.keys()].sort()).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  // The shared day sums across reports; the day-less share stays out of it.
  expect(merged.perDay.get("2026-06-01")?.get("m")).toEqual({
    input: 101,
    output: 2,
    cacheRead: 3,
    cacheCreation: 4,
    events: 2,
  });
  // The merge folded copies, never references: mutating the merged report must
  // not reach back into a source, and the sources are unchanged.
  expect(merged.byModel.get("m")).not.toBe(a.byModel.get("m"));
  expect(merged.byModel.get("m")).not.toBe(b.byModel.get("m"));
  expect(merged.perDay.get("2026-06-01")?.get("m")).not.toBe(a.perDay.get("2026-06-01")?.get("m"));
  expect(merged.perDay.get("2026-06-01")?.get("m")).not.toBe(b.perDay.get("2026-06-01")?.get("m"));
  const mergedM = merged.byModel.get("m");
  if (mergedM !== undefined) mergedM.input += 1_000;
  const mergedDayM = merged.perDay.get("2026-06-01")?.get("m");
  if (mergedDayM !== undefined) mergedDayM.input += 1_000;
  expect(a.byModel.get("m")?.input).toBe(11);
  expect(a.perDay.get("2026-06-01")?.get("m")?.input).toBe(1);
  expect(b.perDay.get("2026-06-01")?.get("m")?.input).toBe(100);
});

test("readUsage drops an unattributable DB row instead of reporting a phantom model", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  // No column constraints: the reader must survive a corrupt file, not just the daemon's.
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model, input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, created_at_ms, created_at_utc
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  const t = ms("2026-06-01T00:00:00Z");
  insert.run("gpt-5.5", 100, 50, 0, 0, t, "x");
  insert.run(null, 999, 999, 0, 0, t, "x"); // no model: cannot be attributed
  insert.run("negative", -5, -5, 0, 0, t, "x"); // hostile counts: clamped, row kept
  db.close();

  const report = readUsage([path]);

  expect([...report.byModel.keys()].sort()).toEqual(["gpt-5.5", "negative"]);
  expect(report.byModel.get("negative")).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  // The dropped row contributed nothing to the totals or the per-day split.
  expect(report.byModel.get("gpt-5.5")?.input).toBe(100);
  expect(report.perDay.get(day("2026-06-01T00:00:00Z"))?.size).toBe(2);
});

function seedUsageDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  const day1 = "2026-06-01T00:00:00Z";
  const day2 = "2026-06-02T00:00:00Z";
  insert.run("claude-opus-4.8", 100, 50, 0, 0, ms(day1), day1);
  insert.run("claude-opus-4.8", 100, 50, 10, 0, ms(day1), day1);
  insert.run("gpt-5.5", 200, 0, 0, 0, ms(day2), day2);
  db.close();
}

test("readUsage sums tokens per model and counts distinct active days", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  const report = readUsage([path]);

  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 200,
    output: 100,
    cacheRead: 10,
    cacheCreation: 0,
    events: 2,
  });
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.perDay.size).toBe(2);
});

test("readUsage exposes a per-day, per-model breakdown that reconciles with byModel", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  const report = readUsage([path]);

  // perDay keys are the distinct LOCAL calendar days.
  expect([...report.perDay.keys()].sort()).toEqual([
    day("2026-06-01T00:00:00Z"),
    day("2026-06-02T00:00:00Z"),
  ]);

  // The first day carried both claude rows (100+100 input, 50+50 output, 0+10 cache read).
  expect(report.perDay.get(day("2026-06-01T00:00:00Z"))?.get("claude-opus-4.8")).toEqual({
    input: 200,
    output: 100,
    cacheRead: 10,
    cacheCreation: 0,
    events: 2,
  });
  // The second day carried only the gpt row.
  expect(report.perDay.get(day("2026-06-02T00:00:00Z"))?.get("gpt-5.5")?.input).toBe(200);
  expect(report.perDay.get(day("2026-06-02T00:00:00Z"))?.has("claude-opus-4.8")).toBe(false);
});

test("readUsage folds divergent spellings of one model into the canonical row", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  // Anthropic dashed, Copilot dotted, and dated-snapshot ids of one model.
  const at = "2026-06-01T00:00:00Z";
  insert.run("claude-opus-4-8", 1, 2, 0, 0, ms(at), at);
  insert.run("claude-opus-4.8", 10, 20, 0, 0, ms(at), at);
  insert.run("claude-opus-4-8-20260101", 100, 200, 0, 0, ms(at), at);
  db.close();

  const report = readUsage([path]);

  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 111,
    output: 222,
    cacheRead: 0,
    cacheCreation: 0,
    events: 3,
  });
  expect(report.byModel.size).toBe(1);
  expect(report.perDay.get(day(at))?.get("claude-opus-4.8")?.events).toBe(3);
});

test("readUsage sums tokens by model and unions active days across two DBs", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const pathA = join(dir, "a.sqlite");
  const pathB = join(dir, "b.sqlite");
  seedUsageDb(pathA);

  // DB B shares the "claude-opus-4.8" model and the 2026-06-01 day with A, plus
  // a fresh model and a fresh day, so we can prove SUM (not overwrite) and a
  // UNION of distinct days (not a per-DB reset).
  const db = new DatabaseSync(pathB);
  db.exec(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("claude-opus-4.8", 5, 7, 1, 2, ms("2026-06-01T00:00:00Z"), "2026-06-01T00:00:00Z");
  insert.run("gemini-3.0", 9, 0, 0, 0, ms("2026-06-03T00:00:00Z"), "2026-06-03T00:00:00Z");
  db.close();

  const report = readUsage([pathA, pathB]);

  // claude-opus-4.8: A (200/100/10/0/2 events) summed with B (5/7/1/2/1 event).
  expect(report.byModel.get("claude-opus-4.8")).toEqual({
    input: 205,
    output: 107,
    cacheRead: 11,
    cacheCreation: 2,
    events: 3,
  });
  // Models only in one DB carry through untouched.
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.byModel.get("gemini-3.0")?.input).toBe(9);
  // Distinct days: 2026-06-01 (both DBs), 2026-06-02 (A), 2026-06-03 (B) = 3.
  expect(report.perDay.size).toBe(3);
});

test("readUsage sinceMs filters older rows from token totals and active days", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  // Seed rows live on 2026-06-01 (claude) and 2026-06-02 (gpt). A cutoff at
  // the gpt row's own timestamp keeps only the gpt row.
  const report = readUsage([path], ms("2026-06-02T00:00:00Z"));

  expect(report.byModel.has("claude-opus-4.8")).toBe(false);
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.byModel.get("gpt-5.5")?.events).toBe(1);
  // Only 2026-06-02 survives the cutoff.
  expect(report.perDay.size).toBe(1);
});

test("readUsage buckets by the user's local day, not the UTC day", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  // 2026-06-02T01:00Z is 2026-06-01 21:00 in New York (UTC-4 in June).
  const at = "2026-06-02T01:00:00Z";
  db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "gpt-5.5",
    1,
    0,
    0,
    0,
    ms(at),
    at,
  );
  db.close();

  // The zone is NAMED rather than pinned through process.env.TZ, so this runs on Windows
  // too (deno honors the TZ env var on unix only). Asserting the SAME row in two zones
  // is what keeps the teeth on every runner: a reader that ignored the zone -- or sliced
  // by UTC -- would have to return one key for both, and these two differ.
  expect([...readUsage([path], undefined, "America/New_York").perDay.keys()])
    .toEqual(["2026-06-01"]);
  expect([...readUsage([path], undefined, "UTC").perDay.keys()]).toEqual(["2026-06-02"]);
});

test("readUsage rejects an unknown zone before it opens a single database", () => {
  // Resolved lazily, a bad zone would raise RangeError per row inside the per-path catch,
  // which reports it as an unreadable DB and returns a report missing its per-day split.
  expect(() => readUsage([], undefined, "Not/AZone")).toThrow();
});

test("a null created_at_ms row counts in byModel but is dropped from perDay", () => {
  // The daemon writes created_at_ms on every row, so this is defensive: the
  // schema belongs to a floating third-party package. A row without it can't
  // be placed on a local day, but its tokens must still reach the totals.
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const path = join(dir, "copilot-api.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    created_at_ms INTEGER,
    created_at_utc TEXT
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("gpt-5.5", 7, 0, 0, 0, null, "2026-06-01T00:00:00Z");
  insert.run("gpt-5.5", 1, 0, 0, 0, ms("2026-06-01T00:00:00Z"), "2026-06-01T00:00:00Z");
  db.close();

  const report = readUsage([path]);

  expect(report.byModel.get("gpt-5.5")).toEqual({
    input: 8,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
  // Only the dated row appears in the per-day split.
  expect(report.perDay.size).toBe(1);
  expect(report.perDay.get(day("2026-06-01T00:00:00Z"))?.get("gpt-5.5")?.input).toBe(1);
});

test("readUsage skips a missing DB and still reports the readable ones", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const good = join(dir, "good.sqlite");
  const missing = join(dir, "does-not-exist.sqlite");
  seedUsageDb(good);

  const report = readUsage([missing, good]);

  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.perDay.size).toBe(2);
});

test("readUsage skips a corrupt DB file without throwing", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const good = join(dir, "good.sqlite");
  const corrupt = join(dir, "corrupt.sqlite");
  seedUsageDb(good);
  // Not a valid SQLite file; opening/querying it must be caught and skipped.
  writeFileSync(corrupt, "this is not a sqlite database");

  const report = readUsage([corrupt, good]);

  // The good DB still contributes its full totals; the corrupt one is dropped.
  expect(report.byModel.get("claude-opus-4.8")?.input).toBe(200);
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.perDay.size).toBe(2);
});

test("readUsage on an all-corrupt set returns an empty report, no throw", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const corrupt = join(dir, "corrupt.sqlite");
  writeFileSync(corrupt, "garbage");

  const report = readUsage([corrupt]);

  expect(report.byModel.size).toBe(0);
  expect(report.perDay.size).toBe(0);
});

test("discoverUsageDbs finds the legacy file plus per-host DBs", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const legacy = join(dir, "copilot-api.sqlite");
  writeFileSync(legacy, "");

  const hostDir = join(dir, ".run", "host-a");
  mkdirSync(hostDir, { recursive: true });
  const hostDb = join(hostDir, "copilot-api.sqlite");
  writeFileSync(hostDb, "");

  const found = discoverUsageDbs(dir);

  expect(found).toContain(legacy);
  expect(found).toContain(hostDb);
  expect(found).toHaveLength(2);
});

test("discoverUsageDbs also sweeps named profile daemon homes", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));

  const defaultHost = join(dir, ".run", "host-a");
  mkdirSync(defaultHost, { recursive: true });
  const defaultDb = join(defaultHost, "copilot-api.sqlite");
  writeFileSync(defaultDb, "");

  // A named profile's isolated daemon home carries its own per-host DB.
  const profileHost = join(dir, "profiles", "work", ".run", "host-a");
  mkdirSync(profileHost, { recursive: true });
  const profileDb = join(profileHost, "copilot-api.sqlite");
  writeFileSync(profileDb, "");

  // A profile home with no DB yet contributes nothing.
  mkdirSync(join(dir, "profiles", "fresh"), { recursive: true });

  const found = discoverUsageDbs(dir);

  expect(found).toContain(defaultDb);
  expect(found).toContain(profileDb);
  expect(found).toHaveLength(2);
});

test("discoverUsageDbs excludes a stray .run file and a host dir missing the sqlite", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));

  // A stray plain file sitting directly under .run/ (not a host directory).
  const runDir = join(dir, ".run");
  mkdirSync(runDir, { recursive: true });
  const strayFile = join(runDir, "stray.txt");
  writeFileSync(strayFile, "not a host dir");

  // A host directory that exists but has no copilot-api.sqlite inside it.
  const emptyHost = join(runDir, "host-empty");
  mkdirSync(emptyHost, { recursive: true });
  writeFileSync(join(emptyHost, "other.txt"), "no db here");

  // A real host directory that does carry the sqlite.
  const goodHost = join(runDir, "host-good");
  mkdirSync(goodHost, { recursive: true });
  const goodDb = join(goodHost, "copilot-api.sqlite");
  writeFileSync(goodDb, "");

  const found = discoverUsageDbs(dir);

  expect(found).toEqual([goodDb]);
  expect(found).not.toContain(strayFile);
});
