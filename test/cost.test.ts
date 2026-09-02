import {
  activeDayCoverage,
  buildSourceJson,
  computeDayMetrics,
  median,
  perDayRows,
  sumDayTotals,
  UNDATED_DAY_LABEL,
} from "../src/usage/cost.ts";
import { estimateCost, type ModelCost, type PricingTier } from "../src/usage/pricing.ts";
import { type ModelUsage, record, type UsageReport, usageReport } from "../src/usage/usage.ts";
import { expect, test } from "./helpers/testing.ts";

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
