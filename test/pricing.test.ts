import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalPricingUrl } from "../src/copilot_api/config_registry.ts";
import {
  canonicalModelName,
  estimateCost,
  fetchPricing,
  loadPricing,
  type ModelCost,
  pricingCachePath,
  type PricingTier,
  resolvePricingId,
  roundUsd,
  type UsageTokens,
  withGitHubRates,
} from "../src/usage/pricing.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The ONE serialized-USD precision: 4 decimal places, half-up, applied only at
// cost.ts's --json boundary; in-memory estimates stay exact so sums reconcile.
test("roundUsd pins the 4-decimal USD rounding rule", () => {
  expect(roundUsd(1.23456)).toBe(1.2346);
  expect(roundUsd(0.00004)).toBe(0);
  expect(roundUsd(0.00005)).toBe(0.0001);
  expect(roundUsd(12)).toBe(12);
});

const CATALOG = new Set<string>([
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.1",
  "openai/gpt-5.5",
]);

/** A usage model id against a price catalog, and the catalog entry it prices at. */
const RESOLUTIONS: { name: string; id: string; catalog: Set<string>; resolved: string | null }[] = [
  {
    name: "a fully-qualified id resolves directly",
    id: "anthropic/claude-opus-4.8",
    catalog: CATALOG,
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "a bare claude id infers its provider",
    id: "claude-opus-4.8",
    catalog: CATALOG,
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "a gpt id infers its provider",
    id: "gpt-5.5",
    catalog: CATALOG,
    resolved: "openai/gpt-5.5",
  },
  {
    name: "[1m] and digit-dash are normalized before matching",
    id: "claude-opus-4-8[1m]",
    catalog: CATALOG,
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "a dated Anthropic snapshot id lands on its base model",
    id: "claude-haiku-4-5-20251001",
    catalog: new Set(["anthropic/claude-haiku-4.5"]),
    resolved: "anthropic/claude-haiku-4.5",
  },
  {
    name: "a -1m-internal id lands on its base model",
    id: "claude-opus-4-7-1m-internal",
    catalog: new Set(["anthropic/claude-opus-4.7"]),
    resolved: "anthropic/claude-opus-4.7",
  },
  {
    name: "the opus shorthand prefix-matches a claude-opus entry",
    id: "opus",
    catalog: CATALOG,
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "the fable shorthand prefix-matches a claude-fable entry",
    id: "fable",
    catalog: new Set(["anthropic/claude-fable-5", "anthropic/claude-opus-4.8"]),
    resolved: "anthropic/claude-fable-5",
  },
  {
    // Single-number version: the [1m] strip applies, digit-dash-digit does not.
    name: "a single-number version keeps its [1m] strip",
    id: "claude-fable-5[1m]",
    catalog: new Set(["anthropic/claude-fable-5", "anthropic/claude-opus-4.8"]),
    resolved: "anthropic/claude-fable-5",
  },
  {
    name: "nothing matches",
    id: "totally-unknown-model",
    catalog: CATALOG,
    resolved: null,
  },
  {
    name: "the bare flagship beats -fast/-mini siblings sharing a prefix",
    id: "opus",
    catalog: new Set([
      "anthropic/claude-opus-4.8-fast",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4.8-mini",
    ]),
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "the newest version wins among prefix matches",
    id: "opus",
    catalog: new Set(["anthropic/claude-opus-4.1", "anthropic/claude-opus-4.8"]),
    resolved: "anthropic/claude-opus-4.8",
  },
  {
    name: "an exact sort tie breaks by id (forward insertion order)",
    id: "opus",
    catalog: new Set(["anthropic/claude-opus-4.8-a", "anthropic/claude-opus-4.8-b"]),
    resolved: "anthropic/claude-opus-4.8-a",
  },
  {
    name: "an exact sort tie breaks by id (reversed insertion order)",
    id: "opus",
    catalog: new Set(["anthropic/claude-opus-4.8-b", "anthropic/claude-opus-4.8-a"]),
    resolved: "anthropic/claude-opus-4.8-a",
  },
  {
    name: "an inferable provider with no catalog match is null",
    id: "gpt-9.9",
    catalog: new Set(["anthropic/claude-opus-4.8"]),
    resolved: null,
  },
];

for (const { name, id, catalog, resolved } of RESOLUTIONS) {
  test(`resolvePricingId: ${name}`, () => {
    expect(resolvePricingId(id, catalog)).toBe(resolved);
  });
}

test("canonicalModelName unifies the source spellings of one model", () => {
  // Anthropic dashed vs Copilot dotted vs dated snapshot: one canonical key.
  expect(canonicalModelName("claude-opus-4-8")).toBe("claude-opus-4.8");
  expect(canonicalModelName("claude-opus-4.8")).toBe("claude-opus-4.8");
  expect(canonicalModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
  // The 1M-context marker survives as `-1m` (a distinct offering), undotted,
  // and a trailing `-internal` qualifier never mangles it (upstream ids can
  // end in `-1m-internal`).
  expect(canonicalModelName("claude-opus-4-6-1m")).toBe("claude-opus-4.6-1m");
  expect(canonicalModelName("claude-fable-5[1m]")).toBe("claude-fable-5-1m");
  expect(canonicalModelName("claude-opus-4-7-1m-internal")).toBe("claude-opus-4.7-1m-internal");
  // Provider prefixes survive; the dash-to-dot and date-strip rewrites are
  // scoped to claude ids, so legitimately dashed or date-suffixed ids from
  // other vendors are never respelled.
  expect(canonicalModelName("openai/gpt-5.5")).toBe("openai/gpt-5.5");
  expect(canonicalModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(canonicalModelName("openai/gpt-4-0314")).toBe("openai/gpt-4-0314");
  expect(canonicalModelName("meta-llama/llama-3-8b")).toBe("meta-llama/llama-3-8b");
  expect(canonicalModelName("vendor/widget-20251001")).toBe("vendor/widget-20251001");
});

/** A price list and a usage map, and the estimate they must produce; USD amounts are
 *  compared to 10 places, well inside what pre-rounding to 4 would move. */
const ESTIMATES: {
  name: string;
  pricing: Map<string, PricingTier>;
  usage: Map<string, UsageTokens>;
  perModel: Record<string, Partial<ModelCost>>;
  totalUsd: number;
  unpriced: string[];
}[] = [
  {
    name: "cache buckets are priced and included in the totals",
    pricing: new Map([
      ["anthropic/claude-opus-4.8", {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheCreation: 18.75,
      }],
    ]),
    usage: new Map([
      [
        "claude-opus-4.8",
        { input: 2_000_000, output: 1_000_000, cacheRead: 4_000_000, cacheCreation: 1_000_000 },
      ],
    ]),
    // input: 2M * 15/M ; output: 1M * 75/M ; cacheRead: 4M * 1.5/M ; cacheCreation: 1M * 18.75/M
    perModel: {
      "claude-opus-4.8": {
        inputCostUsd: 30,
        outputCostUsd: 75,
        cacheReadCostUsd: 6,
        cacheCreationCostUsd: 18.75,
        estimatedCostUsd: 129.75,
      },
    },
    totalUsd: 129.75,
    unpriced: [],
  },
  {
    // 333_333 / 1M * 1.5 = 0.4999995, stored EXACT and never pre-rounded to 0.5: per-model
    // costs feed the per-day sums, so rounding here would make the by-model and per-day
    // tables disagree. roundUsd applies once, at the boundary.
    name: "USD amounts stay exact; rounding belongs to the boundary",
    pricing: new Map([["anthropic/claude-opus-4.8", { input: 15, cacheRead: 1.5 }]]),
    usage: new Map([
      ["claude-opus-4.8", { input: 0, output: 0, cacheRead: 333_333, cacheCreation: 0 }],
    ]),
    perModel: { "claude-opus-4.8": { cacheReadCostUsd: 0.4999995, estimatedCostUsd: 0.4999995 } },
    totalUsd: 0.4999995,
    unpriced: [],
  },
  {
    name: "known models are priced and unpriceable ones listed",
    pricing: new Map([
      ["anthropic/claude-opus-4.8", {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheCreation: 18.75,
      }],
    ]),
    usage: new Map([
      ["claude-opus-4.8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }],
      ["mystery-model", { input: 500, output: 0, cacheRead: 0, cacheCreation: 0 }],
    ]),
    perModel: {
      "claude-opus-4.8": {
        pricingReference: "anthropic/claude-opus-4.8",
        inputCostUsd: 15,
        outputCostUsd: 75,
        estimatedCostUsd: 90,
      },
    },
    totalUsd: 90,
    unpriced: ["mystery-model"],
  },
  {
    name: "a model whose used bucket has no rate is excluded",
    pricing: new Map([["anthropic/claude-opus-4.8", { input: 15, output: 75 }]]),
    usage: new Map([
      ["claude-opus-4.8", { input: 0, output: 0, cacheRead: 1_000, cacheCreation: 0 }],
    ]),
    perModel: {},
    totalUsd: 0,
    unpriced: ["claude-opus-4.8"],
  },
];

for (const { name, pricing, usage, perModel, totalUsd, unpriced } of ESTIMATES) {
  test(`estimateCost: ${name}`, () => {
    const result = estimateCost({ byModel: usage }, pricing);
    expect(Object.keys(result.perModel).sort()).toEqual(Object.keys(perModel).sort());
    for (const [model, expected] of Object.entries(perModel)) {
      const cost = result.perModel[model];
      for (const [field, value] of Object.entries(expected)) {
        const actual = cost?.[field as keyof ModelCost];
        if (typeof value === "number") expect(actual, `${model}.${field}`).toBeCloseTo(value, 10);
        else expect(actual, `${model}.${field}`).toBe(value);
      }
    }
    expect(result.totalUsd).toBeCloseTo(totalUsd, 10);
    expect(result.unpriced).toEqual(unpriced);
    // The total is the sum of the per-model estimates, exact doubles on both sides.
    const summed = Object.values(result.perModel).reduce((s, c) => s + c.estimatedCostUsd, 0);
    expect(result.totalUsd).toBe(summed);
  });
}

// ---------- GitHub's rate card ----------

const ONE_MILLION_EACH: UsageTokens = {
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheCreation: 1_000_000,
};

test("withGitHubRates prices gpt-5.6-sol at GitHub's card, leaves the list and every other model as they are, and names it", () => {
  const list = new Map<string, PricingTier>([
    ["openai/gpt-5.6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5 }],
    ["anthropic/claude-fable-5.1", { input: 10, output: 50, cacheRead: 0.25, cacheCreation: 12.5 }],
  ]);
  const usage = new Map([["gpt-5.6-sol", ONE_MILLION_EACH], [
    "claude-fable-5.1",
    ONE_MILLION_EACH,
  ]]);
  const estimate = estimateCost({ byModel: usage }, withGitHubRates(list));
  // GitHub's card for Sol: 4 / 20 / 0.40 / 5 per million (input, output, cache read, cache write).
  expect(estimate.perModel["gpt-5.6-sol"]).toEqual({
    pricingReference: "openai/gpt-5.6-sol",
    inputCostUsd: 4,
    outputCostUsd: 20,
    cacheReadCostUsd: 0.4,
    cacheCreationCostUsd: 5,
    estimatedCostUsd: 4 + 20 + 0.4 + 5,
  });
  expect(estimate.perModel["claude-fable-5.1"]?.estimatedCostUsd).toBeCloseTo(
    10 + 50 + 0.25 + 12.5,
    10,
  );
  expect(estimate.githubRated).toEqual(["gpt-5.6-sol"]);
  // The list is copied, never edited: its cache on disk stays the list as fetched.
  expect(list.get("openai/gpt-5.6-sol")?.input).toBe(2);
  // The card stands on its own: a list without the model still prices it.
  expect(estimateCost({ byModel: usage }, withGitHubRates(new Map())).unpriced).toEqual([
    "claude-fable-5.1",
  ]);
});

test("estimateCost bills an OpenAI long-context share at its tier and an Anthropic one flat", () => {
  const pricing = new Map<string, PricingTier>([
    ["openai/gpt-6-astra", { input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5 }],
    ["anthropic/claude-fable-5.1", { input: 10, output: 50, cacheRead: 0.25, cacheCreation: 12.5 }],
  ]);
  const total = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheCreation: 0 };
  const long = { input: 400_000, output: 40_000, cacheRead: 1_000_000, cacheCreation: 0 };
  const { perModel, githubRated } = estimateCost({
    byModel: new Map([["gpt-6-astra", total], ["claude-fable-5.1", total]]),
    longContext: { byModel: new Map([["gpt-6-astra", long], ["claude-fable-5.1", long]]) },
  }, pricing);
  // astra: 600K input at 10 + 400K at 20; 60K output at 50 + 40K at 75; 1M reads at 1 + 1M at 2.
  expect(perModel["gpt-6-astra"]?.inputCostUsd).toBeCloseTo(0.6 * 10 + 0.4 * 20, 10);
  expect(perModel["gpt-6-astra"]?.outputCostUsd).toBeCloseTo(0.06 * 50 + 0.04 * 75, 10);
  expect(perModel["gpt-6-astra"]?.cacheReadCostUsd).toBeCloseTo(1 + 2, 10);
  // fable: the same share, and no tier to move it to.
  expect(perModel["claude-fable-5.1"]?.estimatedCostUsd).toBeCloseTo(10 + 0.1 * 50 + 2 * 0.25, 10);
  // The tier is GitHub's rate too: the footer names astra, and not fable.
  expect(githubRated).toEqual(["gpt-6-astra"]);
});

// ---------- the on-disk price-list cache ----------

const PRICE_URL = "https://pricing.example/models";
const OTHER_URL = "https://pricing.example/other-models";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An OpenRouter-shaped models payload pricing one model at the given per-token rate. */
function openRouterBody(id: string, promptPerToken: string): unknown {
  return {
    data: [
      {
        id,
        pricing: {
          prompt: promptPerToken,
          completion: "0.000075",
          "input_cache_read": "0.0000015",
          "input_cache_write": "0.00001875",
        },
      },
    ],
  };
}

/** A fetch stub serving `body` and counting its calls; `fail` makes every call
 *  throw the way the real transport does, with the requested URL in the message. */
function fakeFetch(
  body: unknown,
  opts: { fail?: boolean } = {},
): { fetch: typeof fetch; calls: number } {
  const state = {
    calls: 0,
    fetch: ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      state.calls++;
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      if (opts.fail) {
        return Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch,
  };
  return state;
}

async function withCacheDir(body: (cacheDir: string) => Promise<void>): Promise<void> {
  const cacheDir = tempDir("pricing-cache-");
  try {
    await body(cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

test("loadPricing fetches on a cold cache, persists the list, and reports `fetched`", () =>
  withCacheDir(async (cacheDir) => {
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    const now = 1_700_000_000_000;

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect(loaded.fetchedAtMs).toBe(now);
    expect(net.calls).toBe(1);
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    const path = pricingCachePath(PRICE_URL, cacheDir);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(cacheDir)).toEqual([basename(path)]);
    const record = JSON.parse(readFileSync(path, "utf8"));
    // The URL itself never lands on disk (a custom one may carry credentials).
    expect(Object.keys(record).sort()).toEqual(["fetched_at_ms", "tiers", "url_sha256"]);
    expect(record.url_sha256).toBe(sha256(PRICE_URL));
    expect(JSON.stringify(record)).not.toContain("pricing.example");
    expect(record.fetched_at_ms).toBe(now);
    expect(record.tiers["anthropic/claude-opus-4.8"]).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheCreation: 18.75,
    });
  }));

/** A cache stamped at `seededAt`, read at `readAt`: fresh answers from disk, expired refreshes,
 *  and either way the stamp on disk is the last successful fetch. */
const CACHE_AGES: {
  name: string;
  seededAt: number;
  readAt: number;
  ttlMs?: number;
  fresh: boolean;
}[] = [
  { name: "inside the default ttl", seededAt: NOW, readAt: NOW + DAY_MS - 1, fresh: true },
  { name: "at the default ttl", seededAt: NOW, readAt: NOW + DAY_MS, fresh: false },
  {
    name: "inside a caller-supplied ttl",
    seededAt: NOW,
    readAt: NOW + HOUR_MS - 1,
    ttlMs: HOUR_MS,
    fresh: true,
  },
  {
    name: "at a caller-supplied ttl",
    seededAt: NOW,
    readAt: NOW + HOUR_MS,
    ttlMs: HOUR_MS,
    fresh: false,
  },
  // The clock moved back: a "fresh" stamp from the future must not be trusted.
  { name: "stamped in the future", seededAt: NOW + HOUR_MS, readAt: NOW, fresh: false },
];

for (const { name, seededAt, readAt, ttlMs, fresh } of CACHE_AGES) {
  test(`loadPricing: a cache ${name} is ${fresh ? "answered from disk" : "refreshed"}`, () =>
    withCacheDir(async (cacheDir) => {
      const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
      await loadPricing(PRICE_URL, { cacheDir, nowMs: seededAt, fetchImpl: seed.fetch });
      const path = pricingCachePath(PRICE_URL, cacheDir);
      /** What the file on disk says: when it was fetched and the one tier's input rate. */
      const onDisk = (): { stamp: number; input: number } => {
        const record = JSON.parse(readFileSync(path, "utf8"));
        return {
          stamp: record.fetched_at_ms,
          input: record.tiers["anthropic/claude-opus-4.8"].input,
        };
      };

      // A failing refresh: a fresh cache is the answer; an expired one is the fallback, and
      // the failed refresh leaves the stale file untouched.
      const down = fakeFetch(null, { fail: true });
      const fallback = await loadPricing(PRICE_URL, {
        cacheDir,
        nowMs: readAt,
        ttlMs,
        fetchImpl: down.fetch,
      });
      expect(fallback.source).toBe(fresh ? "cache" : "stale-cache");
      expect(fallback.fetchedAtMs).toBe(seededAt);
      expect(fallback.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
      expect(down.calls).toBe(fresh ? 0 : 1);
      expect(onDisk()).toEqual({ stamp: seededAt, input: 15 });

      // A working refresh would serve a DIFFERENT rate: a cache hit must not see it.
      const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000099"));
      const loaded = await loadPricing(PRICE_URL, {
        cacheDir,
        nowMs: readAt,
        ttlMs,
        fetchImpl: net.fetch,
      });
      expect(loaded.source).toBe(fresh ? "cache" : "fetched");
      expect(loaded.fetchedAtMs).toBe(fresh ? seededAt : readAt);
      expect(net.calls).toBe(fresh ? 0 : 1);
      expect(loaded.pricing.get("anthropic/claude-opus-4.8")).toEqual({
        input: fresh ? 15 : 99,
        output: 75,
        cacheRead: 1.5,
        cacheCreation: 18.75,
      });
      // A refresh rewrites the file with the new list under the new stamp; a hit leaves it.
      expect(onDisk()).toEqual(
        fresh ? { stamp: seededAt, input: 15 } : { stamp: readAt, input: 99 },
      );
      expect(readdirSync(cacheDir)).toEqual([basename(path)]);
    }));
}

test("loadPricing treats a cache file that is not JSON or was written for another URL as absent", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const path = pricingCachePath(PRICE_URL, cacheDir);
    const digest = sha256(PRICE_URL);
    const invalid: string[] = [
      "{not json",
      "[]",
      // A valid record written for ANOTHER url under this file name.
      JSON.stringify({
        "url_sha256": sha256(OTHER_URL),
        "fetched_at_ms": now,
        tiers: { "x/y": { input: 1 } },
      }),
    ];
    for (const text of invalid) {
      writeFileSync(path, text);
      const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
      const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
      expect(loaded.source).toBe("fetched");
      expect(net.calls).toBe(1);
      // ... and a failing refresh has nothing to fall back on.
      writeFileSync(path, text);
      const down = fakeFetch(null, { fail: true });
      await expect(loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch })).rejects
        .toThrow("pricing request failed");
    }
    // Negative control: the same record with a valid shape IS a cache hit.
    writeFileSync(
      path,
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/y": { input: 1 } },
      }),
    );
    const net = fakeFetch(null, { fail: true });
    const hit = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    expect(hit.source).toBe("cache");
    expect(net.calls).toBe(0);
  }));

test("fetchPricing reads only string or number rates; absent rates round-trip through the cache", () =>
  withCacheDir(async (cacheDir) => {
    const net = fakeFetch({
      data: [
        { id: "a/bool", pricing: { prompt: true, completion: "0.000002" } },
        { id: "a/array", pricing: { prompt: [], completion: {} } },
        { id: "a/number", pricing: { prompt: 0.000001, completion: "0.000002" } },
        { id: "a/blank", pricing: { prompt: "", completion: "   " } },
        { id: "a/padded", pricing: { prompt: " 0.000001 ", completion: "0.000002" } },
        { id: "a/garbage", pricing: { prompt: "abc", completion: "0.000002" } },
        { id: "vendor/bare", pricing: { prompt: "0.000001" } },
      ],
    });
    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch });

    // `true` and `[]` would coerce to 1 and 0 through Number(); neither is a price.
    expect(loaded.pricing.get("a/bool")).toEqual({ input: undefined, output: 2 });
    expect(loaded.pricing.get("a/array")).toEqual({ input: undefined, output: undefined });
    // Negative control: a numeric string and a plain number both price.
    expect(loaded.pricing.get("a/number")).toEqual({ input: 1, output: 2 });
    // Empty and whitespace-only strings are absent (Number("   ") is 0, which
    // would have priced the bucket as free); a padded number still prices.
    expect(loaded.pricing.get("a/blank")).toEqual({ input: undefined, output: undefined });
    expect(loaded.pricing.get("a/padded")).toEqual({ input: 1, output: 2 });
    // A string that is neither blank nor a number is not a price: the model is dropped.
    expect(loaded.pricing.has("a/garbage")).toBe(false);
    // A rate the response never named stays absent.
    expect(loaded.pricing.get("vendor/bare")).toEqual({ input: 1, output: undefined });

    // The cache writer and reader agree on every absent rate.
    const cached = await loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch });
    expect(net.calls).toBe(1);
    expect(cached.source).toBe("cache");
    expect(cached.pricing).toEqual(loaded.pricing);
    expect(cached.pricing.get("vendor/bare")?.output).toBeUndefined();
  }));

test("loadPricing serves a fetched list even when the cache cannot be written", () =>
  withCacheDir(async (dir) => {
    // A cache dir nested under a regular FILE cannot be created on any platform.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const cacheDir = join(blocker, "usage-index");
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect(loaded.source === "fetched" && loaded.cacheWriteError).toBeTruthy();
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    expect(existsSync(cacheDir)).toBe(false);
    // Negative control: a writable dir reports no write error.
    const ok = await loadPricing(PRICE_URL, { cacheDir: dir, nowMs: 1, fetchImpl: net.fetch });
    expect(ok).toEqual({ source: "fetched", pricing: ok.pricing, fetchedAtMs: 1 });
  }));

// Modelled on the live catalog, where the router pseudo-models (`openrouter/auto`
// and friends) carry `-1` sentinel rates beside hundreds of priced models.
test("loadPricing drops the entries that are not prices and keeps the rest of the catalog", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const net = fakeFetch({
      data: [
        {
          id: "anthropic/claude-opus-4.8",
          pricing: { prompt: "0.000015", completion: "0.000075" },
        },
        { id: "openai/gpt-5.5", pricing: { prompt: "0.000002", completion: "0.000008" } },
        { id: "Google/Gemini-3-Pro", pricing: { prompt: "0.000001", completion: "0.000004" } },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "openrouter/fusion", pricing: { prompt: "0.000001", completion: "-1" } },
        { id: "vendor/infinite", pricing: { prompt: "Infinity", completion: "0.000001" } },
        { id: "vendor/nan", pricing: { prompt: 0.000001, completion: "NaN" } },
        { id: "vendor/negative-number", pricing: { prompt: -0.000001, completion: "0.000001" } },
        { id: "vendor/space d", pricing: { prompt: "0.000001", completion: "0.000001" } },
        { id: "", pricing: { prompt: "0.000001", completion: "0.000001" } },
      ],
    });

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect([...loaded.pricing.keys()].sort()).toEqual([
      "anthropic/claude-opus-4.8",
      "google/gemini-3-pro",
      "openai/gpt-5.5",
    ]);
    expect(loaded.pricing.get("openai/gpt-5.5")).toEqual({
      input: 2,
      output: 8,
      cacheRead: undefined,
      cacheCreation: undefined,
    });
    // A dropped entry is simply unpriced when usage names it.
    const usage = new Map<string, UsageTokens>([
      ["openrouter/auto", { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }],
      ["gpt-5.5", { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }],
    ]);
    const cost = estimateCost({ byModel: usage }, loaded.pricing);
    expect(cost.unpriced).toEqual(["openrouter/auto"]);
    expect(cost.totalUsd).toBe(2);
    // The persisted list is the filtered one and is a valid cache on re-read.
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(Object.keys(record.tiers).sort()).toEqual([...loaded.pricing.keys()].sort());
    const down = fakeFetch(null, { fail: true });
    const hit = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    expect(hit.source).toBe("cache");
    expect(hit.pricing).toEqual(loaded.pricing);
    expect(down.calls).toBe(0);
  }));

test("loadPricing treats a response with no priced model as a failed refresh", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    // No cache yet: an empty list is an error, not a price list, and nothing is written.
    const empty = fakeFetch({ data: [] });
    await expect(loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: empty.fetch })).rejects
      .toThrow("pricing response has no priced models");
    expect(readdirSync(cacheDir)).toEqual([]);

    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });
    const later = now + 2 * DAY_MS;

    // With an expired cache: the stale list wins over a body with no list at all.
    const bodyless = fakeFetch({});
    const loaded = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: later,
      fetchImpl: bodyless.fetch,
    });
    expect(loaded.source).toBe("stale-cache");
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);

    // Router entries only, models with no rates at all, and unroutable ids
    // (empty or with whitespace): nothing here is a priced model.
    const unpriced = fakeFetch({
      data: [
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "openai/gpt-5.5", pricing: { prompt: "-0.000001" } },
        { id: "a/b" },
        { id: "c/d", pricing: {} },
        { id: "", pricing: { prompt: "0.001" } },
        { id: "a b", pricing: { prompt: "0.001" } },
      ],
    });
    const kept = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: later,
      fetchImpl: unpriced.fetch,
    });
    expect(kept).toMatchObject({
      source: "stale-cache",
      fetchedAtMs: now,
      fetchError: "pricing response has no priced models",
    });
    expect(kept.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    expect(kept.pricing.has("openai/gpt-5.5")).toBe(false);

    // The stale file is untouched by the failed refreshes.
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(record.fetched_at_ms).toBe(now);
    expect(Object.keys(record.tiers)).toEqual(["anthropic/claude-opus-4.8"]);
    // Negative control: one priced model among unpriced ones IS a usable list.
    const mixed = fakeFetch({
      data: [{ id: "a/b" }, { id: "anthropic/claude-opus-4.8", pricing: { prompt: "0.00002" } }],
    });
    const fresh = await loadPricing(PRICE_URL, { cacheDir, nowMs: later, fetchImpl: mixed.fetch });
    expect(fresh.source).toBe("fetched");
    expect(fresh.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(20);
  }));

test("the flag and the stored key share one URL rule: https only, canonical before the cache digest, one file per url", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    // Two spellings of one list -> one cache file, one fetch (the second run is a hit).
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    const loud = "HTTPS://Pricing.Example/Models?x=1";
    const quiet = "https://pricing.example/Models?x=1";
    expect(canonicalPricingUrl(loud)).toBe(quiet);
    expect(pricingCachePath(loud, cacheDir)).toBe(pricingCachePath(quiet, cacheDir));
    await loadPricing(loud, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    expect(readdirSync(cacheDir)).toEqual([basename(pricingCachePath(quiet, cacheDir))]);
    const hit = await loadPricing(quiet, { cacheDir, nowMs: now + 1, fetchImpl: net.fetch });
    expect(hit.source).toBe("cache");
    expect(net.calls).toBe(1);

    // Another list is another file: each url answers from its own cache.
    const other = fakeFetch(openRouterBody("openai/gpt-5.5", "0.000002"));
    await loadPricing(OTHER_URL, { cacheDir, nowMs: now, fetchImpl: other.fetch });
    expect(pricingCachePath(quiet, cacheDir)).not.toBe(pricingCachePath(OTHER_URL, cacheDir));
    expect(readdirSync(cacheDir).length).toBe(2);
    const down = fakeFetch(null, { fail: true });
    const first = await loadPricing(quiet, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    const second = await loadPricing(OTHER_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    expect([...first.pricing.keys()]).toEqual(["anthropic/claude-opus-4.8"]);
    expect([...second.pricing.keys()]).toEqual(["openai/gpt-5.5"]);
    expect(down.calls).toBe(0);

    // fetchPricing itself accepts the loud spelling and requests the canonical one.
    let requested = "";
    const recording = ((input: string | URL | Request) => {
      requested = String(input);
      return net.fetch(input);
    }) as typeof fetch;
    await fetchPricing(loud, recording);
    expect(requested).toBe(quiet);

    // Anything but https, or an https URL with userinfo (fetch would refuse it), is refused
    // with the stored key's fixed text, which never echoes the URL.
    const rejected: [string, string][] = [
      ["http://user:SECRET@pricing.example/models", "expected an https:// URL"],
      ["pricing.example", "expected an https:// URL"],
      ["ftp://x", "expected an https:// URL"],
      [
        "https://user:SECRET@pricing.example/models",
        "expected an https:// URL without user:password@ credentials (put a token in the query instead)",
      ],
    ];
    for (const [bad, expected] of rejected) {
      let message = "";
      try {
        canonicalPricingUrl(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(expected);
      await expect(fetchPricing(bad, net.fetch)).rejects.toThrow(message);
      await expect(loadPricing(bad, { cacheDir, nowMs: now, fetchImpl: net.fetch })).rejects
        .toThrow(message);
    }
    expect(net.calls).toBe(2);
  }));

test("loadPricing never echoes the URL in its errors", () =>
  withCacheDir(async (cacheDir) => {
    const secretUrl = "https://pricing.example/models?token=SECRET-TOKEN-123";
    const now = 1_700_000_000_000;

    // Transport failure, no cache: the rejection carries neither the URL nor the token.
    const down = fakeFetch(null, { fail: true });
    const rejected = await loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: down.fetch })
      .then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(rejected).toBe("pricing request failed");

    // A transport error's NAME is as untrusted as its message.
    const named = fakeFetch(null);
    named.fetch = (() => {
      const e = new Error(`boom ${secretUrl}`);
      e.name = secretUrl;
      return Promise.reject(e);
    }) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: named.fetch })).rejects
      .toThrow(/^pricing request failed$/);

    // HTTP failure (a server's status text can echo the request) and a non-JSON
    // body: summarized without either.
    const denied = fakeFetch(null);
    denied.fetch = (() =>
      Promise.resolve(
        new Response("nope", { status: 401, statusText: `Unauthorized ${secretUrl}` }),
      )) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: denied.fetch })).rejects
      .toThrow(/^pricing request returned HTTP 401$/);
    const html = fakeFetch(null);
    html.fetch = (() => Promise.resolve(new Response("<html>", { status: 200 }))) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: html.fetch })).rejects
      .toThrow("pricing response was not valid JSON");

    // Stale fallback: the recorded fetchError is equally URL-free, and so is the file.
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: seed.fetch });
    const stale = await loadPricing(secretUrl, {
      cacheDir,
      nowMs: now + 2 * DAY_MS,
      fetchImpl: down.fetch,
    });
    expect(stale).toMatchObject({
      source: "stale-cache",
      fetchedAtMs: now,
      fetchError: "pricing request failed",
    });
    const text = JSON.stringify(stale) +
      readFileSync(pricingCachePath(secretUrl, cacheDir), "utf8");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("pricing.example");
    // Negative control: the fake transport's own error DOES carry the token.
    await expect(down.fetch(secretUrl)).rejects.toThrow("SECRET-TOKEN-123");
  }));
