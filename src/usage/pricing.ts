// OpenRouter pricing lookup + cost estimation.
//
// Fetch live per-token pricing from the OpenRouter models API, resolve internal
// model ids onto OpenRouter ids (provider inference + version-aware best match),
// and price the aggregated token usage. Models OpenRouter cannot price are
// reported as unpriced and excluded from the total.

import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { isRecord } from "../utils/json.ts";

const FETCH_TIMEOUT_MS = 10_000;
const PER_MILLION = 1_000_000;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

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

/** Cost breakdown for a single model. */
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

/** Fetch live model pricing keyed by lowercased OpenRouter model id. */
export async function fetchPricing(
  url: string = OPENROUTER_MODELS_URL,
): Promise<Map<string, PricingTier>> {
  if (!url.startsWith("https://")) {
    throw new Error(`pricing URL must use HTTPS: ${url}`);
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "copilot-env-cost" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];

  const out = new Map<string, PricingTier>();
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    out.set(entry.id.toLowerCase(), {
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read),
      cacheCreation: perMillion(pricing.input_cache_write),
    });
  }
  return out;
}

/** Bare Anthropic family slugs that map to `claude-<family>` catalog stems. */
const ANTHROPIC_FAMILY_SLUGS = new Set(["fable", "opus", "sonnet", "haiku"]);

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
  const catalogIds = new Set(pricing.keys());
  const perModel: Record<string, ModelCost> = {};
  const unpriced: string[] = [];
  let totalUsd = 0;

  for (const [model, usage] of usageByModel) {
    const reference = resolvePricingId(model, catalogIds);
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
      estimatedCostUsd: round(estimatedCostUsd),
      inputCostUsd: round(inputCostUsd),
      outputCostUsd: round(outputCostUsd),
      cacheReadCostUsd: round(cacheReadCostUsd),
      cacheCreationCostUsd: round(cacheCreationCostUsd),
    };
  }

  return { perModel, totalUsd: round(totalUsd), unpriced: unpriced.sort() };
}

// ---------- internals ----------

/** Lowercase, drop `[1m]`/`-1m`/`.1m` and trailing `-internal`, and convert digit-dash-digit to dots. */
function normalizeModelName(model: string): string {
  let n = (model || "").toLowerCase().replace(/\*+$/, "").replace(/\s+/g, "-");
  n = n
    .replace(ONE_M_SUFFIX, "")
    .replace(/-internal$/, "")
    .replace(/(-|\.)1m$/, "");
  const toDot = (s: string): string => s.replace(/(?<=\d)-(?=\d)/g, ".");
  if (n.includes("/")) {
    const [provider, ...rest] = n.split("/");
    return `${provider}/${toDot(rest.join("/"))}`;
  }
  return toDot(n);
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
  return [...matches].sort((a, b) => compareKeys(sortKey(a), sortKey(b)))[0] ?? null;
}

/** Lexicographic compare of mixed scalar/array sort keys. */
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

/** Convert OpenRouter's per-token string price into per-million USD. */
function perMillion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num * PER_MILLION : undefined;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
