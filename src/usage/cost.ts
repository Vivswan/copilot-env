// `agent cost`: fetches pricing, reads usage DBs, and prints spend estimates.
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import {
  type CostEstimate,
  estimateCost,
  fetchPricing,
  OPENROUTER_MODELS_URL,
  type PricingTier,
} from "./pricing.ts";
import { discoverUsageDbs, readUsage, type UsageReport } from "./usage.ts";

/** `cost`: aggregate per-host SQLite usage and estimate spend. */
export async function runCost(args: {
  days?: string;
  json?: boolean;
  perDay?: boolean;
  pricingUrl?: string;
}): Promise<void> {
  const dbPaths = discoverUsageDbs();
  if (dbPaths.length === 0) {
    consola.warn(
      "WARNING: no copilot-api usage databases found; start the proxy with 'agent start' and make some requests, then re-run 'agent cost'.",
    );
    return;
  }

  const sinceMs = parseDaysCutoff(args.days);
  const report = readUsage(dbPaths, sinceMs);

  // Best-effort pricing: a fetch failure still yields a token-only report.
  let pricing = new Map<string, PricingTier>();
  try {
    pricing = await fetchPricing(args.pricingUrl ?? OPENROUTER_MODELS_URL);
  } catch (e) {
    consola.warn(
      `WARNING: could not fetch OpenRouter pricing (${errMessage(e)}); reporting tokens only.`,
    );
  }

  // ModelUsage is a structural superset of UsageTokens, so the read-only
  // estimateCost reads report.byModel directly -- no per-model copy needed.
  const estimate = estimateCost(report.byModel, pricing);

  if (args.json) {
    console.log(
      JSON.stringify(
        buildCostJson(report, estimate, pricing, dbPaths.length, sinceMs, Boolean(args.perDay)),
        null,
        2,
      ),
    );
    return;
  }
  printCostReport(report, estimate, pricing, dbPaths.length, args.days);
  if (args.perDay) {
    printPerDayReport(report, pricing, estimate);
  }
}

/** Translate `--days N` into a unix-ms cutoff, or undefined for "all time". */
function parseDaysCutoff(days: string | undefined): number | undefined {
  if (days === undefined) {
    return undefined;
  }
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--days must be a positive number, got '${days}'`);
  }
  return Date.now() - n * MILLISECONDS_PER_DAY;
}

/** One day's totals across all models, including per-category cost. */
export interface DayMetrics {
  day: string;
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

/**
 * Collapse the per-day, per-model breakdown into one DayMetrics per active day.
 * Cost is priced per day (estimateCost is linear in tokens), but only for models
 * the aggregate `estimate` actually priced: a model the aggregate excluded as
 * unpriced (some non-zero bucket lacks a rate) must contribute $0 every day too,
 * or summing the days would not reconcile with the aggregate totalUsd.
 */
export function computeDayMetrics(
  report: UsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
): DayMetrics[] {
  const priced = new Set(Object.keys(estimate.perModel));
  const out: DayMetrics[] = [];
  for (const [day, dayModels] of report.perDay) {
    const est = estimateCost(dayModels, pricing);
    const m: DayMetrics = {
      day,
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
    for (const [model, u] of dayModels) {
      m.reqs += u.events;
      m.input += u.input;
      m.output += u.output;
      m.cacheRead += u.cacheRead;
      m.cacheWrite += u.cacheCreation;
      const c = est.perModel[model];
      // A day's tokens are a subset of the aggregate's, so any model the
      // aggregate priced is priced here too; gating on `priced` only drops the
      // models the aggregate already excluded.
      if (c !== undefined && priced.has(model)) {
        m.inputCost += c.inputCostUsd;
        m.outputCost += c.outputCostUsd;
        m.cacheReadCost += c.cacheReadCostUsd;
        m.cacheWriteCost += c.cacheCreationCostUsd;
        m.cost += c.estimatedCostUsd;
      }
    }
    m.total = m.input + m.output + m.cacheRead + m.cacheWrite;
    out.push(m);
  }
  return out;
}

/** Median of a numeric sample (mean of the two middles when even). 0 if empty. */
export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid]!;
}

/**
 * Calendar span and density of the active days: how many distinct days carried
 * usage out of the inclusive min..max calendar window, and what fraction of
 * that window was active. `spanDays` is 0 (and `percent` 100) when no days.
 */
export function activeDayCoverage(report: UsageReport): { spanDays: number; percent: number } {
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

/** Format a token count with a K/M suffix. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function formatCurrency(amount: number | undefined): string {
  return amount === undefined ? "N/A" : `$${amount.toFixed(2)}`;
}

type Align = "left" | "right";

function padCell(text: string, width: number, align: Align): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

/**
 * Render an aligned text table to stdout: a header row, a separator, the body
 * rows, then (if present) a second separator and footer rows. Uses console.log
 * directly so output is clean -- no consola `i` prefix or trailing timestamp.
 */
function printTable(
  headers: string[],
  aligns: Align[],
  body: string[][],
  footer: string[][],
): void {
  const rows = [headers, ...body, ...footer];
  const widths = headers.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (row: string[]): string =>
    `  ${row.map((c, i) => padCell(c ?? "", widths[i] ?? 0, aligns[i] ?? "left")).join("  ")}`;
  const sep = `  ${widths.map((w) => "-".repeat(w)).join("  ")}`;

  console.log(fmt(headers));
  console.log(sep);
  for (const row of body) {
    console.log(fmt(row));
  }
  if (footer.length > 0) {
    console.log(sep);
    for (const row of footer) {
      console.log(fmt(row));
    }
  }
}

/** A category cell: a token count and, when priced, its cost (null = unpriced). */
interface CatCell {
  tok: string;
  cost: string | null;
}

/**
 * Sub-align a category column: pad the token parts to one width and the `$`
 * amounts to another, separated by `|`, so the tokens, the separator, and the
 * decimal points all line up vertically -- e.g.
 *   `   176 |   $0.00`  /  `90.3K |   $0.45`  /  `234.2M | $117.09`.
 */
function alignCatColumn(cells: CatCell[]): string[] {
  const tokW = Math.max(...cells.map((c) => c.tok.length));
  const costStrs = cells.map((c) => (c.cost === null ? "" : `$${c.cost}`));
  const costW = Math.max(...costStrs.map((s) => s.length));
  return cells.map((c, i) => {
    const tok = c.tok.padStart(tokW);
    return c.cost === null ? tok : `${tok} | ${(costStrs[i] ?? "").padStart(costW)}`;
  });
}

/** Print the by-model usage + cost report as one table (tokens with $ per category). */
function printCostReport(
  report: UsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  dbCount: number,
  days: string | undefined,
): void {
  const { byModel, activeDays } = report;
  const models = [...byModel.keys()].sort();
  const period = days ? `last ${days} days` : "all time";
  const div = activeDays > 0 ? activeDays : 1;
  const dayMetrics = computeDayMetrics(report, pricing, estimate);
  const med = (sel: (d: DayMetrics) => number): number => median(dayMetrics.map(sel));

  // Bare cost amount (no `$`; alignCatColumn re-adds it after padding).
  const money = (n: number): string => n.toFixed(2);

  const sum = {
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
  };

  // Collect raw rows; the four category columns are sub-aligned together afterward.
  const labels: string[] = [];
  const reqsCol: string[] = [];
  const inputCol: CatCell[] = [];
  const outputCol: CatCell[] = [];
  const cacheReadCol: CatCell[] = [];
  const cacheWriteCol: CatCell[] = [];
  const totalCol: string[] = [];
  const costCol: string[] = [];

  for (const model of models) {
    const u = byModel.get(model);
    if (u === undefined) {
      continue;
    }
    const total = u.input + u.output + u.cacheRead + u.cacheCreation;
    const c = estimate.perModel[model]; // ModelCost | undefined (unpriced)
    sum.reqs += u.events;
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheWrite += u.cacheCreation;
    sum.total += total;
    if (c !== undefined) {
      sum.inputCost += c.inputCostUsd;
      sum.outputCost += c.outputCostUsd;
      sum.cacheReadCost += c.cacheReadCostUsd;
      sum.cacheWriteCost += c.cacheCreationCostUsd;
    }
    labels.push(model);
    reqsCol.push(formatTokens(u.events));
    inputCol.push({ tok: formatTokens(u.input), cost: c ? money(c.inputCostUsd) : null });
    outputCol.push({ tok: formatTokens(u.output), cost: c ? money(c.outputCostUsd) : null });
    cacheReadCol.push({
      tok: formatTokens(u.cacheRead),
      cost: c ? money(c.cacheReadCostUsd) : null,
    });
    cacheWriteCol.push({
      tok: formatTokens(u.cacheCreation),
      cost: c ? money(c.cacheCreationCostUsd) : null,
    });
    totalCol.push(formatTokens(total));
    costCol.push(c ? formatCurrency(c.estimatedCostUsd) : "unpriced");
  }

  // Footer rows (TOTAL, Avg/day) participate in the same sub-alignment.
  const avg = (n: number): number => n / div;
  const footerRows: Array<{
    label: string;
    reqs: string;
    cats: [CatCell, CatCell, CatCell, CatCell];
    total: string;
    cost: string;
  }> = [
    {
      label: "TOTAL",
      reqs: formatTokens(sum.reqs),
      cats: [
        { tok: formatTokens(sum.input), cost: money(sum.inputCost) },
        { tok: formatTokens(sum.output), cost: money(sum.outputCost) },
        { tok: formatTokens(sum.cacheRead), cost: money(sum.cacheReadCost) },
        { tok: formatTokens(sum.cacheWrite), cost: money(sum.cacheWriteCost) },
      ],
      total: formatTokens(sum.total),
      cost: formatCurrency(estimate.totalUsd),
    },
    {
      label: "Avg/day",
      reqs: activeDays > 0 ? formatTokens(Math.round(avg(sum.reqs))) : "N/A",
      cats: [
        { tok: formatTokens(Math.round(avg(sum.input))), cost: money(avg(sum.inputCost)) },
        { tok: formatTokens(Math.round(avg(sum.output))), cost: money(avg(sum.outputCost)) },
        { tok: formatTokens(Math.round(avg(sum.cacheRead))), cost: money(avg(sum.cacheReadCost)) },
        {
          tok: formatTokens(Math.round(avg(sum.cacheWrite))),
          cost: money(avg(sum.cacheWriteCost)),
        },
      ],
      total: activeDays > 0 ? formatTokens(Math.round(avg(sum.total))) : "N/A",
      cost: activeDays > 0 ? formatCurrency(estimate.totalUsd / div) : "N/A",
    },
    {
      label: "Median/day",
      reqs: activeDays > 0 ? formatTokens(Math.round(med((d) => d.reqs))) : "N/A",
      cats: [
        {
          tok: formatTokens(Math.round(med((d) => d.input))),
          cost: money(med((d) => d.inputCost)),
        },
        {
          tok: formatTokens(Math.round(med((d) => d.output))),
          cost: money(med((d) => d.outputCost)),
        },
        {
          tok: formatTokens(Math.round(med((d) => d.cacheRead))),
          cost: money(med((d) => d.cacheReadCost)),
        },
        {
          tok: formatTokens(Math.round(med((d) => d.cacheWrite))),
          cost: money(med((d) => d.cacheWriteCost)),
        },
      ],
      total: activeDays > 0 ? formatTokens(Math.round(med((d) => d.total))) : "N/A",
      cost: activeDays > 0 ? formatCurrency(med((d) => d.cost)) : "N/A",
    },
  ];
  for (const f of footerRows) {
    inputCol.push(f.cats[0]);
    outputCol.push(f.cats[1]);
    cacheReadCol.push(f.cats[2]);
    cacheWriteCol.push(f.cats[3]);
  }

  const inputCells = alignCatColumn(inputCol);
  const outputCells = alignCatColumn(outputCol);
  const cacheReadCells = alignCatColumn(cacheReadCol);
  const cacheWriteCells = alignCatColumn(cacheWriteCol);

  const body: string[][] = labels.map((label, i) => [
    label,
    reqsCol[i] ?? "",
    inputCells[i] ?? "",
    outputCells[i] ?? "",
    cacheReadCells[i] ?? "",
    cacheWriteCells[i] ?? "",
    totalCol[i] ?? "",
    costCol[i] ?? "",
  ]);
  const n = labels.length;
  const footer: string[][] = footerRows.map((f, j) => [
    f.label,
    f.reqs,
    inputCells[n + j] ?? "",
    outputCells[n + j] ?? "",
    cacheReadCells[n + j] ?? "",
    cacheWriteCells[n + j] ?? "",
    f.total,
    f.cost,
  ]);

  console.log();
  const coverage = activeDayCoverage(report);
  const activeDaysLabel =
    activeDays > 0
      ? `${activeDays} active day${activeDays === 1 ? "" : "s"} (${coverage.percent}% of a ${coverage.spanDays}-day span)`
      : "0 active days";
  console.log(
    `Usage by model - ${period} | ${dbCount} db${dbCount === 1 ? "" : "s"} | ${sum.reqs} requests | ${activeDaysLabel}`,
  );
  console.log();
  printTable(
    ["Model", "Requests", "Input", "Output", "Cache Read", "Cache Write", "Total", "Cost"],
    ["left", "right", "right", "right", "right", "right", "right", "right"],
    body,
    footer,
  );
  if (estimate.unpriced.length > 0) {
    console.log();
    console.log(`  Unpriced (excluded from total): ${estimate.unpriced.join(", ")}`);
  }
  console.log();
  console.log(
    "Note: only proxy usage is recorded. Direct-wired Codex/Claude (GitHub Copilot Direct) bypasses the proxy and is not tracked here at all.",
  );
  console.log();
}

/**
 * Print a day-by-day table (one row per active day, oldest first) plus a TOTAL
 * footer, sharing the main report's per-category token+cost sub-alignment.
 */
function printPerDayReport(
  report: UsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
): void {
  const days = computeDayMetrics(report, pricing, estimate).sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  if (days.length === 0) {
    return;
  }
  const money = (n: number): string => n.toFixed(2);

  const labels: string[] = [];
  const reqsCol: string[] = [];
  const inputCol: CatCell[] = [];
  const outputCol: CatCell[] = [];
  const cacheReadCol: CatCell[] = [];
  const cacheWriteCol: CatCell[] = [];
  const totalCol: string[] = [];
  const costCol: string[] = [];
  const sum = { reqs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

  const pushRow = (label: string, d: DayMetrics): void => {
    labels.push(label);
    reqsCol.push(formatTokens(d.reqs));
    inputCol.push({ tok: formatTokens(d.input), cost: money(d.inputCost) });
    outputCol.push({ tok: formatTokens(d.output), cost: money(d.outputCost) });
    cacheReadCol.push({ tok: formatTokens(d.cacheRead), cost: money(d.cacheReadCost) });
    cacheWriteCol.push({ tok: formatTokens(d.cacheWrite), cost: money(d.cacheWriteCost) });
    totalCol.push(formatTokens(d.total));
    costCol.push(formatCurrency(d.cost));
  };

  for (const d of days) {
    pushRow(d.day, d);
    sum.reqs += d.reqs;
    sum.input += d.input;
    sum.output += d.output;
    sum.cacheRead += d.cacheRead;
    sum.cacheWrite += d.cacheWrite;
    sum.total += d.total;
    sum.cost += d.cost;
  }
  // TOTAL footer mirrors the per-day rows so the sub-alignment stays consistent.
  const totalRow: DayMetrics = {
    day: "TOTAL",
    reqs: sum.reqs,
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    total: sum.total,
    inputCost: days.reduce((s, d) => s + d.inputCost, 0),
    outputCost: days.reduce((s, d) => s + d.outputCost, 0),
    cacheReadCost: days.reduce((s, d) => s + d.cacheReadCost, 0),
    cacheWriteCost: days.reduce((s, d) => s + d.cacheWriteCost, 0),
    cost: sum.cost,
  };
  pushRow("TOTAL", totalRow);

  const inputCells = alignCatColumn(inputCol);
  const outputCells = alignCatColumn(outputCol);
  const cacheReadCells = alignCatColumn(cacheReadCol);
  const cacheWriteCells = alignCatColumn(cacheWriteCol);

  const row = (i: number): string[] => [
    labels[i] ?? "",
    reqsCol[i] ?? "",
    inputCells[i] ?? "",
    outputCells[i] ?? "",
    cacheReadCells[i] ?? "",
    cacheWriteCells[i] ?? "",
    totalCol[i] ?? "",
    costCol[i] ?? "",
  ];
  const last = labels.length - 1;
  const body = days.map((_, i) => row(i));
  const footer = [row(last)];

  console.log("Per-day breakdown");
  console.log();
  printTable(
    ["Day", "Requests", "Input", "Output", "Cache Read", "Cache Write", "Total", "Cost"],
    ["left", "right", "right", "right", "right", "right", "right", "right"],
    body,
    footer,
  );
  console.log();
}

/** Build the `--json` payload. */
function buildCostJson(
  report: UsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  dbCount: number,
  sinceMs: number | undefined,
  perDay: boolean,
): Record<string, unknown> {
  const div = report.activeDays > 0 ? report.activeDays : 1;
  const dayMetrics = computeDayMetrics(report, pricing, estimate);
  const dayCosts = dayMetrics.map((d) => d.cost);
  const coverage = activeDayCoverage(report);
  return {
    dbCount,
    sinceMs: sinceMs ?? null,
    activeDays: report.activeDays,
    activeDaySpan: coverage.spanDays,
    activeDayPercent: report.activeDays > 0 ? coverage.percent : null,
    usageByModel: Object.fromEntries(report.byModel),
    perModel: estimate.perModel,
    totalUsd: estimate.totalUsd,
    avgCostPerDayUsd:
      report.activeDays > 0 ? Math.round((estimate.totalUsd / div) * 10_000) / 10_000 : null,
    medianCostPerDayUsd:
      report.activeDays > 0 ? Math.round(median(dayCosts) * 10_000) / 10_000 : null,
    ...(perDay
      ? {
          perDay: [...dayMetrics]
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((d) => ({
              day: d.day,
              requests: d.reqs,
              input: d.input,
              output: d.output,
              cacheRead: d.cacheRead,
              cacheCreation: d.cacheWrite,
              total: d.total,
              costUsd: Math.round(d.cost * 10_000) / 10_000,
            })),
        }
      : {}),
    unpriced: estimate.unpriced,
    note: "only proxy usage is recorded; direct GitHub Copilot usage is not tracked at all",
  };
}
