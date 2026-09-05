// OpenRouter pricing lookup + cost estimation.
//
// Fetch live per-token pricing from the OpenRouter models API, resolve internal
// model ids onto OpenRouter ids (provider inference + version-aware best match),
// and price the aggregated token usage. Models OpenRouter cannot price are
// reported as unpriced and excluded from the total.
//
// The price list is PUBLIC data, which is why loadPricing may keep a day-old
// copy on disk. Nothing else `agent cost` reads (usage, tokens, transcripts) is
// ever cached by this module.

import { createHash } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import { atomicWriteFile } from "../copilot_api/config.ts";
import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { readTextOrNull } from "../utils/fs.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";

const FETCH_TIMEOUT_MS = 10_000;
const PER_MILLION = 1_000_000;
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_CACHE_DIR_NAME = "usage-index";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** A routable model id: nonempty, no whitespace. */
const MODEL_ID_RE = /^\S+$/;

/** Per-million-token USD rates; a field is absent when OpenRouter omits it. */
export interface PricingTier {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** Token counts to price (cache buckets optional). */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Cost breakdown for a single model. USD fields are exact (unrounded), so no
 *  intermediate rounding drifts derived sums; rounding happens once at the
 *  render/JSON boundaries in cost.ts. */
export interface ModelCost {
  pricingReference: string;
  estimatedCostUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheCreationCostUsd: number;
}

/** Result of pricing a whole usage map. */
export interface CostEstimate {
  perModel: Record<string, ModelCost>;
  totalUsd: number;
  unpriced: string[];
}

/** Fetch live model pricing keyed by lowercased OpenRouter model id. Errors are
 *  fixed text (plus a numeric HTTP status), never the transport's, because a
 *  custom --pricing-url may carry credentials. `signal` cancels the request. */
export async function fetchPricing(
  url: string = OPENROUTER_MODELS_URL,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, PricingTier>> {
  if (!url.startsWith("https://")) {
    throw new Error("pricing URL must use HTTPS");
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "copilot-env-cost" },
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch {
    if (timeout.aborted) {
      throw new Error(`pricing request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(signal?.aborted ? "pricing request was cancelled" : "pricing request failed");
  }
  if (!res.ok) {
    throw new Error(`pricing request returned HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("pricing response was not valid JSON");
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

/** An entry's tier, or null when a supplied rate is not a price (OpenRouter's
 *  router pseudo-models list `-1`): that model stays unpriced instead of
 *  spoiling the whole list. */
function tierOf(pricing: Record<string, unknown>): PricingTier | null {
  const tier: PricingTier = {
    input: perMillion(pricing.prompt),
    output: perMillion(pricing.completion),
    cacheRead: perMillion(pricing.input_cache_read),
    cacheCreation: perMillion(pricing.input_cache_write),
  };
  return v.is(TIER_SCHEMA, tier) ? tier : null;
}

/** A loaded price list and where it came from. `fetchedAtMs` is when the
 *  returned list was fetched from OpenRouter (the cache stamp). */
export type LoadedPricing =
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

/**
 * The price list with a day-long on-disk cache: a fresh cache answers without
 * touching the network, an expired one is refreshed (and the refreshed copy
 * persisted), and a refresh failure falls back to the expired copy rather than
 * to a token-only report. Rejects only when there is neither a fetch nor any
 * cached copy. The cache file is treated as absent whenever it fails
 * validation or was written for a different URL; a cache stamped in the
 * future (clock moved back) is expired, never fresh.
 */
export async function loadPricing(
  url: string,
  opts: {
    cacheDir?: string;
    nowMs?: number;
    ttlMs?: number;
    fetchImpl?: typeof fetch;
    /** Cancels an in-flight refresh (a run that turns out to need no prices). */
    signal?: AbortSignal;
  } = {},
): Promise<LoadedPricing> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? PRICING_CACHE_TTL_MS;
  const urlDigest = sha256Hex(url);
  const cachePath = pricingCachePath(url, opts.cacheDir ?? defaultPricingCacheDir());
  const cached = readPricingCache(cachePath, urlDigest);
  if (cached !== null) {
    const ageMs = nowMs - cached.fetchedAtMs;
    if (ageMs >= 0 && ageMs < ttlMs) {
      return { pricing: cached.pricing, source: "cache", fetchedAtMs: cached.fetchedAtMs };
    }
  }
  let pricing: Map<string, PricingTier>;
  try {
    pricing = await fetchPricing(url, opts.fetchImpl ?? fetch, opts.signal);
    // A 200 that does not carry a usable price list is a broken response:
    // persisting it would silence pricing for a whole TTL.
    const problem = priceListProblem(pricing);
    if (problem !== null) throw new Error(`pricing response ${problem}`);
  } catch (e) {
    if (cached === null) throw e;
    return {
      pricing: cached.pricing,
      source: "stale-cache",
      fetchedAtMs: cached.fetchedAtMs,
      fetchError: errorText(e),
    };
  }
  // The cache only accelerates the next run; a list that was fetched is served
  // whether or not it could be persisted.
  try {
    writePricingCache(cachePath, urlDigest, nowMs, pricing);
  } catch (e) {
    return { pricing, source: "fetched", fetchedAtMs: nowMs, cacheWriteError: errorText(e) };
  }
  return { pricing, source: "fetched", fetchedAtMs: nowMs };
}

/** `<cacheDir>/pricing-<key>.json`, keyed by a SHA-256 prefix of the URL so
 *  every distinct price-list URL gets its own file. */
export function pricingCachePath(url: string, cacheDir: string): string {
  return join(cacheDir, `pricing-${sha256Hex(url).slice(0, 16)}.json`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultPricingCacheDir(): string {
  return join(resolveRootHome(), PRICING_CACHE_DIR_NAME);
}

const RATE_SCHEMA = v.optional(v.pipe(v.number(), v.finite(), v.minValue(0)));

const TIER_SCHEMA = v.strictObject({
  "input": RATE_SCHEMA,
  "output": RATE_SCHEMA,
  "cacheRead": RATE_SCHEMA,
  "cacheCreation": RATE_SCHEMA,
});

// THE definition of a usable price list, applied to a fetched response before
// it is persisted and to a cache record when it is read, so the two can never
// disagree; tierOf holds each fetched entry to TIER_SCHEMA on its own.
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

/** Why `pricing` is not a usable price list, or null when it is. */
function priceListProblem(pricing: ReadonlyMap<string, PricingTier>): string | null {
  const parsed = v.safeParse(TIERS_SCHEMA, Object.fromEntries(pricing));
  if (parsed.success) return null;
  const issue = parsed.issues[0];
  return issue.path === undefined ? `has ${issue.message}` : "carries an invalid rate";
}

// The record identifies its URL by digest only: a custom --pricing-url may
// carry credentials or signed query parameters, and this file holds nothing
// but the public price list.
const PRICING_CACHE_SCHEMA = v.strictObject({
  "url_sha256": v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  "fetched_at_ms": v.pipe(v.number(), v.finite(), v.minValue(0)),
  "tiers": TIERS_SCHEMA,
});

function readPricingCache(
  path: string,
  urlDigest: string,
): { pricing: Map<string, PricingTier>; fetchedAtMs: number } | null {
  const text = readTextOrNull(path);
  if (text === null) return null;
  const raw = parseJsonRecord(text);
  if (raw === null) return null;
  const parsed = v.safeParse(PRICING_CACHE_SCHEMA, raw);
  if (!parsed.success || parsed.output.url_sha256 !== urlDigest) return null;
  const pricing = new Map<string, PricingTier>();
  for (const [id, tier] of Object.entries(parsed.output.tiers)) {
    pricing.set(id, {
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheCreation: tier.cacheCreation,
    });
  }
  return { pricing, fetchedAtMs: parsed.output.fetched_at_ms };
}

function writePricingCache(
  path: string,
  urlDigest: string,
  fetchedAtMs: number,
  pricing: ReadonlyMap<string, PricingTier>,
): void {
  const record = {
    "url_sha256": urlDigest,
    "fetched_at_ms": fetchedAtMs,
    "tiers": Object.fromEntries(pricing),
  };
  atomicWriteFile(path, `${JSON.stringify(record)}\n`);
}

/** Bare Anthropic family slugs that map to `claude-<family>` catalog stems. */
const ANTHROPIC_FAMILY_SLUGS = new Set(["fable", "opus", "sonnet", "haiku"]);

/**
 * Canonical spelling of a model id, shared by every usage reader so the same
 * model keys the same row no matter which source recorded it: the proxy logs
 * Copilot's dotted ids (`claude-opus-4.8`) while agent transcripts log
 * Anthropic's dashed, sometimes date-snapshotted ids (`claude-opus-4-8`,
 * `claude-haiku-4-5-20251001`). Lowercases, drops whitespace and trailing
 * asterisks, normalizes any 1M-context marker (`[1m]`/`.1m`/`-1m`) to a
 * trailing `-1m` (kept distinct: 1M usage is a different offering), and, for
 * claude ids only, strips a `-YYYYMMDD` snapshot date and converts
 * digit-dash-digit to dots.
 */
export function canonicalModelName(model: string): string {
  let n = (model || "").trim().toLowerCase().replace(/\*+$/, "").replace(/\s+/g, "-");
  // Detach the known terminal qualifiers (upstream ids can end in
  // `-1m-internal`) so the digit-dash-digit dotting cannot mangle the 1m
  // marker in ids like `claude-opus-4-7-1m-internal`.
  const internal = n.endsWith("-internal");
  if (internal) {
    n = n.slice(0, -"-internal".length);
  }
  const oneM = n.endsWith(ONE_M_SUFFIX) || /(-|\.)1m$/.test(n);
  n = n.replace(ONE_M_SUFFIX, "").replace(/(-|\.)1m$/, "");
  // The dash/dot and dated-snapshot respellings are Anthropic/Copilot claude
  // conventions; other vendors' ids are legitimately dashed (gpt-4-0314) or
  // date-suffixed, so only claude ids are rewritten.
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

/** Map an internal model id onto an OpenRouter id, or null if none matches. */
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

  // Direct hit on a fully-qualified id.
  if (normalized.includes("/") && catalogIds.has(normalized)) {
    return normalized;
  }

  const candidates = ANTHROPIC_FAMILY_SLUGS.has(bare) ? [`claude-${bare}`] : [bare];

  // Exact `provider/candidate`.
  for (const provider of providers) {
    for (const candidate of candidates) {
      const id = `${provider}/${candidate}`;
      if (catalogIds.has(id)) {
        return id;
      }
    }
  }

  // Prefix match, longest stem first, version-aware best pick.
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

/** Price an aggregated usage map; unpriceable models are excluded from the total. */
export function estimateCost(
  usageByModel: ReadonlyMap<string, UsageTokens>,
  pricing: Map<string, PricingTier>,
): CostEstimate {
  const lookup = pricingLookupFor(pricing);
  const perModel: Record<string, ModelCost> = {};
  const unpriced: string[] = [];
  let totalUsd = 0;

  for (const [model, usage] of usageByModel) {
    const reference = lookup.resolve(model);
    const tier = reference ? pricing.get(reference) : undefined;
    if (!reference || !tier || !tierCoversUsage(tier, usage)) {
      unpriced.push(model);
      continue;
    }

    const inputCostUsd = tokenCost(usage.input, tier.input);
    const outputCostUsd = tokenCost(usage.output, tier.output);
    const cacheReadCostUsd = tokenCost(usage.cacheRead, tier.cacheRead);
    const cacheCreationCostUsd = tokenCost(usage.cacheCreation, tier.cacheCreation);
    const estimatedCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheCreationCostUsd;
    totalUsd += estimatedCostUsd;

    perModel[model] = {
      pricingReference: reference,
      estimatedCostUsd,
      inputCostUsd,
      outputCostUsd,
      cacheReadCostUsd,
      cacheCreationCostUsd,
    };
  }

  return { perModel, totalUsd, unpriced: unpriced.sort() };
}

// ---------- internals ----------

interface PricingLookup {
  /** The ids the lookup was built for: resolutions depend only on the key set,
   *  so a lookup stays valid exactly while the map still has these keys. */
  catalogIds: Set<string>;
  resolve(model: string): string | null;
}

// One lookup per price list, keyed by map identity: `agent cost` prices the
// same list once per source and once per day per model, and every one of those
// calls used to rebuild the catalog Set and re-run the prefix scan per model.
const PRICING_LOOKUPS = new WeakMap<Map<string, PricingTier>, PricingLookup>();

function pricingLookupFor(pricing: Map<string, PricingTier>): PricingLookup {
  const existing = PRICING_LOOKUPS.get(pricing);
  if (existing !== undefined && sameKeys(pricing, existing.catalogIds)) return existing;
  const catalogIds = new Set(pricing.keys());
  const memo = new Map<string, string | null>();
  const lookup: PricingLookup = {
    catalogIds,
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

function sameKeys(pricing: ReadonlyMap<string, PricingTier>, ids: Set<string>): boolean {
  if (pricing.size !== ids.size) return false;
  for (const id of pricing.keys()) {
    if (!ids.has(id)) return false;
  }
  return true;
}

/** Pricing-lookup form: the canonical spelling minus the -internal/1m markers. */
function normalizeModelName(model: string): string {
  return canonicalModelName(model)
    .replace(/-internal$/, "")
    .replace(/-1m$/, "");
}

/** Likely OpenRouter providers for a bare slug (no provider prefix). */
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

/** Pick the most likely stable OpenRouter match from prefix candidates. */
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
  // The id itself breaks any remaining tie, so the pick is a function of the
  // catalog's key SET alone (never its insertion order): the memoized lookup
  // in estimateCost relies on exactly that.
  return [...matches].sort((a, b) =>
    compareKeys(sortKey(a), sortKey(b)) || (a < b ? -1 : a > b ? 1 : 0)
  )[0] ?? null;
}

/** Lexicographic compare of mixed scalar/array sort keys. */
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

/** True when every non-zero token bucket has a corresponding rate. */
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

/** Convert OpenRouter's per-token price into per-million USD. Absent (undefined)
 *  when the field is omitted, blank, or not a string/number; otherwise the
 *  parsed number as-is, so a non-price (`-1`, `abc`) reaches tierOf's check. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return Number(value) * PER_MILLION;
}

/** The ONE precision every SERIALIZED USD amount uses: 4 decimal places. Applied
 *  only at cost.ts's `--json` boundary -- in-memory estimates stay exact, so sums
 *  never accumulate rounding error (regrouped float sums can still differ by one
 *  ulp; the render layer draws every TOTAL from one set of numbers for that). */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
