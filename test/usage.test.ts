import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  discoverUsageDbs,
  foldUsageRequests,
  mergeUsageReports,
  parseUsageRow,
  readUsageRequests,
  record,
  sanitizeTokenCount,
  undatedUsage,
  usageReport,
} from "../src/usage/usage.ts";
import { dayKeyIn, localDayKey } from "../src/utils/time.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";

// Day keys are LOCAL calendar days, so expectations derive from the reader's own helper.
// Timestamps meant to share a day are written at the SAME instant; distinct days sit a full
// day apart, which lands on different local days in any runner zone (a fall-back transition
// could stretch a day to 25h, but these June dates avoid one).
const ms = (utc: string): number => Date.parse(utc);
const day = (utc: string): string => localDayKey(ms(utc));

/** The read and the fold composed, the way `agent cost` runs them. */
function readProxy(dbPaths: string[], sinceMs?: number, timeZone?: string) {
  return foldUsageRequests(readUsageRequests(dbPaths, sinceMs), dayKeyIn(timeZone));
}

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

// The ONE token-count sanitization rule both session readers apply.
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

// parseUsageRow is THE boundary between untyped SQLite output and the report. The file is
// external state a torn write or a hand edit can corrupt, so shapes a live daemon DB never
// holds are driven directly rather than through a DB that cannot produce all of them.
test("parseUsageRow normalizes every count, canonicalizes the model, and drops rows it cannot attribute", () => {
  const ok = parseUsageRow({
    tsMs: 100,
    model: "claude-opus-4-8-20260101",
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheCreation: 40,
  });
  expect(ok).toEqual({
    tsMs: 100,
    model: "claude-opus-4.8",
    buckets: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
  });

  // A bigint column (node:sqlite hands one back for an integer a double cannot hold, and
  // for every column under readBigInts) becomes a plain number, never leaks downstream.
  expect(parseUsageRow({ tsMs: 5n, model: "m", input: 7n })?.buckets.input).toBe(7);
  expect(parseUsageRow({ tsMs: 5n, model: "m" })?.tsMs).toBe(5);

  const clamped = parseUsageRow({
    tsMs: null,
    model: "m",
    input: -5,
    output: null,
    cacheRead: "700",
    cacheCreation: Number.NaN,
  });
  expect(clamped?.buckets).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  expect(clamped?.tsMs).toBeNull(); // no timestamp -> omitted from the per-day split

  expect(parseUsageRow({ model: null, input: 10 })).toBeNull();
  expect(parseUsageRow({ model: "", input: 10 })).toBeNull();
  expect(parseUsageRow({ model: 42, input: 10 })).toBeNull();
  expect(parseUsageRow(null)).toBeNull();
  expect(parseUsageRow("not a row")).toBeNull();
});

// record is the ONE owner of the report's two maps; every producer folds through it, so every
// source's totals-vs-split behaviour reduces to this contract.
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

// A column a live daemon never writes badly, but a torn write or a hand edit can: no model, hostile
// counts, no timestamp. The row is dropped, clamped, or kept out of the day split, never a phantom.
test("the proxy reader: an unattributable row is dropped, hostile counts clamp, an undated row reaches the totals only", () => {
  dir = tempDir("copilot-usage-");
  const path = join(dir, "copilot-api.sqlite");
  // No column constraints: the reader must survive a corrupt file, not just the daemon's.
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE token_usage_events (
    model, input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, created_at_ms, created_at_utc
  )`);
  const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  const at = "2026-06-01T00:00:00Z";
  insert.run("gpt-5.5", 100, 50, 0, 0, ms(at), at);
  insert.run(null, 999, 999, 0, 0, ms(at), at); // no model: cannot be attributed
  insert.run("negative", -5, -5, 0, 0, ms(at), at); // hostile counts: clamped, row kept
  // The daemon writes created_at_ms on every row, so this is defensive: the schema belongs to a
  // floating third-party package. A row without it cannot be placed on a local day, but its
  // tokens must still reach the totals.
  insert.run("gpt-5.5", 7, 0, 0, 0, null, at);
  db.close();

  const report = readProxy([path]);

  expect([...report.byModel.keys()].sort()).toEqual(["gpt-5.5", "negative"]);
  expect(report.byModel.get("negative")).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    events: 1,
  });
  expect(report.byModel.get("gpt-5.5")).toEqual({
    input: 107,
    output: 50,
    cacheRead: 0,
    cacheCreation: 0,
    events: 2,
  });
  expect(report.perDay.size).toBe(1);
  expect(report.perDay.get(day(at))?.size).toBe(2);
  expect(report.perDay.get(day(at))?.get("gpt-5.5")?.input).toBe(100);
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

test("the proxy reader sums tokens per canonical model across DBs and splits them by local day, the split reconciling with byModel", () => {
  dir = tempDir("copilot-usage-");
  const pathA = join(dir, "a.sqlite");
  const pathB = join(dir, "b.sqlite");
  seedUsageDb(pathA);

  // B shares a model and a day with A, plus a fresh model and a fresh day: SUM, not overwrite,
  // and a UNION of days, not a per-DB reset. Its shared model is spelled the Anthropic dashed,
  // Copilot dotted, and dated-snapshot ways: one canonical row, never three.
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
  const day1 = "2026-06-01T00:00:00Z";
  const day3 = "2026-06-03T00:00:00Z";
  insert.run("claude-opus-4-8", 1, 2, 1, 2, ms(day1), day1);
  insert.run("claude-opus-4.8", 10, 20, 0, 0, ms(day1), day1);
  insert.run("claude-opus-4-8-20260101", 100, 200, 0, 0, ms(day1), day1);
  insert.run("gemini-3.0", 9, 0, 0, 0, ms(day3), day3);
  db.close();

  const report = readProxy([pathA, pathB]);

  // A's 200/100/10/0 over two events plus B's 111/222/1/2 over three.
  const claude = { input: 311, output: 322, cacheRead: 11, cacheCreation: 2, events: 5 };
  const gpt = { input: 200, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 };
  const gemini = { input: 9, output: 0, cacheRead: 0, cacheCreation: 0, events: 1 };
  expect(report.byModel).toEqual(
    new Map([["claude-opus-4.8", claude], ["gpt-5.5", gpt], ["gemini-3.0", gemini]]),
  );
  // Every model's usage sits on one day, so each day's row is that model's byModel row.
  expect(report.perDay).toEqual(
    new Map([
      [day(day1), new Map([["claude-opus-4.8", claude]])],
      [day("2026-06-02T00:00:00Z"), new Map([["gpt-5.5", gpt]])],
      [day(day3), new Map([["gemini-3.0", gemini]])],
    ]),
  );
});

test("the proxy reader sinceMs filters older rows from token totals and active days", () => {
  dir = tempDir("copilot-usage-");
  const path = join(dir, "copilot-api.sqlite");
  seedUsageDb(path);

  // The cutoff sits at the gpt row's own timestamp: the boundary row is kept.
  const report = readProxy([path], ms("2026-06-02T00:00:00Z"));

  expect(report.byModel.has("claude-opus-4.8")).toBe(false);
  expect(report.byModel.get("gpt-5.5")?.input).toBe(200);
  expect(report.byModel.get("gpt-5.5")?.events).toBe(1);
  expect(report.perDay.size).toBe(1);
});

test("the proxy reader buckets by the user's local day, not the UTC day", () => {
  dir = tempDir("copilot-usage-");
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

  // The zone is NAMED rather than pinned through process.env.TZ, so this runs on Windows too
  // (deno honours the TZ env var on unix only). The SAME row in two zones keeps the teeth: a
  // reader that ignored the zone or sliced by UTC would return one key for both.
  expect([...readProxy([path], undefined, "America/New_York").perDay.keys()])
    .toEqual(["2026-06-01"]);
  expect([...readProxy([path], undefined, "UTC").perDay.keys()]).toEqual(["2026-06-02"]);
});

/** A set of database paths, some unreadable, and the report the readable ones give. */
const UNREADABLE_SETS: {
  name: string;
  files: (dir: string) => string[];
  inputs: Record<string, number>;
  days: number;
}[] = [
  {
    name: "a missing file",
    files: (dir) => {
      const good = join(dir, "good.sqlite");
      seedUsageDb(good);
      return [join(dir, "does-not-exist.sqlite"), good];
    },
    inputs: { "claude-opus-4.8": 200, "gpt-5.5": 200 },
    days: 2,
  },
  {
    name: "a corrupt file",
    files: (dir) => {
      const good = join(dir, "good.sqlite");
      const corrupt = join(dir, "corrupt.sqlite");
      seedUsageDb(good);
      writeFileSync(corrupt, "this is not a sqlite database");
      return [corrupt, good];
    },
    inputs: { "claude-opus-4.8": 200, "gpt-5.5": 200 },
    days: 2,
  },
  {
    name: "nothing but corrupt files",
    files: (dir) => {
      const corrupt = join(dir, "corrupt.sqlite");
      writeFileSync(corrupt, "garbage");
      return [corrupt];
    },
    inputs: {},
    days: 0,
  },
];

for (const { name, files, inputs, days } of UNREADABLE_SETS) {
  test(`the proxy reader skips ${name} without throwing and reports the readable ones`, () => {
    dir = tempDir("copilot-usage-");
    const report = readProxy(files(dir));
    expect(Object.fromEntries([...report.byModel].map(([m, u]) => [m, u.input]))).toEqual(inputs);
    expect(report.perDay.size).toBe(days);
  });
}

/** A home's directory tree (paths relative to the home) and the databases the sweep must find. */
const LAYOUTS: { name: string; dirs?: string[]; files: string[]; found: string[] }[] = [
  {
    // The per-host DBs under .run, the default home's and each named profile home's; a profile
    // home with no DB yet contributes nothing.
    name: "the per-host DBs under .run in the default and named profile daemon homes",
    dirs: ["profiles/fresh"],
    files: [".run/host-a/copilot-api.sqlite", "profiles/work/.run/host-a/copilot-api.sqlite"],
    found: [".run/host-a/copilot-api.sqlite", "profiles/work/.run/host-a/copilot-api.sqlite"],
  },
  {
    // The default daemon's DBs live under profiles/default (a name isValidProfileName REJECTS as
    // reserved, so the sweep must admit it explicitly). Control: a stray non-profile dir under
    // profiles/ carrying a DB must NOT be swept, proving the default is admitted by name, not
    // by the filter having gone permissive.
    name: "the DEFAULT profile's home, never a stray invalid dir",
    files: [
      "profiles/default/.run/host-a/copilot-api.sqlite",
      "profiles/.stray/.run/host-a/copilot-api.sqlite",
    ],
    found: ["profiles/default/.run/host-a/copilot-api.sqlite"],
  },
  {
    name: "neither a stray .run file nor a host dir missing the sqlite",
    files: [".run/stray.txt", ".run/host-empty/other.txt", ".run/host-good/copilot-api.sqlite"],
    found: [".run/host-good/copilot-api.sqlite"],
  },
  {
    // Absence is the PROVEN "nothing here" and must keep flowing silently: a fresh home has
    // neither .run nor profiles/, and `agent cost` must not raise on it.
    name: "nothing in a fresh home: absent dirs read as empty, never as a failure",
    files: [],
    found: [],
  },
];

for (const { name, dirs = [], files, found } of LAYOUTS) {
  test(`discoverUsageDbs finds ${name}`, () => {
    dir = tempDir("copilot-usage-");
    for (const rel of dirs) mkdirSync(join(dir, rel), { recursive: true });
    for (const rel of files) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), "");
    }
    expect(discoverUsageDbs(dir).sort()).toEqual(found.map((rel) => join(dir, rel)).sort());
  });
}

// A scan that FAILED must not read as an empty one: discoverUsageDbs backs a "no databases
// found" line and a summed cost TOTAL, so a silently short answer under-reports money. Only a
// MISSING directory is the proven "nothing here", the same narrowing as profileHomeNames in
// copilot_api/paths.ts.
//   ENOENT / ENOTDIR                 -> nothing here
//   a directory that cannot be read  -> raises; driven here as a real EACCES
// POSIX, non-root only: 0000 blocks the readdir, and root bypasses file modes.
const skipUnreadableDir = process.platform === "win32" || process.getuid?.() === 0;

for (const scanned of [".run", "profiles"]) {
  test.skipIf(skipUnreadableDir)(
    `an UNREADABLE ${scanned} dir raises instead of reporting nothing found`,
    () => {
      dir = tempDir("copilot-usage-");
      const blocked = join(dir, scanned);
      mkdirSync(blocked, { recursive: true });
      chmodSync(blocked, 0o000);
      try {
        let threw = "";
        try {
          discoverUsageDbs(dir);
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        // Positive assertion: a call that did NOT throw fails here rather than
        // passing on an empty string.
        expect(threw).toContain("EACCES");
      } finally {
        chmodSync(blocked, 0o755);
      }
    },
  );
}
