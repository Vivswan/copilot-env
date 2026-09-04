// `agent cost`: fetches pricing, reads usage DBs, and prints spend estimates.
import { consola } from "consola";
import { errMessage } from "../utils/error.ts";
import { type Align, printTable } from "../utils/table.ts";
import { formatDuration, MILLISECONDS_PER_DAY, startOfLocalDay } from "../utils/time.ts";
import { discoverClaudeSessionRoots, readClaudeSessions } from "./claude_sessions.ts";
import { discoverCodexSessionRoots, readCodexSessions } from "./codex_sessions.ts";
import {
  type CostEstimate,
  estimateCost,
  loadPricing,
  type ModelCost,
  OPENROUTER_MODELS_URL,
  type PricingTier,
  roundUsd,
} from "./pricing.ts";
import {
  discoverUsageDbs,
  mergeUsageReports,
  type ModelUsage,
  type ReadonlyUsageReport,
  readUsage,
  undatedUsage,
  type UsageReport,
  usageReport,
} from "./usage.ts";

/**
 * The default table merges the proxy DBs (proxied traffic) with the Codex and
 * Claude session logs (ALL of each agent's traffic, Direct included); traffic
 * through the proxy appears in both its agent's logs and the proxy DB, so
 * merged totals can double count it. This note closes every run.
 */
const SOURCES_NOTE =
  "Note: merges three sources -- the proxy DBs (proxied traffic) plus Codex session logs and Claude transcripts (each agent's full traffic, Direct included). Traffic through the proxy appears twice, so totals can double count it; use --sources for per-source tables.\nDisclaimer: these numbers are approximate -- gathered from local logs and priced at public OpenRouter rates; actual billing may differ.";

const EMPTY_REPORT: ReadonlyUsageReport = usageReport();

/** `cost`: aggregate per-host SQLite + Codex session usage and estimate spend. */
export async function runCost(args: {
  days?: string;
  json?: boolean;
  perDay?: boolean;
  pricingUrl?: string;
  sources?: boolean;
}): Promise<void> {
  const window = args.days === undefined ? undefined : parseDaysWindow(args.days);
  const sinceMs = window === undefined ? undefined : daysCutoffMs(window);

  // Started before the source readers, awaited where first needed: the network
  // round-trip overlaps the file parsing. The no-op catch keeps the no-sources
  // early return from leaving an unhandled rejection; the abort keeps it from waiting.
  const pricingAbort = new AbortController();
  const pricingLoad = loadPricing(args.pricingUrl ?? OPENROUTER_MODELS_URL, {
    signal: pricingAbort.signal,
  });
  pricingLoad.catch(() => {});

  const dbPaths = discoverUsageDbs();
  const proxyReport = dbPaths.length > 0 ? readUsage(dbPaths, sinceMs) : EMPTY_REPORT;

  const sessionRoots = discoverCodexSessionRoots();
  const codexByProvider = sessionRoots.length > 0
    ? await readCodexSessions(sessionRoots, sinceMs)
    : new Map<string, UsageReport>();

  const claudeRoots = discoverClaudeSessionRoots();
  const claudeReport = claudeRoots.length > 0
    ? await readClaudeSessions(claudeRoots, sinceMs)
    : EMPTY_REPORT;

  if (dbPaths.length === 0 && codexByProvider.size === 0 && claudeReport.byModel.size === 0) {
    consola.warn(
      "WARNING: no copilot-api usage databases, Codex session logs, or Claude transcripts found; start the proxy with 'agent start' and make some requests, then re-run 'agent cost'.",
    );
    pricingAbort.abort();
    return;
  }

  // Best-effort pricing: a fetch failure still yields a token-only report.
  let pricing = new Map<string, PricingTier>();
  try {
    const loaded = await pricingLoad;
    pricing = loaded.pricing;
    if (loaded.source === "stale-cache") {
      consola.warn(
        `WARNING: could not refresh OpenRouter pricing (${loaded.fetchError}); using the cached price list from ${
          formatDuration(Date.now() - loaded.fetchedAtMs)
        } ago.`,
      );
    }
    if (loaded.source === "fetched" && loaded.cacheWriteError !== undefined) {
      consola.warn(
        `WARNING: could not cache the OpenRouter price list (${loaded.cacheWriteError}); the next run fetches it again.`,
      );
    }
  } catch (e) {
    consola.warn(
      `WARNING: could not fetch OpenRouter pricing (${errMessage(e)}); reporting tokens only.`,
    );
  }

  // ModelUsage is a structural superset of UsageTokens, so the read-only
  // estimateCost reads report.byModel directly -- no per-model copy needed.
  const proxyEstimate = estimateCost(proxyReport.byModel, pricing);
  const codexProviders = [...codexByProvider.keys()].sort();

  if (args.json) {
    const codexSessions = {
      roots: sessionRoots.length,
      providers: Object.fromEntries(
        codexProviders.map((provider) => {
          const report = codexByProvider.get(provider) ?? EMPTY_REPORT;
          return [
            provider,
            buildSourceJson(report, estimateCost(report.byModel, pricing), pricing, {
              perDay: Boolean(args.perDay),
            }),
          ];
        }),
      ),
    };
    const claudeSessions = {
      roots: claudeRoots.length,
      ...buildSourceJson(claudeReport, estimateCost(claudeReport.byModel, pricing), pricing, {
        perDay: Boolean(args.perDay),
      }),
    };
    console.log(
      JSON.stringify(
        buildCostJson(
          proxyReport,
          proxyEstimate,
          pricing,
          dbPaths.length,
          sinceMs,
          Boolean(args.perDay),
          codexSessions,
          claudeSessions,
        ),
        null,
        2,
      ),
    );
    return;
  }

  const claude = { report: claudeReport, roots: claudeRoots.length };
  if (args.sources) {
    printSeparateReports(
      { report: proxyReport, estimate: proxyEstimate, dbCount: dbPaths.length },
      codexByProvider,
      claude,
      { pricing, window, perDay: Boolean(args.perDay), roots: sessionRoots.length },
    );
  } else {
    printCombinedView(
      { report: proxyReport, estimate: proxyEstimate, dbCount: dbPaths.length },
      codexByProvider,
      claude,
      { pricing, window, perDay: Boolean(args.perDay), roots: sessionRoots.length },
    );
  }

  console.log(SOURCES_NOTE);
  console.log("");
}

/** Shared per-call context for the two report layouts. */
interface ReportOpts {
  pricing: Map<string, PricingTier>;
  window: DaysWindow | undefined;
  perDay: boolean;
  roots: number;
}

interface ProxySource {
  report: ReadonlyUsageReport;
  estimate: CostEstimate;
  dbCount: number;
}

interface ClaudeSource {
  report: ReadonlyUsageReport;
  roots: number;
}

/** `--sources`: one full table (with day stats) per source and Codex provider. */
function printSeparateReports(
  proxy: ProxySource,
  codexByProvider: ReadonlyMap<string, ReadonlyUsageReport>,
  claude: ClaudeSource,
  opts: ReportOpts,
): void {
  if (proxy.dbCount > 0) {
    printCostReport(proxy.report, proxy.estimate, opts.pricing, {
      title: "Proxy usage by model",
      sourceLabel: `${proxy.dbCount} db${proxy.dbCount === 1 ? "" : "s"}`,
      window: opts.window,
    });
    if (opts.perDay) {
      printPerDayReport(proxy.report, opts.pricing, proxy.estimate, "Per-day breakdown (proxy)");
    }
  } else {
    console.log("");
    console.log("No proxy usage databases found; skipping the proxy section.");
  }

  for (const provider of [...codexByProvider.keys()].sort()) {
    const report = codexByProvider.get(provider) ?? EMPTY_REPORT;
    const estimate = estimateCost(report.byModel, opts.pricing);
    printCostReport(report, estimate, opts.pricing, {
      title: `Codex sessions (provider: ${provider}) by model`,
      sourceLabel: `${opts.roots} root${opts.roots === 1 ? "" : "s"}`,
      window: opts.window,
    });
    if (opts.perDay) {
      printPerDayReport(report, opts.pricing, estimate, `Per-day breakdown (codex: ${provider})`);
    }
  }

  if (claude.roots > 0) {
    const estimate = estimateCost(claude.report.byModel, opts.pricing);
    printCostReport(claude.report, estimate, opts.pricing, {
      title: "Claude sessions by model",
      sourceLabel: `${claude.roots} root${claude.roots === 1 ? "" : "s"}`,
      window: opts.window,
    });
    if (opts.perDay) {
      printPerDayReport(claude.report, opts.pricing, estimate, "Per-day breakdown (claude)");
    }
  }
}

/** Default layout: the classic single table over the union of all sources. */
function printCombinedView(
  proxy: ProxySource,
  codexByProvider: ReadonlyMap<string, ReadonlyUsageReport>,
  claude: ClaudeSource,
  opts: ReportOpts,
): void {
  const merged = mergeUsageReports([proxy.report, ...codexByProvider.values(), claude.report]);
  const estimate = estimateCost(merged.byModel, opts.pricing);
  const parts: string[] = [];
  if (proxy.dbCount > 0) {
    parts.push(`${proxy.dbCount} proxy db${proxy.dbCount === 1 ? "" : "s"}`);
  }
  if (opts.roots > 0) {
    parts.push(`${opts.roots} codex session root${opts.roots === 1 ? "" : "s"}`);
  }
  if (claude.roots > 0) {
    parts.push(`${claude.roots} claude projects root${claude.roots === 1 ? "" : "s"}`);
  }
  printCostReport(merged, estimate, opts.pricing, {
    title: "Usage by model",
    sourceLabel: parts.join(" + "),
    window: opts.window,
  });
  if (opts.perDay) {
    printPerDayReport(merged, opts.pricing, estimate, "Per-day breakdown");
  }
}

/**
 * The `--days` window, told apart by SPELLING: a whole number counts local
 * calendar days (`1` = today since local midnight, `7` = today plus the six
 * days before), while a decimal is an exact span of 24-hour days (`1.0` = the
 * last 24 hours, `0.5` = the last 12). Number("1.0") === 1, so the raw flag
 * text is the only place the two can be distinguished -- which is why the
 * parser takes the string, not a number.
 */
export type DaysWindow =
  | { kind: "calendar"; days: number }
  | { kind: "exact"; days: number };

/** The two admitted spellings: ASCII digits alone for calendar days, digits with one
 *  decimal point for exact days. Nothing else parses. Number() would also admit a
 *  sign, whitespace, an exponent, or hex, and each of those would silently land in a
 *  window kind the user never chose. */
const WHOLE_DAYS = /^\d+$/;
const DECIMAL_DAYS = /^(\d+\.\d*|\.\d+)$/;

/** The longest window with a valid cutoff instant: Date represents 8.64e15 ms either
 *  side of the epoch, which is exactly this many 24-hour days. */
const MAX_DAYS = 8.64e15 / MILLISECONDS_PER_DAY;

/** Parse the raw `--days` text into a DaysWindow; the ONE mint, so a window's `days`
 *  is always positive, finite, and small enough to yield a real cutoff. */
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

/**
 * Translate a DaysWindow into the unix-ms cutoff the readers apply. A calendar
 * window starts at a real local midnight (`days - 1` days before today's), so
 * it always covers whole calendar days and its first day is never partial; an
 * exact window is a plain multiple of 24 hours back from now.
 */
export function daysCutoffMs(window: DaysWindow, nowMs: number = Date.now()): number {
  return window.kind === "calendar"
    ? startOfLocalDay(nowMs, window.days - 1)
    : nowMs - window.days * MILLISECONDS_PER_DAY;
}

/** The report header's period phrase: "all time", "today", "last 7 calendar
 *  days", or the exact span as a duration ("last 36h"). formatDuration rounds to
 *  whole seconds, so a span it would render as "0s" falls back to the day count. */
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

/** One row group's totals across all models, including per-category cost. */
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

/** One calendar day's totals: DayTotals pinned to its YYYY-MM-DD day. */
export interface DayMetrics extends DayTotals {
  day: string;
}

/** One per-day table row: a calendar day's totals, or the undated rest (usage
 *  recorded without a date). The discriminant replaces a magic day label; the
 *  "(undated)" spelling is applied at render time only. */
export type PerDayRow =
  | ({ kind: "dated" } & DayMetrics)
  | ({ kind: "undated" } & DayTotals);

/**
 * Collapse the per-day, per-model breakdown into one DayMetrics per active day.
 * Dated days only: usage recorded without a day is undatedTotals' row, kept
 * out of here so the per-day medians stay per-DAY statistics. (Avg/day is
 * different by design: it spreads the aggregate, undated included, over the
 * active days.)
 * Cost is priced per day (estimateCost is linear in tokens), but only for models
 * the aggregate `estimate` actually priced: a model the aggregate excluded as
 * unpriced (some non-zero bucket lacks a rate) must contribute $0 every day too,
 * or summing the days would not reconcile with the aggregate totalUsd.
 */
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

/** One row group's totals across its models: a calendar day, or the undated rest. */
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
    // A group's tokens are a subset of the aggregate's, so any model the
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
  return m;
}

/** The render-time label of the per-day table's row for usage no day claims.
 *  Exported only to pin the spelling, an external display contract, in tests. */
export const UNDATED_DAY_LABEL = "(undated)";

/**
 * The undated rest's totals: usage recorded without a date reaches byModel but
 * no perDay entry, and without its row the per-day table's columns could not
 * sum to the TOTAL line (which always carries the aggregate's numbers).
 * null when the days account for everything -- the normal case, since the
 * daemon timestamps every DB row.
 */
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

/**
 * The per-day table's body rows: one dated row per active day, oldest first,
 * closed by the undated row when one is due. THE row list the table prints
 * and its TOTAL line sums over.
 */
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

/**
 * Format a token count with a one-decimal K/M suffix ("1.2K", "1.0M").
 * Distinct from commands/models.ts's formatTokens, which renders catalog
 * context-window sizes as bare "200k"/"1M" -- different semantics, so a
 * different name.
 */
function formatTokensCompact(n: number): string {
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

/** One assembled table row: label, requests, the four category cells, total, cost. */
interface CostRow {
  label: string;
  reqs: string;
  input: CatCell;
  output: CatCell;
  cacheRead: CatCell;
  cacheWrite: CatCell;
  total: string;
  cost: string;
}

/** The CostRow category columns, in table order. */
const CAT_COLUMNS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Column headings and alignment shared by the by-model and per-day tables. */
const COST_TABLE_COLUMNS = [
  "Requests",
  "Input",
  "Output",
  "Cache Read",
  "Cache Write",
  "Total",
  "Cost",
];
const COST_TABLE_ALIGNS: Align[] = [
  "left",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
];

/** Build a category cell: a bare cost amount (alignCatColumn re-adds the `$`
 *  after padding), or a null cost to render the token count alone (unpriced). */
function catCell(tokens: number, costUsd: number | null): CatCell {
  return { tok: formatTokensCompact(tokens), cost: costUsd === null ? null : costUsd.toFixed(2) };
}

/**
 * Turn assembled rows into printTable cells. Each category column is
 * sub-aligned across body and footer TOGETHER, so the `|` separators and
 * decimal points line up down the whole table, footer included.
 */
function renderCostRows(
  body: CostRow[],
  footer: CostRow[],
): { body: string[][]; footer: string[][] } {
  const rows = [...body, ...footer];
  const cats = CAT_COLUMNS.map((key) => alignCatColumn(rows.map((r) => r[key])));
  const cells = rows.map((r, i) => [
    r.label,
    r.reqs,
    ...cats.map((col) => col[i] ?? ""),
    r.total,
    r.cost,
  ]);
  return { body: cells.slice(0, body.length), footer: cells.slice(body.length) };
}

/** Running token totals across the by-model rows. Cost totals deliberately live
 *  elsewhere (sumEstimateCosts): every TOTAL row renders the aggregate's numbers. */
interface CostSums {
  reqs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

type CostFields = Pick<
  DayTotals,
  "inputCost" | "outputCost" | "cacheReadCost" | "cacheWriteCost" | "cost"
>;

/**
 * Per-category cost sums over the estimate's exact per-model costs. EVERY total
 * row (by-model TOTAL and per-day TOTAL alike) renders these same doubles:
 * summing the same costs regrouped differently (by model vs by day) can differ
 * by one ulp, which toFixed can stretch into a visible cent at a boundary.
 */
function sumEstimateCosts(estimate: CostEstimate): CostFields {
  const sums = {
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    cost: estimate.totalUsd,
  };
  for (const c of Object.values(estimate.perModel)) {
    sums.inputCost += c.inputCostUsd;
    sums.outputCost += c.outputCostUsd;
    sums.cacheReadCost += c.cacheReadCostUsd;
    sums.cacheWriteCost += c.cacheCreationCostUsd;
  }
  return sums;
}

/** One row per model (most expensive first) plus the totals they sum to. */
function buildModelRows(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
): { rows: CostRow[]; sum: CostSums } {
  const { byModel } = report;
  // Most expensive first; unpriced models sink to the bottom, ties by name.
  const models = [...byModel.keys()].sort((a, b) => {
    const costA = estimate.perModel[a]?.estimatedCostUsd ?? -1;
    const costB = estimate.perModel[b]?.estimatedCostUsd ?? -1;
    return costB - costA || a.localeCompare(b);
  });
  const sum: CostSums = {
    reqs: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  const rows: CostRow[] = [];
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
    rows.push({
      label: model,
      reqs: formatTokensCompact(u.events),
      input: catCell(u.input, c ? c.inputCostUsd : null),
      output: catCell(u.output, c ? c.outputCostUsd : null),
      cacheRead: catCell(u.cacheRead, c ? c.cacheReadCostUsd : null),
      cacheWrite: catCell(u.cacheCreation, c ? c.cacheCreationCostUsd : null),
      total: formatTokensCompact(total),
      cost: c ? formatCurrency(c.estimatedCostUsd) : "unpriced",
    });
  }
  return { rows, sum };
}

/** The TOTAL / Avg-day / Median-day footer rows of the by-model table. */
function buildAggregateFooter(
  sum: CostSums,
  estimate: CostEstimate,
  activeDays: number,
  dayMetrics: DayMetrics[],
): CostRow[] {
  const div = activeDays > 0 ? activeDays : 1;
  const agg = sumEstimateCosts(estimate);
  const avg = (n: number): number => n / div;
  const med = (sel: (d: DayMetrics) => number): number => median(dayMetrics.map(sel));
  const orNa = (s: string): string => (activeDays > 0 ? s : "N/A");
  return [
    {
      label: "TOTAL",
      reqs: formatTokensCompact(sum.reqs),
      input: catCell(sum.input, agg.inputCost),
      output: catCell(sum.output, agg.outputCost),
      cacheRead: catCell(sum.cacheRead, agg.cacheReadCost),
      cacheWrite: catCell(sum.cacheWrite, agg.cacheWriteCost),
      total: formatTokensCompact(sum.total),
      cost: formatCurrency(agg.cost),
    },
    {
      label: "Avg/day",
      reqs: orNa(formatTokensCompact(Math.round(avg(sum.reqs)))),
      input: catCell(Math.round(avg(sum.input)), avg(agg.inputCost)),
      output: catCell(Math.round(avg(sum.output)), avg(agg.outputCost)),
      cacheRead: catCell(Math.round(avg(sum.cacheRead)), avg(agg.cacheReadCost)),
      cacheWrite: catCell(Math.round(avg(sum.cacheWrite)), avg(agg.cacheWriteCost)),
      total: orNa(formatTokensCompact(Math.round(avg(sum.total)))),
      cost: orNa(formatCurrency(avg(agg.cost))),
    },
    {
      label: "Median/day",
      reqs: orNa(formatTokensCompact(Math.round(med((d) => d.reqs)))),
      input: catCell(
        Math.round(med((d) => d.input)),
        med((d) => d.inputCost),
      ),
      output: catCell(
        Math.round(med((d) => d.output)),
        med((d) => d.outputCost),
      ),
      cacheRead: catCell(
        Math.round(med((d) => d.cacheRead)),
        med((d) => d.cacheReadCost),
      ),
      cacheWrite: catCell(
        Math.round(med((d) => d.cacheWrite)),
        med((d) => d.cacheWriteCost),
      ),
      total: orNa(formatTokensCompact(Math.round(med((d) => d.total)))),
      cost: orNa(formatCurrency(med((d) => d.cost))),
    },
  ];
}

/** Print one source's by-model usage + cost table (tokens with $ per category). */
function printCostReport(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  opts: { title: string; sourceLabel: string; window: DaysWindow | undefined },
): void {
  const activeDays = report.perDay.size;
  const dayMetrics = computeDayMetrics(report, pricing, estimate);
  const { rows, sum } = buildModelRows(report, estimate);
  const footer = buildAggregateFooter(sum, estimate, activeDays, dayMetrics);
  const cells = renderCostRows(rows, footer);

  console.log("");
  const period = describeDaysWindow(opts.window);
  const coverage = activeDayCoverage(report);
  const activeDaysLabel = activeDays > 0
    ? `${activeDays} active day${
      activeDays === 1 ? "" : "s"
    } (${coverage.percent}% of a ${coverage.spanDays}-day span)`
    : "0 active days";
  console.log(
    `${opts.title} - ${period} | ${opts.sourceLabel} | ${sum.reqs} requests | ${activeDaysLabel}`,
  );
  console.log("");
  printTable(cells.body, {
    header: ["Model", ...COST_TABLE_COLUMNS],
    aligns: COST_TABLE_ALIGNS,
    footer: cells.footer,
  });
  if (estimate.unpriced.length > 0) {
    console.log("");
    console.log(`  Unpriced (excluded from total): ${estimate.unpriced.join(", ")}`);
  }
  console.log("");
}

/** One assembled per-day table row: the caller-chosen label over a group's totals. */
function dayRow(label: string, d: DayTotals): CostRow {
  return {
    label,
    reqs: formatTokensCompact(d.reqs),
    input: catCell(d.input, d.inputCost),
    output: catCell(d.output, d.outputCost),
    cacheRead: catCell(d.cacheRead, d.cacheReadCost),
    cacheWrite: catCell(d.cacheWrite, d.cacheWriteCost),
    total: formatTokensCompact(d.total),
    cost: formatCurrency(d.cost),
  };
}

/**
 * The per-day table's TOTAL line (the "TOTAL" label is the renderer's), summing
 * the token and request columns of the rows above it (the dated days, plus the
 * undated row when one prints -- so the columns really add up to it). The cost
 * fields are the aggregate's numbers via sumEstimateCosts, NOT the column sum:
 * the two tables regroup the SAME aggregate (by model there, by day plus the
 * undated rest here), so both TOTAL rows render the one true grand total,
 * bit-identically.
 */
export function sumDayTotals(days: readonly DayTotals[], estimate: CostEstimate): DayTotals {
  const sum: DayTotals = {
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
  for (const d of days) {
    sum.reqs += d.reqs;
    sum.input += d.input;
    sum.output += d.output;
    sum.cacheRead += d.cacheRead;
    sum.cacheWrite += d.cacheWrite;
    sum.total += d.total;
  }
  return { ...sum, ...sumEstimateCosts(estimate) };
}

/**
 * Print a day-by-day table (one row per active day, oldest first, plus the
 * undated row when usage carries no date) and a TOTAL footer, sharing the main
 * report's per-category token+cost sub-alignment.
 */
function printPerDayReport(
  report: ReadonlyUsageReport,
  pricing: Map<string, PricingTier>,
  estimate: CostEstimate,
  title: string,
): void {
  const rows = perDayRows(report, pricing, estimate);
  if (rows.length === 0) {
    return;
  }
  const cells = renderCostRows(
    rows.map((r) => dayRow(r.kind === "dated" ? r.day : UNDATED_DAY_LABEL, r)),
    [dayRow("TOTAL", sumDayTotals(rows, estimate))],
  );

  console.log(title);
  console.log("");
  printTable(cells.body, {
    header: ["Day", ...COST_TABLE_COLUMNS],
    aligns: COST_TABLE_ALIGNS,
    footer: cells.footer,
  });
  console.log("");
}

/** Round a ModelCost's USD fields for serialization; in-memory values stay exact. */
function roundModelCost(cost: ModelCost): ModelCost {
  return {
    pricingReference: cost.pricingReference,
    estimatedCostUsd: roundUsd(cost.estimatedCostUsd),
    inputCostUsd: roundUsd(cost.inputCostUsd),
    outputCostUsd: roundUsd(cost.outputCostUsd),
    cacheReadCostUsd: roundUsd(cost.cacheReadCostUsd),
    cacheCreationCostUsd: roundUsd(cost.cacheCreationCostUsd),
  };
}

/** Build one source's usage/cost JSON block (shared by the proxy and each provider).
 *  This is the ONE place estimate USD values get rounded for machine output. */
export function buildSourceJson(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  opts: { perDay: boolean },
): Record<string, unknown> {
  const activeDays = report.perDay.size;
  const div = activeDays > 0 ? activeDays : 1;
  const dayMetrics = computeDayMetrics(report, pricing, estimate);
  const dayCosts = dayMetrics.map((d) => d.cost);
  const coverage = activeDayCoverage(report);
  return {
    activeDays,
    activeDaySpan: coverage.spanDays,
    activeDayPercent: activeDays > 0 ? coverage.percent : null,
    usageByModel: Object.fromEntries(report.byModel),
    perModel: Object.fromEntries(
      Object.entries(estimate.perModel).map(([model, c]) => [model, roundModelCost(c)]),
    ),
    totalUsd: roundUsd(estimate.totalUsd),
    avgCostPerDayUsd: activeDays > 0 ? roundUsd(estimate.totalUsd / div) : null,
    medianCostPerDayUsd: activeDays > 0 ? roundUsd(median(dayCosts)) : null,
    ...(opts.perDay
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
            costUsd: roundUsd(d.cost),
          })),
      }
      : {}),
    unpriced: estimate.unpriced,
  };
}

/**
 * Build the `--json` payload. The top-level keys keep their historical
 * proxy-report shape; the Codex session source is the added `codexSessions`
 * key so existing consumers are unaffected.
 */
function buildCostJson(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  dbCount: number,
  sinceMs: number | undefined,
  perDay: boolean,
  codexSessions: { roots: number; providers: Record<string, Record<string, unknown>> },
  claudeSessions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    dbCount,
    sinceMs: sinceMs ?? null,
    ...buildSourceJson(report, estimate, pricing, { perDay }),
    codexSessions,
    claudeSessions,
    note:
      "approximate numbers gathered from local logs and keyed by canonical model spellings (dashed/dated claude ids fold into the dotted form), priced at public OpenRouter rates (actual billing may differ); top-level keys cover proxied traffic only, while codexSessions/claudeSessions cover each agent's FULL traffic (proxy and Direct), so they overlap the proxy keys when an agent is proxy-wired -- never sum them",
  };
}
