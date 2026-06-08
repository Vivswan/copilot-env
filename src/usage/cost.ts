// `agent cost`: fetches pricing, reads usage DBs, and prints spend estimates.
import { consola } from "consola";
import {
  type CostEstimate,
  estimateCost,
  fetchPricing,
  OPENROUTER_MODELS_URL,
  type PricingTier,
  type UsageTokens,
} from "./pricing.ts";
import { discoverUsageDbs, readUsage, type UsageReport } from "./usage.ts";

/** `cost`: aggregate per-host SQLite usage and estimate spend. */
export async function runCost(args: {
  days?: string;
  json?: boolean;
  "pricing-url"?: string;
}): Promise<void> {
  const dbPaths = discoverUsageDbs();
  if (dbPaths.length === 0) {
    consola.warn("WARNING: no copilot-api usage databases found.");
    return;
  }

  const sinceMs = parseDaysCutoff(args.days);
  const report = readUsage(dbPaths, sinceMs);

  // Best-effort pricing: a fetch failure still yields a token-only report.
  let pricing = new Map<string, PricingTier>();
  try {
    pricing = await fetchPricing(args["pricing-url"] ?? OPENROUTER_MODELS_URL);
  } catch (e) {
    consola.warn(
      `WARNING: could not fetch OpenRouter pricing (${e instanceof Error ? e.message : String(e)}); reporting tokens only.`,
    );
  }

  const tokensByModel = new Map<string, UsageTokens>();
  for (const [model, u] of report.byModel) {
    tokensByModel.set(model, {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheCreation: u.cacheCreation,
    });
  }
  const estimate = estimateCost(tokensByModel, pricing);

  if (args.json) {
    console.log(JSON.stringify(buildCostJson(report, estimate, dbPaths.length, sinceMs), null, 2));
    return;
  }
  printCostReport(report, estimate, dbPaths.length, args.days);
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
  return Date.now() - n * 86_400_000;
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
 * directly so output is clean — no consola `i` prefix or trailing timestamp.
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

/** Print the by-model usage + cost report as a table (hosts merged). */
function printCostReport(
  report: UsageReport,
  estimate: CostEstimate,
  dbCount: number,
  days: string | undefined,
): void {
  const { byModel, activeDays } = report;
  const models = [...byModel.keys()].sort();
  const period = days ? `last ${days} days` : "all time";

  const sum = { reqs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const body: string[][] = [];
  for (const model of models) {
    const u = byModel.get(model);
    if (u === undefined) {
      continue;
    }
    const total = u.input + u.output + u.cacheRead + u.cacheCreation;
    sum.reqs += u.events;
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheWrite += u.cacheCreation;
    sum.total += total;
    const priced = estimate.perModel[model];
    body.push([
      model,
      formatTokens(u.events),
      formatTokens(u.input),
      formatTokens(u.output),
      formatTokens(u.cacheRead),
      formatTokens(u.cacheCreation),
      formatTokens(total),
      priced ? formatCurrency(priced.estimatedCostUsd) : "unpriced",
    ]);
  }

  const perDay = (n: number): string =>
    activeDays > 0 ? formatTokens(Math.round(n / activeDays)) : "N/A";
  const footer: string[][] = [
    [
      "TOTAL",
      formatTokens(sum.reqs),
      formatTokens(sum.input),
      formatTokens(sum.output),
      formatTokens(sum.cacheRead),
      formatTokens(sum.cacheWrite),
      formatTokens(sum.total),
      formatCurrency(estimate.totalUsd),
    ],
    [
      "Avg/day",
      perDay(sum.reqs),
      perDay(sum.input),
      perDay(sum.output),
      perDay(sum.cacheRead),
      perDay(sum.cacheWrite),
      perDay(sum.total),
      activeDays > 0 ? formatCurrency(estimate.totalUsd / activeDays) : "N/A",
    ],
  ];

  console.log();
  console.log(
    `Usage by model - ${period} | ${dbCount} db${dbCount === 1 ? "" : "s"} | ${sum.reqs} requests | ${activeDays} active day${activeDays === 1 ? "" : "s"}`,
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
}

/** Build the `--json` payload. */
function buildCostJson(
  report: UsageReport,
  estimate: CostEstimate,
  dbCount: number,
  sinceMs: number | undefined,
): Record<string, unknown> {
  const div = report.activeDays > 0 ? report.activeDays : 1;
  return {
    dbCount,
    sinceMs: sinceMs ?? null,
    activeDays: report.activeDays,
    usageByModel: Object.fromEntries(report.byModel),
    perModel: estimate.perModel,
    totalUsd: estimate.totalUsd,
    avgCostPerDayUsd:
      report.activeDays > 0 ? Math.round((estimate.totalUsd / div) * 10_000) / 10_000 : null,
    unpriced: estimate.unpriced,
  };
}
