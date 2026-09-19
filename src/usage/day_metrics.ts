// The per-day arithmetic behind `agent cost --per-day` and `--days`: window parsing, the day
// grouping, and the coverage statistics. Pure functions over a folded UsageReport; cost.ts renders.

import { formatDuration, MILLISECONDS_PER_DAY, startOfLocalDay } from "../utils/time.ts";
import { type CostEstimate, estimateCost, type PricingTier } from "./pricing.ts";
import { type ModelUsage, type ReadonlyUsageReport, undatedUsage } from "./usage.ts";

/** Told apart by SPELLING: `7` counts local calendar days (today plus the six before), `1.0` is an
 *  exact span of 24-hour days. Number("1.0") === 1, so the raw flag text is the only place the two
 *  differ, which is why the parser takes the string. */
export type DaysWindow =
  | { kind: "calendar"; days: number }
  | { kind: "exact"; days: number };

/** Number() would also admit a sign, whitespace, an exponent, or hex, and each would silently land
 *  in a window kind the user never chose. */
const WHOLE_DAYS = /^\d+$/;
const DECIMAL_DAYS = /^(\d+\.\d*|\.\d+)$/;

/** Date represents 8.64e15 ms either side of the epoch, which is exactly this many 24-hour days. */
const MAX_DAYS = 8.64e15 / MILLISECONDS_PER_DAY;

/** The one mint, so a window's `days` is always positive, finite, and small enough to yield a real
 *  cutoff. */
export function parseDaysWindow(raw: string): DaysWindow {
  const kind = WHOLE_DAYS.test(raw) ? "calendar" : DECIMAL_DAYS.test(raw) ? "exact" : null;
  const days = Number(raw);
  if (kind === null || !(days > 0)) {
    throw new Error(
      `--days must be a positive number, got '${raw}' (a whole number counts calendar days, a decimal counts exact 24-hour days)`,
    );
  }
  if (days > MAX_DAYS) {
    throw new Error(`--days must be at most ${MAX_DAYS}, got '${raw}'`);
  }
  return { kind, days };
}

/** A calendar window starts at a real local midnight, so its first day is never partial. */
export function daysCutoffMs(window: DaysWindow, nowMs: number = Date.now()): number {
  return window.kind === "calendar"
    ? startOfLocalDay(nowMs, window.days - 1)
    : nowMs - window.days * MILLISECONDS_PER_DAY;
}

/** formatDuration rounds to whole seconds, so a span it would render as "0s" falls back to the day
 *  count. */
export function describeDaysWindow(window: DaysWindow | undefined): string {
  if (window === undefined) {
    return "all time";
  }
  if (window.kind === "exact") {
    const duration = formatDuration(window.days * MILLISECONDS_PER_DAY);
    return duration === "0s" ? `last ${window.days} days` : `last ${duration}`;
  }
  return window.days === 1 ? "today" : `last ${window.days} calendar days`;
}

export interface DayTotals {
  reqs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  cost: number;
}

export interface DayMetrics extends DayTotals {
  day: string;
}

/** The discriminant replaces a magic day label; the "(undated)" spelling is applied at render time
 *  only. */
type PerDayRow =
  | ({ kind: "dated" } & DayMetrics)
  | ({ kind: "undated" } & DayTotals);

/** Dated days only, so the per-day medians stay per-DAY statistics (avg/day spreads the aggregate,
 *  undated included, over the active days). Cost is priced per day only for models the aggregate
 *  `estimate` priced: a model it excluded must contribute $0 every day too, or the days would not
 *  sum to the aggregate totalUsd. */
export function computeDayMetrics(
  report: ReadonlyUsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
): DayMetrics[] {
  const priced = new Set(Object.keys(estimate.perModel));
  const out: DayMetrics[] = [];
  for (const [day, dayModels] of report.perDay) {
    out.push({ day, ...groupTotals(dayModels, pricing, priced) });
  }
  return out;
}

function groupTotals(
  models: ReadonlyMap<string, Readonly<ModelUsage>>,
  pricing: Map<string, PricingTier>,
  priced: ReadonlySet<string>,
): DayTotals {
  const est = estimateCost(models, pricing);
  const m: DayTotals = {
    reqs: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    cost: 0,
  };
  for (const [model, u] of models) {
    m.reqs += u.events;
    m.input += u.input;
    m.output += u.output;
    m.cacheRead += u.cacheRead;
    m.cacheWrite += u.cacheCreation;
    const c = est.perModel[model];
    // A group's tokens are a subset of the aggregate's, so `priced` only drops models the aggregate
    // excluded.
    if (c !== undefined && priced.has(model)) {
      m.inputCost += c.inputCostUsd;
      m.outputCost += c.outputCostUsd;
      m.cacheReadCost += c.cacheReadCostUsd;
      m.cacheWriteCost += c.cacheCreationCostUsd;
      m.cost += c.estimatedCostUsd;
    }
  }
  m.total = m.input + m.output + m.cacheRead + m.cacheWrite;
  return m;
}

/** The per-day table's label for the undated row (cost.ts renders it); the spelling is a display
 *  contract. */
export const UNDATED_DAY_LABEL = "(undated)";

/** Without this row the per-day table's columns could not sum to the TOTAL line, which always
 *  carries the aggregate's numbers. Null is the normal case: the daemon timestamps every DB row. */
function undatedTotals(
  report: ReadonlyUsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
): DayTotals | null {
  const rest = undatedUsage(report);
  if (rest.size === 0) {
    return null;
  }
  return groupTotals(rest, pricing, new Set(Object.keys(estimate.perModel)));
}

/** THE row list the per-day table prints and its TOTAL line sums over. */
export function perDayRows(
  report: ReadonlyUsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
): PerDayRow[] {
  const rows: PerDayRow[] = computeDayMetrics(report, pricing, estimate)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ kind: "dated", ...d }));
  const undated = undatedTotals(report, pricing, estimate);
  if (undated !== null) {
    rows.push({ kind: "undated", ...undated });
  }
  return rows;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid]!;
}

/** The inclusive min..max calendar span of the active days, and what fraction of it was active. */
export function activeDayCoverage(
  report: ReadonlyUsageReport,
): { spanDays: number; percent: number } {
  const days = [...report.perDay.keys()].sort();
  if (days.length === 0) {
    return { spanDays: 0, percent: 100 };
  }
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const spanMs = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`);
  const spanDays = Math.round(spanMs / MILLISECONDS_PER_DAY) + 1;
  const percent = spanDays > 0 ? Math.round((days.length / spanDays) * 100) : 100;
  return { spanDays, percent };
}
