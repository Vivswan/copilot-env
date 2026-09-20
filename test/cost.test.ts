import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type IndexStats, parseEveryCandidate, type Reconcile } from "../src/usage/contribution.ts";
import {
  buildSourceJson,
  type CostArgs,
  type CostDeps,
  type CostRuntime,
  formatBytesCompact,
  formatTokensCompact,
  ReconcileMeter,
  runCost,
  type SessionRootDiscovery,
  sumDayTotals,
} from "../src/usage/cost.ts";
import {
  activeDayCoverage,
  computeDayMetrics,
  daysCutoffMs,
  describeDaysWindow,
  median,
  parseDaysWindow,
  parseWindowFlags,
  perDayRows,
  UNDATED_DAY_LABEL,
} from "../src/usage/day_metrics.ts";
import { consola } from "consola";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { openUsageIndex } from "../src/usage/index.ts";
import { USAGE_INDEX_DIR_NAME } from "../src/copilot_api/paths.ts";
import {
  estimateCost,
  loadPricing,
  type ModelCost,
  type PricingTier,
} from "../src/usage/pricing.ts";
import { type ModelUsage, record, type UsageReport, usageReport } from "../src/usage/usage.ts";
import { localDayKey, MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { captureAllWrites, captureChannels } from "./helpers/output.ts";
import {
  assistantLine,
  claudeUsage,
  codexUsage,
  type ProxyRow,
  sessionMeta,
  tokenCount,
  turnContext,
  writeProxyDb,
  writeRollout,
  writeTranscript,
} from "./helpers/session_fixtures.ts";
import { expect, tempDir, test, TZ_PINNABLE } from "./helpers/testing.ts";
import { indexDbFile, storedIndexPaths } from "./helpers/usage_index.ts";

function usage(partial: Partial<ModelUsage>): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0, ...partial };
}

/** Folded through record(), the real producer path; `undated` usage reaches byModel only. */
function makeReport(
  perDay: Record<string, Record<string, ModelUsage>>,
  undated: Record<string, ModelUsage> = {},
): UsageReport {
  const report = usageReport();
  for (const [day, models] of Object.entries(perDay)) {
    for (const [model, u] of Object.entries(models)) {
      record(report, day, model, u);
    }
  }
  for (const [model, u] of Object.entries(undated)) {
    record(report, null, model, u);
  }
  return report;
}

test("median handles odd, even, and empty samples", () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(median([])).toBe(0);
  expect(median([42])).toBe(42);
});

test("activeDayCoverage measures the inclusive min..max span and density", () => {
  const report = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
    "2026-06-03": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
    "2026-06-05": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
  });
  expect(activeDayCoverage(report)).toEqual({ spanDays: 5, percent: 60 });

  const one = makeReport({ "2026-06-01": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) } });
  expect(activeDayCoverage(one)).toEqual({ spanDays: 1, percent: 100 });

  // Zero days reads 100%: the printer shows "0 active days" instead of a percentage.
  expect(activeDayCoverage(makeReport({}))).toEqual({ spanDays: 0, percent: 100 });
});

test("computeDayMetrics sums tokens per day and reconciles cost with the aggregate", () => {
  // Ragged counts land every per-day, per-model cost on a fraction of a cent, so the
  // reconciliation holds only while stored costs stay exact; a 4dp rounding mid-pipeline
  // shifts the day sum far past the tolerance.
  const report = makeReport({
    "2026-06-01": {
      "openai/gpt-5.5": usage({ input: 1_234_567, output: 89_012, events: 3 }),
      "anthropic/claude-opus-4.8": usage({ input: 456_789, cacheRead: 7_654_321, events: 2 }),
    },
    "2026-06-02": {
      "openai/gpt-5.5": usage({ input: 3_333_337, output: 101_113, events: 2 }),
    },
    "2026-06-03": {
      "anthropic/claude-opus-4.8": usage({
        input: 999_983,
        output: 31_337,
        cacheCreation: 271_828,
        events: 1,
      }),
    },
  });
  const pricing = new Map<string, PricingTier>([
    ["openai/gpt-5.5", { input: 1.25, output: 10 }],
    ["anthropic/claude-opus-4.8", { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ]);
  const estimate = estimateCost(report, pricing);
  const days = computeDayMetrics(report, pricing, estimate).sort((a, b) =>
    a.day.localeCompare(b.day)
  );

  expect(days.map((d) => d.day)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  // Day 1 tokens: 1,234,567 + 89,012 + 456,789 + 7,654,321.
  expect(days[0]?.total).toBe(9_434_689);
  // Day 1 cost: gpt 1.234567*1.25 + 0.089012*10, claude 0.456789*15 + 7.654321*1.5.
  expect(days[0]?.cost).toBeCloseTo(1.54320875 + 0.89012 + 6.851835 + 11.4814815, 8);
  // Per-day costs sum to the aggregate total to a float ulp: both sides sum the
  // same unrounded per-model costs, merely grouped differently.
  const dayCostSum = days.reduce((s, d) => s + d.cost, 0);
  expect(dayCostSum).toBeCloseTo(estimate.totalUsd, 10);
});

test("computeDayMetrics keeps a model unpriced in the aggregate at $0 every day", () => {
  // Day 1 alone uses cacheCreation, which the pricing omits, so the aggregate is unpriced.
  // Day 2 would be priceable in isolation and must still contribute $0, or the breakdown
  // stops reconciling with the excluded aggregate.
  const report = makeReport({
    "2026-06-01": {
      "anthropic/claude-opus-4.8": usage({ input: 1_000_000, cacheCreation: 50, events: 1 }),
    },
    "2026-06-02": { "anthropic/claude-opus-4.8": usage({ input: 3_000_000, events: 1 }) },
  }, {
    // Undated usage of the same model: its synthetic row obeys the same rule.
    "anthropic/claude-opus-4.8": usage({ input: 500_000, events: 1 }),
  });
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 1, output: 2 }], // no cacheCreation rate
  ]);
  const estimate = estimateCost(report, pricing);

  expect(estimate.unpriced).toContain("anthropic/claude-opus-4.8");
  expect(estimate.totalUsd).toBe(0);

  const days = computeDayMetrics(report, pricing, estimate);
  for (const d of days) {
    expect(d.cost).toBe(0);
    expect(d.inputCost).toBe(0);
  }
  const undated = perDayRows(report, pricing, estimate).find((r) => r.kind === "undated");
  expect(undated?.input).toBe(500_000);
  expect(undated?.cost).toBe(0);
});

test("sumDayTotals carries the aggregate's cost numbers, bit-exact", () => {
  // 4 + 4_996 tokens at $1/M: the aggregate prices 5_000 tokens ($0.005) while
  // the day costs sum to 0.004999999999999999 -- one ulp apart, which toFixed(2)
  // stretches into $0.01 vs $0.00. The per-day TOTAL row must therefore carry
  // the aggregate's exact doubles, never the column sum.
  const report = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 4, events: 1 }) },
    "2026-06-02": { "openai/gpt-5.5": usage({ input: 4_996, events: 1 }) },
  });
  const pricing = new Map<string, PricingTier>([["openai/gpt-5.5", { input: 1 }]]);
  const estimate = estimateCost(report, pricing);
  const days = computeDayMetrics(report, pricing, estimate);

  // Control: this fixture really does regroup differently.
  expect(days.reduce((s, d) => s + d.cost, 0)).not.toBe(estimate.totalUsd);

  const total = sumDayTotals(days, estimate);
  expect(total.cost).toBe(estimate.totalUsd);
  expect(total.inputCost).toBe(estimate.perModel["openai/gpt-5.5"]?.inputCostUsd);
  expect(total.input).toBe(5_000);
  expect(total.reqs).toBe(2);
});

test("undated usage prints as its own row so the TOTAL's columns add up", () => {
  // 1M dated + 1M undated at $1/M. The TOTAL cost is the aggregate's ($2.00);
  // without the undated row the token columns above it summed only the dated
  // 1M, rendering "1M tokens, $2.00" -- the row must surface the missing 1M.
  const report = makeReport(
    {
      // Days deliberately recorded out of order: the rows must sort.
      "2026-06-02": { "openai/gpt-5.5": usage({ input: 300_000, events: 1 }) },
      "2026-06-01": { "openai/gpt-5.5": usage({ input: 700_000, events: 1 }) },
    },
    { "openai/gpt-5.5": usage({ input: 1_000_000, events: 1 }) },
  );
  const pricing = new Map<string, PricingTier>([["openai/gpt-5.5", { input: 1 }]]);
  const estimate = estimateCost(report, pricing);

  // computeDayMetrics stays dated-only (per-day medians are per-DAY statistics).
  expect(computeDayMetrics(report, pricing, estimate).map((d) => d.day).sort()).toEqual([
    "2026-06-01",
    "2026-06-02",
  ]);

  // The undated label is applied at render time only; its spelling is a display contract.
  expect(UNDATED_DAY_LABEL).toBe("(undated)");
  const rows = perDayRows(report, pricing, estimate);
  expect(rows.map((r) => r.kind)).toEqual(["dated", "dated", "undated"]);
  expect(rows.flatMap((r) => (r.kind === "dated" ? r.day : []))).toEqual([
    "2026-06-01",
    "2026-06-02",
  ]);
  const undated = rows[2]!;
  expect(undated.input).toBe(1_000_000);
  expect(undated.reqs).toBe(1);
  expect(undated.cost).toBeCloseTo(1, 10);

  const total = sumDayTotals(rows, estimate);
  expect(total.input).toBe(2_000_000);
  expect(total.total).toBe(2_000_000);
  expect(total.reqs).toBe(3);
  expect(total.cost).toBe(estimate.totalUsd);
  expect(estimate.totalUsd).toBe(2);

  const allUndated = makeReport({}, { "openai/gpt-5.5": usage({ input: 42, events: 1 }) });
  const undatedEstimate = estimateCost(allUndated, pricing);
  expect(perDayRows(allUndated, pricing, undatedEstimate).map((r) => r.kind)).toEqual([
    "undated",
  ]);

  const dated = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 5, events: 1 }) },
  });
  expect(
    perDayRows(dated, pricing, estimateCost(dated, pricing))
      .map((r) => (r.kind === "dated" ? r.day : r.kind)),
  ).toEqual(["2026-06-01"]);

  // The JSON contract is deliberately different: usageByModel and totalUsd
  // cover undated usage, while the perDay array stays dated-only.
  const json = buildSourceJson(report, estimate, pricing, { perDay: true });
  const byModel = json.usageByModel as Record<string, ModelUsage>;
  expect(byModel["openai/gpt-5.5"]?.input).toBe(2_000_000);
  expect(json.totalUsd).toBe(2);
  const perDay = json.perDay as Array<{ day: string; costUsd: number }>;
  expect(perDay.map((d) => d.day)).toEqual(["2026-06-01", "2026-06-02"]);
  // Avg/day spreads the aggregate (undated included) over the dated active
  // days by design: $2 across 2 active days, not the $0.50/day the dated rows
  // alone would average.
  expect(json.avgCostPerDayUsd).toBe(1);
});

test("buildSourceJson rounds every USD field once at the boundary", () => {
  // 333_333 tokens at $1.5/M = 0.4999995 per bucket: exact in the estimate,
  // 0.5 in the JSON. Total = 1.999998 -> 2 for the total/avg/median fields.
  const report = makeReport({
    "2026-06-01": {
      "openai/gpt-5.5": usage({
        input: 333_333,
        output: 333_333,
        cacheRead: 333_333,
        cacheCreation: 333_333,
        events: 1,
      }),
    },
  });
  const pricing = new Map<string, PricingTier>([
    ["openai/gpt-5.5", { input: 1.5, output: 1.5, cacheRead: 1.5, cacheCreation: 1.5 }],
  ]);
  const estimate = estimateCost(report, pricing);
  expect(estimate.totalUsd).not.toBe(2); // control: the input is unrounded

  const json = buildSourceJson(report, estimate, pricing, { perDay: true });
  expect(json.totalUsd).toBe(2);
  expect(json.avgCostPerDayUsd).toBe(2);
  expect(json.medianCostPerDayUsd).toBe(2);
  const cost = (json.perModel as Record<string, ModelCost>)["openai/gpt-5.5"];
  expect(cost?.inputCostUsd).toBe(0.5);
  expect(cost?.outputCostUsd).toBe(0.5);
  expect(cost?.cacheReadCostUsd).toBe(0.5);
  expect(cost?.cacheCreationCostUsd).toBe(0.5);
  expect(cost?.estimatedCostUsd).toBe(2);
  const perDay = json.perDay as Array<{ costUsd: number }>;
  expect(perDay[0]?.costUsd).toBe(2);
  // The estimate itself stays exact: the boundary rounds a copy.
  expect(estimate.perModel["openai/gpt-5.5"]?.inputCostUsd).not.toBe(0.5);
});

test("parseDaysWindow admits exactly two spellings and tells them apart", () => {
  // Number("1.0") === 1, so only the raw text can carry the distinction; and Number()
  // admits far more than the two spellings, so every other shape must be rejected
  // rather than silently landing in a window kind.
  const cases: Array<[string, { kind: "calendar" | "exact"; days: number } | null]> = [
    ["1", { kind: "calendar", days: 1 }],
    ["7", { kind: "calendar", days: 7 }],
    ["1.0", { kind: "exact", days: 1 }],
    ["0.5", { kind: "exact", days: 0.5 }],
    [".5", { kind: "exact", days: 0.5 }],
    ["1.", { kind: "exact", days: 1 }],
    ["1.5", { kind: "exact", days: 1.5 }],
    // Not positive.
    ["0", null],
    ["0.0", null],
    ["-1", null],
    // Number() would accept these; the flag must not.
    ["+1", null],
    [" 1", null],
    ["1 ", null],
    ["1e0", null],
    ["0x10", null],
    ["1_000", null],
    ["Infinity", null],
    // Not numbers at all.
    ["", null],
    ["abc", null],
    ["NaN", null],
    ["1.2.3", null],
    // The longest window Date can place a cutoff for is exactly 1e8 days.
    ["100000000", { kind: "calendar", days: 100_000_000 }],
    ["100000000.0", { kind: "exact", days: 100_000_000 }],
  ];
  for (const [raw, want] of cases) {
    if (want === null) {
      expect(() => parseDaysWindow(raw), raw).toThrow("--days must be a positive number");
    } else {
      expect(parseDaysWindow(raw), raw).toEqual(want);
    }
  }
  // Beyond Date's range there is no valid cutoff instant: a distinct error, since the
  // number itself is fine.
  for (const raw of ["100000001", "100000000.5", "1".repeat(400)]) {
    expect(() => parseDaysWindow(raw), raw).toThrow("--days must be at most 100000000");
  }
});

test("daysCutoffMs: an exact window is a plain multiple of 24 hours", () => {
  const now = Date.UTC(2026, 5, 15, 13, 47, 5);
  expect(daysCutoffMs({ kind: "exact", days: 1 }, now)).toBe(now - MILLISECONDS_PER_DAY);
  expect(daysCutoffMs({ kind: "exact", days: 0.5 }, now)).toBe(now - MILLISECONDS_PER_DAY / 2);
  expect(daysCutoffMs({ kind: "exact", days: 2.5 }, now)).toBe(now - 2.5 * MILLISECONDS_PER_DAY);
});

function dayKeyDistance(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MILLISECONDS_PER_DAY,
  );
}

test("daysCutoffMs: a calendar window starts at the local midnight N-1 days back", () => {
  // Assertions are phrased through localDayKey, the same system-zone day key the
  // readers split on, so they hold in whatever zone the runner sits in.
  const now = Date.UTC(2026, 5, 15, 13, 47, 5);
  for (const days of [1, 2, 7, 30]) {
    const cutoff = daysCutoffMs({ kind: "calendar", days }, now);
    // A real day boundary: the instant before the cutoff is the previous local day.
    expect(localDayKey(cutoff - 1)).not.toBe(localDayKey(cutoff));
    expect(localDayKey(cutoff) < localDayKey(now)).toBe(days > 1);
    expect(dayKeyDistance(localDayKey(cutoff), localDayKey(now))).toBe(days - 1);
    expect(cutoff <= now).toBe(true);
  }
  // `1` is today alone: the cutoff is today's own local midnight.
  expect(localDayKey(daysCutoffMs({ kind: "calendar", days: 1 }, now))).toBe(localDayKey(now));
});

// Pinned to America/New_York (2026: springs forward Mar 8, falls back Nov 1), so the
// 23- and 25-hour days are known instants. Save/restore by explicit zone name, never
// delete (TZ assignments are ignored after a delete; see test/time.test.ts). Deno honours
// the TZ env var on unix only, so the case is skipped where the zone cannot be pinned.
test.skipIf(!TZ_PINNABLE)(
  "daysCutoffMs: a calendar window's midnight is a real local midnight across DST, month, and year rollovers",
  () => {
    const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      process.env.TZ = "America/New_York";
      const cal = (days: number, nowIso: string): string =>
        new Date(daysCutoffMs({ kind: "calendar", days }, Date.parse(nowIso))).toISOString();
      // Spring forward: Mar 8 is 23 hours long. Today's midnight is EST (05:00Z); the
      // day after starts in EDT (04:00Z), 23h later, not 24.
      expect(cal(1, "2026-03-08T17:00:00Z")).toBe("2026-03-08T05:00:00.000Z");
      expect(cal(2, "2026-03-09T17:00:00Z")).toBe("2026-03-08T05:00:00.000Z");
      expect(cal(1, "2026-03-09T17:00:00Z")).toBe("2026-03-09T04:00:00.000Z");
      // Fall back: Nov 1 is 25 hours long. Late on Nov 1 (23:30 EST = 04:30Z Nov 2),
      // "today" still starts at Nov 1's EDT midnight (04:00Z), 24.5h earlier.
      expect(cal(1, "2026-11-02T04:30:00Z")).toBe("2026-11-01T04:00:00.000Z");
      expect(cal(2, "2026-11-02T17:00:00Z")).toBe("2026-11-01T04:00:00.000Z");
      // Month rollover: 23:00 EDT on Jun 30 is already Jul 1 in UTC; the window is local.
      expect(cal(1, "2026-07-01T03:00:00Z")).toBe("2026-06-30T04:00:00.000Z");
      expect(cal(2, "2026-07-01T03:00:00Z")).toBe("2026-06-29T04:00:00.000Z");
      // Year rollover: 23:30 EST on Dec 31 2025 (04:30Z Jan 1 2026).
      expect(cal(1, "2026-01-01T04:30:00Z")).toBe("2025-12-31T05:00:00.000Z");
      expect(cal(3, "2026-01-01T04:30:00Z")).toBe("2025-12-29T05:00:00.000Z");
    } finally {
      process.env.TZ = savedTz;
    }
  },
);

// The month is GitHub's own period (agent credits reports the same one): it starts at 00:00 UTC
// on the 1st in every zone, where a calendar day starts at the LOCAL midnight.
test.skipIf(!TZ_PINNABLE)(
  "the month window starts at 00:00 UTC on the 1st, not at the local midnight a calendar day uses",
  () => {
    const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      // UTC+14: local Sep 1 begins at Aug 31 10:00Z, fourteen hours before GitHub's month.
      process.env.TZ = "Pacific/Kiritimati";
      const now = Date.parse("2026-09-01T02:00:00Z");
      const monthStart = daysCutoffMs({ kind: "month" }, now);
      const todayStart = daysCutoffMs({ kind: "calendar", days: 1 }, now);
      expect(new Date(monthStart).toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(new Date(todayStart).toISOString()).toBe("2026-08-31T10:00:00.000Z");
      // A request late on Aug 31 UTC is inside "today" locally and outside the month GitHub bills.
      const lateAugust = Date.parse("2026-08-31T23:30:00Z");
      expect(lateAugust >= todayStart).toBe(true);
      expect(lateAugust >= monthStart).toBe(false);
    } finally {
      process.env.TZ = savedTz;
    }
    expect(parseWindowFlags(undefined, true)).toEqual({ kind: "month" });
    expect(parseWindowFlags("7", false)).toEqual({ kind: "calendar", days: 7 });
    expect(() => parseWindowFlags("7", true)).toThrow("--month and --days");
    expect(describeDaysWindow({ kind: "month" })).toBe("this month (UTC)");
  },
);

test("describeDaysWindow phrases each window kind for the report header", () => {
  expect(describeDaysWindow(undefined)).toBe("all time");
  expect(describeDaysWindow({ kind: "calendar", days: 1 })).toBe("today");
  expect(describeDaysWindow({ kind: "calendar", days: 7 })).toBe("last 7 calendar days");
  expect(describeDaysWindow({ kind: "exact", days: 1 })).toBe("last 24h");
  expect(describeDaysWindow({ kind: "exact", days: 1.5 })).toBe("last 36h");
  expect(describeDaysWindow({ kind: "exact", days: 0.5 })).toBe("last 12h");
  // A span formatDuration would round to "0s" is phrased by its day count instead.
  expect(describeDaysWindow({ kind: "exact", days: 0.000001 })).toBe("last 0.000001 days");
});

// ---------- runCost ----------

const PRICE_URL = "https://pricing.example/models";

const PRICED_BODY = {
  data: [{
    id: "anthropic/claude-opus-4.8",
    pricing: { prompt: "0.000015", completion: "0.000075" },
  }],
};

/** `fail` rejects with the TypeError shape the real transport throws. */
function fakeFetch(body: unknown, opts: { fail?: boolean } = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    if (opts.fail) {
      return Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

function recordingFetch(body: unknown, opts: { fail?: boolean } = {}): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const inner = fakeFetch(body, opts);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, urls };
}

/** `open` reads the WAL sidecar: SQLite keeps it beside the file until the last connection closes. */
interface IndexSnapshot {
  open: boolean;
  paths: string[];
}

function snapshotIndex(home: string): IndexSnapshot {
  const dbFile = indexDbFile(home);
  if (!existsSync(dbFile)) return { open: false, paths: [] };
  return { open: existsSync(`${dbFile}-wal`), paths: storedIndexPaths(dbFile) };
}

/** Answers only once the index is closed with `parsedPath` stored. The readers store it and
 *  the index closes after both return, fold included, so such a request was made after the
 *  whole synchronous parse. */
function afterParseFetch(home: string, parsedPath: string, body: unknown): {
  fetch: typeof fetch;
  sawAtRequests: () => IndexSnapshot[];
} {
  const seen: IndexSnapshot[] = [];
  const inner = fakeFetch(body);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const snapshot = snapshotIndex(home);
    seen.push(snapshot);
    if (snapshot.open || !snapshot.paths.includes(parsedPath)) {
      return Promise.reject(new TypeError(`request for ${String(input)} made before the parse`));
    }
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, sawAtRequests: () => seen };
}

interface CostHome {
  home: string;
  claudeRoot: string;
}

async function withCostHome(body: (ctx: CostHome) => Promise<void>): Promise<void> {
  const dir = tempDir("cost-run-");
  const savedHome = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api");
  try {
    const claudeRoot = join(dir, "projects");
    writeTranscript(join(claudeRoot, "-Users-x-proj"), "aaa.jsonl", [
      assistantLine("2026-06-01T10:00:00.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 20)),
    ]);
    await body({ home: process.env.COPILOT_API_HOME, claudeRoot });
  } finally {
    process.env.COPILOT_API_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_SOURCES = { sessionRoots: { codex: () => [] as string[], claude: () => [] as string[] } };

function rootsOf(codex: string[], claude: string[]): { sessionRoots: SessionRootDiscovery } {
  return { sessionRoots: { codex: () => codex, claude: () => claude } };
}

interface CostJson {
  runtime: CostRuntime;
  usageByModel: Record<string, ModelUsage>;
  claudeSessions: { totalUsd: number; billedUsd?: number };
}

/** Parses the WHOLE of stdout: a stray line there breaks every consumer, so it fails here. */
async function jsonRun(args: CostArgs, deps: CostDeps): Promise<{
  payload: CostJson;
  stderr: string;
}> {
  const out = await captureChannels(() => runCost({ ...args, json: true }, deps));
  return { payload: JSON.parse(out.stdout) as CostJson, stderr: out.stderr };
}

test("runCost with no sources returns early and never asks for the price list", () =>
  withCostHome(async () => {
    const net = recordingFetch(null, { fail: true });
    const out = await captureAllWrites(() =>
      runCost({ pricingUrl: PRICE_URL }, { fetchImpl: net.fetch, ...NO_SOURCES })
    );
    expect(out).toContain("no copilot-api usage databases");
    expect(out).not.toContain("could not fetch OpenRouter pricing");
    expect(net.urls).toEqual([]);
  }));

test("a cold run fetches the price list only after the synchronous parse, so the parse cannot starve the fetch", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    // The readers are synchronous, so a request made before they return cannot be
    // answered until they do; the fake refuses one made that early.
    const transcript = join(claudeRoot, "-Users-x-proj", "aaa.jsonl");
    const net = afterParseFetch(home, transcript, PRICED_BODY);
    // No price cache exists yet, so this run has to go to the network.
    const { payload, stderr } = await jsonRun({ pricingUrl: PRICE_URL }, {
      fetchImpl: net.fetch,
      ...rootsOf([], [claudeRoot]),
    });
    expect(net.sawAtRequests()).toEqual([{ open: false, paths: [transcript] }]);
    expect(stderr).not.toContain("could not fetch OpenRouter pricing");
    // Priced: 10 in at $15/M + 20 out at $75/M.
    expect(payload.claudeSessions.totalUsd).toBe(0.0017);
  }));

test("runCost discovers roots before it opens the index, so a failing discovery opens nothing", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    const net = recordingFetch(PRICED_BODY);
    await expect(
      captureAllWrites(() =>
        runCost({ pricingUrl: PRICE_URL }, {
          fetchImpl: net.fetch,
          sessionRoots: {
            codex: () => {
              throw new Error("codex homes unreadable");
            },
            claude: () => [claudeRoot],
          },
        })
      ),
    ).rejects.toThrow("codex homes unreadable");
    // Opening the index creates its directory, and no cache landed there either (the run never
    // reached the price list), so its absence proves no index was opened. Control: a working
    // discovery creates it.
    expect(net.urls).toEqual([]);
    const indexDir = join(home, USAGE_INDEX_DIR_NAME);
    expect(existsSync(indexDir)).toBe(false);
    await captureAllWrites(() =>
      runCost({ pricingUrl: PRICE_URL }, {
        fetchImpl: fakeFetch(null, { fail: true }),
        ...rootsOf([], [claudeRoot]),
      })
    );
    expect(existsSync(indexDir)).toBe(true);
  }));

const STORED_URL = "https://stored.example/with-secret-token/models";

/** How the price list was loaded and the stderr line that earns: the turn (10 in at $15/M +
 *  20 out at $75/M) is priced by any list that loaded, and no line ever names the URL, which a
 *  custom one may carry a token in. */
const PRICE_LIST_WARNINGS: {
  name: string;
  /** The URL the run resolves, stored under the config key or passed as the flag. */
  url: string;
  stored: boolean;
  /** What the run finds on disk before it starts, in the copilot-api home. */
  seed: (home: string) => Promise<void> | void;
  noIndex?: boolean;
  fetchImpl: typeof fetch;
  lines: string[];
  totalUsd: number;
}[] = [
  {
    // A cache stamped two days ago, then the network taken away.
    name: "it prices against a stale cached list",
    url: PRICE_URL,
    stored: false,
    seed: async (home) => {
      await loadPricing(PRICE_URL, {
        cacheDir: join(home, USAGE_INDEX_DIR_NAME),
        nowMs: Date.now() - 2 * MILLISECONDS_PER_DAY,
        fetchImpl: fakeFetch(PRICED_BODY),
      });
    },
    fetchImpl: fakeFetch(null, { fail: true }),
    lines: [
      "WARNING: could not refresh OpenRouter pricing (pricing request failed)",
      "using the cached price list from",
    ],
    totalUsd: 0.0017,
  },
  {
    // A regular file where the cache directory belongs: the write fails, the report is still
    // priced. --no-index keeps the index from claiming the path.
    name: "the fetched price list cannot be cached",
    url: PRICE_URL,
    stored: false,
    seed: (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, USAGE_INDEX_DIR_NAME), "not a directory");
    },
    noIndex: true,
    fetchImpl: fakeFetch(PRICED_BODY),
    lines: [
      "WARNING: could not cache the OpenRouter price list (",
      "the next run fetches it again.",
    ],
    totalUsd: 0.0017,
  },
  {
    // No cache and no network: the warning names the failure, never the stored URL.
    name: "the fetch fails with nothing cached",
    url: STORED_URL,
    stored: true,
    seed: () => {},
    noIndex: true,
    fetchImpl: fakeFetch(null, { fail: true }),
    lines: ["could not fetch OpenRouter pricing (pricing request failed)"],
    totalUsd: 0,
  },
];

for (
  const { name, url, stored, seed, noIndex, fetchImpl, lines, totalUsd } of PRICE_LIST_WARNINGS
) {
  test(`runCost warns when ${name}`, () =>
    withCostHome(async ({ home, claudeRoot }) => {
      if (stored) new CopilotEnvConfig().set({ "cost.pricing-url": url });
      await seed(home);
      const { payload, stderr } = await jsonRun(
        { pricingUrl: stored ? undefined : url, noIndex },
        { fetchImpl, ...rootsOf([], [claudeRoot]) },
      );
      for (const line of lines) expect(stderr).toContain(line);
      // Neither the host nor any path segment (a token baked into the path) reaches either channel.
      const printed = stderr + JSON.stringify(payload);
      expect(printed).not.toContain(new URL(url).host);
      for (const segment of new URL(url).pathname.split("/").filter(Boolean)) {
        expect(printed, segment).not.toContain(segment);
      }
      expect(payload.claudeSessions.totalUsd).toBe(totalUsd);
      expect(payload.runtime.indexed).toBe(noIndex !== true);
    }));
}

async function runtimeOf(
  args: { noIndex?: boolean },
  roots: { codex: string[]; claude: string[] },
): Promise<CostRuntime> {
  const { payload } = await jsonRun({ pricingUrl: PRICE_URL, ...args }, {
    fetchImpl: fakeFetch(PRICED_BODY),
    ...rootsOf(roots.codex, roots.claude),
  });
  return payload.runtime;
}

test("a message's GitHub bill lands once in billedUsd and in one report line, however often its line repeats", async () => {
  const claudeRoot = join(tempDir("cost-billed-"), "projects");
  const proj = join(claudeRoot, "-Users-x-proj");
  const billed = assistantLine(
    "2026-06-01T10:00:00.000Z",
    "claude-fable-5-1",
    "msg_billed",
    claudeUsage(4, 262, 912_223, 6_399),
    { "copilot_usage": { "token_details": [], "total_nano_aiu": 40_000_000_000 } },
  );
  writeTranscript(proj, "aaa.jsonl", [
    billed,
    assistantLine("2026-06-01T10:01:00.000Z", "claude-fable-5-1", "msg_plain", claudeUsage(10, 20)),
  ]);
  writeTranscript(proj, "bbb.jsonl", [billed]);
  const fable = {
    data: [{
      id: "anthropic/claude-fable-5.1",
      pricing: {
        prompt: "0.00001",
        completion: "0.00005",
        "input_cache_read": "0.00000025",
        "input_cache_write": "0.0000125",
      },
    }],
  };
  const deps = { fetchImpl: fakeFetch(fable), ...rootsOf([], [claudeRoot]) };

  // 40 credits at $0.01, once. The proxy block carried no bill and has no key for it.
  const { payload } = await jsonRun({ pricingUrl: PRICE_URL, noIndex: true }, deps);
  expect(payload.claudeSessions.billedUsd).toBe(0.4);
  expect("billedUsd" in payload).toBe(false);

  // The like-for-like line: GitHub's bill against OUR price for that one request (4 input, 262
  // output, 912,223 cache reads, 6,399 cache writes at fable's card = $0.32).
  const { stdout } = await captureChannels(() =>
    runCost({ pricingUrl: PRICE_URL, noIndex: true }, deps)
  );
  expect(stdout).toContain(
    "GitHub billed $0.40 for the 1 request that carried a bill; our estimate for those same requests: $0.32",
  );

  // No price list at all (a URL with no cached copy, and the fetch fails): the bill still prints,
  // and the estimate is named unpriced, never $0.
  const tokensOnly = await captureChannels(() =>
    runCost({ pricingUrl: "https://pricing.example/unreachable-models", noIndex: true }, {
      fetchImpl: fakeFetch(null, { fail: true }),
      ...rootsOf([], [claudeRoot]),
    })
  );
  expect(tokensOnly.stdout).toContain(
    "GitHub billed $0.40 for the 1 request that carried a bill; our estimate for those same requests: unpriced (claude-fable-5.1)",
  );
});

test("runCost --json keeps stdout pure JSON while the index narrates a rebuild on stderr", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    // An index stamped by another parser: opening it says so, at a level consola would
    // route to stdout by default, right in front of the payload a consumer parses whole.
    const stale = openUsageIndex({
      dir: join(home, USAGE_INDEX_DIR_NAME),
      fingerprint: "another-parser",
    });
    expect(stale).not.toBeNull();
    stale!.close();
    const { payload, stderr } = await jsonRun({ pricingUrl: PRICE_URL }, {
      fetchImpl: fakeFetch(PRICED_BODY),
      ...rootsOf([], [claudeRoot]),
    });
    expect(stderr).toContain("rebuilding the usage index (parser_fingerprint another-parser).");
    expect(payload.runtime.indexed).toBe(true);
    expect(payload.runtime.index.filesParsedWhole).toBe(1);
    // Timings are whole milliseconds from the real clock, never fractions.
    for (const ms of Object.values(payload.runtime.timing)) {
      expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    }
  }));

test("runtime.timing.pricing is the wait for the price list alone, never the warning work", () =>
  withCostHome(async ({ claudeRoot }) => {
    // A ticking fake clock: every warning printed advances it, so a pricing figure
    // clocked after the warnings would carry those ticks.
    let nowMs = 0;
    const warnedMs = 5_000;
    const originalWarn = consola.warn;
    consola.warn = ((...args: unknown[]) => {
      nowMs += warnedMs;
      return originalWarn.apply(consola, args as Parameters<typeof consola.warn>);
    }) as typeof consola.warn;
    try {
      const runtime = async (fetchImpl: typeof fetch): Promise<CostRuntime> => {
        const { payload } = await jsonRun({ pricingUrl: PRICE_URL, noIndex: true }, {
          fetchImpl,
          ...rootsOf([], [claudeRoot]),
          now: () => nowMs,
        });
        return payload.runtime;
      };
      // Rejected load: the warning prints, the clock jumps, pricing stays at the wait.
      const failed = await runtime(fakeFetch(null, { fail: true }));
      expect(failed.timing.pricing).toBe(0);
      expect(failed.timing.total).toBe(warnedMs);
      // Seed the price cache with one fetched run; a fresh cache then answers without
      // the network, so the load reads as exactly 0, no warning.
      await runtime(fakeFetch(PRICED_BODY));
      nowMs = 0;
      const cached = await runtime(fakeFetch(null, { fail: true }));
      expect(cached.timing.pricing).toBe(0);
      expect(cached.timing.total).toBe(0);
    } finally {
      consola.warn = originalWarn;
    }
  }));

function codexRootWithTwoRollouts(dir: string): string {
  const root = join(dir, "sessions");
  for (const id of ["aaa", "bbb"]) {
    writeRollout(root, "2026-06-01", id, [
      sessionMeta("2026-06-01T10:00:00.000Z", id, { provider: "copilot-env" }),
      turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6"),
      tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1)),
    ]);
  }
  return root;
}

// Each source in turn loses all its roots while the other keeps the run past the no-sources
// return; a reconcile skipped on empty roots would leave the rows behind.
for (const vanished of ["codex", "claude"] as const) {
  test(`runCost reconciles ${vanished} with no roots left, so its rows go with the root`, () =>
    withCostHome(async ({ claudeRoot }) => {
      const codexRoot = codexRootWithTwoRollouts(join(claudeRoot, ".."));
      writeTranscript(join(claudeRoot, "-Users-y-proj"), "bbb.jsonl", [
        assistantLine("2026-06-01T11:00:00.000Z", "claude-opus-4-8", "msg_2", claudeUsage(1, 2)),
      ]);
      const seeded = await runtimeOf({}, { codex: [codexRoot], claude: [claudeRoot] });
      expect(seeded.index.filesParsedWhole).toBe(4);

      const after = await runtimeOf({}, {
        codex: vanished === "codex" ? [] : [codexRoot],
        claude: vanished === "claude" ? [] : [claudeRoot],
      });
      expect(after.index.filesDeleted).toBe(2);
      expect(after.index.filesReused).toBe(2);
      expect(after.index.filesSeen).toBe(2);
    }));
}

test("the combined view counts a request the proxy DB and a client log both recorded once", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    // The home's transcript holds msg_1's first line: claude-opus-4-8, 10 in / 20 out, 10:00:00Z.
    // Streaming appends a line two seconds later with the output grown to 35, then a final line
    // at 10:01:30 that repeats those counts exactly (the stream's stop line), so the request's
    // counts are 10 / 35 and its lines span 10:00:00-10:01:30. The proxy relayed that response
    // and recorded it when the stream ended, seconds after the last line; a second proxy row has
    // no client line at all (an agent whose logs are not on this machine) and keeps counting.
    appendFileSync(
      join(claudeRoot, "-Users-x-proj", "aaa.jsonl"),
      `${
        assistantLine("2026-06-01T10:00:02.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 35))
      }\n${
        assistantLine("2026-06-01T10:01:30.000Z", "claude-opus-4-8", "msg_1", claudeUsage(10, 35))
      }\n`,
    );
    const relayed: ProxyRow = {
      at: "2026-06-01T10:01:35.000Z",
      model: "claude-opus-4.8",
      input: 10,
      output: 35,
    };
    const unlogged: ProxyRow = {
      at: "2026-06-01T12:00:00.000Z",
      model: "claude-opus-4.8",
      input: 100,
      output: 200,
    };
    const deps = { fetchImpl: fakeFetch(PRICED_BODY), ...rootsOf([], [claudeRoot]) };
    const report = (args: CostArgs) =>
      captureChannels(() => runCost({ pricingUrl: PRICE_URL, ...args }, deps));

    // Control: the same counts a minute and a millisecond after the client's LAST line are another
    // request, and the note stays off the header.
    const dbFile = writeProxyDb(home, "work-bot", [
      { ...relayed, at: "2026-06-01T10:02:30.001Z" },
      unlogged,
    ]);
    const apart = await report({ noIndex: true });
    expect(apart.stdout).toContain("| 1 proxy db + 1 claude projects root | 3 requests | ");
    expect(apart.stdout).toMatch(/^\s+TOTAL\s+3\s+120 \|/m);

    // The relayed row, plus a second row with the same counts 35 s later that is still inside the
    // window: one client record pairs one proxy row, so the second stays.
    rmSync(dbFile, { maxRetries: 10, retryDelay: 100 });
    writeProxyDb(home, "work-bot", [
      relayed,
      { ...relayed, at: "2026-06-01T10:02:10.000Z" },
      unlogged,
    ]);
    const plain = await report({ noIndex: true });
    expect(plain.stdout).toContain(
      "| 1 proxy db + 1 claude projects root | 3 requests (1 seen in both a proxy row and a client log, counted once) | ",
    );
    expect(plain.stdout).toMatch(/^\s+TOTAL\s+3\s+120 \|/m);
    // The pairing runs over the records the reconcile yields, so the index changes nothing.
    const indexed = await report({});
    expect(indexed.stdout).toBe(plain.stdout);
    // --json and --sources report each source whole: the proxy keys still carry all three rows.
    const { payload } = await jsonRun({ pricingUrl: PRICE_URL, noIndex: true }, deps);
    expect(payload.usageByModel["claude-opus-4.8"]?.events).toBe(3);
  }));

test("runCost's human report ends with one index line only when the index was used", () =>
  withCostHome(async ({ claudeRoot }) => {
    const deps = { fetchImpl: fakeFetch(PRICED_BODY), ...rootsOf([], [claudeRoot]) };
    // Pad the transcript to exactly 1200 bytes with a user line: the byte count
    // crosses into the kB unit, so the line proves the count is formatted, not echoed.
    const file = join(claudeRoot, "-Users-x-proj", "aaa.jsonl");
    const filler = (text: string) =>
      `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
    appendFileSync(file, filler("x".repeat(1200 - statSync(file).size - filler("").length)));
    expect(statSync(file).size).toBe(1200);
    const cold = await captureChannels(() => runCost({ pricingUrl: PRICE_URL }, deps));
    expect(cold.all.trimEnd().split("\n").at(-1)).toBe(
      "usage index: 0 files reused, 0 tail-parsed, 1 whole-parsed, 1.2 kB read",
    );
    // The line is a note about the run, so it rides stderr and never the report.
    expect(cold.stderr).toContain("usage index:");
    expect(cold.stdout).not.toContain("usage index:");
    const warm = await captureChannels(() => runCost({ pricingUrl: PRICE_URL }, deps));
    expect(warm.stderr.trimEnd().split("\n").at(-1)).toBe(
      "usage index: 1 files reused, 0 tail-parsed, 0 whole-parsed, 0 B read",
    );
    const plain = await captureAllWrites(() =>
      runCost({ pricingUrl: PRICE_URL, noIndex: true }, deps)
    );
    expect(plain).not.toContain("usage index:");
  }));

test("formatBytesCompact picks decimal units with one decimal from kB up", () => {
  expect(formatBytesCompact(0)).toBe("0 B");
  expect(formatBytesCompact(999)).toBe("999 B");
  expect(formatBytesCompact(1_000)).toBe("1.0 kB");
  expect(formatBytesCompact(1_234_567)).toBe("1.2 MB");
  expect(formatBytesCompact(2_500_000_000)).toBe("2.5 GB");
});

test("formatTokensCompact steps K, M, B, T at each thousand with one decimal", () => {
  expect(formatTokensCompact(999)).toBe("999");
  expect(formatTokensCompact(999_949)).toBe("999.9K");
  expect(formatTokensCompact(1_000_000)).toBe("1.0M");
  expect(formatTokensCompact(999_949_999)).toBe("999.9M");
  expect(formatTokensCompact(1_000_000_000)).toBe("1.0B");
  expect(formatTokensCompact(45_894_700_000)).toBe("45.9B");
  expect(formatTokensCompact(1_000_000_000_000)).toBe("1.0T");
  expect(formatTokensCompact(1_234_000_000_000)).toBe("1.2T");
});

test("ReconcileMeter bills a reader's synchronous fold, never a microtask queued behind it", async () => {
  // A fake clock the reader and a bystander advance by hand: walk 5, parse 7, fold 11,
  // then 40 more from a microtask queued before the read.
  let nowMs = 1_000;
  const noParse = () => {
    throw new Error("no candidates to parse");
  };
  const reader = (reconcile: Reconcile): Promise<string> => {
    nowMs += 5;
    reconcile("claude", [], noParse, noParse);
    nowMs += 11;
    return Promise.resolve("folded");
  };
  const parseTimed = new ReconcileMeter((source, walked, parseWhole, parseTail) => {
    nowMs += 7;
    return parseEveryCandidate(source, walked, parseWhole, parseTail);
  }, () => nowMs);
  // Queued BEFORE the read: it runs when the meter first yields, and would land in
  // `fold` if the clock were read after the await instead of at the return.
  queueMicrotask(() => {
    nowMs += 40;
  });

  expect(await parseTimed.read(reader)).toBe("folded");
  expect(parseTimed.timing).toEqual({ walk: 5, parse: 7, fold: 11 });
  expect(nowMs).toBe(1_063);
  expect(parseTimed.stats.filesSeen).toBe(0);
});

test("ReconcileMeter sums every IndexStats field over both readers' reconciles", async () => {
  // Every field distinct and non-zero, so a field that stopped accumulating shows.
  const perCall: IndexStats = {
    filesSeen: 1,
    filesReused: 2,
    filesParsedWhole: 3,
    filesParsedTail: 4,
    filesFailed: 5,
    filesDeleted: 6,
    bytesRead: 7,
  };
  const meter = new ReconcileMeter(() => ({ records: [], stats: { ...perCall } }));
  const noParse = () => {
    throw new Error("no candidates to parse");
  };
  const reader = (reconcile: Reconcile): Promise<void> => {
    reconcile("codex", [], noParse, noParse);
    return Promise.resolve();
  };
  await meter.read(reader);
  await meter.read(reader);
  expect(meter.stats).toEqual({
    filesSeen: 2,
    filesReused: 4,
    filesParsedWhole: 6,
    filesParsedTail: 8,
    filesFailed: 10,
    filesDeleted: 12,
    bytesRead: 14,
  });
});
