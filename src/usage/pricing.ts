// The price list is PUBLIC data, which is why loadPricing may keep a day-old copy on disk; nothing
// else `agent cost` reads is ever cached by this module.

import { createHash } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import * as fs from "../utils/fs_facade.ts";
import { canonicalPricingUrl, OPENROUTER_MODELS_URL } from "../copilot_api/config_registry.ts";
import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { usageIndexDir } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

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
  perModel: Record<string, ModelCost>;
  totalUsd: number;
  unpriced: string[];
  /** Models priced at a GitHub rate the list does not carry: the card's own rate for the model, or
   *  the long-context tier that applied to part of its usage. Sorted. */
  githubRated: string[];
}

// GitHub's rate card for Copilot, USD per million tokens, read 2026-09-19 from
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing and keyed by
// the OpenRouter id the list spells. Static on purpose: the page is not fetched.

/** The models GitHub prices differently from the OpenRouter list; every other model's card
 *  matches the list. Applied over the loaded list by withGitHubRates. */
const GITHUB_RATES: ReadonlyMap<string, PricingTier> = new Map([
  ["openai/gpt-5.6-sol", { input: 4, output: 20, cacheRead: 0.4, cacheCreation: 5 }],
]);

/** A request whose prompt (input plus cached input) exceeds this is billed at the long-context
 *  tier below. OpenAI models only: Anthropic's are flat at any size. */
export const LONG_CONTEXT_PROMPT_TOKENS = 272_000;

const LONG_CONTEXT_RATES: ReadonlyMap<string, PricingTier> = new Map([
  ["openai/gpt-6-astra", { input: 20, output: 75, cacheRead: 2, cacheCreation: 25 }],
  ["openai/gpt-5.6-sol", { input: 8, output: 30, cacheRead: 0.8, cacheCreation: 10 }],
]);

/** A copy of the list with GitHub's rates in place of its own; the list itself (and its cache on
 *  disk) is left as fetched. */
export function withGitHubRates(
  pricing: ReadonlyMap<string, PricingTier>,
): Map<string, PricingTier> {
  const out = new Map(pricing);
  for (const [id, tier] of GITHUB_RATES) out.set(id, tier);
  return out;
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
  fetchImpl: typeof fetch = fetch,
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

/** `fetchedAtMs` is the cache stamp: when the returned list was fetched. */
type LoadedPricing =
  | { source: "cache"; pricing: Map<string, PricingTier>; fetchedAtMs: number }
  | {
    source: "fetched";
    pricing: Map<string, PricingTier>;
    fetchedAtMs: number;
    /** Set when the list could not be persisted: the next run fetches again. */
    cacheWriteError?: string;
  }
  | {
    /** The refresh failed; the caller is pricing against an expired copy. */
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
    fetchImpl?: typeof fetch;
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

/** Keyed by the CANONICAL URL, so two spellings of one list share a file. */
export function pricingCachePath(url: string, cacheDir: string): string {
  return join(cacheDir, `pricing-${sha256Hex(canonicalPricingUrl(url)).slice(0, 16)}.json`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const RATE_SCHEMA = v.optional(v.pipe(v.number(), v.finite(), v.minValue(0)));

const TIER_SCHEMA = v.strictObject({
  "input": RATE_SCHEMA,
  "output": RATE_SCHEMA,
  "cacheRead": RATE_SCHEMA,
  "cacheCreation": RATE_SCHEMA,
});

// Applied to a fetched response before it is persisted; the cache record it becomes is this
// program's own and is read back as written.
const TIERS_SCHEMA = v.pipe(
  v.record(
    v.pipe(v.string(), v.regex(MODEL_ID_RE), v.check((id) => id === id.toLowerCase())),
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
  "url_sha256": string;
  "fetched_at_ms": number;
  "tiers": Record<string, PricingTier>;
}

/** A file written for another URL, or one that is not JSON, reads as absent. */
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
    "url_sha256": urlDigest,
    "fetched_at_ms": fetchedAtMs,
    "tiers": Object.fromEntries(pricing),
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
  const bare = normalized.includes("/") ? normalized.split("/").slice(1).join("/") : normalized;

  const providers: string[] = [];
  if (normalized.includes("/")) {
    providers.push(normalized.split("/", 1)[0]!);
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
    // The long-context share at its tier and the rest at the base tier, so the model's row shows
    // one blended cost. A model with no long-context tier is flat at any size; a bucket the tier
    // leaves out keeps the base rate.
    const longTier = LONG_CONTEXT_RATES.get(reference);
    const long = longTier === undefined ? undefined : usage.longContext?.byModel.get(model);
    const parts: [UsageTokens, PricingTier][] = long === undefined
      ? [[total, tier]]
      : [[tokensMinus(total, long), tier], [long, { ...tier, ...longTier }]];
    const cost = blendedCost(reference, parts);
    totalUsd += cost.estimatedCostUsd;
    perModel[model] = cost;
    if (GITHUB_RATES.has(reference) || (long !== undefined && hasTokens(long))) {
      githubRated.push(model);
    }
  }

  return { perModel, totalUsd, unpriced: unpriced.sort(), githubRated: githubRated.sort() };
}

/** Each bucket summed over its parts, each part's tokens at that part's tier. */
function blendedCost(reference: string, parts: readonly [UsageTokens, PricingTier][]): ModelCost {
  const bucket = (
    tokens: (u: UsageTokens) => number,
    rate: (t: PricingTier) => number | undefined,
  ): number => parts.reduce((sum, [u, t]) => sum + tokenCost(tokens(u), rate(t)), 0);
  const inputCostUsd = bucket((u) => u.input, (t) => t.input);
  const outputCostUsd = bucket((u) => u.output, (t) => t.output);
  const cacheReadCostUsd = bucket((u) => u.cacheRead, (t) => t.cacheRead);
  const cacheCreationCostUsd = bucket((u) => u.cacheCreation, (t) => t.cacheCreation);
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

// One lookup per price list: `agent cost` prices the same list once per source and once per day per
// model, and never changes a list after loading it.
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

function inferProviders(slug: string): string[] {
  if (ANTHROPIC_FAMILY_SLUGS.has(slug) || slug.startsWith("claude-")) {
    return ["anthropic"];
  }
  if (slug.startsWith("gpt-")) {
    return ["openai"];
  }
  if (slug.startsWith("gemini-")) {
    return ["google"];
  }
  return [];
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
  return [...matches].sort((a, b) =>
    compareKeys(sortKey(a), sortKey(b)) || (a < b ? -1 : a > b ? 1 : 0)
  )[0] ?? null;
}

function compareKeys(a: Array<number | number[]>, b: Array<number | number[]>): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const diff = Array.isArray(x) && Array.isArray(y)
      ? compareNumberArrays(x, y)
      : Number(x) - Number(y);
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
