import { consola } from "consola";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { errMessage } from "../utils/error.ts";
import { type Align, printTable } from "../utils/table.ts";
import { formatDuration, MILLISECONDS_PER_DAY, startOfLocalDay } from "../utils/time.ts";
import { discoverClaudeSessionRoots, readClaudeSessions } from "./claude_sessions.ts";
import { discoverCodexSessionRoots, readCodexSessions } from "./codex_sessions.ts";
import {
  emptyIndexStats,
  type IndexStats,
  parseEveryCandidate,
  type Reconcile,
} from "./contribution.ts";
import { openUsageIndex } from "./index.ts";
import {
  type CostEstimate,
  estimateCost,
  loadPricing,
  type ModelCost,
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

const SOURCES_NOTE =
  "Note: merges three sources -- the proxy DBs (proxied traffic) plus Codex session logs and Claude transcripts " +
  "(each agent's full traffic, Direct included). Traffic through the proxy appears twice, so totals can double count it; " +
  "use --sources for per-source tables.\n" +
  "Disclaimer: these numbers are approximate -- gathered from local logs and priced at public OpenRouter rates; " +
  "actual billing may differ.";

const EMPTY_REPORT: ReadonlyUsageReport = usageReport();

/** Supplied together or not at all, so a test cannot redirect one source and still sweep the
 *  other's real home. */
export interface SessionRootDiscovery {
  codex(): string[];
  claude(): string[];
}

const DEFAULT_SESSION_ROOTS: SessionRootDiscovery = {
  codex: () => discoverCodexSessionRoots(),
  claude: () => discoverClaudeSessionRoots(),
};

/** Tests inject a fetch and their own session roots, because the default discovery sweeps the real
 *  Codex and Claude homes. */
export interface CostDeps {
  fetchImpl?: typeof fetch;
  sessionRoots?: SessionRootDiscovery;
  /** The clock every `runtime.timing` figure is read from, in ms. */
  now?: () => number;
}

export interface CostArgs {
  days?: string;
  json?: boolean;
  perDay?: boolean;
  /** Unset defers to the `pricing-url` config key. */
  pricingUrl?: string;
  sources?: boolean;
  /** The usage index is neither opened nor written. */
  noIndex?: boolean;
}

/** How the run went, never what it found, so consumers comparing two runs' numbers drop it.
 *  `timing` is wall-clock ms per phase; `pricing` is the price-list load (network, or the cache
 *  read), and `total` runs from the start to the moment the JSON payload is built. */
export interface CostRuntime {
  /** False under --no-index and when the index could not be opened. */
  indexed: boolean;
  index: IndexStats;
  timing: { walk: number; parse: number; fold: number; pricing: number; total: number };
}

/** `total` is missing because only the payload's builder can stamp it: it is the last thing
 *  measured. */
interface MeasuredRun {
  indexed: boolean;
  index: IndexStats;
  timing: Omit<CostRuntime["timing"], "total">;
  startedAt: number;
  now: () => number;
}

export function addIndexStats(into: IndexStats, more: IndexStats): void {
  into.filesSeen += more.filesSeen;
  into.filesReused += more.filesReused;
  into.filesParsedWhole += more.filesParsedWhole;
  into.filesParsedTail += more.filesParsedTail;
  into.filesFailed += more.filesFailed;
  into.filesDeleted += more.filesDeleted;
  into.bytesRead += more.bytesRead;
}

/** Each reader call is split into walk / parse / fold by the wall clock at the reconcile's entry
 *  and exit: a reader walks, reconciles, and folds in sequence, and always calls the reconcile
 *  exactly once. */
export class ReconcileMeter {
  readonly stats: IndexStats = emptyIndexStats();
  readonly timing = { walk: 0, parse: 0, fold: 0 };
  readonly reconcile: Reconcile;
  readonly #now: () => number;
  #enteredAt = 0;
  #exitedAt = 0;

  constructor(inner: Reconcile, now: () => number = () => performance.now()) {
    this.#now = now;
    this.reconcile = (source, walked, parseWhole, parseTail) => {
      this.#enteredAt = this.#now();
      const result = inner(source, walked, parseWhole, parseTail);
      this.#exitedAt = this.#now();
      this.timing.parse += this.#exitedAt - this.#enteredAt;
      addIndexStats(this.stats, result.stats);
      return result;
    };
  }

  /** The readers' bodies are synchronous, so the clock is read when the reader RETURNS its promise;
   *  awaiting first would bill whatever else the microtask queue held to `fold`. */
  async read<T>(reader: (reconcile: Reconcile) => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    this.#enteredAt = startedAt;
    this.#exitedAt = startedAt;
    const pending = reader(this.reconcile);
    const returnedAt = this.#now();
    this.timing.walk += this.#enteredAt - startedAt;
    this.timing.fold += returnedAt - this.#exitedAt;
    return await pending;
  }
}

/** Flag, else the stored `pricing-url` key, else the built-in (the accessor folds the last two). */
export function resolvePricingUrl(
  flag: string | undefined,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): string {
  return flag ?? config.pricingUrl();
}

export async function runCost(args: CostArgs, deps: CostDeps = {}): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const window = args.days === undefined ? undefined : parseDaysWindow(args.days);
  // Up front, so an unreadable preference store rejects the command before any source is read
  // rather than degrading to a token-only report.
  const pricingUrl = resolvePricingUrl(args.pricingUrl);
  await reportCost(args, deps.sessionRoots ?? DEFAULT_SESSION_ROOTS, {
    window,
    startedAt,
    now,
    pricingUrl,
    fetchImpl: deps.fetchImpl,
  });
}

interface CostRun {
  window: DaysWindow | undefined;
  startedAt: number;
  now: () => number;
  pricingUrl: string;
  fetchImpl: typeof fetch | undefined;
}

async function reportCost(
  args: CostArgs,
  roots: SessionRootDiscovery,
  run: CostRun,
): Promise<void> {
  const { window, startedAt, now } = run;
  const sinceMs = window === undefined ? undefined : daysCutoffMs(window);
  const dbPaths = discoverUsageDbs();
  const proxyReport = dbPaths.length > 0 ? readUsage(dbPaths, sinceMs) : EMPTY_REPORT;

  // Discovered before the index opens, so nothing but the reads sits between open and close.
  const sessionRoots = roots.codex();
  const claudeRoots = roots.claude();
  const logs = await readSessionLogs(
    sessionRoots,
    claudeRoots,
    sinceMs,
    args.noIndex === true,
    now,
  );
  const { codexByProvider, claudeReport } = logs;

  if (dbPaths.length === 0 && codexByProvider.size === 0 && claudeReport.byModel.size === 0) {
    consola.warn(
      "WARNING: no copilot-api usage databases, Codex session logs, or Claude transcripts found; start the proxy with 'agent start' and make some requests, then re-run 'agent cost'.",
    );
    return;
  }

  // After the readers, never beside them: they are synchronous, so a fetch in flight across them
  // could make no progress and its timeout fired the moment the event loop was free again. A fetch
  // failure prices from an expired cache when one exists, and reports tokens only when none does.
  let pricing = new Map<string, PricingTier>();
  const pricingWaitStartedAt = now();
  let pricingWaitMs = 0;
  try {
    const loaded = await loadPricing(run.pricingUrl, { fetchImpl: run.fetchImpl }).finally(() => {
      pricingWaitMs = now() - pricingWaitStartedAt;
    });
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

  const measured: MeasuredRun = {
    indexed: logs.indexed,
    index: logs.meter.stats,
    timing: {
      walk: Math.round(logs.meter.timing.walk),
      parse: Math.round(logs.meter.timing.parse),
      fold: Math.round(logs.meter.timing.fold),
      pricing: Math.round(pricingWaitMs),
    },
    startedAt,
    now,
  };

  // ModelUsage is a structural superset of UsageTokens, so no per-model copy is needed.
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
          measured,
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
  if (logs.indexed) {
    process.stderr.write(`${describeIndexRun(logs.meter.stats)}\n`);
  }
}

interface SessionLogs {
  codexByProvider: Map<string, UsageReport>;
  claudeReport: UsageReport;
  /** False under --no-index and when the index could not be opened. */
  indexed: boolean;
  meter: ReconcileMeter;
}

/** Both readers run even when a source has no roots: the reconcile is what deletes the rows of a
 *  session root that no longer exists, and only that source's walk (an empty one included) reaches
 *  it. */
async function readSessionLogs(
  codexRoots: string[],
  claudeRoots: string[],
  sinceMs: number | undefined,
  noIndex: boolean,
  now: () => number,
): Promise<SessionLogs> {
  const index = noIndex ? null : openUsageIndex();
  try {
    const meter = new ReconcileMeter(index?.reconcile ?? parseEveryCandidate, now);
    const codexByProvider = await meter.read((reconcile) =>
      readCodexSessions(codexRoots, sinceMs, undefined, reconcile)
    );
    const claudeReport = await meter.read((reconcile) =>
      readClaudeSessions(claudeRoots, sinceMs, undefined, reconcile)
    );
    return { codexByProvider, claudeReport, indexed: index !== null, meter };
  } finally {
    index?.close();
  }
}

export function describeIndexRun(stats: IndexStats): string {
  return `usage index: ${stats.filesReused} files reused, ${stats.filesParsedTail} tail-parsed, ${stats.filesParsedWhole} whole-parsed, ${
    formatBytesCompact(stats.bytesRead)
  } read`;
}

export function formatBytesCompact(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}

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
export type PerDayRow =
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

/** Exported only to pin the spelling, an external display contract, in tests. */
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

/** "1.2K", "1.0M", "45.9B". Distinct from commands/models.ts's formatTokens, which renders catalog
 *  context-window sizes as bare "200k"/"1M": different semantics, so a different name. */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000_000_000) {
    return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  }
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }
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

interface CatCell {
  tok: string;
  cost: string | null;
}

/** Token parts padded to one width and `$` amounts to another, so the separator and the decimal
 *  points line up: `   176 |   $0.00`  /  `90.3K |   $0.45`  /  `234.2M | $117.09` */
function alignCatColumn(cells: CatCell[]): string[] {
  const tokW = Math.max(...cells.map((c) => c.tok.length));
  const costStrs = cells.map((c) => (c.cost === null ? "" : `$${c.cost}`));
  const costW = Math.max(...costStrs.map((s) => s.length));
  return cells.map((c, i) => {
    const tok = c.tok.padStart(tokW);
    return c.cost === null ? tok : `${tok} | ${(costStrs[i] ?? "").padStart(costW)}`;
  });
}

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

const CAT_COLUMNS = ["input", "output", "cacheRead", "cacheWrite"] as const;

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

/** A bare cost amount: alignCatColumn re-adds the `$` after padding. */
function catCell(tokens: number, costUsd: number | null): CatCell {
  return { tok: formatTokensCompact(tokens), cost: costUsd === null ? null : costUsd.toFixed(2) };
}

/** Body and footer are sub-aligned TOGETHER, so the `|` separators line up down the whole table. */
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

/** No cost fields on purpose: every TOTAL row renders the aggregate's numbers (sumEstimateCosts).
 */
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

/** EVERY total row (by-model and per-day alike) renders these same doubles: the same costs
 *  regrouped by day can differ by one ulp, which toFixed can stretch into a visible cent at a
 *  boundary. */
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

function buildModelRows(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
): { rows: CostRow[]; sum: CostSums } {
  const { byModel } = report;
  // Unpriced models sink to the bottom.
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
    const c = estimate.perModel[model];
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

/** The cost fields are the aggregate's numbers, NOT the column sum: both tables regroup the SAME
 *  aggregate, so both TOTAL rows must render the one grand total bit-identically. */
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

/** The one place estimate USD values get rounded for machine output. */
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

function completeRuntime(measured: MeasuredRun): CostRuntime {
  return {
    indexed: measured.indexed,
    index: measured.index,
    timing: { ...measured.timing, total: Math.round(measured.now() - measured.startedAt) },
  };
}

/** The top-level keys are the proxy report; `codexSessions`/`claudeSessions` sit beside them, and
 *  `runtime` is the one key that describes the run rather than the usage. */
function buildCostJson(
  report: ReadonlyUsageReport,
  estimate: CostEstimate,
  pricing: Map<string, PricingTier>,
  dbCount: number,
  sinceMs: number | undefined,
  perDay: boolean,
  codexSessions: { roots: number; providers: Record<string, Record<string, unknown>> },
  claudeSessions: Record<string, unknown>,
  measured: MeasuredRun,
): Record<string, unknown> {
  // Property order is evaluation order: `runtime` last, so its `total` covers the construction of
  // the rest.
  return {
    dbCount,
    sinceMs: sinceMs ?? null,
    ...buildSourceJson(report, estimate, pricing, { perDay }),
    codexSessions,
    claudeSessions,
    note: "approximate numbers gathered from local logs and keyed by canonical model spellings " +
      "(dashed/dated claude ids fold into the dotted form), priced at public OpenRouter rates (actual billing may differ); " +
      "top-level keys cover proxied traffic only, while codexSessions/claudeSessions cover each agent's FULL traffic " +
      "(proxy and Direct), so they overlap the proxy keys when an agent is proxy-wired -- never sum them",
    runtime: completeRuntime(measured),
  };
}
