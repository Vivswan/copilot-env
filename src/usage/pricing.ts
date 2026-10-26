// The price list is PUBLIC data, which is why loadPricing may keep a day-old copy on disk; nothing
// else `agent cost` reads is ever cached by this module.
//
// A long-context tier exists on OpenAI's card rows only; Anthropic's are flat at any size. The
// readers bucket usage on LONG_CONTEXT_PROMPT_TOKENS alone, so a card tier cut at or below it
// covers the bucket, and one cut above it (none today) would over-price it and is not applied.

import { createHash } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import { canonicalPricingUrl, OPENROUTER_MODELS_URL } from "../copilot_api/config_registry.ts";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { usageIndexDir } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";
import type { GitHubRateCard, RateCardSource } from "./github_rate_card.ts";

const FETCH_TIMEOUT_MS = 10_000;
const PER_MILLION = 1_000_000;
const PRICING_CACHE_TTL_MS = MILLISECONDS_PER_DAY;

const MODEL_ID_RE = /^\S+$/;

/** Per-million-token USD; a field is absent when OpenRouter omits it. */
export interface PricingTier {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** USD fields are exact: rounding happens once, at cost.ts's render and JSON boundaries, so no
 *  intermediate rounding drifts the sums. */
export interface ModelCost {
  pricingReference: string;
  estimatedCostUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheCreationCostUsd: number;
}

export interface CostEstimate {
  /** Keyed by the usage model name as logged, not the catalog id it resolved to. */
  perModel: Record<string, ModelCost>;

  /** The exact sum over `perModel`; rounded once, at the render and JSON boundaries. */
  totalUsd: number;

  /** Models with no catalog id, or no tier rate for their usage: tokens count, cost is absent; sorted. */
  unpriced: string[];

  /** Priced at the card over the list: a differing or missing list rate, or a tier; sorted. */
  githubRated: string[];
}

/** A prompt (input + cached) past this bills at the long-context tier; the readers bucket on it. */
export const LONG_CONTEXT_PROMPT_TOKENS = 272_000;

/** The OpenRouter list with GitHub's rate card over it: the card's rate for every model it names, the
 *  card's long-context tiers, and the card itself for the report's footer. estimateCost prices a
 *  plain Map at the list's rates alone. */
export class PriceList extends Map<string, PricingTier> {
  constructor(
    entries: Iterable<readonly [string, PricingTier]>,
    readonly card: GitHubRateCard,
    readonly from: RateCardSource,
    /** The ids whose card rate is not the list's (a differing rate, or one the list lacks). */
    readonly githubRated: ReadonlySet<string>,
  ) {
    super(entries);
  }
}

/** The list is copied, never edited: its cache on disk stays the list as fetched. A model the card
 *  prices at the list's own rate is not GitHub-rated: the footer names only the models whose price
 *  the card changed. */
export function withGitHubRates(
  pricing: ReadonlyMap<string, PricingTier>,
  card: GitHubRateCard,
  from: RateCardSource,
): PriceList {
  // Bucket by bucket: a rate the card leaves out ("Not applicable" cache writes on a pre-5.6 OpenAI
  // or Google model) keeps the list's, so usage the list priced stays priced.
  const merged = new Map(pricing);
  const changed = new Set<string>();
  for (const [id, tier] of card.rates) {
    const listed = pricing.get(id);
    const over = overTier(listed ?? {}, tier);
    merged.set(id, over);
    if (listed === undefined || !sameTier(listed, over)) changed.add(id);
  }
  return new PriceList(merged, card, from, changed);
}

/** Per-million rates agree within a nano-dollar: the list's per-token strings scaled up
 *  (0.0000002 * 1e6) land a float ulp off the card's 0.2 and are the same price. */
function sameTier(a: PricingTier, b: PricingTier): boolean {
  const same = (x: number | undefined, y: number | undefined): boolean =>
    x === undefined || y === undefined ? x === y : Math.abs(x - y) < 1e-9;
  return (
    same(a.input, b.input) &&
    same(a.output, b.output) &&
    same(a.cacheRead, b.cacheRead) &&
    same(a.cacheCreation, b.cacheCreation)
  );
}

/** GitHub meters in AI credits, 1 credit = $0.01; a transcript's `total_nano_aiu` is the request's
 *  bill in nano credits. */
export function nanoAiuToUsd(nanoAiu: number): number {
  return (nanoAiu / 1e9) * 0.01;
}

/** Keyed by lowercased OpenRouter id. Errors are fixed text (plus a numeric HTTP status), never the
 *  transport's, because a custom --pricing-url may carry credentials. */
export async function fetchPricing(
  url: string = OPENROUTER_MODELS_URL,
  fetchImpl: ProbeFetch = fetch,
): Promise<Map<string, PricingTier>> {
  const canonical = canonicalPricingUrl(url);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(canonical, {
      headers: { Accept: "application/json", "User-Agent": COPILOT_ENV_USER_AGENT },
      signal: timeout,
    });
  } catch {
    throw timeoutError(timeout) ?? new Error("pricing request failed");
  }
  if (!res.ok) {
    throw new Error(`pricing request returned HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // The timeout can fire while the body is still streaming; that is not a malformed response.
    throw timeoutError(timeout) ?? new Error("pricing response was not valid JSON");
  }
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];

  const out = new Map<string, PricingTier>();
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !MODEL_ID_RE.test(entry.id)) {
      continue;
    }
    const tier = tierOf(isRecord(entry.pricing) ? entry.pricing : {});
    if (tier !== null) out.set(entry.id.toLowerCase(), tier);
  }
  return out;
}

function timeoutError(timeout: AbortSignal): Error | null {
  return timeout.aborted
    ? new Error(`pricing request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
    : null;
}

/** Null when a supplied rate is not a price (OpenRouter's router pseudo-models list `-1`): that
 *  model stays unpriced instead of spoiling the whole list. */
function tierOf(pricing: Record<string, unknown>): PricingTier | null {
  const tier: PricingTier = {
    input: perMillion(pricing.prompt),
    output: perMillion(pricing.completion),
    cacheRead: perMillion(pricing.input_cache_read),
    cacheCreation: perMillion(pricing.input_cache_write),
  };
  return v.is(TIER_SCHEMA, tier) ? tier : null;
}

/** `cacheWriteError`: a fetched list could not be persisted, so the next run fetches again. */
type LoadedPricing =
  | { source: "cache"; pricing: Map<string, PricingTier>; fetchedAtMs: number }
  | {
      source: "fetched";
      pricing: Map<string, PricingTier>;
      fetchedAtMs: number;
      cacheWriteError?: string;
    }
  | {
      source: "stale-cache";
      pricing: Map<string, PricingTier>;
      fetchedAtMs: number;
      fetchError: string;
    };

/** A refresh failure falls back to the expired copy rather than to a token-only report. A cache
 *  that fails validation or was written for another URL is absent; one stamped in the future (clock
 *  moved back) is expired, never fresh. */
export async function loadPricing(
  url: string,
  opts: {
    cacheDir?: string;
    nowMs?: number;
    ttlMs?: number;
    fetchImpl?: ProbeFetch;
  } = {},
): Promise<LoadedPricing> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? PRICING_CACHE_TTL_MS;
  const canonical = canonicalPricingUrl(url);
  const urlDigest = sha256Hex(canonical);
  const cachePath = pricingCachePath(canonical, opts.cacheDir ?? usageIndexDir());
  const cached = readPricingCache(cachePath, urlDigest);
  if (cached !== null) {
    const ageMs = nowMs - cached.fetchedAtMs;
    if (ageMs >= 0 && ageMs < ttlMs) {
      return { pricing: cached.pricing, source: "cache", fetchedAtMs: cached.fetchedAtMs };
    }
  }
  let pricing: Map<string, PricingTier>;
  try {
    pricing = await fetchPricing(canonical, opts.fetchImpl ?? fetch);
    // A 200 without a usable price list is a broken response: persisting it would silence pricing
    // for a TTL.
    const problem = priceListProblem(pricing);
    if (problem !== null) throw new Error(`pricing response ${problem}`);
  } catch (e) {
    if (cached === null) throw e;
    return {
      pricing: cached.pricing,
      source: "stale-cache",
      fetchedAtMs: cached.fetchedAtMs,
      fetchError: errMessage(e),
    };
  }
  // The cache only accelerates the next run; a fetched list is served whether or not it could be
  // persisted.
  try {
    writePricingCache(cachePath, urlDigest, nowMs, pricing);
  } catch (e) {
    return { pricing, source: "fetched", fetchedAtMs: nowMs, cacheWriteError: errMessage(e) };
  }
  return { pricing, source: "fetched", fetchedAtMs: nowMs };
}

export function pricingCachePath(url: string, cacheDir: string): string {
  return join(cacheDir, `pricing-${sha256Hex(canonicalPricingUrl(url)).slice(0, 16)}.json`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// A listed rate: finite and non-negative; a bucket OpenRouter omits is absent.
const RATE_SCHEMA = v.optional(v.pipe(v.number(), v.finite(), v.minValue(0)));

// PricingTier's four buckets, strict: an unknown key fails the read.
const TIER_SCHEMA = v.strictObject({
  input: RATE_SCHEMA,
  output: RATE_SCHEMA,
  cacheRead: RATE_SCHEMA,
  cacheCreation: RATE_SCHEMA,
});

// Applied to a fetched response before the persist, so the cache record is read back as written.
const TIERS_SCHEMA = v.pipe(
  v.record(
    v.pipe(
      v.string(),
      v.regex(MODEL_ID_RE),
      v.check((id) => id === id.toLowerCase()),
    ),
    TIER_SCHEMA,
  ),
  v.check(
    (tiers) =>
      Object.values(tiers).some((tier) => Object.values(tier).some((r) => r !== undefined)),
    "no priced models",
  ),
);

function priceListProblem(pricing: ReadonlyMap<string, PricingTier>): string | null {
  const parsed = v.safeParse(TIERS_SCHEMA, Object.fromEntries(pricing));
  if (parsed.success) return null;
  const issue = parsed.issues[0];
  return issue.path === undefined ? `has ${issue.message}` : "carries an invalid rate";
}

// The URL is stored as a digest only: a custom --pricing-url may carry credentials or signed query
// parameters. The quoted snake_case keys are the on-disk contract.
interface PricingCacheRecord {
  url_sha256: string;
  fetched_at_ms: number;
  tiers: Record<string, PricingTier>;
}

function readPricingCache(
  path: string,
  urlDigest: string,
): { pricing: Map<string, PricingTier>; fetchedAtMs: number } | null {
  const read = fs.readTextResult(path);
  if (read.kind !== "text") return null;
  const raw = parseJsonRecord(read.text) as PricingCacheRecord | null;
  if (raw === null || raw.url_sha256 !== urlDigest) return null;
  return { pricing: new Map(Object.entries(raw.tiers)), fetchedAtMs: raw.fetched_at_ms };
}

function writePricingCache(
  path: string,
  urlDigest: string,
  fetchedAtMs: number,
  pricing: ReadonlyMap<string, PricingTier>,
): void {
  const record: PricingCacheRecord = {
    url_sha256: urlDigest,
    fetched_at_ms: fetchedAtMs,
    tiers: Object.fromEntries(pricing),
  };
  fs.writeText(path, `${JSON.stringify(record)}\n`, { secretKeys: [] });
}

const ANTHROPIC_FAMILY_SLUGS = new Set(["fable", "opus", "sonnet", "haiku"]);

/**
 * Shared by every usage reader so the same model keys the same row: the proxy logs Copilot's dotted
 * ids (`claude-opus-4.8`), transcripts Anthropic's dashed, sometimes date-snapshotted ones
 * (`claude-opus-4-8`, `claude-haiku-4-5-20251001`). A 1M-context marker stays distinct as a
 * trailing `-1m`: 1M usage is a different offering.
 */
export function canonicalModelName(model: string): string {
  let n = (model || "").trim().toLowerCase().replace(/\*+$/, "").replace(/\s+/g, "-");
  // Detached first so the digit-dash-digit dotting cannot mangle the 1m marker in
  // `claude-opus-4-7-1m-internal`.
  const internal = n.endsWith("-internal");
  if (internal) {
    n = n.slice(0, -"-internal".length);
  }
  const oneM = n.endsWith(ONE_M_SUFFIX) || /(-|\.)1m$/.test(n);
  n = n.replace(ONE_M_SUFFIX, "").replace(/(-|\.)1m$/, "");
  // Other vendors' ids are legitimately dashed (gpt-4-0314) or date-suffixed, so only claude ids
  // are rewritten.
  const slash = n.indexOf("/");
  const provider = slash >= 0 ? n.slice(0, slash + 1) : "";
  let bare = slash >= 0 ? n.slice(slash + 1) : n;
  if (bare.startsWith("claude-")) {
    bare = bare.replace(/-20\d{6}$/, "").replace(/(?<=\d)-(?=\d)/g, ".");
  }
  n = provider + bare;
  if (oneM) {
    n += "-1m";
  }
  return internal ? `${n}-internal` : n;
}

/** For a fold that meets the same handful of ids hundreds of thousands of times. One memo per fold
 *  keeps the map's life bounded by the run. */
export function canonicalModelNames(): (model: string) => string {
  const memo = new Map<string, string>();
  return (model) => {
    let canonical = memo.get(model);
    if (canonical === undefined) {
      canonical = canonicalModelName(model);
      memo.set(model, canonical);
    }
    return canonical;
  };
}

export function resolvePricingId(model: string, catalogIds: Set<string>): string | null {
  const normalized = normalizeModelName(model);
  const slash = normalized.indexOf("/");
  const bare = slash === -1 ? normalized : normalized.slice(slash + 1);

  const providers: string[] = [];
  if (slash !== -1) {
    providers.push(normalized.slice(0, slash));
  }
  for (const provider of inferProviders(bare)) {
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }

  if (normalized.includes("/") && catalogIds.has(normalized)) {
    return normalized;
  }

  const candidates = ANTHROPIC_FAMILY_SLUGS.has(bare) ? [`claude-${bare}`] : [bare];

  for (const provider of providers) {
    for (const candidate of candidates) {
      const id = `${provider}/${candidate}`;
      if (catalogIds.has(id)) {
        return id;
      }
    }
  }

  const stems = new Set(candidates);
  for (const suffix of ["-preview", "-1m"]) {
    if (bare.endsWith(suffix)) {
      stems.add(bare.slice(0, -suffix.length));
    }
  }
  for (const provider of providers) {
    for (const stem of [...stems].sort((a, b) => b.length - a.length)) {
      const prefix = `${provider}/${stem}`;
      const matches = [...catalogIds].filter((id) => id.startsWith(prefix));
      const best = chooseBestMatch(matches, stem);
      if (best) {
        return best;
      }
    }
  }

  return null;
}

/** What estimateCost prices: a roll-up and, of it, the share from requests whose prompt exceeded
 *  LONG_CONTEXT_PROMPT_TOKENS (usage.ts's record() keeps it a subset). A UsageReport is one. */
export interface UsageToPrice {
  byModel: ReadonlyMap<string, UsageTokens>;
  longContext?: { byModel: ReadonlyMap<string, UsageTokens> };
}

export function estimateCost(usage: UsageToPrice, pricing: Map<string, PricingTier>): CostEstimate {
  const lookup = pricingLookupFor(pricing);
  const book = pricing instanceof PriceList ? pricing : null;
  const perModel: Record<string, ModelCost> = {};
  const unpriced: string[] = [];
  const githubRated: string[] = [];
  let totalUsd = 0;

  for (const [model, total] of usage.byModel) {
    const reference = lookup.resolve(model);
    const tier = reference ? pricing.get(reference) : undefined;
    if (!reference || !tier || !tierCoversUsage(tier, total)) {
      unpriced.push(model);
      continue;
    }
    const over = longContextTierFor(book, reference);
    const long = over === undefined ? undefined : usage.longContext?.byModel.get(model);
    const parts: [UsageTokens, PricingTier][] =
      over === undefined || long === undefined
        ? [[total, tier]]
        : [
            [tokensMinus(total, long), tier],
            [long, overTier(tier, over)],
          ];
    const cost = blendedCost(reference, parts);
    totalUsd += cost.estimatedCostUsd;
    perModel[model] = cost;
    if (book?.githubRated.has(reference) || (long !== undefined && hasTokens(long))) {
      githubRated.push(model);
    }
  }

  return { perModel, totalUsd, unpriced: unpriced.sort(), githubRated: githubRated.sort() };
}

function longContextTierFor(book: PriceList | null, reference: string): PricingTier | undefined {
  const long = book?.card.longContext.get(reference);
  return long !== undefined && long.promptTokens <= LONG_CONTEXT_PROMPT_TOKENS
    ? long.tier
    : undefined;
}

function overTier(tier: PricingTier, over: PricingTier): PricingTier {
  return {
    input: over.input ?? tier.input,
    output: over.output ?? tier.output,
    cacheRead: over.cacheRead ?? tier.cacheRead,
    cacheCreation: over.cacheCreation ?? tier.cacheCreation,
  };
}

function blendedCost(reference: string, parts: readonly [UsageTokens, PricingTier][]): ModelCost {
  const bucket = (
    tokens: (u: UsageTokens) => number,
    rate: (t: PricingTier) => number | undefined,
  ): number => parts.reduce((sum, [u, t]) => sum + tokenCost(tokens(u), rate(t)), 0);
  const inputCostUsd = bucket(
    (u) => u.input,
    (t) => t.input,
  );
  const outputCostUsd = bucket(
    (u) => u.output,
    (t) => t.output,
  );
  const cacheReadCostUsd = bucket(
    (u) => u.cacheRead,
    (t) => t.cacheRead,
  );
  const cacheCreationCostUsd = bucket(
    (u) => u.cacheCreation,
    (t) => t.cacheCreation,
  );
  return {
    pricingReference: reference,
    estimatedCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheCreationCostUsd,
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheCreationCostUsd,
  };
}

function hasTokens(u: UsageTokens): boolean {
  return u.input + u.output + u.cacheRead + u.cacheCreation > 0;
}

function tokensMinus(total: UsageTokens, part: UsageTokens): UsageTokens {
  return {
    input: total.input - part.input,
    output: total.output - part.output,
    cacheRead: total.cacheRead - part.cacheRead,
    cacheCreation: total.cacheCreation - part.cacheCreation,
  };
}

// ---------- internals ----------

interface PricingLookup {
  resolve(model: string): string | null;
}

// One per list: priced once per source and once per day per model, and never changed after loading.
const PRICING_LOOKUPS = new WeakMap<Map<string, PricingTier>, PricingLookup>();

function pricingLookupFor(pricing: Map<string, PricingTier>): PricingLookup {
  const existing = PRICING_LOOKUPS.get(pricing);
  if (existing !== undefined) return existing;
  const catalogIds = new Set(pricing.keys());
  const memo = new Map<string, string | null>();
  const lookup: PricingLookup = {
    resolve(model) {
      const hit = memo.get(model);
      if (hit !== undefined) return hit;
      const resolved = resolvePricingId(model, catalogIds);
      memo.set(model, resolved);
      return resolved;
    },
  };
  PRICING_LOOKUPS.set(pricing, lookup);
  return lookup;
}

/** The canonical spelling minus the -internal/1m markers, which OpenRouter ids never carry. */
function normalizeModelName(model: string): string {
  return canonicalModelName(model)
    .replace(/-internal$/, "")
    .replace(/-1m$/, "");
}

/** The OpenRouter provider of a bare id: a log's `grok-4.5` reaches the card's `x-ai/grok-4.5`. */
const PROVIDER_BY_PREFIX: readonly [prefix: string, provider: string][] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "google"],
  ["grok-", "x-ai"],
  ["kimi-", "moonshotai"],
  ["mai-", "microsoft"],
];

function inferProviders(slug: string): string[] {
  if (ANTHROPIC_FAMILY_SLUGS.has(slug)) return ["anthropic"];
  const hit = PROVIDER_BY_PREFIX.find(([prefix]) => slug.startsWith(prefix));
  return hit === undefined ? [] : [hit[1]];
}

function chooseBestMatch(matches: string[], requestedSlug: string): string | null {
  if (matches.length === 0) {
    return null;
  }
  const sortKey = (modelId: string): Array<number | number[]> => {
    const slug = modelId.split("/").slice(1).join("/");
    const versionParts = [...slug.matchAll(/\d+/g)].map((m) => Number(m[0]));
    const inverseVersion = versionParts.map((p) => -p);
    return [
      slug === requestedSlug ? 0 : 1,
      slug.includes(":") ? 1 : 0,
      slug.includes("fast") && !requestedSlug.includes("fast") ? 1 : 0,
      slug.includes("image") && !requestedSlug.includes("image") ? 1 : 0,
      slug.includes("mini") && !requestedSlug.includes("mini") ? 1 : 0,
      slug.includes("nano") && !requestedSlug.includes("nano") ? 1 : 0,
      slug.startsWith(requestedSlug) ? 0 : 1,
      inverseVersion,
      slug.length,
    ];
  };
  // The id itself breaks any remaining tie, so the pick is a function of the catalog's key SET
  // alone, never its insertion order; the memoized lookup in estimateCost relies on that.
  return (
    [...matches].sort(
      (a, b) => compareKeys(sortKey(a), sortKey(b)) || (a < b ? -1 : a > b ? 1 : 0),
    )[0] ?? null
  );
}

function compareKeys(a: Array<number | number[]>, b: Array<number | number[]>): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const diff =
      Array.isArray(x) && Array.isArray(y) ? compareNumberArrays(x, y) : Number(x) - Number(y);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function compareNumberArrays(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function tierCoversUsage(tier: PricingTier, usage: UsageTokens): boolean {
  const checks: Array<[number, number | undefined]> = [
    [usage.input, tier.input],
    [usage.output, tier.output],
    [usage.cacheRead, tier.cacheRead],
    [usage.cacheCreation, tier.cacheCreation],
  ];
  return checks.every(([tokens, rate]) => tokens === 0 || rate !== undefined);
}

function tokenCost(tokens: number, ratePerMillion: number | undefined): number {
  if (!tokens || ratePerMillion === undefined) {
    return 0;
  }
  return (tokens / PER_MILLION) * ratePerMillion;
}

/** Only a non-blank string or a number counts as present; a non-price among them (`-1`, `abc`)
 *  passes through as-is so it reaches tierOf's check. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return Number(value) * PER_MILLION;
}

/** The one precision every SERIALIZED USD amount uses, applied only at cost.ts's `--json` boundary;
 *  in-memory estimates stay exact so sums never accumulate rounding error. */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
