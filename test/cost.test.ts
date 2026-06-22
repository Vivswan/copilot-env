import { expect, test } from "bun:test";

import { activeDayCoverage, computeDayMetrics, median } from "../src/usage/cost.ts";
import { estimateCost, type PricingTier } from "../src/usage/pricing.ts";
import type { ModelUsage, UsageReport } from "../src/usage/usage.ts";

function usage(partial: Partial<ModelUsage>): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0, ...partial };
}

/** A report with a per-day, per-model breakdown; byModel/activeDays derived. */
function makeReport(perDay: Record<string, Record<string, ModelUsage>>): UsageReport {
  const perDayMap = new Map<string, Map<string, ModelUsage>>();
  const byModel = new Map<string, ModelUsage>();
  for (const [day, models] of Object.entries(perDay)) {
    const dayMap = new Map<string, ModelUsage>();
    for (const [model, u] of Object.entries(models)) {
      dayMap.set(model, u);
      const prev = byModel.get(model) ?? usage({});
      byModel.set(model, {
        input: prev.input + u.input,
        output: prev.output + u.output,
        cacheRead: prev.cacheRead + u.cacheRead,
        cacheCreation: prev.cacheCreation + u.cacheCreation,
        events: prev.events + u.events,
      });
    }
    perDayMap.set(day, dayMap);
  }
  return { byModel, activeDays: perDayMap.size, perDay: perDayMap };
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
  const report = makeReport({
    "2026-06-01": { "openai/gpt-5.5": usage({ input: 1_000_000, output: 500_000, events: 1 }) },
    "2026-06-02": { "openai/gpt-5.5": usage({ input: 3_000_000, output: 100_000, events: 2 }) },
  });
  // $1/M input, $2/M output.
  const pricing = new Map<string, PricingTier>([["openai/gpt-5.5", { input: 1, output: 2 }]]);
  const estimate = estimateCost(report.byModel, pricing);
  const days = computeDayMetrics(report, pricing, estimate).sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  expect(days.map((d) => d.day)).toEqual(["2026-06-01", "2026-06-02"]);
  // Day 1: 1M input + 0.5M output = 1.5M tokens; cost = $1.00 + $1.00 = $2.00.
  expect(days[0]?.total).toBe(1_500_000);
  expect(days[0]?.cost).toBeCloseTo(2, 6);
  // Day 2: 3M input + 0.1M output; cost = $3.00 + $0.20 = $3.20.
  expect(days[1]?.cost).toBeCloseTo(3.2, 6);
  // Per-day costs sum to the aggregate total.
  const dayCostSum = days.reduce((s, d) => s + d.cost, 0);
  expect(dayCostSum).toBeCloseTo(estimate.totalUsd, 6);
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
});
