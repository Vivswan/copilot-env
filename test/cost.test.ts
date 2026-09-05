import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyIndexStats,
  type IndexStats,
  parseEveryCandidate,
  type Reconcile,
} from "../src/usage/contribution.ts";
import {
  activeDayCoverage,
  buildSourceJson,
  computeDayMetrics,
  type CostRuntime,
  daysCutoffMs,
  describeDaysWindow,
  formatBytesCompact,
  median,
  parseDaysWindow,
  perDayRows,
  ReconcileMeter,
  resolvePricingUrl,
  runCost,
  type SessionRootDiscovery,
  sumDayTotals,
  UNDATED_DAY_LABEL,
} from "../src/usage/cost.ts";
import { consola } from "consola";
import { CopilotEnvConfig, OPENROUTER_MODELS_URL } from "../src/copilot_api/env_config.ts";
import { USAGE_INDEX_DIR_NAME } from "../src/usage/paths.ts";
import {
  estimateCost,
  loadPricing,
  type ModelCost,
  pricingCachePath,
  type PricingTier,
} from "../src/usage/pricing.ts";
import { type ModelUsage, record, type UsageReport, usageReport } from "../src/usage/usage.ts";
import { localDayKey, MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { captureAllWrites, captureChannels } from "./helpers/output.ts";
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
import { expect, test, TZ_PINNABLE } from "./helpers/testing.ts";

function usage(partial: Partial<ModelUsage>): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0, ...partial };
}

/** A report folded through record(), the real producer path: a per-day, per-model
 *  breakdown plus optional `undated` usage that reaches byModel only. */
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
  expect(median([5, 1, 3])).toBe(3); // sorts then picks middle
  expect(median([1, 2, 3, 4])).toBe(2.5); // mean of the two middles
  expect(median([])).toBe(0);
  expect(median([42])).toBe(42);
});

test("activeDayCoverage measures the inclusive min..max span and density", () => {
  // 3 active days across 2026-06-01..2026-06-05 -> 5-day span, 60%.
  const report = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
    "2026-06-03": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
    "2026-06-05": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) },
  });
  expect(activeDayCoverage(report)).toEqual({ spanDays: 5, percent: 60 });

  // A single day is a 1-day span at 100%.
  const one = makeReport({ "2026-06-01": { "openai/gpt-5.5": usage({ input: 1, events: 1 }) } });
  expect(activeDayCoverage(one)).toEqual({ spanDays: 1, percent: 100 });

  // No days: 0 span, 100% (the printer shows "0 active days" instead).
  expect(activeDayCoverage(makeReport({}))).toEqual({ spanDays: 0, percent: 100 });
});

test("computeDayMetrics sums tokens per day and reconciles cost with the aggregate", () => {
  // Ragged token counts: every per-day, per-model cost lands on a fraction of a
  // cent, so the reconciliation below holds only while stored costs stay exact.
  // Any mid-pipeline rounding (e.g. 4dp per-model values) shifts the day sum
  // away from the aggregate by orders of magnitude more than this tolerance.
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
  const estimate = estimateCost(report.byModel, pricing);
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
  // claude uses a cacheCreation bucket on day 1 only. The pricing below omits a
  // cache-write rate, so the AGGREGATE is unpriced. Day 2 (no cacheCreation)
  // would be priceable in isolation -- it must still contribute $0, or the
  // per-day breakdown would not reconcile with the excluded aggregate total.
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
  const estimate = estimateCost(report.byModel, pricing);

  // Aggregate excludes the model entirely.
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
  const estimate = estimateCost(report.byModel, pricing);
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
  const estimate = estimateCost(report.byModel, pricing);

  // computeDayMetrics stays dated-only (per-day medians are per-DAY statistics).
  expect(computeDayMetrics(report, pricing, estimate).map((d) => d.day).sort()).toEqual([
    "2026-06-01",
    "2026-06-02",
  ]);

  // The printed row list: dated rows oldest first, the undated remainder
  // closing it. Its label is applied at render time only; the spelling is an
  // external display contract, pinned here.
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

  // Dated rows + the undated row: the TOTAL's token columns now really sum to
  // the aggregate cost it carries.
  const total = sumDayTotals(rows, estimate);
  expect(total.input).toBe(2_000_000);
  expect(total.total).toBe(2_000_000);
  expect(total.reqs).toBe(3);
  expect(total.cost).toBe(estimate.totalUsd);
  expect(estimate.totalUsd).toBe(2);

  // An all-undated report still yields a printable row list.
  const allUndated = makeReport({}, { "openai/gpt-5.5": usage({ input: 42, events: 1 }) });
  const undatedEstimate = estimateCost(allUndated.byModel, pricing);
  expect(perDayRows(allUndated, pricing, undatedEstimate).map((r) => r.kind)).toEqual([
    "undated",
  ]);

  // Fully dated usage: no synthetic row.
  const dated = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 5, events: 1 }) },
  });
  expect(
    perDayRows(dated, pricing, estimateCost(dated.byModel, pricing))
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
  const estimate = estimateCost(report.byModel, pricing);
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

/** Calendar distance in days between two YYYY-MM-DD keys (b - a). */
function dayKeyDistance(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MILLISECONDS_PER_DAY,
  );
}

test("daysCutoffMs: a calendar window starts at a local midnight N-1 days back", () => {
  // Assertions are phrased through localDayKey, the same system-zone day key the
  // readers split on, so they hold in whatever zone the runner sits in.
  const now = Date.UTC(2026, 5, 15, 13, 47, 5);
  for (const days of [1, 2, 7, 30]) {
    const cutoff = daysCutoffMs({ kind: "calendar", days }, now);
    // A real day boundary: the instant before the cutoff is the previous local day.
    expect(localDayKey(cutoff - 1)).not.toBe(localDayKey(cutoff));
    expect(localDayKey(cutoff) < localDayKey(now)).toBe(days > 1);
    // Exactly `days` local calendar days from the cutoff's day through today.
    expect(dayKeyDistance(localDayKey(cutoff), localDayKey(now))).toBe(days - 1);
    // The window covers `now` and never reaches past it.
    expect(cutoff <= now).toBe(true);
  }
  // `1` is today alone: the cutoff is today's own local midnight.
  expect(localDayKey(daysCutoffMs({ kind: "calendar", days: 1 }, now))).toBe(localDayKey(now));
});

test.skipIf(!TZ_PINNABLE)(
  "daysCutoffMs: calendar cutoffs are real midnights across DST and month/year rollovers",
  () => {
    // Pinned to America/New_York (2026: springs forward Mar 8, falls back Nov 1), so the
    // 23- and 25-hour days are known instants. Save/restore by explicit zone name, never
    // delete (TZ assignments are ignored after a delete; see test/time.test.ts).
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

/** A fetch answering `body` once per call; `fail` rejects the way the transport does. */
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

/** `fakeFetch` that also records every URL it was asked for. */
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

/** A fetch that never answers until the request is cancelled, and records that it was. */
function hangingFetch(): { fetch: typeof fetch; aborted: () => boolean } {
  let aborted = false;
  const fetchImpl =
    ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
  return { fetch: fetchImpl, aborted: () => aborted };
}

interface CostHome {
  /** The run's COPILOT_API_HOME: usage DBs, the index, and the price cache live under it. */
  home: string;
  /** One Claude projects root holding a single priced turn. */
  claudeRoot: string;
}

/** Run `body` with COPILOT_API_HOME pointed at a fresh temp home, restored afterwards. */
async function withCostHome(body: (ctx: CostHome) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cost-run-"));
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

/** Run `body` and return the unhandled rejections it left behind (settled first). */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent): void => {
    seen.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await body();
    // A rejection surfaces as unhandled only after the microtasks drain and the
    // event loop turns once; yield that one turn (no wall-clock wait) before reading.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  return seen;
}

test("unhandledRejectionsDuring catches a rejection nobody handles (its own negative control)", async () => {
  const sentinel = new Error("nobody handles this");
  const seen = await unhandledRejectionsDuring(async () => {
    Promise.reject(sentinel);
  });
  expect(seen).toEqual([sentinel]);
  // A handled rejection is not reported, so the zero the runCost tests trust is exact.
  expect(
    await unhandledRejectionsDuring(async () => {
      Promise.reject(new Error("handled")).catch(() => {});
    }),
  ).toEqual([]);
});

const NO_SOURCES = { sessionRoots: { codex: () => [] as string[], claude: () => [] as string[] } };

/** Codex roots `codex`, Claude roots `claude`, as runCost's deps. */
function rootsOf(codex: string[], claude: string[]): { sessionRoots: SessionRootDiscovery } {
  return { sessionRoots: { codex: () => codex, claude: () => claude } };
}

test("runCost with no sources returns early and cancels the pricing load it started", () =>
  withCostHome(async () => {
    const net = hangingFetch();
    let out = "";
    const unhandled = await unhandledRejectionsDuring(async () => {
      out = await captureAllWrites(() =>
        runCost({ pricingUrl: PRICE_URL }, { fetchImpl: net.fetch, ...NO_SOURCES })
      );
    });
    expect(out).toContain("no copilot-api usage databases");
    expect(net.aborted()).toBe(true);
    expect(unhandled).toEqual([]);
  }));

test("runCost with no sources swallows a pricing load that already failed", () =>
  withCostHome(async () => {
    const unhandled = await unhandledRejectionsDuring(async () => {
      const out = await captureAllWrites(() =>
        runCost({ pricingUrl: PRICE_URL }, {
          fetchImpl: fakeFetch(null, { fail: true }),
          ...NO_SOURCES,
        })
      );
      expect(out).toContain("no copilot-api usage databases");
      expect(out).not.toContain("could not fetch OpenRouter pricing");
    });
    expect(unhandled).toEqual([]);
  }));

test("runCost discovers roots before it opens the index, so a failing discovery opens nothing", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    const net = hangingFetch();
    const unhandled = await unhandledRejectionsDuring(async () => {
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
    });
    expect(unhandled).toEqual([]);
    // The thrown exit still cancels the price list still in flight.
    expect(net.aborted()).toBe(true);
    // The index directory is created by opening the index (the hanging fetch wrote
    // no price cache there), so its absence proves no index was opened. The control:
    // the same run with a working discovery (and a fetch that writes no cache) does
    // create it.
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

test("runCost warns when it prices against a stale cached list", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    // Seed a cache stamped two days ago, then take the network away.
    await loadPricing(PRICE_URL, {
      cacheDir: join(home, USAGE_INDEX_DIR_NAME),
      nowMs: Date.now() - 2 * MILLISECONDS_PER_DAY,
      fetchImpl: fakeFetch(PRICED_BODY),
    });
    const out = await captureAllWrites(() =>
      runCost({ pricingUrl: PRICE_URL, json: true }, {
        fetchImpl: fakeFetch(null, { fail: true }),
        ...rootsOf([], [claudeRoot]),
      })
    );
    expect(out).toContain("WARNING: could not refresh OpenRouter pricing (pricing request failed)");
    expect(out).toContain("using the cached price list from");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    // The stale list still priced the turn: 10 in at $15/M + 20 out at $75/M.
    expect(payload.claudeSessions.totalUsd).toBe(0.0017);
  }));

test("runCost warns when the fetched price list cannot be cached", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    // A regular file where the cache directory belongs: the write fails, the
    // report is still priced. --no-index keeps the index from claiming the path.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, USAGE_INDEX_DIR_NAME), "not a directory");
    const out = await captureAllWrites(() =>
      runCost({ pricingUrl: PRICE_URL, json: true, noIndex: true }, {
        fetchImpl: fakeFetch(PRICED_BODY),
        ...rootsOf([], [claudeRoot]),
      })
    );
    expect(out).toContain("WARNING: could not cache the OpenRouter price list (");
    expect(out).toContain("the next run fetches it again.");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.claudeSessions.totalUsd).toBe(0.0017);
    expect(payload.runtime.indexed).toBe(false);
  }));

/** The `runtime` key of one `--json` run over the given roots. */
async function runtimeOf(
  args: { noIndex?: boolean },
  roots: { codex: string[]; claude: string[] },
): Promise<CostRuntime> {
  const out = await captureAllWrites(() =>
    runCost({ pricingUrl: PRICE_URL, json: true, ...args }, {
      fetchImpl: fakeFetch(PRICED_BODY),
      ...rootsOf(roots.codex, roots.claude),
    })
  );
  return JSON.parse(out.slice(out.indexOf("{"))).runtime;
}

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
        const out = await captureAllWrites(() =>
          runCost({ pricingUrl: PRICE_URL, json: true, noIndex: true }, {
            fetchImpl,
            ...rootsOf([], [claudeRoot]),
            now: () => nowMs,
          })
        );
        return JSON.parse(out.slice(out.indexOf("{"))).runtime;
      };
      // Rejected load: the warning prints, the clock jumps, pricing stays at the wait.
      const failed = await runtime(fakeFetch(null, { fail: true }));
      expect(failed.timing.pricing).toBe(0);
      expect(failed.timing.total).toBe(warnedMs);
      // Seed the price cache with one fetched run; a fresh cache then answers before
      // the reads finish, so the already-settled load reads as exactly 0, no warning.
      await runtime(fakeFetch(PRICED_BODY));
      nowMs = 0;
      const cached = await runtime(fakeFetch(null, { fail: true }));
      expect(cached.timing.pricing).toBe(0);
      expect(cached.timing.total).toBe(0);
    } finally {
      consola.warn = originalWarn;
    }
  }));

test("runCost --json carries the reserved runtime key with exactly its three parts", () =>
  withCostHome(async ({ claudeRoot }) => {
    const deps = { codex: [], claude: [claudeRoot] };
    const cold = await runtimeOf({}, deps);
    expect(Object.keys(cold)).toEqual(["indexed", "index", "timing"]);
    expect(Object.keys(cold.index)).toEqual(Object.keys(emptyIndexStats()));
    expect(Object.keys(cold.timing)).toEqual(["walk", "parse", "fold", "pricing", "total"]);
    for (const ms of Object.values(cold.timing)) {
      expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    }
    expect(cold.indexed).toBe(true);
    expect(cold.index.filesParsedWhole).toBe(1);

    const warm = await runtimeOf({}, deps);
    expect(warm.index.filesReused).toBe(1);
    expect(warm.index.bytesRead).toBe(0);

    const plain = await runtimeOf({ noIndex: true }, deps);
    expect(plain.indexed).toBe(false);
    expect(plain.index.filesParsedWhole).toBe(1);
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

// Each source in turn: seed its rows, then hand the run NO roots for it while the
// other source keeps the run past the no-sources return. The old `roots.length > 0`
// guards would skip the reconcile and leave the rows; the count says they all went.
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

// ---------- the pricing-url preference ----------

const STORED_URL = "https://stored.example/with-secret-token/models";
const FLAG_URL = "https://flag.example/models";

test("resolvePricingUrl: the flag beats the stored key, which beats the built-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-config-"));
  try {
    const config = new CopilotEnvConfig(join(dir, "config.json"));
    expect(resolvePricingUrl(undefined, config)).toBe(OPENROUTER_MODELS_URL);
    config.set({ pricingUrl: STORED_URL });
    expect(resolvePricingUrl(undefined, config)).toBe(STORED_URL);
    expect(resolvePricingUrl(FLAG_URL, config)).toBe(FLAG_URL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCost fetches the stored pricing-url, and --pricing-url overrides it for one run", () =>
  withCostHome(async ({ claudeRoot }) => {
    new CopilotEnvConfig().set({ pricingUrl: STORED_URL });
    const stored = recordingFetch(PRICED_BODY);
    await captureAllWrites(() =>
      runCost({ json: true }, { fetchImpl: stored.fetch, ...rootsOf([], [claudeRoot]) })
    );
    expect(stored.urls).toEqual([STORED_URL]);

    const flagged = recordingFetch(PRICED_BODY);
    await captureAllWrites(() =>
      runCost({ json: true, pricingUrl: FLAG_URL }, {
        fetchImpl: flagged.fetch,
        ...rootsOf([], [claudeRoot]),
      })
    );
    expect(flagged.urls).toEqual([FLAG_URL]);
  }));

test("a stored pricing-url never reaches a warning or the price cache on disk", () =>
  withCostHome(async ({ home, claudeRoot }) => {
    new CopilotEnvConfig().set({ pricingUrl: STORED_URL });
    const cacheDir = join(home, USAGE_INDEX_DIR_NAME);

    // A failed fetch: the warning names the failure, never the URL.
    const failed = await captureAllWrites(() =>
      runCost({ json: true, noIndex: true }, {
        fetchImpl: fakeFetch(null, { fail: true }),
        ...rootsOf([], [claudeRoot]),
      })
    );
    expect(failed).toContain("could not fetch OpenRouter pricing (pricing request failed)");
    expect(failed).not.toContain("stored.example");
    expect(failed).not.toContain("with-secret-token");

    // A successful fetch: the cache file is keyed by the URL's digest and holds only it.
    await captureAllWrites(() =>
      runCost({ json: true, noIndex: true }, {
        fetchImpl: fakeFetch(PRICED_BODY),
        ...rootsOf([], [claudeRoot]),
      })
    );
    const cacheFile = pricingCachePath(STORED_URL, cacheDir);
    expect(readdirSync(cacheDir)).toEqual([cacheFile.slice(cacheDir.length + 1)]);
    const cached = readFileSync(cacheFile, "utf8");
    expect(cached).not.toContain("stored.example");
    expect(cached).not.toContain("with-secret-token");
  }));
